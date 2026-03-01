#!/usr/bin/env python3
"""
Minimal beat detector: onset detection only.
Detects kicks (low-frequency percussive) and snares/claps (high-frequency percussive).
No prediction, no pattern matching, no debouncing.
"""

import argparse
import math
import numpy as np
import sounddevice as sd
import threading
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
BLOCK_SIZE = 256
FFT_SIZE = 2048

# Frequency bands
KICK_LOW_HZ = 30
KICK_HIGH_HZ = 100
SNARE_LOW_HZ = 600
SNARE_HIGH_HZ = 4000

# Derived bin indices
FREQ_PER_BIN = SAMPLE_RATE / FFT_SIZE
KICK_BIN_LOW = int(KICK_LOW_HZ / FREQ_PER_BIN)
KICK_BIN_HIGH = int(KICK_HIGH_HZ / FREQ_PER_BIN)
SNARE_BIN_LOW = int(SNARE_LOW_HZ / FREQ_PER_BIN)
SNARE_BIN_HIGH = int(SNARE_HIGH_HZ / FREQ_PER_BIN)

# Fixed onset thresholds
KICK_SPIKE_THRESHOLD = 1.5   # kick energy must be this many times the running average
SNARE_SPIKE_THRESHOLD = 2.0  # snare energy must be this many times the running average
KICK_ENERGY_MIN = 400.0      # absolute kick band energy floor
SNARE_ENERGY_MIN = 600.0     # absolute snare band energy floor

# Noise gate calibration
NOISE_GATE_CALIBRATION_FRAMES = 80
NOISE_GATE_HEADROOM = 5.0


class MinimalDetector:
    def __init__(self, on_beat=None):
        self.on_beat = on_beat
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

    def _process_block(self, mono_block, timeinfo):
        now = timeinfo.inputBufferAdcTime

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

        # Estimated latency: beat onset is somewhere in the most recent block,
        # so latency is at most one block period.
        latency_s = BLOCK_SIZE / SAMPLE_RATE

        if kick_spike > KICK_SPIKE_THRESHOLD and kick_energy > KICK_ENERGY_MIN and (now - self.last_kick_time) > self.cooldown_s:
            self.last_kick_time = now
            print(f"  KICK   k_spike={kick_spike:.2f}  k_e={kick_energy:.1f}  s_e={snare_energy:.1f}")
            if self.on_beat: self.on_beat(1, latency_s)

        if snare_spike > SNARE_SPIKE_THRESHOLD and snare_energy > SNARE_ENERGY_MIN and (now - self.last_snare_time) > self.cooldown_s:
            self.last_snare_time = now
            print(f"  SNARE  s_e={snare_energy:.1f}  s_spike={snare_spike:.2f}  k_e={kick_energy:.1f}")
            if self.on_beat: self.on_beat(4, latency_s)

    def _audio_callback(self, indata, frames, time_info, status):
        mono = indata[:, 0] if indata.ndim > 1 else indata.flatten()
        self._process_block(mono, time_info)

    def run_mic(self, device=None):
        self.running = True
        print("Listening via mic... (Ctrl+C to stop)")
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
                    time.sleep(1.0)
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


class PredictiveBeatDetector:
    """
    Wraps MinimalDetector with GCD-based tempo estimation and sync generation.

    Beat messages (on_beat) are always sent reactively with positive latency,
    same as MinimalDetector.

    Once a stable tempo is detected from kick timing ('locked'):
      - on_sync(sync_rate_hz, sync_idx) fires at PPQN=24 rate (MIDI clock)
      - Sync continues at the last known BPM after unlock until a new lock

    Lock: achieved when GCD of recent kick IOIs produces a beat interval where
    ≥ LOCK_SCORE of IOIs land within GRID_TOL of a grid multiple.
    Unlock: when a sliding window of recent kicks shows < UNLOCK_SCORE on-grid.

    Callbacks are invoked from the sounddevice audio thread or a daemon
    scheduler thread; use call_soon_threadsafe when bridging to asyncio.
    """

    MIN_KICKS        = 8      # kicks needed before first lock attempt
    GRID_TOL_S       = 0.060  # ±60ms on-grid tolerance (covers FFT windowing jitter)
    LOCK_SCORE       = 0.70   # fraction of kicks on-grid required to lock
    UNLOCK_SCORE     = 0.50   # fraction of recent kicks on-grid to stay locked
    UNLOCK_WINDOW    = 8      # sliding window size for unlock check
    PPQN             = 24     # sync pulses per quarter note

    def __init__(self, on_beat=None, on_sync=None):
        self.on_beat = on_beat
        self.on_sync = on_sync

        self._detector = MinimalDetector(on_beat=self._on_raw_beat)
        self._mu = threading.Lock()

        self._kick_times = []    # rolling buffer of kick timestamps (monotonic)

        self.locked = False
        self._beat_s = None      # beat interval in seconds
        self._origin_s = None    # phase reference: a known beat boundary

        self._grid_window = []   # [bool] sliding on-grid results for recent kicks

        # Sync clock — persists across lock/unlock so the stream stays continuous
        self._sync_idx = 0
        self._next_sync_s = None
        self._sched_started = False

    # ── Public ────────────────────────────────────────────────────────────────

    def run_mic(self, device=None):
        self._detector.run_mic(device)

    # ── Audio thread callback ─────────────────────────────────────────────────

    def _on_raw_beat(self, channel, latency_s):
        # Always send every beat reactively, unchanged from MinimalDetector
        if self.on_beat:
            self.on_beat(channel, latency_s)

        if channel != 1:   # only kicks drive tempo estimation
            return

        now = time.monotonic()
        beat_time = now - latency_s
        do_unlock = False

        with self._mu:
            self._kick_times.append(beat_time)
            if len(self._kick_times) > 64:
                self._kick_times = self._kick_times[-64:]

            if self.locked:
                on_grid = self._on_grid(beat_time)
                self._grid_window.append(on_grid)
                if len(self._grid_window) > self.UNLOCK_WINDOW:
                    self._grid_window = self._grid_window[-self.UNLOCK_WINDOW:]
                if (len(self._grid_window) >= 4 and
                        sum(self._grid_window) / len(self._grid_window) < self.UNLOCK_SCORE):
                    do_unlock = True

            if len(self._kick_times) >= self.MIN_KICKS:
                result = self._estimate()
                if result is not None:
                    beat_s, origin_s, score = result
                    self._apply_lock(beat_s, origin_s, score)
                    do_unlock = False   # fresh lock cancels any pending unlock

        if do_unlock:
            with self._mu:
                if self.locked:
                    self.locked = False
                    self._grid_window = []
                    print(f"  [predict] Unlocked. "
                          f"Sync-only at {60/self._beat_s:.1f} BPM until new lock.")

    # ── Grid check ────────────────────────────────────────────────────────────

    def _on_grid(self, t):
        """True if t falls within GRID_TOL of a beat boundary."""
        phase = (t - self._origin_s) % self._beat_s
        return min(phase, self._beat_s - phase) < self.GRID_TOL_S

    # ── Tempo estimation ──────────────────────────────────────────────────────

    def _estimate(self):
        """
        Estimate beat interval using linear regression on kick timestamps.

        Why regression instead of GCD/median of IOIs:

        The Hanning FFT window peaks at the buffer's center (FFT_SIZE/2 samples
        in the past), so every kick is detected with a systematic delay of
        ~FFT_SIZE/2/SAMPLE_RATE ≈ 23ms.  Because the kick period is not an
        integer number of blocks, this delay drifts slightly each beat, producing
        alternating long/short IOIs (e.g. 474ms and 373ms at true 133 BPM =
        451ms).  GCD and median both see the wrong value.

        Regression treats kick timestamps as T(k) ≈ origin + k * beat_s.  The
        systematic detection delay is a constant offset that cancels in the slope,
        so the slope converges to the true beat period regardless of per-beat
        timing drift.

        Returns (beat_s, origin_s, score) or None.
        Called with _mu held.
        """
        times = np.array(self._kick_times, dtype=float)

        iois_ms = np.diff(times) * 1000.0

        # Use a rough median to assign beat indices (handles multi-beat gaps)
        valid = iois_ms[(iois_ms > 200.0) & (iois_ms < 3000.0)]
        if len(valid) < 2:
            return None
        rough_ms = float(np.median(valid))
        if not (250.0 <= rough_ms <= 2000.0):
            return None

        # Assign beat indices: round each IOI to nearest integer multiple of rough_ms
        # so sparse patterns (kick on 1 & 3 only) get indices 0, 2, 4, … not 0,1,2,…
        k = np.zeros(len(times))
        for i in range(1, len(times)):
            ioi = iois_ms[i - 1]
            if 200.0 < ioi < 3000.0:
                k[i] = k[i - 1] + max(1, round(ioi / rough_ms))
            else:
                k[i] = k[i - 1] + 1

        # Linear regression: T(k) = origin_s + k * beat_s
        # np.polyfit degree-1 returns [slope, intercept]
        beat_s, origin_s = np.polyfit(k, times, 1)
        beat_ms = beat_s * 1000.0

        if not (250.0 <= beat_ms <= 2000.0):
            return None

        # Subdivide if the detected period is slow — e.g. kicks on beats 1 & 3
        # give beat_ms ≈ 900ms; halving to 450ms is the actual quarter-note tempo.
        tol_s = self.GRID_TOL_S
        while beat_ms > 600.0:
            half_s = beat_ms / 2000.0
            if half_s < 0.250:
                break
            phases = (times - origin_s) % half_s
            phases = np.minimum(phases, half_s - phases)
            if np.mean(phases < tol_s) >= self.LOCK_SCORE:
                beat_ms = half_s * 1000.0
            else:
                break

        beat_s = beat_ms / 1000.0

        # Score: fraction of kicks within GRID_TOL of a beat boundary
        phases = (times - origin_s) % beat_s
        phases = np.minimum(phases, beat_s - phases)
        score = float(np.mean(phases < tol_s))
        if score < self.LOCK_SCORE:
            return None

        return beat_s, float(origin_s), score


    # ── Lock ──────────────────────────────────────────────────────────────────

    def _apply_lock(self, beat_s, origin_s, score):
        """Update lock state and re-align sync clock. Called with _mu held."""
        prev_locked = self.locked
        bpm_changed = (self._beat_s is None or
                       abs(beat_s - self._beat_s) / self._beat_s > 0.02)

        self._beat_s = beat_s
        self._origin_s = origin_s
        self.locked = True
        self._grid_window = []

        bpm = 60.0 / beat_s
        if not prev_locked:
            print(f"  [predict] Locked! {bpm:.1f} BPM  score={score:.0%}")
        elif bpm_changed:
            print(f"  [predict] BPM updated: {bpm:.1f}  score={score:.0%}")

        # Align sync clock to new grid: next PPQN tick at or after now
        now = time.monotonic()
        ppqn_s = beat_s / self.PPQN
        elapsed_ppqn = (now - origin_s) / ppqn_s
        next_idx = math.ceil(elapsed_ppqn)
        self._next_sync_s = origin_s + next_idx * ppqn_s
        self._sync_idx = next_idx

        if not self._sched_started:
            self._sched_started = True
            threading.Thread(target=self._sync_loop, daemon=True).start()

    # ── Sync scheduler ────────────────────────────────────────────────────────

    def _sync_loop(self):
        """Single daemon thread: send PPQN sync pulses whenever beat_s is set."""
        while True:
            now = time.monotonic()
            with self._mu:
                if self._beat_s and self._next_sync_s:
                    ppqn_s = self._beat_s / self.PPQN
                    while now >= self._next_sync_s:
                        if self.on_sync:
                            self.on_sync(1.0 / ppqn_s, self._sync_idx)
                        self._sync_idx += 1
                        self._next_sync_s += ppqn_s
                    next_wake = self._next_sync_s
                else:
                    next_wake = now + 0.005

            sleep_s = next_wake - time.monotonic()
            time.sleep(max(0.001, min(sleep_s, 0.005)))


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
