import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    ShaderLoader
} from './util.js';

function create_instanced_cube(dims, color) {
    let geometry = new THREE.BoxGeometry(...dims);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 1 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);

    const fill_mat = new THREE.MeshBasicMaterial({
        color: "black",
        polygonOffset: true,
        polygonOffsetFactor: 1, // positive value pushes polygon further away
        polygonOffsetUnits: 1
    });
    const inner_geom = new THREE.BoxGeometry(...dims);
    mesh.add(new THREE.Mesh(inner_geom, fill_mat));

    return mesh;
}


export class SpectrumScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);

        // Create a line with many points to display a spectrum
        let geometry = new THREE.BufferGeometry();
        this.num_points = 1024;
        this.positions = new Float32Array(this.num_points * 3); // each point needs x, y, z coordinates
        for (let i = 0; i < this.num_points; i++) {
            this.positions[i * 3] = (i / this.num_points - 0.5) * this.frustum_size * aspect;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

        // Define the material of your line
        let material = new THREE.LineBasicMaterial({ color: "yellow", linewidth: 1 });

        // Create the line and add it to the scene
        this.line = new THREE.Line(geometry, material);
        this.base_group = new THREE.Group();
        this.base_group.add(this.line);

        this.base_group.rotation.x = Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.base_group.rotation.y = Math.PI / 4;

        this.scene.add(this.base_group);
        this.camera = this.cam_orth;

        this.signals = [
            [0.1, 0.5],
            [0.4, 0.3],
            [0.7, 0.7],
        ];


        this.elapsed_beats = 0.0;
    }

    get_frequency_data() {
        const noise_ampl = 0.3;
        const sharpness = 40;
        const data = new Array(this.num_points);
        for (let i = 0; i < this.num_points; i++) {
            data[i] = Math.random() * noise_ampl;
        }
        for (const [f, mag] of this.signals) {
            for (let i = 0; i < this.num_points; i++) {
                const x = (i / this.num_points);
                const dist = Math.abs(x - f);
                const mag_comp = mag * this.frustum_size;
                const val_to_add = mag * 1 / (sharpness * Math.abs(dist) + 1.0 / mag_comp);
                data[i] += val_to_add;
            }
        }
        return data;
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        let frequencyData = this.get_frequency_data();

        const clock_dt = this.clock.getDelta();
        this.elapsed_beats += clock_dt * beats_per_sec;

        // Update the line's y-values based on the frequency data
        let positions = this.line.geometry.attributes.position.array;
        for (let i = 0; i < frequencyData.length; i++) {
            positions[i * 3 + 1] = frequencyData[i];
        }

        // Notify Three.js of the change in the positions data
        this.line.geometry.attributes.position.needsUpdate = true;
        //this.plane.position.z -= 0.02;
        //this.plane.rotation.y += 0.01;
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        console.log("beat");
    }
}
