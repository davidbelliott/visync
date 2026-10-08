// The shared view transform: one rotation and one zoom for every scene.
//
// Knob 8 sets the yaw rate and knob 9 the pitch rate (knob_to_rate: centred =
// stopped, extremes = +-2x VIEW_NOM_ROT_RATE), integrated here into a yaw and
// pitch angle; knob 10 sets the zoom factor, eased. The context owns one
// instance and updates it once per frame before any scene, and it keeps
// running while scenes are hidden, so a scene shown later picks up the same
// rotation. Scenes read it rather than binding these knobs themselves:
//   - free axes: base + angle x the scene's own pace (Scene.view_yaw/
//     view_pitch with a scale), so every scene turns the same way,
//   - stepped axes: the same, quantised by a SteppedRotation,
//   - locked axes: simply don't read it,
//   - zoom: Scene.bind_zoom opts in; the camera gets base zoom x factor.
// Direction standard (every scene): yaw > 0 turns the object positively about
// its own up axis (the side facing the viewer moves right); pitch > 0 tips its
// top towards the viewer (positive X). Rotating the camera instead counts as
// the opposite object rotation, so negate it.
import { EasedFollower, lerp_scalar } from './util.js';
import { CH_ROT_Y, CH_ROT_X, CH_ZOOM, knob_to_rate } from './controller_map.js';

// Shared rotation rate (rad/s) at knob 1x (knob extremes +-2x); scenes scale
// it to their own pace.
export const VIEW_NOM_ROT_RATE = 0.2;

// Zoom factor range relative to each scene's base zoom (the framing it was
// composed at, and the zoom before the knob is touched). The knob mostly
// pulls back: zooming in past ~1.1x crowds the frame and reads as chaotic,
// while 0.5x shows the wider structure. Spaced logarithmically so equal knob
// turns feel like equal zoom steps.
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.1;
// Seconds from the knob's last change to the zoom settling on it (eased, in
// log space); quick enough to feel direct, slow enough to read as a camera
// move.
const ZOOM_MOVE_TIME = 0.8;

export class ViewTransform {
    constructor(knobs) {
        // Angles (rad) and their change over the last update, for scenes that
        // accumulate rather than set (e.g. only while some state is active).
        this.yaw = 0;
        this.pitch = 0;
        this.yaw_delta = 0;
        this.pitch_delta = 0;
        // Knob-set rate multipliers; defaults: yaw drifting, pitch still.
        this.yaw_rate = 1;
        this.pitch_rate = 0;
        knobs.get(CH_ROT_Y).bind_to((v) => { this.yaw_rate = v; }, knob_to_rate);
        knobs.get(CH_ROT_X).bind_to((v) => { this.pitch_rate = v; }, knob_to_rate);

        this.zoom = 1;
        this.log_zoom = new EasedFollower(0, ZOOM_MOVE_TIME);
        knobs.get(CH_ZOOM).bind_to((v) => this.log_zoom.set_target(v),
            (norm) => lerp_scalar(Math.log(MIN_ZOOM), Math.log(MAX_ZOOM), norm));
    }

    // Advance by dt seconds.
    update(dt) {
        this.yaw_delta = VIEW_NOM_ROT_RATE * this.yaw_rate * dt;
        this.pitch_delta = VIEW_NOM_ROT_RATE * this.pitch_rate * dt;
        this.yaw += this.yaw_delta;
        this.pitch += this.pitch_delta;
        this.zoom = Math.exp(this.log_zoom.update(dt));
    }
}
