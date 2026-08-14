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

BeatDetector (adapter.py's -i/--infer-beat) reuses that same spectrum: it
integrates power over the BEAT_BANDS frequency ranges and fires a beat on the
channel a band is mapped to when its energy jumps above a per-band ratio of its
own moving average.
"""

from dataclasses import dataclass
import math
import threading
import time

import numpy as np
import sounddevice as sd

# FFT window length, in samples. The spectrum is computed over the most recent
# this-many samples, so the window (and thus the latency it adds, plus the bin
# count = FFT_SIZE//2 + 1 and hence payload/CPU) scales with it. 512 @ 48 kHz ->
# 257 bins ~94 Hz apart over an ~11 ms window; higher sample rates shrink the
# window further. Tuned for low latency over frequency resolution: raise it for
# finer/lower-frequency bins at the cost of latency, payload, and per-message CPU.
FFT_SIZE = 4096

# Only bins up to this frequency are sent; the rest are discarded before the
# message is built. The visuals only care about the low end, and dropping the
# top saves the bulk of the per-message cost (json serialization of the bin
# list dominates, well above the rfft itself) plus the wire payload and the
# frontend's per-frame vertex updates. At 48 kHz this keeps 683 of 2049 bins,
# at 96 kHz 342 of 2049. Frequency resolution and latency are unaffected --
# those are set by FFT_SIZE.
SPECTRUM_MAX_HZ = 8000

# How fast each band's reference level (the moving average its threshold is
# measured against) follows the music, as a time constant in seconds. Long
# enough that individual hits don't pull the reference up with them, short
# enough to track a build or a level change. Applied per update via exp(-dt/tau).
BEAT_AVG_TAU_S = 1.5

# Amplitudes are converted to dBFS before being sent: 0 dB is full scale, and
# the conversion happens here rather than in the frontend so the wire values are
# quantized in the domain they're displayed in. Rounding linear amplitudes would
# spend most of its resolution on loud bins and leave only a few levels for
# quiet ones (a 1e-4 step is 13 bits at -20 dB but 3 bits at -62 dB); 0.1 dB
# steps are uniform across the whole range instead. DB_FLOOR is what silence and
# anything below it clamp to -- well under any display floor.
DB_FLOOR = -120.0
DB_DECIMALS = 1

# Time constant of the smoothed spectrum sent alongside the instantaneous one,
# in seconds. The average accumulates on linear amplitudes (before the dB
# conversion, so it isn't biased by log-domain averaging) and settles the
# low-level bins onto the true noise floor. Applied per frame via exp(-dt/tau).
SPECTRUM_SMOOTH_TAU_S = 0.15


@dataclass
class BeatBand:
    """One inferred-beat trigger: a frequency range whose energy fires MsgBeat on
    `channel` when it jumps. Tune `threshold` (and `min_energy`) per band to get
    them firing correctly -- that's what these are here for."""
    name: str            # shown in the -i console log, for tuning
    channel: int         # MsgBeat channel; see the frontend's handle_beat()
    f_lo_hz: float       # band edges, inclusive
    f_hi_hz: float
    threshold: float     # fire when energy > threshold * its moving average
    refractory_s: float  # ignore retriggers for this long after a hit
    min_energy: float    # absolute gate: never fire below this, so a quiet room
                         # (where the average is ~0) can't trigger on noise


# The inferred-beat bands. Channels follow the convention the scenes already
# expect (see any scene's handle_beat, and fake_beat above in adapter.py):
# 1 = kick, 4 = snare/clap, 9 = hats. Edit freely -- ranges, channels and
# thresholds are all per-band and take effect on the next run.
BEAT_BANDS = [
    BeatBand('kick',  1,   30,  150, 1.8, 0.12, 1e-5),
    BeatBand('snare', 4,  200,  800, 2.0, 0.12, 1e-5),
    BeatBand('hat',   9, 4000, 8000, 1.5, 0.06, 1e-6),
]


def amp_to_db(amp):
    """Linear amplitude (scalar or array) -> dBFS, floored at DB_FLOOR and
    rounded to DB_DECIMALS. Arrays come back as a list, ready to serialize."""
    floor_amp = 10.0 ** (DB_FLOOR / 20.0)
    db = 20.0 * np.log10(np.maximum(amp, floor_amp))
    if np.isscalar(amp) or np.ndim(amp) == 0:
        return round(float(db), DB_DECIMALS)
    # float64 before rounding: rounding a float32 array leaves values like
    # -85.19999694824219, which json then serializes in full (3x the payload).
    return db.astype(np.float64).round(DB_DECIMALS).tolist()


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

    def __init__(self, samplerate):
        self._lock = threading.Lock()

        # Number of leading rfft bins kept (those at or below SPECTRUM_MAX_HZ);
        # bin k sits at k * samplerate / FFT_SIZE Hz.
        self.n_bins = min(FFT_SIZE // 2 + 1,
                          int(SPECTRUM_MAX_HZ * FFT_SIZE / samplerate) + 1)

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

        # Running per-bin average of the spectrum, in linear amplitude (see
        # SPECTRUM_SMOOTH_TAU_S). Seeded by the first frame so it doesn't have
        # to ramp up from silence.
        self._smooth = np.zeros(self.n_bins, dtype=np.float64)
        self._smooth_primed = False
        self._last_snapshot = None

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

    def take_snapshot(self, now=None):
        """Return (avg, peak, spectrum, smoothed) for the interval since the
        previous call and reset the interval accumulators. All four are in
        linear amplitude -- that's the internal currency, so the beat detector
        sees true power; callers convert to dBFS with amp_to_db() when building
        the message. spectrum/smoothed are float arrays of one magnitude per
        rfft bin up to SPECTRUM_MAX_HZ. The FFT runs here, off the audio
        thread."""
        with self._lock:
            avg = self._sum_abs / self._count if self._count else 0.0
            peak = self._peak
            self._sum_abs = 0.0
            self._count = 0
            self._peak = 0.0
            # Copy the ring buffer out in time order (oldest -> newest) so the
            # window function lines up with the samples.
            ordered = np.concatenate((self._buf[self._write:], self._buf[:self._write]))

        spectrum = self._spectrum(ordered)

        # Smooth on linear amplitudes, before the dB conversion, so the average
        # isn't biased by the log and isn't averaging already-quantized values.
        if now is None:
            now = time.monotonic()
        dt = 0.0 if self._last_snapshot is None else now - self._last_snapshot
        self._last_snapshot = now
        if not self._smooth_primed:
            self._smooth[:] = spectrum
            self._smooth_primed = True
        else:
            alpha = math.exp(-dt / SPECTRUM_SMOOTH_TAU_S) if dt > 0 else 0.0
            self._smooth *= alpha
            self._smooth += (1 - alpha) * spectrum
        return avg, peak, spectrum, self._smooth

    def _spectrum(self, samples):
        """Amplitude-normalized magnitude of the windowed rfft, one value per bin
        up to SPECTRUM_MAX_HZ. Bin k is the linearly-spaced frequency
        k * samplerate / FFT_SIZE; the 2/sum(window) scaling means a full-scale
        sine reads ~1.0 in its bin (Hann coherent gain = sum/2)."""
        mag = np.abs(np.fft.rfft(samples * self._window)) * (2.0 / self._window.sum())
        return mag[:self.n_bins]


class BeatDetector:
    """Fires beats when a BEAT_BANDS range's energy jumps above a ratio of its
    own moving average -- a spectral-flux onset detector, one per band.

    Each band keeps its own reference level, so a loud kick doesn't desensitize
    the hat band and vice versa. Runs on the broadcast loop's thread off the
    already-computed spectrum, so it costs one slice-and-sum per band and adds
    nothing to the audio thread.
    """

    def __init__(self, samplerate, n_bins, bands=BEAT_BANDS):
        self.bands = bands
        bin_hz = samplerate / FFT_SIZE
        # Precompute each band's bin slice, clamped to the bins we actually have
        # (the spectrum stops at SPECTRUM_MAX_HZ).
        self._slices = []
        for band in bands:
            lo = min(n_bins, max(0, math.ceil(band.f_lo_hz / bin_hz)))
            hi = min(n_bins, math.floor(band.f_hi_hz / bin_hz) + 1)
            self._slices.append((lo, max(lo + 1, hi)))
        self._avg = [0.0] * len(bands)
        self._last_beat = [float('-inf')] * len(bands)
        self._last_update = None

    def band_ranges(self):
        """(name, channel, first_bin, last_bin) per band, for the startup log."""
        return [(b.name, b.channel, lo, hi - 1)
                for b, (lo, hi) in zip(self.bands, self._slices)]

    def update(self, spectrum, now):
        """Fold one spectrum frame in. Returns a list of (band, energy, ratio)
        for the bands that fired this frame (usually empty)."""
        dt = 0.0 if self._last_update is None else now - self._last_update
        self._last_update = now
        # Reference level follows the music slowly; alpha derived from the actual
        # frame interval so the time constant holds at any AUDIO_INFO_HZ.
        alpha = math.exp(-dt / BEAT_AVG_TAU_S) if dt > 0 else 0.0

        fired = []
        for i, band in enumerate(self.bands):
            lo, hi = self._slices[i]
            # Power integrated over the band (magnitudes are amplitudes).
            energy = float(np.dot(spectrum[lo:hi], spectrum[lo:hi]))
            avg = self._avg[i]
            ratio = energy / avg if avg > 0 else 0.0

            if (energy >= band.min_energy and avg > 0
                    and ratio >= band.threshold
                    and now - self._last_beat[i] >= band.refractory_s):
                self._last_beat[i] = now
                fired.append((band, energy, ratio))

            self._avg[i] = alpha * avg + (1 - alpha) * energy
        return fired
