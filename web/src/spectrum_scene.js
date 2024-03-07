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


function make_wireframe_circle(radius, segments, color) {
    // Make a wireframe circle using THREE.js and return it
    const geometry = new THREE.CircleGeometry(radius, segments);
    const edges_geom = new THREE.EdgesGeometry(geometry);

    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: color,
        linewidth: 1.0});

    const circle = new THREE.LineSegments(edges_geom, wireframe_mat);
    //const circle = new THREE.Mesh(edges_geom, wireframe_mat);
    return circle;
}

class Signal {
    constructor(freq, max_amp) {
        this.freq = freq;
        this.max_amp = max_amp;
        this.amp = max_amp;
        this.target_freq = freq;
        this.start_freq = freq;
        this.move_clock = new THREE.Clock(false);
    }

    update(bpm) {
        const beats_per_sec = bpm / 60;
        const t = this.move_clock.getElapsedTime();
        const elapsed_beats = t * beats_per_sec;
        const move_beats = 0.5;
        const frac = clamp(elapsed_beats / move_beats, 0, 1);
        const new_freq = lerp_scalar(this.start_freq, this.target_freq, frac);
        this.freq = new_freq;
        this.amp = this.max_amp * Math.min(1, 2 * (frac - 0.5) ** 2 + 0.5);
    }

    get_whole_freq(num_points) {
        return Math.round(this.freq * num_points) / num_points;
    }

    goto_freq(f) {
        this.target_freq = f;
        this.start_freq = this.freq;
        this.move_clock.start();
    }
}


export class SpectrumScene extends VisScene {
    constructor(env) {
        super(env, 3);

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);


        this.line_length = this.frustum_size * aspect;
        this.ceiling_height = 5;

        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(false);
        this.state_change_clock = new THREE.Clock(false);

        this.base_group = new THREE.Group();


        // Create a line with many points to display a spectrum
        {
            let geometry = new THREE.BufferGeometry();
            this.num_points = 512;
            this.positions = new Float32Array(this.num_points * 3); // each point needs x, y, z coordinates
            for (let i = 0; i < this.num_points; i++) {
                this.positions[i * 3] = (i / this.num_points - 0.5) * this.line_length;
            }
            geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

            let material = new THREE.LineBasicMaterial({ color: "yellow", linewidth: 1 });
            this.num_divisions = 16;

            this.line = new THREE.Line(geometry, material);
            this.line.position.z = 0.0;
            this.line.position.y = -this.ceiling_height;
            this.base_group.add(this.line);
        }

        this.show_traces = false;
        this.traces = [];
        this.max_num_traces = 10;
        this.trace_spacing = this.line_length / this.num_divisions;

        {
            this.markers = [];
            for (let i = 0; i < this.max_num_traces * this.num_divisions; i++) {
                const marker = make_wireframe_circle(0.5, 16, "white");
                marker.rotation.x = Math.PI / 2;
                marker.position.y = this.ceiling_height;
                marker.position.z = this.line.position.z;
                marker.material.opacity = 0.0;
                marker.visible = this.show_traces;
                this.markers.push(marker);
                this.base_group.add(marker);
            }
            this.cur_marker_idx = 0;
        }


        {
            const div_mat = new THREE.LineBasicMaterial({ color: 'white', linewidth: 1, transparent: true, opacity: 0.2 });
            for (let i = 0; i < this.num_divisions + 1; i++) {
                const plane_geom = new THREE.PlaneGeometry(this.line_length, this.ceiling_height * 2);
                const edges = new THREE.EdgesGeometry(plane_geom);
                const mesh = new THREE.LineSegments(edges, div_mat);
                mesh.position.x = (i - this.num_divisions / 2) * this.trace_spacing;
                mesh.position.z = this.line.position.z - this.line_length / 2;
                mesh.rotation.y = Math.PI / 2;
                this.base_group.add(mesh);
            }
            const front_plane = new THREE.PlaneGeometry(this.line_length, this.ceiling_height * 2);
            const front_edges = new THREE.EdgesGeometry(front_plane);
            const front_mesh = new THREE.LineSegments(front_edges, div_mat);
            front_mesh.position.z = this.line.position.z;
            this.base_group.add(front_mesh);
        }

        this.base_group.rotation.x = 0;
        this.base_group.rotation.y = 0;

        this.scene.add(this.base_group);
        this.camera = this.cam_orth;

        this.signals = [];
        for (let i = 0; i < 5; i++) {
            this.signals.push(new Signal(0.5, 2 * (this.ceiling_height - i)));
        }

        this.target_rot_x = 0;
        this.start_rot_x = 0;

        this.rot = 0;
        this.target_noise_ampl = 5.0;
        this.start_noise_ampl = 5.0;

        this.elapsed_beats = 0.0;
    }

    get_frequency_data(noise_ampl) {
        const sharpness = 40;
        const data = new Array(this.num_points).fill(0.0);
        for (const signal of this.signals) {
            for (let i = 0; i < this.num_points; i++) {
                const x = (i / this.num_points);
                const dist = Math.abs(x - signal.get_whole_freq(this.num_points));
                const amp_comp = signal.amp;
                const val_to_add = 1 / (sharpness * Math.abs(dist) + 1.0 / amp_comp);
                data[i] = Math.max(data[i], val_to_add);
            }
        }
        for (let i = 0; i < this.num_points; i++) {
            data[i] = Math.min(this.ceiling_height * 2, data[i] + Math.random() * noise_ampl);
        }
        return data;
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;


        if (this.rotating_y) {
            this.rot++;
        }
        //const target_x_rot_delta = this.target_rot_x - this.base_group.rotation.x;
        //this.base_group.rotation.x += Math.sign(target_x_rot_delta) * Math.min(Math.abs(target_x_rot_delta), 0.01);
        //

        // Handle state change X rotation
        const x_rot_beats = 8;
        const x_rot_frac = clamp(this.state_change_clock.getElapsedTime() * beats_per_sec / x_rot_beats, 0, 1);
        this.base_group.rotation.x = lerp_scalar(this.start_rot_x, this.target_rot_x, x_rot_frac);

        // Handle noise level change
        const noise_ampl = lerp_scalar(this.start_noise_ampl, this.target_noise_ampl, x_rot_frac);

        let frequencyData = this.get_frequency_data(noise_ampl);

        const clock_dt = this.clock.getDelta();
        this.elapsed_beats += clock_dt * beats_per_sec;


        for (const signal of this.signals) {
            signal.update(this.get_local_bpm());
        }

        // Update the line's y-values based on the frequency data
        let positions = this.line.geometry.attributes.position.array;
        for (let i = 0; i < frequencyData.length; i++) {
            positions[i * 3 + 1] = frequencyData[i];
        }

        const opacity_step = 0.4;
        for (const trace of this.traces) {
            trace.position.z -= dt * beats_per_sec * this.trace_spacing;
            trace.material.opacity -= opacity_step * dt;
        }

        for (const marker of this.markers) {
            marker.position.z -= dt * beats_per_sec * this.trace_spacing;
            marker.material.opacity -= opacity_step * dt;
        }

        // Notify Three.js of the change in the positions data
        this.line.geometry.attributes.position.needsUpdate = true;
        //this.plane.position.z -= 0.02;
        //this.plane.rotation.y += 0.01;
        //
        this.base_group.rotation.y = this.rot * Math.PI / 1024;
    }

    state_transition(old_state_idx, new_state_idx) {
        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle
        if (new_state_idx == 0) {
            this.start_rot_x = this.base_group.rotation.x;
            this.target_rot_x = 0;
            this.rotating_y = false;
            this.start_noise_ampl = this.target_noise_ampl;
            this.target_noise_ampl = 5.0;
            this.doubletime = false;
            this.show_traces = false;
        } else if (new_state_idx == 1) {
            this.start_rot_x = this.base_group.rotation.x;
            this.target_rot_x = isom_angle;
            this.rotating_y = true;
            this.start_noise_ampl = this.target_noise_ampl;
            this.target_noise_ampl = 1.0;
            this.doubletime = false;
            this.show_traces = true;
        } else if (new_state_idx == 2) {
            this.start_rot_x = this.base_group.rotation.x;
            this.target_rot_x = isom_angle;
            this.rotating_y = true;
            this.start_noise_ampl = this.target_noise_ampl;
            this.target_noise_ampl = 0.3;
            this.doubletime = true;
            this.show_traces = true;
        }
        for (const trace of this.traces) {
            trace.visible = this.show_traces;
        }

        for (const marker of this.markers) {
            marker.visible = this.show_traces;
        }
        this.state_change_clock.start();
    }

    handle_sync(t, bpm, beat) {
        this.sync_clock.start();
        const edge_margin = this.trace_spacing / this.line_length;
        for (let i = 0; i < this.signals.length; i++) {
            const target_freq = clamp(
                (Math.round(this.signals[i].freq * this.num_divisions) +
                rand_int(-2, 3)) / this.num_divisions, edge_margin, 1 - edge_margin);
            this.signals[i].goto_freq(target_freq);
        }
        if (beat % 1 == 0) {
            for (const signal of this.signals) {
                if (signal.amp == this.ceiling_height * 2) {
                    const marker = this.markers[this.cur_marker_idx];
                    this.cur_marker_idx = (this.cur_marker_idx + 1) % this.markers.length;
                    marker.position.x = (signal.get_whole_freq(this.num_points) - 0.5) * this.line_length;
                    marker.material.opacity = 1.0;
                    marker.position.z = this.line.position.z;
                }
            }



            if (this.traces.length >= this.max_num_traces) {
                const trace = this.traces.shift();
                trace.position.z = this.line.position.z;
                trace.material.opacity = 1.0;
                trace.geometry.getAttribute('position').array = this.positions.slice();
                trace.geometry.getAttribute('position').needsUpdate = true;
                trace.visible = this.show_traces;
                this.traces.push(trace);
            } else {
                const trace = this.line.clone();
                trace.material = new THREE.LineBasicMaterial({ color: "cyan", linewidth: 1, transparent: true });
                trace.geometry = new THREE.BufferGeometry();
                trace.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions.slice(), 3));
                trace.visible = this.show_traces;
                this.traces.push(trace);
                this.base_group.add(trace);
            }
        }
    }

    handle_beat(t, channel) {
    }
}
