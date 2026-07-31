import * as THREE from 'three';
import { Scene } from './scene.js';

const NUM_DIALS = 16;
const COLS = 4;
const ROWS = NUM_DIALS / COLS;

// Grid layout in world units (orthographic, frustum_size 20 => y in [-10, 10]).
const COL_SPACING = 8;
const ROW_SPACING = 4.5;

const INNER_R = 1.2;
const OUTER_R = 1.7;
const SEGMENTS = 128;          // circle smoothness
const DIAL_COLOR = 0xffffff;
const HALF_PI = Math.PI / 2;

// Audio spectrum + amplitude readout (MsgAudioInfo), laid across the bottom of
// the frame. World units: orthographic frustum_size 20 => y in [-10, 10], and x
// roughly [-14, 14] over the dial grid. Amplitude 0..1 (0 = silence, 1 = the
// full-scale maximum a float32 device can capture) maps to baseline..full-scale
// height; the same vertical scale is shared by the amp bar and the spectrum
// line so their heights are directly comparable.
const AUDIO_BASELINE_Y = -9.5;      // world y of zero amplitude
const AUDIO_FULL_SCALE_H = 18.0;     // world height of amplitude 1.0
const AUDIO_Z = 0.1;                // sit in front of the dials

// Left-side amplitude bar: full-scale outline frame, average fill, peak tick.
const AMP_BAR_X = -13.5;
const AMP_BAR_W = 0.8;

// Spectrum polyline: the N bands span this x-range, left to right, low to high.
const SPECTRUM_X0 = -12.5;
const SPECTRUM_WIDTH = 26.0;

// Log-frequency x axis for the spectrum. The edges snap to the "nice" log ticks
// (1,2,...,9 x 10^k) just outside the data range: left = the tick at/below the
// lowest bin's frequency, right = the tick at/above Nyquist. Dim vertical marks
// sit at every such log tick (derived per-message from the samplerate).
const LOG_TICK_H = 0.5;             // world height of the log tick marks

const SPECTRUM_COLOR = 0xffffff;    // spectrum line
const AVG_COLOR = 0xffffff;         // average fill
const PEAK_COLOR = 0xffffff;        // peak tick
const AUDIO_REF_COLOR = 0x555555;   // dim baseline + full-scale frame + ticks

// Two-vertex line geometry between (x0, y0) and (x1, y1) in the xy plane.
function segment_geometry(x0, y0, x1, y1) {
    return new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x1, y1, 0),
    ]);
}

// Nearest "nice" log tick (m x 10^k, m in 1..9) at or below / at or above f.
function tick_below(f) {
    const base = Math.pow(10, Math.floor(Math.log10(f)));
    return Math.floor(f / base) * base;
}
function tick_above(f) {
    const base = Math.pow(10, Math.floor(Math.log10(f)));
    return Math.ceil(f / base - 1e-9) * base;   // m=10 -> 10^(k+1), still a tick
}

// Ascending list of log ticks (m x 10^k, m in 1..9) within [f_lo, f_hi].
function log_tick_freqs(f_lo, f_hi) {
    const ticks = [];
    for (let k = Math.floor(Math.log10(f_lo)); k <= Math.ceil(Math.log10(f_hi)); k++) {
        const base = Math.pow(10, k);
        for (let m = 1; m <= 9; m++) {
            const f = m * base;
            if (f >= f_lo - 1e-6 && f <= f_hi + 1e-6) {
                ticks.push(f);
            }
        }
    }
    return ticks;
}

// Outline circle as a 1px-wide line loop (WebGL lines are always single-pixel).
function circle_geometry(radius) {
    const pts = [];
    for (let i = 0; i < SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
}

// A round "filled dial": two concentric 1px circles with a RingGeometry sector
// fill that sweeps clockwise from the bottom (-90 deg).
class Dial {
    constructor() {
        this.group = new THREE.Group();

        const line_mat = new THREE.LineBasicMaterial({ color: DIAL_COLOR });
        this.group.add(new THREE.LineLoop(circle_geometry(INNER_R), line_mat));
        this.group.add(new THREE.LineLoop(circle_geometry(OUTER_R), line_mat));

        this.fill_material = new THREE.MeshBasicMaterial({
            color: DIAL_COLOR,
            side: THREE.DoubleSide,
        });
        this.fill = new THREE.Mesh(new THREE.BufferGeometry(), this.fill_material);
        this.fill.position.z = -0.02;   // sit just behind the outline circles
        this.group.add(this.fill);

        this.value = -1;
        this.set(0);
    }

    // value in [0, 1] -> fraction of the ring filled, clockwise from the bottom.
    set(value) {
        if (Math.abs(value - this.value) < 1e-4) {
            return;
        }
        this.value = value;
        const phi = value * Math.PI * 2;
        const segs = Math.max(1, Math.ceil(value * SEGMENTS));
        this.fill.geometry.dispose();
        // RingGeometry sweeps CCW from thetaStart; place the start phi clockwise
        // of the bottom so the trailing edge stays pinned at the bottom.
        this.fill.geometry = new THREE.RingGeometry(
            INNER_R, OUTER_R, segs, 1, -HALF_PI - phi, phi
        );
    }
}

// Live audio readout for MsgAudioInfo. Its group is anchored at the baseline so
// children work in local coords where y=0 is silence and y=AUDIO_FULL_SCALE_H is
// full scale. Left: an amplitude bar (dim full-scale frame, orange average fill,
// magenta peak tick). Right: a cyan 1px polyline through the spectrum bands.
class AudioDisplay {
    constructor() {
        this.group = new THREE.Group();
        this.group.position.set(0, AUDIO_BASELINE_Y, AUDIO_Z);

        const H = AUDIO_FULL_SCALE_H;
        const bx0 = AMP_BAR_X - AMP_BAR_W / 2;
        const bx1 = AMP_BAR_X + AMP_BAR_W / 2;
        const spec_x1 = SPECTRUM_X0 + SPECTRUM_WIDTH;

        const ref_mat = new THREE.LineBasicMaterial({ color: AUDIO_REF_COLOR });
        // Baseline spanning bar + spectrum, and a full-scale frame around the bar
        // so the amplitude=1 reference height is visible.
        this.group.add(new THREE.Line(segment_geometry(bx0, 0, spec_x1, 0), ref_mat));
        this.group.add(new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(bx0, 0, 0), new THREE.Vector3(bx1, 0, 0),
                new THREE.Vector3(bx1, H, 0), new THREE.Vector3(bx0, H, 0),
            ]), ref_mat));

        // Average fill: a unit-height plane anchored at its bottom edge (y=0),
        // scaled vertically to avg * H each update.
        const fill_geom = new THREE.PlaneGeometry(AMP_BAR_W, 1);
        fill_geom.translate(0, 0.5, 0);
        this.avg_fill = new THREE.Mesh(
            fill_geom, new THREE.MeshBasicMaterial({ color: AVG_COLOR }));
        this.avg_fill.position.set(AMP_BAR_X, 0, 0);
        this.avg_fill.scale.y = 1e-4;   // start effectively empty
        this.group.add(this.avg_fill);

        // Peak tick: a horizontal 1px line across the bar, raised to peak * H.
        this.peak_geom = segment_geometry(bx0, 0, bx1, 0);
        this.group.add(new THREE.Line(
            this.peak_geom, new THREE.LineBasicMaterial({ color: PEAK_COLOR })));

        this.ref_mat = ref_mat;

        // Log-frequency axis, configured from the first message's samplerate +
        // bin count: log_fmin/log_fmax are the natural logs of the axis edge
        // frequencies (the log ticks just outside the data range).
        this.samplerate = 0;
        this.bin_count = 0;
        this.log_fmin = 0;
        this.log_fmax = 0;
        this.configured = false;
        this.tick_lines = null;     // THREE.LineSegments of the log tick marks

        // Spectrum polyline is built lazily on the first message, once the bin
        // count and samplerate are known; positions are then rewritten in place.
        this.spectrum_mat = new THREE.LineBasicMaterial({ color: SPECTRUM_COLOR });
        this.spectrum_line = null;
        this.spectrum_pos = null;   // Float32Array backing the line's positions
    }

    // World x for a frequency on the log axis (log_fmin..log_fmax edges -> the
    // spectrum's left..right edge). Requires configure_axis() to have run.
    freq_to_x(freq) {
        return SPECTRUM_X0 +
            (Math.log(freq) - this.log_fmin) / (this.log_fmax - this.log_fmin) * SPECTRUM_WIDTH;
    }

    // Set the axis edges from the samplerate + bin count and (re)draw the log
    // ticks. Edges snap to the log ticks just outside the data: left = tick at/
    // below the lowest bin, right = tick at/above Nyquist. Rebuilds the spectrum
    // line so its x mapping matches. No-op if samplerate and bin count are same.
    configure_axis(samplerate, n) {
        if (!samplerate || (samplerate === this.samplerate && n === this.bin_count)) {
            return;
        }
        this.samplerate = samplerate;
        this.bin_count = n;
        const nyquist = samplerate / 2;
        const bin_hz = nyquist / (n - 1);        // bin 1 is the lowest data freq
        const f_lo = tick_below(bin_hz);
        const f_hi = tick_above(nyquist);
        this.log_fmin = Math.log(f_lo);
        this.log_fmax = Math.log(f_hi);
        this.configured = true;

        if (this.tick_lines) {
            this.group.remove(this.tick_lines);
            this.tick_lines.geometry.dispose();
        }
        const pts = [];
        for (const f of log_tick_freqs(f_lo, f_hi)) {
            const x = this.freq_to_x(f);
            pts.push(new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, LOG_TICK_H, 0));
        }
        this.tick_lines = new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(pts), this.ref_mat);
        this.group.add(this.tick_lines);

        // Force the spectrum line to rebuild against the new frequency mapping.
        if (this.spectrum_line) {
            this.group.remove(this.spectrum_line);
            this.spectrum_line.geometry.dispose();
            this.spectrum_line = null;
        }
    }

    // n is the raw fft bin count. We plot bins 1..n-1 (skipping DC) placed by
    // their actual frequency on the log axis, where bin i is at
    // i * Nyquist / (n - 1) Hz. Rebuilds only when the point count changes.
    ensure_spectrum(n) {
        if (!this.configured) {
            return;   // axis not configured yet (no samplerate seen)
        }
        const num_points = n - 1;
        if (num_points < 1 || (this.spectrum_line && this.spectrum_pos.length === num_points * 3)) {
            return;
        }
        if (this.spectrum_line) {
            this.group.remove(this.spectrum_line);
            this.spectrum_line.geometry.dispose();
        }
        const bin_hz = (this.samplerate / 2) / (n - 1);
        this.spectrum_pos = new Float32Array(num_points * 3);
        for (let j = 0; j < num_points; j++) {
            const bin = j + 1;   // point j shows fft bin j+1; y filled per update
            this.spectrum_pos[j * 3] = this.freq_to_x(bin * bin_hz);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.spectrum_pos, 3));
        this.spectrum_line = new THREE.Line(geom, this.spectrum_mat);
        this.group.add(this.spectrum_line);
    }

    // avg/peak in [0, 1] (clamped to full scale); spectrum is the raw fft
    // magnitude per bin, on the same 0..1-per-full-scale vertical scale (may
    // exceed 1); samplerate (Hz) fixes the frequency axis.
    set(avg, peak, spectrum, samplerate) {
        this.configure_axis(samplerate, spectrum.length);

        this.avg_fill.scale.y = Math.max(1e-4, clamp01(avg) * AUDIO_FULL_SCALE_H);

        const peak_y = clamp01(peak) * AUDIO_FULL_SCALE_H;
        const pp = this.peak_geom.attributes.position.array;
        pp[1] = peak_y;
        pp[4] = peak_y;
        this.peak_geom.attributes.position.needsUpdate = true;

        this.ensure_spectrum(spectrum.length);
        if (!this.spectrum_line) {
            return;   // axis not configured yet, or fewer than 2 bins to draw
        }
        const num_points = this.spectrum_pos.length / 3;
        for (let j = 0; j < num_points; j++) {
            this.spectrum_pos[j * 3 + 1] = spectrum[j + 1] * AUDIO_FULL_SCALE_H;
        }
        this.spectrum_line.geometry.attributes.position.needsUpdate = true;
    }
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

// Debug scene: a grid of 16 round dials showing the live (normalized) values of
// MIDI knobs 1-16, driven through the standard knob -> property binding path.
export class DebugScene extends Scene {
    constructor(context) {
        super(context, 'debug');
        this.camera = this.cam_orth;
        this.camera.position.set(0, 0, 10);

        this.dials = [];
        for (let i = 0; i < NUM_DIALS; i++) {
            const dial = new Dial();
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            dial.group.position.set(
                (col - (COLS - 1) / 2) * COL_SPACING,
                ((ROWS - 1) / 2 - row) * ROW_SPACING,
                0
            );
            this.add(dial.group);
            this.dials.push(dial);

            // One knob -> one dial here, but bind() supports many bindings per
            // knob for one-knob -> many-properties mappings.
            this.bind('apc', i, (v) => dial.set(v));
        }

        this.audio = new AudioDisplay();
        this.add(this.audio.group);
    }

    // avg/peak: mean and peak absolute input amplitude in [0, 1]; spectrum: raw
    // FFT magnitude bins, low->high frequency; samplerate (Hz) fixes the axis.
    // See adapter/audio_info.py.
    handle_audio_info(avg, peak, spectrum, samplerate) {
        this.audio.set(avg, peak, spectrum, samplerate);
    }

    anim_frame(dt) {
        this.controls.update();
    }
}
