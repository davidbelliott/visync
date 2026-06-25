import { DrumKit } from '../components/drum_kit.js';
import { Scene } from './scene.js';
import * as THREE from 'three';
import { CH_ROT_Y, knob_to_rate } from '../controller_map.js';

const KIT_SCALE = 1.25;
const KIT_SOURCE_HEIGHT = 4;

export class DrumKitScene extends Scene {
    constructor(context) {
        super(context);

        // Knob 8 sets the continuous spin rate/direction in [-cur_rate, +cur_rate].
        // Evaluated via update_bindings() inside super.anim_frame().
        this.rot_rate = 1;
        this.bind('apc', CH_ROT_Y, (v) => { this.rot_rate = v; }, knob_to_rate);

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

        this.camera.zoom = 2;
        this.camera.updateProjectionMatrix();
    }

    anim_frame(dt) {
        super.anim_frame(dt);
        // Knob 8 scales the continuous spin rate to [-0.2, +0.2] rad/s.
        this.kit.rotation.y += dt * 0.2 * this.rot_rate;
    }
}
