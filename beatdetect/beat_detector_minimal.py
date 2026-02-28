#!/usr/bin/env python3
"""
Minimal beat detector: onset detection only.
Detects kicks (low-frequency percussive) and snares/claps (high-frequency percussive).
No prediction, no pattern matching, no debouncing.
"""

import argparse
import numpy as np
import sounddevice as sd
import time
import sys

try:
    import soundfile as sf
except ImportError:
    sf = None


# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────

SAMPLE_RATE = 44100
BLOCK_SIZE = 512
FFT_SIZE = 2048

# Frequency bands
KICK_LOW_HZ = 30
KICK_HIGH_HZ = 150
SNARE_LOW_HZ = 600
SNARE_HIGH_HZ = 4000

# Derived bin indices
FREQ_PER_BIN = SAMPLE_RATE / FFT_SIZE
KICK_BIN_LOW = int(KICK_LOW_HZ / FREQ_PER_BIN)
KICK_BIN_HIGH = int(KICK_HIGH_HZ / FREQ_PER_BIN)
SNARE_BIN_LOW = int(SNARE_LOW_HZ / FREQ_PER_BIN)
SNARE_BIN_HIGH = int(SNARE_HIGH_HZ / FREQ_PER_BIN)

# Fixed onset thresholds
KICK_SPIKE_THRESHOLD = 2.0   # kick energy must be this many times the running average
SNARE_SPIKE_THRESHOLD = 2.0  # snare energy must be this many times the running average
KICK_ENERGY_MIN = 300.0      # absolute kick band energy floor
SNARE_ENERGY_MIN = 600.0     # absolute snare band energy floor

# Noise gate calibration
NOISE_GATE_CALIBRATION_FRAMES = 80
NOISE_GATE_HEADROOM = 5.0


class MinimalDetector:
    def __init__(self):
        self.audio_buffer = np.zeros(FFT_SIZE, dtype=np.float32)
        self.window = np.hanning(FFT_SIZE).astype(np.float32)

        # Running averages for spike detection
        self.kick_energy_history = []
        self.kick_energy_avg = 0.0
        self.snare_energy_history = []
        self.snare_energy_avg = 0.0

        # Cooldown: fastest retrigger = 16th note at 80bpm = ~187ms
        # Use 150ms to be safe at faster tempos
        self.cooldown_s = 0.15
        self.last_kick_time = 0.0
        self.last_snare_time = 0.0

        # Noise gate
        self.frame_count = 0
        self.cal_kick = []
        self.cal_snare = []
        self.kick_gate = 0.0
        self.snare_gate = 0.0
        self.calibrated = False

        self.running = False

    def _process_block(self, mono_block):
        now = time.monotonic()

        # Accumulate into FFT buffer
        n = len(mono_block)
        self.audio_buffer = np.roll(self.audio_buffer, -n)
        self.audio_buffer[-n:] = mono_block

        # FFT
        spectrum = np.abs(np.fft.rfft(self.audio_buffer * self.window, n=FFT_SIZE))

        kick_band = spectrum[KICK_BIN_LOW:KICK_BIN_HIGH + 1]
        snare_band = spectrum[SNARE_BIN_LOW:SNARE_BIN_HIGH + 1]
        kick_energy = np.sum(kick_band)
        snare_energy = np.sum(snare_band)

        # Calibration phase
        self.frame_count += 1
        if not self.calibrated:
            self.cal_kick.append(kick_energy)
            self.cal_snare.append(snare_energy)
            if self.frame_count >= NOISE_GATE_CALIBRATION_FRAMES:
                self.kick_gate = np.mean(self.cal_kick) * NOISE_GATE_HEADROOM
                self.snare_gate = np.mean(self.cal_snare) * NOISE_GATE_HEADROOM
                self.calibrated = True
                print(f"  Noise gate: kick>{self.kick_gate:.2f}  snare>{self.snare_gate:.2f}\n")
            return

        # ── Kick: energy spike over running average ──
        self.kick_energy_history.append(kick_energy)
        if len(self.kick_energy_history) > 128:
            self.kick_energy_history = self.kick_energy_history[-128:]
        if len(self.kick_energy_history) >= 8:
            self.kick_energy_avg = np.mean(self.kick_energy_history)
        kick_spike = kick_energy / max(self.kick_energy_avg, 1e-6)

        # ── Snare: energy spike over running average ──
        self.snare_energy_history.append(snare_energy)
        if len(self.snare_energy_history) > 128:
            self.snare_energy_history = self.snare_energy_history[-128:]
        if len(self.snare_energy_history) >= 8:
            self.snare_energy_avg = np.mean(self.snare_energy_history)
        snare_spike = snare_energy / max(self.snare_energy_avg, 1e-6)

        if kick_spike > KICK_SPIKE_THRESHOLD and kick_energy > KICK_ENERGY_MIN and (now - self.last_kick_time) > self.cooldown_s:
            self.last_kick_time = now
            print(f"  KICK   k_spike={kick_spike:.2f}  k_e={kick_energy:.1f}  s_e={snare_energy:.1f}")

        if snare_spike > SNARE_SPIKE_THRESHOLD and snare_energy > SNARE_ENERGY_MIN and (now - self.last_snare_time) > self.cooldown_s:
            self.last_snare_time = now
            print(f"  SNARE  s_e={snare_energy:.1f}  s_spike={snare_spike:.2f}  k_e={kick_energy:.1f}")

    def _audio_callback(self, indata, frames, time_info, status):
        mono = indata[:, 0] if indata.ndim > 1 else indata.flatten()
        self._process_block(mono)

    def run_mic(self, device=None):
        self.running = True
        print("Listening via mic... (Ctrl+C to stop)")
        print(f"  Calibrating noise gate (~1s of silence)...\n")
        try:
            with sd.InputStream(
                device=device,
                samplerate=SAMPLE_RATE,
                blocksize=BLOCK_SIZE,
                channels=1,
                dtype='float32',
                callback=self._audio_callback
            ):
                while self.running:
                    time.sleep(0.1)
        except KeyboardInterrupt:
            print("\nStopped.")

    def run_file(self, filepath, device=None):
        if sf is None:
            print("ERROR: pip install soundfile")
            return

        self.running = True
        file_data, file_sr = sf.read(filepath, dtype='float32')
        if file_data.ndim == 1:
            file_data = file_data.reshape(-1, 1)

        mono = np.mean(file_data, axis=1)
        if file_sr != SAMPLE_RATE:
            target_len = int(len(mono) * SAMPLE_RATE / file_sr)
            mono = np.interp(
                np.linspace(0, len(mono) - 1, target_len),
                np.arange(len(mono)), mono
            ).astype(np.float32)
            # Resample playback data too
            playback = np.zeros(
                (target_len, file_data.shape[1]), dtype=np.float32
            )
            for ch in range(file_data.shape[1]):
                playback[:, ch] = np.interp(
                    np.linspace(0, len(file_data) - 1, target_len),
                    np.arange(len(file_data)), file_data[:, ch]
                )
        else:
            playback = file_data

        print(f"Playing: {filepath} ({len(mono)/SAMPLE_RATE:.1f}s)")
        print(f"  Calibrating noise gate (~1s)...\n")

        # Playback state
        play_pos = [0]
        play_ch = playback.shape[1]

        def playback_cb(outdata, frames, time_info, status):
            pos = play_pos[0]
            end = pos + frames
            if end <= len(playback):
                outdata[:] = playback[pos:end]
            else:
                valid = max(0, len(playback) - pos)
                if valid > 0:
                    outdata[:valid] = playback[pos:pos + valid]
                outdata[valid:] = 0
            play_pos[0] = end

        try:
            stream = sd.OutputStream(
                device=device,
                samplerate=SAMPLE_RATE,
                blocksize=BLOCK_SIZE,
                channels=play_ch,
                dtype='float32',
                callback=playback_cb
            )
            stream.start()

            pos = 0
            block_dur = BLOCK_SIZE / SAMPLE_RATE
            while self.running and pos < len(mono):
                end = min(pos + BLOCK_SIZE, len(mono))
                block = mono[pos:end]
                if len(block) < BLOCK_SIZE:
                    block = np.pad(block, (0, BLOCK_SIZE - len(block)))
                self._process_block(block)
                pos = end
                time.sleep(block_dur)

            # Drain
            remaining = max(0, (len(playback) - play_pos[0]) / SAMPLE_RATE)
            time.sleep(remaining + 0.1)
            stream.stop()
            stream.close()
            print("\nDone.")

        except KeyboardInterrupt:
            print("\nStopped.")
            try:
                stream.stop()
                stream.close()
            except:
                pass


def main():
    parser = argparse.ArgumentParser(description="Minimal beat detector — detection only")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--mic', action='store_true', help='Listen via microphone')
    source.add_argument('--file', type=str, metavar='PATH', help='Play and detect from audio file')
    source.add_argument('--list-devices', action='store_true', help='List audio devices')
    parser.add_argument('--device', type=int, metavar='N', help='Audio device index')

    args = parser.parse_args()

    if args.list_devices:
        for i, dev in enumerate(sd.query_devices()):
            dirs = []
            if dev['max_input_channels'] > 0: dirs.append(f"{dev['max_input_channels']}in")
            if dev['max_output_channels'] > 0: dirs.append(f"{dev['max_output_channels']}out")
            print(f"  [{i}] {dev['name']}  ({', '.join(dirs)})")
        return

    d = MinimalDetector()
    if args.file:
        d.run_file(args.file, device=args.device)
    else:
        d.run_mic(device=args.device)


if __name__ == '__main__':
    main()
