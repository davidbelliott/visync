import { VectorFieldComponent } from '../components/vector_field.js';
import { Scene } from './scene.js';

export class VectorFieldScene extends Scene {
    constructor(context) {
        super(context);
        this.add(new VectorFieldComponent())
        this.rotation.x = Math.atan(1 / Math.sqrt(3));
        this.controls.update();

        this.add_knob('tracer_length');
        this.add_knob('vectors_direction');
        this.add_knob('camera_zoom');
        this.add_knob('orbit_x');
        this.add_knob('orbit_y');
        this.add_knob('tracer_spread_x');
        this.add_knob('tracer_spread_y');
        this.add_knob('tracer_scale_x');
        this.add_knob('tracer_scale_y');
    }
}
