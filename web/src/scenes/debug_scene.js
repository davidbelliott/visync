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
// height on a logarithmic (dB) scale (see amp_to_y); the same vertical scale is
// shared by the amp bar and the spectrum line so their heights are comparable.
const AUDIO_BASELINE_Y = -9.5;      // world y of the dB floor (AUDIO_DB_MIN)
const AUDIO_FULL_SCALE_H = 18.0;     // world height of amplitude 1.0 (0 dB)
const AUDIO_Z = 0.1;                // sit in front of the dials

// Vertical axis range, in dBFS. The adapter already sends levels in dB (see
// adapter/audio_info.py), so this is a straight linear remap: AUDIO_DB_MAX
// (0 dB, full scale) at full height, AUDIO_DB_MIN and anything below it on the
// baseline.
const AUDIO_DB_MIN = -90;
const AUDIO_DB_MAX = 0;

// Left-side amplitude bar: full-scale outline frame, average fill, peak tick.
const AMP_BAR_X = -13.5;
const AMP_BAR_W = 0.8;

// Spectrum polyline: the fft bins span this x-range, one point per bin, evenly
// spaced by bin index (so x is linear in frequency), low to high.
const SPECTRUM_X0 = -12.5;
const SPECTRUM_WIDTH = 26.0;

// Which of the two spectrum traces to draw; independent, either or both (or
// neither). The averaged one (adapter/audio_info.py's SPECTRUM_SMOOTH_TAU_S,
// computed on linear amplitude before the dB conversion) settles the low-level
// bins onto the true noise floor; the raw one shows transients as they land.
// When both are on, the averaged trace draws behind the raw one.
const SHOW_RAW_SPECTRUM = true;
const SHOW_SMOOTHED_SPECTRUM = false;

const SPECTRUM_COLOR = 0x555555;    // instantaneous spectrum line
const SMOOTH_COLOR = 0xff8800;      // time-averaged spectrum line
const AVG_COLOR = 0xffffff;         // average fill
const PEAK_COLOR = 0xffffff;        // peak tick
const AUDIO_REF_COLOR = 0x555555;   // dim baseline + full-scale frame + ticks

// Two-vertex line geometry between (x0, y0) and (x1, y1) in the xy plane.
function segment_geometry(x0, y0, x1, y1) {
    return new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x0, y0, 0), new THREE.Vector3(x1, y1, 0),
    ]);
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
// children work in local coords where y=0 is the dB floor (AUDIO_DB_MIN) and
// y=AUDIO_FULL_SCALE_H is full scale (0 dB); amplitudes map to y logarithmically
// (see amp_to_y_db). Left: an amplitude bar (dim full-scale frame, average fill,
// peak tick). Right: two 1px polylines of the fft spectrum, one point per bin --
// white for the instantaneous magnitude, orange for its time average.
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

        // Enabled spectrum polylines are built lazily on the first message, once
        // the bin count is known; positions are rewritten in place each update.
        this.spectrum_mat = new THREE.LineBasicMaterial({ color: SPECTRUM_COLOR });
        this.smooth_mat = new THREE.LineBasicMaterial({ color: SMOOTH_COLOR });
        this.spectrum_line = null;
        this.smooth_line = null;
        this.spectrum_pos = null;   // Float32Array backing the raw line
        this.smooth_pos = null;     // Float32Array backing the averaged line
        this.bin_count = 0;         // 0 until the lines are built
    }

    // Build one spectrum polyline of n points: a Float32Array of positions with
    // x fixed by bin index (low -> high, left -> right) and y filled per update,
    // plus the THREE.Line drawing it. Returns [line, positions].
    build_line(n, material, z) {
        const pos = new Float32Array(n * 3);
        for (let j = 0; j < n; j++) {
            pos[j * 3] = SPECTRUM_X0 + (j / (n - 1)) * SPECTRUM_WIDTH;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const line = new THREE.Line(geom, material);
        line.position.z = z;
        this.group.add(line);
        return [line, pos];
    }

    // n is the fft bin count: one point per bin. Rebuilds only when the bin
    // count changes -- this runs per message, so it must not reallocate on
    // every frame. Either trace can be disabled, so both may end up null.
    ensure_spectrum(n) {
        if (n < 2 || this.bin_count === n) {
            return;
        }
        for (const line of [this.smooth_line, this.spectrum_line]) {
            if (line) {
                this.group.remove(line);
                line.geometry.dispose();
            }
        }
        this.spectrum_line = this.smooth_line = null;
        this.spectrum_pos = this.smooth_pos = null;
        this.bin_count = n;

        // Averaged trace first, set back in z so the raw one draws over it.
        if (SHOW_SMOOTHED_SPECTRUM) {
            [this.smooth_line, this.smooth_pos] =
                this.build_line(n, this.smooth_mat, -0.01);
        }
        if (SHOW_RAW_SPECTRUM) {
            [this.spectrum_line, this.spectrum_pos] =
                this.build_line(n, this.spectrum_mat, 0);
        }
    }

    // All arguments are dBFS (the adapter does the log conversion). avg/peak are
    // the interval's mean and peak level; spectrum and smoothed are one value
    // per fft bin, the latter already time-averaged adapter-side.
    set(avg, peak, spectrum, smoothed) {
        this.avg_fill.scale.y = Math.max(1e-4, db_to_y(avg));

        const peak_y = db_to_y(peak);
        const pp = this.peak_geom.attributes.position.array;
        pp[1] = peak_y;
        pp[4] = peak_y;
        this.peak_geom.attributes.position.needsUpdate = true;

        this.ensure_spectrum(spectrum.length);
        // Each trace is independent: fill only the ones that are enabled.
        if (this.spectrum_line) {
            for (let j = 0; j < spectrum.length; j++) {
                this.spectrum_pos[j * 3 + 1] = db_to_y(spectrum[j]);
            }
            this.spectrum_line.geometry.attributes.position.needsUpdate = true;
        }
        if (this.smooth_line) {
            for (let j = 0; j < smoothed.length; j++) {
                this.smooth_pos[j * 3 + 1] = db_to_y(smoothed[j]);
            }
            this.smooth_line.geometry.attributes.position.needsUpdate = true;
        }
    }
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

// dBFS -> world y: AUDIO_DB_MIN (and below) on the baseline, AUDIO_DB_MAX
// (0 dB, full scale) at full height. A straight remap -- the log conversion
// already happened adapter-side (adapter/audio_info.py's amp_to_db).
function db_to_y(db) {
    return clamp01((db - AUDIO_DB_MIN) / (AUDIO_DB_MAX - AUDIO_DB_MIN)) * AUDIO_FULL_SCALE_H;
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
            this.bind(i, (v) => dial.set(v));
        }

        this.audio = new AudioDisplay();
        this.add(this.audio.group);
    }

    // All levels in dBFS (see adapter/audio_info.py): avg/peak for the interval,
    // spectrum/smoothed one value per fft bin, low->high frequency, plotted one
    // point per bin.
    handle_audio_info(avg, peak, spectrum, smoothed, samplerate) {
        this.audio.set(avg, peak, spectrum, smoothed);
    }

    anim_frame(dt) {
        this.controls.update();
    }
}
