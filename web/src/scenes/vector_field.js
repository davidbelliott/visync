import { VectorFieldComponent } from '../components/vector_field.js';
import { Scene } from './scene.js';

export class VectorFieldScene extends Scene {
    constructor(context) {
        super(context);
        this.add(new VectorFieldComponent())
        this.rotation.x = Math.atan(1 / Math.sqrt(3));
        this.controls.update();
    }
}
