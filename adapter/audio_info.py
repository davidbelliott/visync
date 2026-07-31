"""Realtime audio-input analysis for adapter.py's MsgAudioInfo broadcasts.

Kept in its own module (like beatdetect.py) so numpy/sounddevice stay optional:
only adapter.py's -a/--audio path imports this, leaving the fake/MIDI modes
importable on machines without an audio stack.

An AudioAnalyzer is fed raw input blocks from the sounddevice callback thread
and, on demand from the asyncio broadcast loop, returns the interval's
average/peak amplitude plus the raw FFT magnitude spectrum (one value per rfft
bin, no re-binning). The callback does only cheap work (abs-accumulate + a
ring-buffer copy); the FFT runs in take_snapshot() on the caller's thread, so
the realtime audio thread never stalls on it.
"""

import threading

import numpy as np
import sounddevice as sd

# FFT window length, in samples. The spectrum is always computed over the most
# recent this-many samples, so frequency resolution is fixed regardless of the
# broadcast rate. 2048 @ 48 kHz -> 1025 linearly-spaced bins ~23 Hz apart over a
# ~43 ms window; one rfft of this size at 60 Hz is negligible CPU. Raise it for
# finer resolution (more bins, longer window) at the cost of payload/latency.
FFT_SIZE = 2048


class AudioDeviceError(Exception):
    """No single input device matched the requested name pattern."""


def resolve_audio_device(pattern):
    """Return (index, name) of the one input device whose name contains
    `pattern` (case-insensitive substring). Raises AudioDeviceError, listing the
    candidates, when zero or more than one input device matches."""
    needle = pattern.lower()
    matches = [(i, dev['name'])
               for i, dev in enumerate(sd.query_devices())
               if dev['max_input_channels'] > 0 and needle in dev['name'].lower()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise AudioDeviceError(f"no audio input device matches '{pattern}'")
    listing = '\n'.join(f"  [{i}] {name}" for i, name in matches)
    raise AudioDeviceError(
        f"'{pattern}' matches {len(matches)} input devices; be more specific:\n"
        f"{listing}")


class AudioAnalyzer:
    """Accumulates input blocks and turns them into (avg, peak, spectrum).

    Thread model: callback() runs on the sounddevice/PortAudio thread and only
    touches state under `_lock`; take_snapshot() runs on the broadcast thread,
    grabs+resets that state under the same lock, then does the FFT lock-free.
    """

    def __init__(self):
        self._lock = threading.Lock()

        # Ring buffer of the most recent FFT_SIZE mono samples, plus the write
        # cursor. Read back in time order in take_snapshot().
        self._buf = np.zeros(FFT_SIZE, dtype=np.float32)
        self._write = 0

        # Interval accumulators (reset each take_snapshot): running sum of
        # |sample| and sample count give the average; _peak the maximum.
        self._sum_abs = 0.0
        self._count = 0
        self._peak = 0.0

        self._window = np.hanning(FFT_SIZE).astype(np.float32)

    def callback(self, indata, frames, time_info, status):
        """sounddevice InputStream callback (audio thread). Keep this cheap."""
        mono = indata[:, 0] if indata.ndim > 1 else indata.ravel()
        a = np.abs(mono)
        n = mono.size
        with self._lock:
            self._sum_abs += float(a.sum())
            self._count += n
            if n:
                self._peak = max(self._peak, float(a.max()))
            self._ring_write(mono)

    def _ring_write(self, mono):
        """Copy `mono` into the ring buffer, wrapping at FFT_SIZE. Caller holds
        the lock."""
        n = mono.size
        if n >= FFT_SIZE:
            self._buf[:] = mono[-FFT_SIZE:]
            self._write = 0
            return
        end = self._write + n
        if end <= FFT_SIZE:
            self._buf[self._write:end] = mono
        else:
            first = FFT_SIZE - self._write
            self._buf[self._write:] = mono[:first]
            self._buf[:n - first] = mono[first:]
        self._write = end % FFT_SIZE

    def take_snapshot(self):
        """Return (avg, peak, spectrum) for the interval since the previous call
        and reset the interval accumulators. spectrum is one magnitude per rfft
        bin (FFT_SIZE//2 + 1 floats). The FFT runs here, off the audio thread."""
        with self._lock:
            avg = self._sum_abs / self._count if self._count else 0.0
            peak = self._peak
            self._sum_abs = 0.0
            self._count = 0
            self._peak = 0.0
            # Copy the ring buffer out in time order (oldest -> newest) so the
            # window function lines up with the samples.
            ordered = np.concatenate((self._buf[self._write:], self._buf[:self._write]))
        return round(avg, 5), round(peak, 5), self._spectrum(ordered)

    def _spectrum(self, samples):
        """Amplitude-normalized magnitude of the windowed rfft, one value per bin
        (FFT_SIZE//2 + 1 of them), sent raw. Bin k is the linearly-spaced
        frequency k * samplerate / FFT_SIZE; the 2/sum(window) scaling means a
        full-scale sine reads ~1.0 in its bin (Hann coherent gain = sum/2)."""
        mag = np.abs(np.fft.rfft(samples * self._window)) * (2.0 / self._window.sum())
        return mag.round(4).tolist()
