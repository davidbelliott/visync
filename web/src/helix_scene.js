import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { ShaderLoader, BeatClock } from './util.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// Double Helix Curve
class HelixCurve extends THREE.Curve {
    constructor(scale, parent_scene) {
        super();
        this.scale = scale;
        this.turns_per_length = 20;
        this.turns_per_beat = 1;
        this.clock = new THREE.Clock(true);
        this.beats = [];
    }

    update(dt) {
    }

    getRadius(tau, time) {
        const t = tau * this.turns_per_length + time * this.turns_per_beat;
        const radius = 2 * (Math.sin(t / 4) + 1);
        return radius;
    }

    getRadiusSinceBeat(tau) {
        const elapsed_time = this.clock.getElapsedTime();
        let radius = 0;
        for (let i = this.beats.length - 1; i >= 0; i--) {
            const t = (tau - 1) + elapsed_time - this.beats[i];
            if (t >= 0) {
                //radius += 50 * t * Math.exp(-8 * t);
                radius = Math.max(radius, 5 * Math.exp(-4 * t));
            }
            if (t > 10) {
                this.beats.splice(0, i);
                break;
            }
        }
        return radius;
    }

    getAngle(tau, time) {
        const t = tau * this.turns_per_length + time * this.turns_per_beat;
        const angle = 2 * Math.PI * t; // Full rotation
        return angle;
    }

    getHeight(tau, time) {
        const t = tau * this.turns_per_length;
        const y = 2 * (t - this.turns_per_length); // Moves from -1 to 1 as t goes from 0 to 1
        return y;
    }

    getPointWithRadius(tau, time) {
        //const radius = this.getRadius(tau, time);
        const radius = this.getRadiusSinceBeat(tau);
        const angle = this.getAngle(tau, time);
        const x = radius * Math.cos(angle);
        const z = -radius * Math.sin(angle);
        const y = this.getHeight(tau, time);
        return new THREE.Vector3(x, y, z).multiplyScalar(this.scale);
    }

    getPoint(tau, offset = 0) {
        return this.getPointWithRadius(tau, 0, offset);
    }

    handle_beat(t, channel) {
        const elapsed_time = this.clock.getElapsedTime();
        this.beats.push(elapsed_time);
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

        this.clock = new THREE.Clock();
        this.base_group = new THREE.Group();
        this.base_group.position.set(0, this.frustum_size / 6, 0);
        this.scene = new THREE.Scene();


        this.camera.rotation.x = -Math.PI / 4;
        this.scene.add(this.base_group);


        // Parameters
        const scale = 1;
        const turns = 4;
        const pointsPerTurn = 100;

        const material = new THREE.LineBasicMaterial({ color: "white" });

        // Create the helix points
        this.curve1 = new HelixCurve(scale, this);
        this.geom1 = new THREE.BufferGeometry();
        this.geom1.setFromPoints(this.curve1.getPoints(1024));

        const line = new THREE.Line(this.geom1, material);
        this.base_group.add(line);

        this.curve2 = new HelixCurve(scale, this);
        this.geom2 = new THREE.BufferGeometry();
        this.geom2.setFromPoints(this.curve2.getPoints(1024));

        this.curves = [this.curve1, this.curve2];

        const line2 = line.clone();
        line2.rotation.y = Math.PI;
        this.base_group.add(line2);

        // Create the vectors (arrows)
        {
            this.vectors = [];
            const vector_loader = new STLLoader();
            const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
                'glsl/chunks/dither.frag');
            const vector_loader_promise = vector_loader.loadAsync('stl/vector.stl');
            const shader_loader_promise = shader_loader.load();
            Promise.all([vector_loader_promise, shader_loader_promise]).then((results) => {
                    const geom = results[0];
                    const dither_pars = results[1][0];
                    const dither = results[1][1];
                    this.vector_mat = new THREE.MeshLambertMaterial({ color: 'blue' });
                    this.vector_mat.onBeforeCompile = (shader) => {
                        shader.fragmentShader = 
                            shader.fragmentShader.replace(
                                '#include <dithering_pars_fragment>',
                                dither_pars
                            ).replace(
                                '#include <dithering_fragment>',
                                dither
                            );
                    };
                    for (let i = 0; i < 2; i++) {
                        const vector = new THREE.Mesh(geom, this.vector_mat);
                        vector.scale.multiplyScalar(1 / 100);
                        vector.rotation.x = Math.PI / 2 * (i * 2 - 1);
                        this.vectors.push(vector);
                        //this.base_group.add(vector);
                    }
            });
        }

        // Create lighting
        {
            this.light = new THREE.PointLight("white", 200, 0, 0.8);
            this.light.position.set(0, 10, 10);
            this.scene.add(this.light);
        }

        this.clock.start();
    }

    anim_frame(dt) {

        for (const c of this.curves) {
            c.update(dt);
        }
        //this.base_group.rotation.y += 0.1;
        const t = this.clock.getElapsedTime();
        const radius = 2 * Math.sin(t / 2) + 1;

        const positionAttribute = this.geom1.getAttribute('position');

        const curve_time = t;
        for (let i = 0; i < positionAttribute.count; i++) {
            const t_norm = i / (positionAttribute.count - 1);
            const point = this.curve1.getPointWithRadius(t_norm, curve_time);
            positionAttribute.setXYZ(i, point.x, point.y, point.z);
        }

        positionAttribute.needsUpdate = true;
        for (let i = 0; i < this.vectors.length; i++) {
            const angle = this.curve1.getAngle(1, curve_time);
            const radius = this.curve1.getRadius(1, curve_time);
            const x = radius * Math.cos(angle);
            const y = 1 + (2 * i - 1);
            const z = -radius * Math.sin(angle);
            this.vectors[i].position.set(x, y, z);
        }
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay();
        setTimeout(() => {
            if (channel == 1 || channel == 3) {
                for (const c of this.curves) {
                    c.handle_beat(t, channel);
                }
            }
        }, delay * 1000);
    }

    handle_sync(t, bpm, beat) {
    }

    state_transition(old_state_idx, new_state_idx) {
    }
}
