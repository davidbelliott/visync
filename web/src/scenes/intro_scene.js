import * as THREE from 'three';
import { Scene } from './scene.js';
import {
    CH_EXPAND_X,
    CH_EXPAND_Y,
    CH_EXPAND_Z,
    CH_EXPAND_W,
    knob_with_zero_zone,
} from '../controller_map.js';
import { BeatClock, ease, clamp } from '../util.js';
import { SteppedRotation, UPRIGHT_PITCHES, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
import { Tesseract } from '../highdim.js';




// Rotation (rad), identical to the spinning robots scene's so the two step in
// lockstep: yaw every 45 deg from a quarter-turn diagonal base, pitch between
// upright views (isometric tilt up or down, or level) starting tilted towards
// the viewer, applied to base_group (yaw about the tesseract's own up axis).
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;
// 4D look. With no 4D rotation at rest, both cubes stay axis-aligned, so all
// x/y/z edges lie on the same isometric grid as the other scenes.
// W_PERSPECTIVE: project w in perspective from W_DIST_SIZES x the tesseract's
//   size along w: the near cube keeps its size, the far one draws inside it
//   at (d - 1/2) / (d + 1/2) of it (half at 1.5), joined by edges running
//   corner to corner. false: drop w (then at rest the w edges shrink to
//   points and it reads as a plain cube).
// XW_TURN: once a bar, ease a quarter turn in the xw plane over
//   XW_TURN_BEATS: the cubes turn inside out through each other. A quarter
//   turn maps the tesseract onto itself, so every rest pose is the same
//   aligned one.
// XW_CONSTANT_VELOCITY: instead of eased turns, turn in xw continuously at a
//   quarter turn per XW_TURN_BEATS beats (the eased turn's average speed),
//   beat-relative. The cubes then never rest, so the tesseract only passes
//   through the aligned pose once per quarter turn, and tracers drop the
//   whole time.
const W_PERSPECTIVE = true;
const W_DIST_SIZES = 1.5;
const XW_TURN = true;
const XW_TURN_BEATS = 1;
const XW_CONSTANT_VELOCITY = true;
// Which 4D plane the turn happens in: 'xw' or 'zw' (both turn the cubes
// inside out through each other, along the tesseract's x or z axis). Either
// way a quarter turn maps the tesseract onto itself.
const TURN_PLANE = 'zw';
const TURN_ROT = 'rot_' + TURN_PLANE;
// Tesseract edge length (scene units).
const TESSERACT_SIZE = 12;
// Tracers (as in the cube locking and vector field scenes): while the
// tesseract turns in 4D, a faded copy of its wireframe is dropped every
// TRACER_INTERVAL beats and fades out over TRACER_LIFETIME beats, leaving an
// echo trail behind the inside-out motion. Beat-relative so the spacing
// scales with tempo; TRACER_OPACITY is a fresh copy's opacity.
const TRACER_INTERVAL = 1 / 64;
const TRACER_LIFETIME = 1 / 2;
const TRACER_COUNT = Math.ceil(TRACER_LIFETIME / TRACER_INTERVAL) + 1;
const TRACER_OPACITY = 0.3;

export class IntroScene extends Scene {
    constructor(context) {
        super(context, 'tesseract');

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.camera = this.cam_orth;

        this.clear();
        // Beat-relative clock for the (currently disabled) per-beat scale
        // bounce in anim_frame; restarted every 4 beats by handle_sync.
        this.beat_clock = new BeatClock(this);

        this.base_group = new THREE.Group();
        this.tesseract = new Tesseract(TESSERACT_SIZE, this.cam_orth);
        this.base_group.add(this.tesseract);

        // 4D view (see W_PERSPECTIVE / XW_TURN); the 3D turn and tilt are
        // the shared view's (base_group).
        this.tesseract.w_dist = W_PERSPECTIVE ? W_DIST_SIZES * TESSERACT_SIZE : null;
        this.xw_turns = 0;      // quarter turns started so far
        this.xw_clock = new BeatClock(this);

        this.add(this.base_group);

        // Tracers: TRACER_COUNT snapshots of the wireframe in one line
        // geometry with per-vertex RGBA (alpha = fade), under base_group so
        // the trail turns with the tesseract.
        this.tracer_verts = this.tesseract.geom.attributes.position.count;
        const n = TRACER_COUNT * this.tracer_verts;
        const tracer_geom = new THREE.BufferGeometry();
        tracer_geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        tracer_geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4).fill(1), 4));
        this.tracers = new THREE.LineSegments(tracer_geom, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, depthWrite: false }));
        this.tracers.frustumCulled = false;
        this.base_group.add(this.tracers);
        this.tracer_birth = new Float32Array(TRACER_COUNT).fill(-Infinity);
        this.next_tracer = 0;
        this.beat_time = 0;             // beats elapsed, for tracer ages
        this.last_tracer_beat = -Infinity;

        // The shared view rotation in eased steps (see YAW_BASE).
        this.yaw = new SteppedRotation();
        this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });
        this.base_group.rotation.x = PITCH_BASE;
        this.base_group.rotation.y = YAW_BASE;

        // Per-axis scale of the tesseract: one knob per 4D axis, mapping to
        // that axis's scale in [0, 1] (1 is full size). The bottom of each
        // knob's travel is exactly 0, fully flattening that axis. Default to a
        // full, uncollapsed tesseract.
        this.scales = new Array(4).fill(1);
        const scale_knob = knob_with_zero_zone(1);
        //this.bind(CH_EXPAND_X, (v) => { this.scales[0] = v; }, scale_knob);
        //this.bind(CH_EXPAND_Y, (v) => { this.scales[1] = v; }, scale_knob);
        //this.bind(CH_EXPAND_Z, (v) => { this.scales[2] = v; }, scale_knob);
        this.bind(CH_EXPAND_W, (v) => { this.scales[3] = v; }, scale_knob);

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        this.base_group.rotation.x = this.pitch.update(dt,
            PITCH_BASE + this.view_pitch(STEPPED_SCALE));
        this.base_group.rotation.y = YAW_BASE + this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));

        // Per-axis scale is driven directly by the CH_EXPAND_* knobs bound in
        // the constructor. `scales` holds the four axis scales as set by those
        // knobs; we just push them into the geometry each frame.
        //
        // Kept for future beat-interactivity: a per-beat "bounce" that pulses
        // one axis's scale over `bounce_beats`, driven by beat_clock (restarted
        // every 4 beats in handle_sync). Re-enable by uncommenting and choosing
        // which axis it should modulate.
        // const t = this.beat_clock.getElapsedBeats();
        // const bounce_beats = 4;
        // const bounce = Math.sin(t * Math.PI / bounce_beats);
        // this.scales[axis] = bounce;

        // xw: turn steadily, or ease through the current quarter turn (at
        // rest between turns).
        if (XW_CONSTANT_VELOCITY) {
            this.tesseract[TURN_ROT] += dt * this.get_local_bpm() / 60 / XW_TURN_BEATS * Math.PI / 2;
        } else if (this.xw_turns > 0) {
            const frac = clamp(this.xw_clock.getElapsedBeats() / XW_TURN_BEATS, 0, 1);
            this.tesseract[TURN_ROT] = (this.xw_turns - 1 + ease(frac)) * Math.PI / 2;
        }

        this.tesseract.scale_vec.set(...this.scales);
        this.tesseract.update_geom(this.camera);
        this.update_tracers(dt * this.get_local_bpm() / 60);
    }

    // Drop a tracer of the wireframe every TRACER_INTERVAL beats while the
    // tesseract is mid-turn in 4D, then fade every tracer by age. d_beats:
    // beats this frame.
    update_tracers(d_beats) {
        this.beat_time += d_beats;
        const n = this.tracer_verts;
        const geom = this.tracers.geometry;
        const turning = XW_CONSTANT_VELOCITY || (this.xw_turns > 0 &&
            this.xw_clock.getElapsedBeats() < XW_TURN_BEATS);
        if (turning && this.beat_time - this.last_tracer_beat >= TRACER_INTERVAL) {
            const i = this.next_tracer;
            this.next_tracer = (i + 1) % TRACER_COUNT;
            this.last_tracer_beat = this.beat_time;
            this.tracer_birth[i] = this.beat_time;
            geom.attributes.position.array.set(
                this.tesseract.geom.attributes.position.array, i * n * 3);
            geom.attributes.position.needsUpdate = true;
        }
        const colors = geom.attributes.color.array;
        for (let i = 0; i < TRACER_COUNT; i++) {
            const age = this.beat_time - this.tracer_birth[i];
            const alpha = TRACER_OPACITY * clamp(1 - age / TRACER_LIFETIME, 0, 1);
            for (let v = i * n; v < (i + 1) * n; v++) {
                colors[v * 4 + 3] = alpha;
            }
        }
        geom.attributes.color.needsUpdate = true;
    }

    handle_sync(t, bpm, beat) {
        //if (beat % 4 == 0) {
        this.beat_clock.start();
        if (XW_TURN && !XW_CONSTANT_VELOCITY) {
            this.xw_turns++;
            this.xw_clock.start();
        }
        //}
    }

    handle_beat(t, channel) {
    }

}
