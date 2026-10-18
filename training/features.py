"""Audio -> cached log-mel feature frames for the training pipeline.

Features are derived data: everything here can be rebuilt from the audio file,
so it is cached in an .npz sidecar beside the audio rather than as a blob in
the database. That keeps the database to hand-made labels only (small, easy to
back up, cheap to copy), lets numpy mmap the features at fit time, and makes
invalidation a matter of deleting a file. The sidecar records the audio's
sha256 and a hash of the extraction parameters, so a changed file or a changed
FEATURE_SPEC rebuilds automatically instead of silently mixing representations.

Representation follows the reasoning in the design discussion: log-spaced mel
bands rather than adapter/audio_info.py's linear FFT bins, because the axes
being labelled (intensity, brightness, valence) track log frequency.

Levels are in dBFS on adapter/audio_info.py's convention: the windowed rfft is
scaled by 2/sum(window), so a single *bin* reads ~0 dB for a full-scale sine.
A mel band sums several bins, so a full-scale tone actually reads 0 to +5 dB in
its band depending on how many bins that band spans (2 at the bottom, 27 at the
top). That tilt is a fixed per-band offset, it is what every standard log-mel
implementation does, and any downstream normalization absorbs it. What matters
is that the bin scaling is identical to audio_info.py's, so the live adapter
can be made to emit these exact features later.

Alongside the mel bands sit four cheap scalars. Music embeddings are usually
trained with gain augmentation and deliberately discard absolute level, which
is exactly what an intensity axis needs most; these carry it explicitly.

No resampling: the mel filterbank is built for the file's own samplerate and
capped at F_MAX, which makes the band centres comparable across samplerates
without needing a resampler (and hence without scipy).
"""

import hashlib
import json
import os

import numpy as np

try:
    import soundfile as sf
except ImportError as e:  # pragma: no cover - install-time guidance
    raise SystemExit(
        'features.py needs the soundfile package to read audio:\n'
        '    adapter/.venv/bin/python -m pip install soundfile\n'
        f'({e})')

# Analysis window, in samples. 2048 is ~46 ms at 44.1 kHz and ~43 ms at 48 kHz
# -- long enough to resolve the low mids, short enough that a frame is still
# one "moment" musically. Fixed rather than derived from samplerate so the
# window's frequency resolution is identical across files.
N_FFT = 2048

# Frames per second of features (and therefore of labels). The axes being
# labelled move on timescales of seconds, so 20 Hz is far finer than needed for
# the signal itself; it is chosen to be fine enough that a human's fader
# movements are not quantized visibly, while keeping a 6-minute track to ~7200
# frames. The realised rate is samplerate/hop, which is exact at 20 Hz for
# every common samplerate (44.1k -> 2205, 48k -> 2400).
TARGET_FRAME_RATE_HZ = 20.0

# Mel band count and range. 64 bands is the usual music-tagging resolution; 30
# Hz drops the DC/rumble region that carries no musical information, and 8 kHz
# matches adapter/audio_info.py's SPECTRUM_MAX_HZ so the live path can produce
# identical features (above 8 kHz there is little but cymbal wash anyway).
N_MELS = 64
F_MIN_HZ = 30.0
F_MAX_HZ = 8000.0

# Level floor in dBFS, mirroring audio_info.py's DB_FLOOR: silence and anything
# below clamps here rather than going to -inf and poisoning a model's input.
DB_FLOOR = -120.0

# Frames processed per chunk during extraction. Bounds peak memory (a chunk
# materializes n x N_FFT float32) so a long file does not need hundreds of MB.
CHUNK_FRAMES = 512

# Names of the per-frame scalars stored alongside the mel bands, in the order
# they occupy columns of the 'scalars' array. Documented here because the fit
# side indexes them by position.
SCALAR_NAMES = ('rms_db', 'centroid_hz', 'flatness', 'flux')


def feature_spec(samplerate):
    """The extraction parameters that a cache entry must match to be reusable."""
    hop = hop_length(samplerate)
    return {
        'version': 1,
        'n_fft': N_FFT,
        'hop': hop,
        'n_mels': N_MELS,
        'f_min_hz': F_MIN_HZ,
        'f_max_hz': F_MAX_HZ,
        'db_floor': DB_FLOOR,
        'samplerate': samplerate,
        'scalars': list(SCALAR_NAMES),
    }


def spec_hash(samplerate):
    blob = json.dumps(feature_spec(samplerate), sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def hop_length(samplerate):
    """Samples between successive frames. Rounded to an integer, so the true
    frame rate is samplerate/hop -- see frame_rate_hz()."""
    return max(1, int(round(samplerate / TARGET_FRAME_RATE_HZ)))


def frame_rate_hz(samplerate):
    """Realised frames per second, which is what labels are keyed on."""
    return samplerate / hop_length(samplerate)


def hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def mel_to_hz(m):
    return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(samplerate, n_fft=N_FFT, n_mels=N_MELS,
                   f_min=F_MIN_HZ, f_max=F_MAX_HZ):
    """(n_mels, n_fft//2+1) matrix of triangular filters, evenly spaced on the
    mel scale between f_min and f_max. Triangles peak at 1.0 (HTK style, no
    area normalization) so a band's value stays interpretable as the amplitude
    around its centre frequency rather than a density."""
    f_max = min(f_max, samplerate / 2.0)
    bin_hz = np.fft.rfftfreq(n_fft, 1.0 / samplerate)
    edges = mel_to_hz(np.linspace(hz_to_mel(f_min), hz_to_mel(f_max), n_mels + 2))
    fb = np.zeros((n_mels, bin_hz.size), dtype=np.float32)
    for i in range(n_mels):
        lo, mid, hi = edges[i], edges[i + 1], edges[i + 2]
        rising = (bin_hz - lo) / max(mid - lo, 1e-9)
        falling = (hi - bin_hz) / max(hi - mid, 1e-9)
        fb[i] = np.clip(np.minimum(rising, falling), 0.0, None)
    return fb


def amp_to_db(amp):
    """Linear amplitude -> dBFS, floored at DB_FLOOR. Mirrors
    adapter/audio_info.py's amp_to_db so offline and live features agree."""
    floor = 10.0 ** (DB_FLOOR / 20.0)
    return 20.0 * np.log10(np.maximum(amp, floor))


def load_audio(path):
    """Read an audio file. Returns (playback, mono, samplerate) where playback
    keeps the file's channel layout (2-D, n x channels) for listening and mono
    is the channel mean used for analysis, both float32 in [-1, 1]."""
    data, samplerate = sf.read(path, dtype='float32', always_2d=True)
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    return data, np.ascontiguousarray(mono), int(samplerate)


def extract(mono, samplerate):
    """Compute per-frame features for a mono float32 signal.

    Returns a dict with 'logmel' (n_frames, N_MELS) in dBFS and 'scalars'
    (n_frames, len(SCALAR_NAMES)), both float32.
    """
    hop = hop_length(samplerate)
    n_frames = max(1, int(np.ceil(max(0, mono.size - N_FFT) / hop)) + 1)

    # Zero-pad the tail so the final frame is whole; a partial frame would
    # otherwise be either dropped (losing the end of the track) or windowed
    # against garbage.
    needed = (n_frames - 1) * hop + N_FFT
    if mono.size < needed:
        mono = np.pad(mono, (0, needed - mono.size))

    window = np.hanning(N_FFT).astype(np.float32)
    # Same normalization as audio_info.py's _spectrum: Hann coherent gain is
    # sum(window)/2, so this makes a full-scale sine read ~1.0 in its bin.
    norm = 2.0 / window.sum()
    fb = mel_filterbank(samplerate, n_fft=N_FFT)
    bin_hz = np.fft.rfftfreq(N_FFT, 1.0 / samplerate).astype(np.float32)

    frames = np.lib.stride_tricks.sliding_window_view(mono, N_FFT)[::hop]
    logmel = np.empty((n_frames, N_MELS), dtype=np.float32)
    scalars = np.empty((n_frames, len(SCALAR_NAMES)), dtype=np.float32)

    prev_tail = None  # last magnitude row of the previous chunk, for flux
    for start in range(0, n_frames, CHUNK_FRAMES):
        stop = min(start + CHUNK_FRAMES, n_frames)
        block = frames[start:stop]
        mag = np.abs(np.fft.rfft(block * window, axis=1)).astype(np.float32) * norm

        logmel[start:stop] = amp_to_db(mag @ fb.T)

        # rms from the unwindowed samples: a plain level, not affected by the
        # analysis window's taper.
        rms = np.sqrt(np.mean(block.astype(np.float32) ** 2, axis=1))

        total = mag.sum(axis=1)
        safe = np.maximum(total, 1e-12)
        centroid = (mag @ bin_hz) / safe

        # Spectral flatness on power: geometric/arithmetic mean, ~1 for noise
        # and ~0 for a pure tone. Computed in the log domain to avoid the
        # underflow a direct product of 1025 small numbers would hit.
        power = np.maximum(mag ** 2, 1e-20)
        flatness = np.exp(np.mean(np.log(power), axis=1)) / np.maximum(
            np.mean(power, axis=1), 1e-20)

        # Positive spectral flux -- onset/percussive energy. Each frame is
        # compared against its predecessor, which for the first frame of a
        # chunk is the last frame of the previous one (prev_tail), so flux does
        # not read a spurious onset at every chunk boundary. The very first
        # frame of the file has no predecessor and is compared against itself,
        # giving 0.
        prev = mag[:1] if prev_tail is None else prev_tail
        ref = np.vstack((prev, mag[:-1]))
        diff = np.clip(mag - ref, 0.0, None).sum(axis=1)
        prev_tail = mag[-1:]

        scalars[start:stop, 0] = amp_to_db(rms)
        scalars[start:stop, 1] = centroid
        scalars[start:stop, 2] = flatness
        scalars[start:stop, 3] = diff

    return {'logmel': logmel, 'scalars': scalars}


def cache_path(audio_path):
    """Sidecar path for an audio file: alongside it, same stem."""
    stem, _ = os.path.splitext(os.path.abspath(audio_path))
    return stem + '.features.npz'


def load_or_build(audio_path, audio_sha256, rebuild=False, log=print):
    """Return (features_dict, playback, samplerate) for audio_path, building and
    caching the features when the sidecar is missing or stale.

    features_dict carries 'logmel', 'scalars', 'frame_rate_hz' and 'n_frames'.
    The audio is decoded either way, because the caller needs it for playback.
    """
    playback, mono, samplerate = load_audio(audio_path)
    path = cache_path(audio_path)
    want_spec = spec_hash(samplerate)

    if not rebuild and os.path.exists(path):
        with np.load(path, allow_pickle=False) as z:
            if (str(z['spec_hash']) == want_spec
                    and str(z['audio_sha256']) == audio_sha256):
                return ({'logmel': z['logmel'],
                         'scalars': z['scalars'],
                         'frame_rate_hz': float(z['frame_rate_hz']),
                         'n_frames': int(z['logmel'].shape[0])},
                        playback, samplerate)
        log(f'feature cache for {os.path.basename(audio_path)} is stale; rebuilding')

    log(f'extracting features from {os.path.basename(audio_path)} ...')
    feats = extract(mono, samplerate)
    rate = frame_rate_hz(samplerate)
    np.savez_compressed(
        path,
        logmel=feats['logmel'], scalars=feats['scalars'],
        frame_rate_hz=np.float64(rate),
        spec_hash=np.str_(want_spec), audio_sha256=np.str_(audio_sha256),
        spec_json=np.str_(json.dumps(feature_spec(samplerate), sort_keys=True)))
    log(f'cached {feats["logmel"].shape[0]} frames -> {os.path.basename(path)}')

    feats['frame_rate_hz'] = rate
    feats['n_frames'] = feats['logmel'].shape[0]
    return feats, playback, samplerate
