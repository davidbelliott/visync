import { VectorFieldComponent } from '../components/vector_field.js';
import { Scene } from './scene.js';

// Free-rotation pace: this x the shared view rotation (0.2 rad/s at knob 1x).
const ROT_SCALE = 1;
// Base pitch: starts at the isometric tilt.
const PITCH_BASE = Math.atan(1 / Math.sqrt(3));

export class VectorFieldScene extends Scene {
    constructor(context) {
        super(context);
        this.add(new VectorFieldComponent())

        this.controls.update();

        this.camera.zoom = 2;
        this.camera.updateProjectionMatrix();

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        super.anim_frame(dt);
        // Free rotation from the shared view. The default XYZ euler order
        // applies yaw about the scene's Y axis first, then pitch about the
        // world X axis, so the pitch axis stays horizontal in the viewport
        // whatever the yaw.
        this.rotation.x = PITCH_BASE + this.view_pitch(ROT_SCALE);
        this.rotation.y = this.view_yaw(ROT_SCALE);
    }
}
