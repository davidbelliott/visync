import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    create_instanced_cube,
    ShaderLoader,
    BeatClock
} from './util.js';
import { InstancedGeometryCollection } from './instanced_geom.js';

const COLOR_CHANGE_RATES = [0.00, 0.00, 0.04, 0.08];
const START_COLOR = new THREE.Color("red");

class PaddleGroup extends THREE.Group {
    constructor(parent_scene, drum_indices) {
        super();
        this.parent_scene = parent_scene;
        this.cur_drum_idx = drum_indices;

        const loaders = {
            'stl/drumbox-paddle-top.stl': new STLLoader(),
            'stl/drumbox-paddle-side-0.stl': new STLLoader(),
        };
        const stl_load_promises = [];
        for (const [key, loader] of Object.entries(loaders)) {
            stl_load_promises.push(loader.loadAsync(key));
        }

        this.shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = this.shader_loader.load();
        Promise.all([...stl_load_promises, shader_load_promise]).then((results) => {
            const geometries = results.slice(0, -1);
            const dither_pars = results[results.length - 1][0];
            const dither = results[results.length - 1][1];
            const paddle_mat = new THREE.MeshLambertMaterial({
                color: "white",
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
                transparent: true,
                opacity: 0.90,
            });
            const paddle_wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1, transparent: true } );
            const side_paddle_wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1, transparent: true } );

            for (const mat of [paddle_mat]) {
                mat.onBeforeCompile = (shader) => {
                    shader.fragmentShader =
                        shader.fragmentShader.replace(
                            '#include <dithering_pars_fragment>',
                            dither_pars
                        ).replace(
                            '#include <dithering_fragment>',
                            dither
                        );
                };
            }

            // Create instanced geometry collections

            // Top paddle
            {
                let top_paddle = new THREE.Mesh(geometries[0], paddle_mat);
                this.top_paddle.scale.multiplyScalar(1 / 8);
                let top_paddle_edges = new THREE.EdgesGeometry(geometries[0], 30);
                this.top_paddle_edges.scale.multiplyScalar(1 / 8);

                this.inst_geom_top_paddle = new InstancedGeometryCollection(this.drums_group, top_paddle, 'Triangles', this.num_per_side * this.num_per_side);

                this.inst_geom_top_paddle_edges = new InstancedGeometryCollection(this.drums_group, top_paddle_edges, 'Lines', this.num_per_side * this.num_per_side);
            }



            this.light = new THREE.PointLight("white", 40);
            this.light.position.set(0, 0, 24);
            this.light2 = new THREE.PointLight("white", 1);
            this.light2.position.set(0, 0, 100);
            this.top_paddle.add(this.light);
            this.top_paddle.add(this.light2);
            this.add(this.top_paddle);

            // Side paddles
            {
                this.side_paddles = [];
                let side_paddle_edges = new THREE.EdgesGeometry(geometries[1], 30);
                const side_paddle = new THREE.Mesh(geometries[1], paddle_mat);
                side_paddle.add(new THREE.LineSegments(side_paddle_edges, side_paddle_wireframe_mat));
                side_paddle.scale.multiplyScalar(1 / 8);
                for (let i = 0; i < 4; i++) {
                    const this_side_paddle = side_paddle.clone();
                    const offset = new THREE.Vector3(1/2, 1/2, 1/2);
                    offset.applyAxisAngle(new THREE.Vector3(0, 0, 1), i * Math.PI / 2);
                    offset.multiplyScalar(4);
                    this_side_paddle.rotation.z = i * Math.PI / 2;
                    this_side_paddle.position.add(offset);
                    this.side_paddles.push(this_side_paddle);
                    this.add(this_side_paddle);
                }
            }

            this.initialized = true;
        });

        // Last jump axis: 0 = x, 1 = y
        this.last_jump_axis = 0;

        // Physical constants for paddles
        this.top_paddle_strike_vel = 80;
        this.side_paddle_strike_vel = 20;

        this.top_paddle_pound_time = 0.08;
        this.side_paddle_pound_time = 0.15;
        this.movement_time_secs = 0.25;
        this.impacts = [];

        this.clock = new THREE.Clock(true);
        this.cur_state_idx = 0;
        this.in_position = false;

        this.movement_clock = new THREE.Clock(false);
        this.movement_clock.start();

        this.retreat_pos = new THREE.Vector3(40, 40, 0);
        this.movement_start_pos = this.retreat_pos.clone();
        this.movement_end_pos = this.retreat_pos.clone();
        this.retreat_movement_secs = 4;
        this.time_for_this_movement = this.retreat_movement_secs;
    }


    paddle_pos(t_till_impact, target_drum_z) {
        const t = t_till_impact;
        const plain_pos = 4 * (Math.abs(t + 0.5) - 0.5);
        if (plain_pos > target_drum_z) {
            return [plain_pos, false];
        } else {
            return [target_drum_z, true];
        }
    }
    
    side_paddle_pos(t_till_impact) {
        const t = t_till_impact;
        return 4 * (1 - (Math.abs(clamp(2 * t, -1, 1)) - 1) ** 2);
    }

    paddle_group_movement_y(t) {
        return 6 * (1 - (2 * t - 1) ** 2);
    }

    offset_by(offset) {
        this.movement_start_pos.add(offset);
        this.movement_end_pos.add(offset);
        this.cur_drum_idx[0] = (this.cur_drum_idx[0] + Math.round(offset.x / this.parent_scene.spacing)) % this.parent_scene.num_per_side;
        this.cur_drum_idx[1] = (this.cur_drum_idx[1] + Math.round(offset.y / this.parent_scene.spacing)) % this.parent_scene.num_per_side;
    }

    anim_frame(dt) {
        // Discard old impacts
        while (this.impacts.length > 0 &&
                this.impacts[0][0] < -16 * this.top_paddle_pound_time) {
            this.impacts.shift();
        }

        if (!this.initialized) {
            return;
        }

        const target_drum_z = this.parent_scene.get_drum_z_from_instance_idx(this.cur_drum_idx[0], this.cur_drum_idx[1]);

        const frac = clamp(
            this.movement_clock.getElapsedTime() / this.time_for_this_movement, 0, 1);
        this.position.lerpVectors(this.movement_start_pos, this.movement_end_pos, frac);
        this.position.z = this.paddle_group_movement_y(frac);


        let top_paddle_pos = this.paddle_pos(1, target_drum_z)[0];
        let side_paddle_pos = this.side_paddle_pos(1, 0);

        this.in_position = this.cur_state_idx != 0 && frac > 0.9;

        for (let i = 0; i < this.impacts.length; i++) {
            const new_time = this.impacts[i][0] - dt;
            if (this.in_position && this.impacts[i][0] >= 0 && new_time < 0) {
                // Impact on target drum
                let strike_vel = 0;
                if (this.impacts[i][1] == 1 || this.impacts[i][1] == 3) {
                    strike_vel = this.top_paddle_strike_vel;
                } else if (this.impacts[i][1] == 2) {
                    strike_vel = this.side_paddle_strike_vel;
                }
                const instance_idx = this.parent_scene.instance_idx_from_drum_coords(this.cur_drum_idx[0], this.cur_drum_idx[1]);
                let new_vel = this.parent_scene.drum_velocities[instance_idx];
                new_vel -= strike_vel;
                new_vel = clamp(new_vel, -this.top_paddle_strike_vel, this.top_paddle_strike_vel);
                this.parent_scene.drum_velocities[instance_idx] = new_vel;
                // It now takes a normal # of beats to move between drums
                this.time_for_this_movement = this.movement_time_secs;
            }
            this.impacts[i][0] = new_time;

            if (this.in_position) {
                // Look at channel associated with the upcoming impact
                if (this.impacts[i][1] == 1 || this.impacts[i][1] == 3) {
                    top_paddle_pos = Math.min(top_paddle_pos, this.paddle_pos(
                        this.impacts[i][0] / this.top_paddle_pound_time,
                        target_drum_z)[0]);
                } else if (this.impacts[i][1] == 2) {
                    side_paddle_pos = Math.min(side_paddle_pos, this.side_paddle_pos(
                        this.impacts[i][0] / this.side_paddle_pound_time));
                }
            }
        }

        // Apply offsets to objects
        this.top_paddle.position.z = top_paddle_pos;
        this.rotation.z = this.parent_scene.get_drum_rotation_from_instance_idx(this.cur_drum_idx[0], this.cur_drum_idx[1]);

        for (let i = 0; i < 4; i++) {
            const offset = new THREE.Vector3(1/2, 1/2, 1/2);
            offset.applyAxisAngle(new THREE.Vector3(0, 0, 1), i * Math.PI / 2);
            offset.multiplyScalar(side_paddle_pos);
            this.side_paddles[i].position.copy(offset);
        }
    }

    start() {
        this.movement_start_pos.copy(this.position);
        this.movement_end_pos.copy(this.parent_scene.drum_pos_in_array(...this.cur_drum_idx));
        this.beats_for_this_movement = this.retreat_movement_beats;
        this.movement_clock.start();
        this.cur_state_idx = 1;
    }

    retreat() {
        this.movement_start_pos.copy(this.position);
        this.movement_end_pos.copy(this.retreat_pos);
        this.beats_for_this_movement = this.retreat_movement_beats;
        this.movement_clock.start();
        this.cur_state_idx = 0;
    }

    handle_sync(t, bpm, beat) {
        if (this.in_position) {
            if (beat % 4 == 3) {
                // Do a jump
                this.last_jump_axis = (this.last_jump_axis + 1) % 2;
                this.cur_drum_idx[this.last_jump_axis] -= 1;
                if (this.cur_drum_idx[this.last_jump_axis] < 0) {
                    this.cur_drum_idx[this.last_jump_axis] += this.parent_scene.num_per_side;
                } else {
                    this.movement_clock.start();
                }
                this.movement_start_pos.copy(this.position);
                this.movement_end_pos.copy(this.parent_scene.drum_pos_in_array(
                    this.cur_drum_idx[0], this.cur_drum_idx[1]));
            }
        }
    }
}

export class DrumboxScene extends VisScene {
    constructor() {
        super(3);
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.frustum_size = 60;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.clock = new THREE.Clock();
        this.initialized = false;

        this.drums = [];
        this.drum_velocities = [];
        this.drum_rotations = [];
        this.paddle_groups = [];

        this.base_group = new THREE.Group();
        this.drums_group = new THREE.Group();
        this.base_group.add(this.drums_group);

        this.drift_vels = [0, 2, 5];
        this.drift_vel = this.drift_vels[0];

        const loaders = {
            'stl/truncated-cuboctahedron.stl': new STLLoader(),
        };
        const stl_load_promises = [];
        for (const [key, loader] of Object.entries(loaders)) {
            stl_load_promises.push(loader.loadAsync(key));
        }

        this.shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = this.shader_loader.load();
        this.spacing = 16;
        this.num_per_side = 12;
        
        Promise.all([...stl_load_promises, shader_load_promise]).then((results) => {
            const geometries = results.slice(0, -1);
            const dither_pars = results[results.length - 1][0];
            const dither = results[results.length - 1][1];
            this.drum_mat = new THREE.MeshLambertMaterial({
                color: START_COLOR,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
                transparent: true,
                opacity: 0.9,
            });
            this.wireframe_mat = new THREE.LineBasicMaterial( { color: START_COLOR, linewidth: 1, transparent: true } );

            for (const mat of [this.drum_mat]) {
                mat.onBeforeCompile = (shader) => {
                    shader.fragmentShader =
                        shader.fragmentShader.replace(
                            '#include <dithering_pars_fragment>',
                            dither_pars
                        ).replace(
                            '#include <dithering_fragment>',
                            dither
                        );
                };
            }

            // Setup instanced geometry
            const edges = new THREE.EdgesGeometry(geometries[0], 30);
            this.inst_geom_drum = new InstancedGeometryCollection(this.drums_group, geometries[0], 'Triangles', this.num_per_side * this.num_per_side);
            this.inst_geom_edges = new InstancedGeometryCollection(this.drums_group, edges, 'Lines', this.num_per_side * this.num_per_side);


            // Create drums
            for (let i = 0; i < this.num_per_side; i++) {
                for (let j = 0; j < this.num_per_side; j++) {
                    const pos = this.drum_pos_in_array(i, j);
                    this.drum_velocities.push(0);
                    this.drum_rotations.push(0);
                    
                    // Create instanced drums
                    const scale = new THREE.Vector3(1/8, 1/8, 1/8);
                    this.inst_geom_drum.create_geom(pos, this.drum_mat.color, scale);
                    this.inst_geom_edges.create_geom(pos, this.wireframe_mat.color, scale);

                    if (i % 2 == 0 && j % 2 == 0) {
                        //const paddle_group = new PaddleGroup(this.inst_geom_paddles, this, [i, j]);
                        //this.paddle_groups.push(paddle_group);
                    }
                }
            }
            this.initialized = true;
        });

        // Physical constants for drums
        this.damping_coeff = 2;
        this.spring_constant = 200;

        this.drums_group.rotation.z = Math.PI / 4;
        this.camera.rotation.x = Math.PI / 4;

        this.scene = new THREE.Scene();
        this.scene.add(this.base_group);

        this.directional_light = new THREE.DirectionalLight("white", 0.2);
        this.directional_light.position.set(0, 0, 100);

        this.color_hue = 0.0;
        this.clock = new THREE.Clock(true);

        // Camera zooming
        this.zoom_clock = new BeatClock(this);
        this.start_zoom = 1;
        this.target_zoom = 1;
        this.zoom_movement_beats = 1;
    }

    get_palette_color(t) {
        const a = [0.5, 0.5, 0.5];
        const b = [0.5, 0.5, 0.5];
        const c = [2.0, 1.0, 0.0];
        const d = [0.5, 0.2, 0.25];

        const out = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            out[i] = a[i] + b[i] * Math.cos(2 * Math.PI * ( c[i] * t + d[i] ) );
        }
        return new THREE.Color(...out);
    }

    drum_spring_accel(x, v) {
        return -this.damping_coeff * v - this.spring_constant * x;
    }

    drum_pos_in_array(i, j) {
        return new THREE.Vector3(
            this.spacing * (i - this.num_per_side / 2),
            this.spacing * (j - this.num_per_side / 2),
            0);
    }

    instance_idx_from_drum_coords(i, j) {
        return i * this.num_per_side + j;
    }

    get_drum_z_from_instance_idx(i, j) {
        const instance_idx = this.instance_idx_from_drum_coords(i, j);
        if (!this.initialized || instance_idx >= this.drum_velocities.length) {
            return 0;
        }
        const pos = this.inst_geom_drum.get_pos(instance_idx);
        return pos.z;
    }

    get_drum_rotation_from_instance_idx(i, j) {
        const instance_idx = this.instance_idx_from_drum_coords(i, j);
        if (!this.initialized || instance_idx >= this.drum_rotations.length) {
            return 0;
        }
        return this.drum_rotations[instance_idx];
    }

    anim_frame(dt) {
        if (!this.initialized) {
            return;
        }

        this.drums_group.position.z += this.drift_vel * dt;

        // Update paddle groups
        for (const paddle_group of this.paddle_groups) {
            paddle_group.anim_frame(dt);
        }

        // Update drum positions
        const num_instances = this.inst_geom_drum.instancedGeometry.instanceCount;
        for (let idx = 0; idx < num_instances; idx++) {
            // Update position
            const position = this.inst_geom_drum.get_pos(idx);
            position.z += this.drum_velocities[idx] * dt;
            this.drum_velocities[idx] += this.drum_spring_accel(position.z, this.drum_velocities[idx]) * dt;
            this.inst_geom_drum.set_pos(idx, position);
            this.inst_geom_edges.set_pos(idx, position);
            
            // Update rotation
            this.drum_rotations[idx] += 0.01;
            this.inst_geom_drum.set_rotation(idx, this.drum_rotations[idx]);
            this.inst_geom_edges.set_rotation(idx, this.drum_rotations[idx]);
        }

        // Handle drum drift and wrapping
        const max_offset = this.spacing + this.spacing;
        if (this.drums_group.position.z > max_offset) {
            this.drums_group.position.z -= max_offset;
            for (const g of this.paddle_groups) {
                g.move_system(new THREE.Vector3(0, 0, max_offset));
            }
            for (let i = this.num_per_side - 1; i > 0; i--) {
                for (let j = 0; j < this.num_per_side; j++) {
                    const from_idx = this.instance_idx_from_drum_coords(i - 1, j);
                    const to_idx = this.instance_idx_from_drum_coords(i, j);
                    
                    this.drum_velocities[to_idx] = this.drum_velocities[from_idx];
                    this.drum_rotations[to_idx] = this.drum_rotations[from_idx];
                    
                    // Update position z value
                    const pos = this.inst_geom_drum.get_pos(to_idx);
                    const from_pos = this.inst_geom_drum.get_pos(from_idx);
                    pos.z = from_pos.z;
                    this.inst_geom_drum.set_pos(to_idx, pos);
                    this.inst_geom_edges.set_pos(to_idx, pos);
                }
            }
        }

        // Change color of materials
        this.color_hue += dt * COLOR_CHANGE_RATES[this.cur_state_idx];
        const color = START_COLOR.clone();
        const color_offset = new THREE.Color();
        color_offset.setHSL(this.color_hue % 1, 1, 0.5);
        color.add(color_offset);
        
        // Update all instance colors
        for (let idx = 0; idx < num_instances; idx++) {
            this.inst_geom_drum.set_color(idx, color);
            this.inst_geom_edges.set_color(idx, color);
        }

        // Update camera zoom
        const zoom_frac = ease(Math.min(1, this.zoom_clock.getElapsedBeats() / this.zoom_movement_beats));
        const new_zoom = lerp_scalar(this.start_zoom, this.target_zoom, zoom_frac);
        if (new_zoom != this.cam_orth.zoom) {
            this.cam_orth.zoom = new_zoom;
            this.cam_orth.updateProjectionMatrix();
        }
    }

    handle_beat(t, channel) {
        if (this.active) {
            const time_till_impact = this.get_beat_delay(t);
            for (const paddle_group of this.paddle_groups) {
                paddle_group.impacts.push([time_till_impact, channel]);
            }
        }
    }

    handle_sync(t, bpm, beat) {
        for (const paddle_group of this.paddle_groups) {
            paddle_group.handle_sync(t, bpm, beat);
        }
        if (beat % 8 == 0) {
            this.target_zoom = Math.random() * 0.5 + 0.85;
            this.start_zoom = this.cam_orth.zoom;
            this.zoom_clock.start();
        }
    }

    state_transition(old_state_idx, new_state_idx) {
        if (old_state_idx == 0 && new_state_idx == 1) {
            for (const paddle_group of this.paddle_groups) {
                paddle_group.start();
            }
        } else if (new_state_idx == 0) {
            for (const paddle_group of this.paddle_groups) {
                paddle_group.retreat();
            }
        }
        this.drift_vel = this.drift_vels[this.cur_state_idx];
    }
}
