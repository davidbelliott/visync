import { VectorFieldComponent } from '../components/vector_field.js';
import { Scene } from './scene.js';
import { CH_ROT_X, CH_ROT_Y, knob_to_rate } from '../controller_map.js';

// Nominal free-rotation rate in rad/s; knob_to_rate scales it to [-2, 2] x this.
const NOM_ROT_RATE = 0.2;

export class VectorFieldScene extends Scene {
    constructor(context) {
        super(context);
        this.add(new VectorFieldComponent())

        // Free rotation: knob 8 sets the yaw rate about the field's Y axis
        // and knob 9 the pitch rate about the viewport-horizontal (world X)
        // axis (knob centred = stopped). Starts at the isometric tilt.
        this.yaw = 0;
        this.pitch = Math.atan(1 / Math.sqrt(3));
        this.rot_rate = 1;
        this.pitch_rate = 0;
        this.bind(CH_ROT_Y, (v) => { this.rot_rate = v; }, knob_to_rate);
        this.bind(CH_ROT_X, (v) => { this.pitch_rate = v; }, knob_to_rate);
        this.controls.update();

        this.camera.zoom = 2;
        this.camera.updateProjectionMatrix();
    }

    anim_frame(dt) {
        super.anim_frame(dt);
        this.yaw += dt * NOM_ROT_RATE * this.rot_rate;
        this.pitch += dt * NOM_ROT_RATE * this.pitch_rate;
        // The default XYZ euler order applies yaw about the scene's Y axis
        // first, then pitch about the world X axis, so the pitch axis stays
        // horizontal in the viewport whatever the yaw.
        this.rotation.x = this.pitch;
        this.rotation.y = this.yaw;
    }
}
