import { DrumKit } from '../components/drum_kit.js';
import { Scene } from './scene.js';
import * as THREE from 'three';

const KIT_SCALE = 1.25;
const KIT_SOURCE_HEIGHT = 4;

export class DrumKitScene extends Scene {
    constructor(context) {
        super(context);
        this.camera = this.cam_persp;
        this.camera.position.set(0, 0, 20);
        {
            const geometry = new THREE.PlaneGeometry(100, 100);
            const material = new THREE.MeshStandardMaterial({
                color: 0x000000,
                transparent: true,
                opacity: 0.5,
                side: THREE.DoubleSide
            });
            this.plane = new THREE.Mesh(geometry, material);
            this.plane.position.set(0, 0, -10);
            this.add(this.plane);
        }
        this.kit = new DrumKit();
        this.fog = new THREE.Fog( 0x101010, 0.1, 50 );
        this.kit.position.set(0, -KIT_SOURCE_HEIGHT / 2 * KIT_SCALE, 0);
        this.kit.scale.setScalar(KIT_SCALE);
        this.add(this.kit);
        this.rotation.x = 0;//Math.atan(1 / Math.sqrt(3));
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

    anim_frame(dt) {
        super.anim_frame(dt);
        this.kit.rotation.y += dt * 0.2;
    }
}
