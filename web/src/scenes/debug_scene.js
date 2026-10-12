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

// Audio spectrum + amplitude readout (MsgAudioInfo), over the whole frame,
// in front of the dials. World units: orthographic frustum_size 20
// => y in [-10, 10], x across the window's width (see AudioDisplay.set_edges).
// Amplitude 0..1 (0 = silence, 1 = the full-scale maximum a float32 device can
// capture) maps to baseline..full-scale height on a logarithmic (dB) scale
// (see db_to_y), from the bottom of the window to the top; the same vertical
// scale is shared by the amp bar and the spectrum line so their heights are
// comparable.
const AUDIO_BASELINE_Y = -10;       // world y of the dB floor (AUDIO_DB_MIN)
const AUDIO_FULL_SCALE_H = 20;      // world height of amplitude 1.0 (0 dB)
const AUDIO_Z = 0.1;                // sit in front of the dials

// Vertical axis range, in dBFS. The adapter already sends levels in dB (see
// adapter/audio_info.py), so this is a straight linear remap: AUDIO_DB_MAX
// (0 dB, full scale) at full height, AUDIO_DB_MIN and anything below it on the
// baseline.
const AUDIO_DB_MIN = -90;
const AUDIO_DB_MAX = 0;

// Left-side amplitude bar: full-scale outline frame, average fill, peak tick.
// Pinned against the screen's left edge (see AudioDisplay.set_edges), as
// wide as a dial's ring, so it stays clear of the dial grid (whose left edge
// is at x ~ -13.7) on any screen at least 4:3 wide.
const AMP_BAR_W = OUTER_R - INNER_R;

// Spectrum polylines: the fft bins span the rest of the window's width, from
// the amp bar to the right edge, one point per bin, evenly spaced by bin
// index (so x is linear in frequency), low to high.

// Which of the two spectrum traces to draw; independent, either or both (or
// neither). The averaged one (adapter/audio_info.py's SPECTRUM_SMOOTH_TAU_S,
// computed on linear amplitude before the dB conversion) settles the low-level
// bins onto the true noise floor; the raw one shows transients as they land.
// When both are on, the averaged trace draws in front of the raw one.
const SHOW_RAW_SPECTRUM = true;
const SHOW_SMOOTHED_SPECTRUM = true;

const SPECTRUM_COLOR = 0x555555;    // instantaneous spectrum line
const SMOOTH_COLOR = 0xffffff;      // time-averaged spectrum line
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
// grey for the instantaneous magnitude, white for its time average.
class AudioDisplay {
    constructor() {
        this.group = new THREE.Group();
        this.group.position.set(0, AUDIO_BASELINE_Y, AUDIO_Z);

        const H = AUDIO_FULL_SCALE_H;
        const bx0 = -AMP_BAR_W / 2;
        const bx1 = AMP_BAR_W / 2;
        // The bar's parts, centred on x = 0 here, the group moved to the
        // screen's edge (see set_edges).
        this.bar_group = new THREE.Group();
        this.group.add(this.bar_group);

        const ref_mat = new THREE.LineBasicMaterial({ color: AUDIO_REF_COLOR });
        // Baseline under the spectrum, and a full-scale frame around the bar
        // so the amplitude=1 reference height is visible.
        this.baseline_geom = segment_geometry(0, 0, 1, 0);
        this.group.add(new THREE.Line(this.baseline_geom, ref_mat));
        this.bar_group.add(new THREE.LineLoop(
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
        this.avg_fill.scale.y = 1e-4;   // start effectively empty
        this.bar_group.add(this.avg_fill);

        // Peak tick: a horizontal 1px line across the bar, raised to peak * H.
        this.peak_geom = segment_geometry(bx0, 0, bx1, 0);
        this.bar_group.add(new THREE.Line(
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
        this.spectrum_x0 = 0;       // the spectrum's x-range, world units
        this.spectrum_x1 = 1;       // (see set_edges)
    }

    // Build one spectrum polyline of n points: a Float32Array of positions with
    // x fixed by bin index (low -> high, left -> right) and y filled per update,
    // plus the THREE.Line drawing it. Returns [line, positions].
    build_line(n, material, z) {
        const pos = new Float32Array(n * 3);
        this.layout_line(pos);
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

        // Averaged trace in front in z, so it stays visible over the raw one.
        if (SHOW_SMOOTHED_SPECTRUM) {
            [this.smooth_line, this.smooth_pos] =
                this.build_line(n, this.smooth_mat, 0.01);
        }
        if (SHOW_RAW_SPECTRUM) {
            [this.spectrum_line, this.spectrum_pos] =
                this.build_line(n, this.spectrum_mat, 0);
        }
    }

    // Space a line's points evenly across the spectrum's x-range.
    layout_line(pos) {
        const n = pos.length / 3;
        for (let j = 0; j < n; j++) {
            pos[j * 3] = this.spectrum_x0 + (j / (n - 1)) * (this.spectrum_x1 - this.spectrum_x0);
        }
    }

    // Fit to the window, whose left and right edges are at world x left and
    // right: the amp bar flush against the left edge, the spectrum (and its
    // baseline) filling the rest.
    set_edges(left, right) {
        this.bar_group.position.x = left + AMP_BAR_W / 2;
        this.spectrum_x0 = left + AMP_BAR_W;
        this.spectrum_x1 = right;
        const bp = this.baseline_geom.attributes.position;
        bp.setX(0, this.spectrum_x0);
        bp.setX(1, this.spectrum_x1);
        bp.needsUpdate = true;
        for (const [line, pos] of [[this.spectrum_line, this.spectrum_pos],
                [this.smooth_line, this.smooth_pos]]) {
            if (line) {
                this.layout_line(pos);
                line.geometry.attributes.position.needsUpdate = true;
            }
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
        this.fit_audio(window.innerWidth / window.innerHeight);
    }

    // The camera's side edges move with the aspect ratio; keep the audio
    // readout spanning them.
    fit_audio(aspect) {
        const half_width = this.frustum_size * aspect / 2;
        this.audio.set_edges(-half_width, half_width);
    }

    handle_resize(width, height) {
        super.handle_resize(width, height);
        this.fit_audio(width / height);
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
