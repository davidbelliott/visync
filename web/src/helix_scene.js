import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { BeatClock } from './util.js';

// Double Helix Curve
class HelixCurve extends THREE.Curve {
    constructor(scale = 1) {
        super();
        this.scale = scale;
        this.num_turns = 10;
    }

    getPointWithRadius(tau, time) {
        const t = tau * this.num_turns;
        const radius = 2 * (Math.sin((time + t) / 4) + 1);
        const angle = 2 * Math.PI * t; // Full rotation
        const x = radius * Math.cos(angle + time);
        const y = 2 * (t - this.num_turns); // Moves from -1 to 1 as t goes from 0 to 1
        const z = -radius * Math.sin(angle + time);
        return new THREE.Vector3(x, y, z).multiplyScalar(this.scale);
    }

    getPoint(tau, offset = 0) {
        return this.getPointWithRadius(tau, 0, offset);
    }
}

export class HelixScene extends VisScene {
    constructor() {
        super(1);
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.frustum_size = 10;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.clock = new BeatClock(this);
        this.base_group = new THREE.Group();
        this.scene = new THREE.Scene();


        this.camera.rotation.x = -Math.PI / 4;
        this.scene.add(this.base_group);


        // Parameters
        const scale = 1;
        const turns = 4;
        const pointsPerTurn = 100;

        const material = new THREE.LineBasicMaterial({ color: "white" });

        // Create the helix points
        this.curve1 = new HelixCurve(scale);
        this.geom1 = new THREE.BufferGeometry();
        this.geom1.setFromPoints(this.curve1.getPoints(1024));

        const line = new THREE.Line(this.geom1, material);
        line.position.set(0, this.frustum_size / 6, 0);
        this.base_group.add(line);

        this.curve2 = new HelixCurve(scale);
        this.geom2 = new THREE.BufferGeometry();
        this.geom2.setFromPoints(this.curve2.getPoints(1024));

        const line2 = line.clone();
        line2.rotation.y = Math.PI;
        this.base_group.add(line2);

        this.clock.start();
    }

    anim_frame(dt) {
        //this.base_group.rotation.y += 0.1;
        const t = this.clock.getElapsedBeats();
        const radius = 2 * Math.sin(t / 2) + 1;

        const positionAttribute = this.geom1.getAttribute('position');

        for (let i = 0; i < positionAttribute.count; i++) {
            const t_norm = i / positionAttribute.count;
            const point = this.curve1.getPointWithRadius(t_norm, t * 2 * Math.PI);
            positionAttribute.setXYZ(i, point.x, point.y, point.z);
        }

        positionAttribute.needsUpdate = true;
    }

    handle_beat(t, channel) {
    }

    handle_sync(t, bpm, beat) {
    }

    state_transition(old_state_idx, new_state_idx) {
    }
}
