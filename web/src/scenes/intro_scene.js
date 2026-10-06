import * as THREE from 'three';
import { Scene } from './scene.js';
import {
    CH_ROT_Y,
    CH_EXPAND_X,
    CH_EXPAND_Y,
    CH_EXPAND_Z,
    CH_EXPAND_W,
    knob_to_snap,
} from '../controller_map.js';
import {
    lerp_scalar,
    ease,
    clamp,
    BeatClock,
} from '../util.js';
import { Tesseract } from '../highdim.js';


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

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.clear();
        this.sync_clock = new BeatClock(this);
        // Beat-relative clock for the (currently disabled) per-beat scale
        // bounce in anim_frame; restarted every 4 beats by handle_sync.
        this.beat_clock = new BeatClock(this);

        this.base_group = new THREE.Group();
        this.tesseract = new Tesseract(10.0, this.cam_orth);
        this.base_group.add(this.tesseract);

        // Fixed 4D orientation: an isometric-ish projection of the tesseract.
        this.tesseract.rot_yz = isom_angle;
        this.tesseract.rot_xz = Math.PI / 4;
        this.tesseract.rot_xw = Math.PI / 4;

        this.add(this.base_group);

        this.start_rot = 0;
        this.end_rot = 0;
        this.cur_rot = this.start_rot;

        // Knob 8 selects one of 8 quarter-pi (45 deg) Y orientations; the
        // scene interpolates from the current angle towards the chosen step.
        this.bind(CH_ROT_Y, (step) => this.set_rot_y_target(step),
            knob_to_snap(8));

        // Per-axis scale of the tesseract: one knob per 4D axis, each mapping
        // its normalized 0..1 value directly to that axis's scale (0 collapses
        // the axis, 1 is full size). Default to a full, uncollapsed tesseract.
        this.scales = new Array(4).fill(1);
        this.bind(CH_EXPAND_X, (v) => { this.scales[0] = v; });
        this.bind(CH_EXPAND_Y, (v) => { this.scales[1] = v; });
        this.bind(CH_EXPAND_Z, (v) => { this.scales[2] = v; });
        this.bind(CH_EXPAND_W, (v) => { this.scales[3] = v; });
    }

    anim_frame(dt) {
        const beats_per_lerp = 2;

        // Y rotation eases toward the knob-8 target (see set_rot_y_target).
        const t_sync = this.sync_clock.getElapsedBeats();
        const rot_frac = ease(clamp(t_sync / beats_per_lerp, 0, 1));
        this.cur_rot = lerp_scalar(this.start_rot, this.end_rot, rot_frac);
        this.tesseract.rotation.y = Math.PI * this.cur_rot / 4;

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

        this.tesseract.scale_vec.set(...this.scales);
        this.tesseract.update_geom(this.camera);
    }

    // Point the Y rotation at a new discrete step (knob-driven). Recording
    // start_rot at the current angle and restarting sync_clock together makes
    // the scene interpolate cleanly from wherever it is to the chosen step.
    set_rot_y_target(target) {
        if (target === this.end_rot) {
            return;
        }
        this.start_rot = this.cur_rot;
        this.end_rot = target;
        this.sync_clock.start();
    }

    handle_sync(t, bpm, beat) {
        if (beat % 4 == 0) {
            this.beat_clock.start();
        }
    }

    handle_beat(t, channel) {
    }

}
