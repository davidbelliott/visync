import * as THREE from 'three';
import { Scene } from './scene.js';
import { CH_EXPAND_W, knob_with_zero_zone } from '../controller_map.js';
import { BeatClock, ease, clamp } from '../util.js';
import { SteppedRotation, UPRIGHT_PITCHES, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
import { Tesseract } from '../highdim.js';

// View rotation (rad), in lockstep with the spinning robots scene.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// Tesseract edge length (scene units).
const TESSERACT_SIZE = 12;
// W_PERSPECTIVE: project w in perspective from W_DIST_SIZES x the size, so
// the far cube draws inside the near one (at half its size for 1.5). With no
// 4D rotation at rest, both cubes stay on the other scenes' isometric grid.
const W_PERSPECTIVE = true;
const W_DIST_SIZES = 1.5;
// 4D turn in TURN_PLANE ('xw' or 'zw'), turning the cubes inside out through
// each other. TURN_MODE: 'constant' turns steadily at a quarter turn per
// TURN_BEATS; 'eased' eases a quarter turn over TURN_BEATS on every sync; 'off'.
// A quarter turn maps the tesseract onto itself, so eased turns always rest
// on the aligned pose.
const TURN_PLANE = 'zw';
const TURN_MODE = 'constant';
const TURN_BEATS = 1;
// Tracers: while turning, a faded copy of the wireframe is dropped every
// TRACER_INTERVAL beats and fades out over TRACER_LIFETIME beats.
const TRACER_INTERVAL = 1 / 64;
const TRACER_LIFETIME = 1 / 2;
const TRACER_COUNT = Math.ceil(TRACER_LIFETIME / TRACER_INTERVAL) + 1;
const TRACER_OPACITY = 0.3;

const TURN_ROT = 'rot_' + TURN_PLANE;

export class IntroScene extends Scene {
    constructor(context) {
        super(context, 'tesseract');

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.clear();

        this.base_group = new THREE.Group();
        this.base_group.rotation.x = PITCH_BASE;
        this.base_group.rotation.y = YAW_BASE;
        this.yaw = new SteppedRotation();
        this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });
        this.add(this.base_group);

        this.tesseract = new Tesseract(TESSERACT_SIZE);
        this.tesseract.w_dist = W_PERSPECTIVE ? W_DIST_SIZES * TESSERACT_SIZE : null;
        this.base_group.add(this.tesseract);
        this.turns = 0;     // eased quarter turns started
        this.turn_clock = new BeatClock(this);

        // Knob: the w axis's scale (0 merges the two cubes).
        this.bind(CH_EXPAND_W, (v) => { this.tesseract.scale_vec.w = v; }, knob_with_zero_zone(1));

        // Tracers: TRACER_COUNT snapshots of the wireframe in one geometry,
        // alpha per vertex.
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
        this.beat_time = 0;
        this.last_tracer_beat = -Infinity;

        this.bind_zoom();
    }

    anim_frame(dt) {
        this.base_group.rotation.x = this.pitch.update(dt,
            PITCH_BASE + this.view_pitch(STEPPED_SCALE));
        this.base_group.rotation.y = YAW_BASE + this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));

        const d_beats = dt * this.get_local_bpm() / 60;
        let turning = false;
        if (TURN_MODE == 'constant') {
            this.tesseract[TURN_ROT] += d_beats / TURN_BEATS * Math.PI / 2;
            turning = true;
        } else if (this.turns > 0) {
            const frac = clamp(this.turn_clock.getElapsedBeats() / TURN_BEATS, 0, 1);
            this.tesseract[TURN_ROT] = (this.turns - 1 + ease(frac)) * Math.PI / 2;
            turning = frac < 1;
        }
        this.tesseract.update_geom();
        this.update_tracers(d_beats, turning);
    }

    // Drop a tracer every TRACER_INTERVAL beats while turning, then fade
    // every tracer by age.
    update_tracers(d_beats, turning) {
        this.beat_time += d_beats;
        const n = this.tracer_verts;
        const geom = this.tracers.geometry;
        if (turning && this.beat_time - this.last_tracer_beat >= TRACER_INTERVAL) {
            const i = this.next_tracer;
            this.next_tracer = (i + 1) % TRACER_COUNT;
            this.last_tracer_beat = this.beat_time;
            this.tracer_birth[i] = this.beat_time;
            geom.attributes.position.array.set(this.tesseract.geom.attributes.position.array, i * n * 3);
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
        if (TURN_MODE == 'eased') {
            this.turns++;
            this.turn_clock.start();
        }
    }
}
