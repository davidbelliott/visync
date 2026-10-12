// The shared view transform: one rotation and one zoom for every scene.
//
// Knob 8 sets the yaw angle and knob 9 the pitch angle directly (centred =
// each scene's base view, extremes = +-YAW_RANGE / +-PITCH_RANGE), eased so
// the knobs' steps never show; knob 10 sets the zoom factor, eased. The context owns one
// instance and updates it once per frame before any scene, and it keeps
// running while scenes are hidden, so a scene shown later picks up the same
// rotation. Scenes read it rather than binding these knobs themselves:
//   - free axes: base + angle x the scene's own scale (Scene.view_yaw/
//     view_pitch), so every scene turns the same way,
//   - stepped axes: the same, quantised by a SteppedRotation,
//   - locked axes: simply don't read it,
//   - zoom: Scene.bind_zoom opts in; the camera gets base zoom x factor.
// Direction standard (every scene): yaw > 0 turns the object positively about
// its own up axis (the side facing the viewer moves right); pitch > 0 tips its
// top towards the viewer (positive X). Rotating the camera instead counts as
// the opposite object rotation, so negate it.
import { EasedFollower, lerp_scalar } from './util.js';
import { CH_ROT_Y, CH_ROT_X, CH_ZOOM } from './controller_map.js';

// Angle at each end of the rotation knobs' travel, rad, either side of the
// base view at the centre. Yaw: half a turn, so the knob sweeps a full turn.
// Pitch: 45 deg, enough to reach the isometric tilt (35.26 deg) in the
// stepped scenes (x STEPPED_SCALE) without tipping free ones too far over.
const YAW_RANGE = Math.PI;
const PITCH_RANGE = Math.PI / 4;
// Seconds from a rotation knob's last change to the view settling on it
// (eased); short enough to feel direct, long enough to smooth the knob's
// 128 MIDI steps (~3 deg each on yaw) into one motion.
const ROT_MOVE_TIME = 0.5;

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
const ZOOM_MOVE_TIME = 1.5;

export class ViewTransform {
    constructor(knobs) {
        // Angles (rad) and their change over the last update, for scenes that
        // accumulate rather than set (e.g. only while some state is active).
        this.yaw = 0;
        this.pitch = 0;
        this.yaw_delta = 0;
        this.pitch_delta = 0;
        // Eased towards the knobs' angles. They start on the base view
        // (centred knobs) rather than where untouched knobs read (0), until a
        // knob reports in.
        this.yaw_follower = new EasedFollower(0, ROT_MOVE_TIME);
        this.pitch_follower = new EasedFollower(0, ROT_MOVE_TIME);
        const knob_to_angle = (range) => (norm) => (norm * 2 - 1) * range;
        knobs.get(CH_ROT_Y).bind_to((v) => this.yaw_follower.set_target(v),
            knob_to_angle(YAW_RANGE));
        knobs.get(CH_ROT_X).bind_to((v) => this.pitch_follower.set_target(v),
            knob_to_angle(PITCH_RANGE));

        this.zoom = 1;
        this.log_zoom = new EasedFollower(0, ZOOM_MOVE_TIME);
        knobs.get(CH_ZOOM).bind_to((v) => this.log_zoom.set_target(v),
            (norm) => lerp_scalar(Math.log(MIN_ZOOM), Math.log(MAX_ZOOM), norm));
    }

    // Advance by dt seconds.
    update(dt) {
        const yaw = this.yaw_follower.update(dt);
        const pitch = this.pitch_follower.update(dt);
        this.yaw_delta = yaw - this.yaw;
        this.pitch_delta = pitch - this.pitch;
        this.yaw = yaw;
        this.pitch = pitch;
        this.zoom = Math.exp(this.log_zoom.update(dt));
    }
}
