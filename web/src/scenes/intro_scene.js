import * as THREE from 'three';
import { Scene } from './scene.js';
import {
    CH_ROT_Y,
    CH_EXPAND_X,
    CH_EXPAND_Y,
    CH_EXPAND_Z,
    CH_EXPAND_W,
    knob_with_zero_zone,
} from '../controller_map.js';
import { BeatClock } from '../util.js';
import { SteppedRotation } from '../stepped_rotation.js';
import { Tesseract } from '../highdim.js';

// Nominal Y rotation rate in rad/s; knob 8 scales it to [-2, 2] x this.
// A 45 deg step roughly every 5 s at 1x, matching the gantry scene.
const NOM_ROT_RATE = 0.15;


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

        // Knob 8 sets the Y rotation rate, shown in eased 45 deg steps.
        this.yaw = new SteppedRotation(NOM_ROT_RATE);
        this.yaw.bind(this, CH_ROT_Y);

        // Per-axis scale of the tesseract: one knob per 4D axis, mapping to
        // that axis's scale in [0, 1] (1 is full size). The bottom of each
        // knob's travel is exactly 0, fully flattening that axis. Default to a
        // full, uncollapsed tesseract.
        this.scales = new Array(4).fill(1);
        const scale_knob = knob_with_zero_zone(1);
        this.bind(CH_EXPAND_X, (v) => { this.scales[0] = v; }, scale_knob);
        this.bind(CH_EXPAND_Y, (v) => { this.scales[1] = v; }, scale_knob);
        this.bind(CH_EXPAND_Z, (v) => { this.scales[2] = v; }, scale_knob);
        this.bind(CH_EXPAND_W, (v) => { this.scales[3] = v; }, scale_knob);

        // Knob CH_ZOOM scales the camera zoom (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        this.tesseract.rotation.y = this.yaw.update(dt);

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

    handle_sync(t, bpm, beat) {
        if (beat % 4 == 0) {
            this.beat_clock.start();
        }
    }

    handle_beat(t, channel) {
    }

}
