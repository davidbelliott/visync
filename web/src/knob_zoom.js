// Knob-controlled camera zoom, shared by every scene that opts in with
// Scene.bind_zoom().
//
// The knob picks a zoom factor between MIN_ZOOM and MAX_ZOOM times the scene's
// base zoom, spaced logarithmically so equal knob turns feel like equal zoom
// steps. The camera follows with an EasedFollower, also in log
// space, so changes start and stop smoothly.
import { EasedFollower, lerp_scalar } from './util.js';
import { CH_ZOOM } from './controller_map.js';

// Zoom factor range relative to the scene's base zoom (the framing each scene
// was composed at, and the zoom before the knob is touched). The knob mostly
// pulls back: zooming in past ~1.1x crowds the frame and reads as chaotic,
// while 0.5x shows the wider structure. Knob top = 1.1x, bottom = 0.5x,
// ~1x at 88% of the travel.
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.1;
// Seconds from the knob's last change to the camera settling on it; quick
// enough to feel direct, slow enough to read as a camera move.
const ZOOM_MOVE_TIME = 0.8;

const LOG_MIN = Math.log(MIN_ZOOM);
const LOG_MAX = Math.log(MAX_ZOOM);

export class KnobZoom {
    // base_zoom: the camera zoom the scene was composed at (factor 1x).
    constructor(base_zoom=1) {
        this.base_zoom = base_zoom;
        this.log_factor = new EasedFollower(0, ZOOM_MOVE_TIME);
    }

    bind(scene) {
        scene.bind(CH_ZOOM, (v) => this.log_factor.set_target(v),
            (norm) => lerp_scalar(LOG_MIN, LOG_MAX, norm));
    }

    // Advance by dt seconds and write the zoom into `camera` (orthographic or
    // perspective), touching the projection only when it changed.
    update(dt, camera) {
        const zoom = this.base_zoom * Math.exp(this.log_factor.update(dt));
        if (zoom !== camera.zoom) {
            camera.zoom = zoom;
            camera.updateProjectionMatrix();
        }
    }
}
