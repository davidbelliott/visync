import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { lerp_scalar, ease } from './util.js';

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

class Excitation extends THREE.Object3D {
    constructor(init_time) {
        super();
        this.init_time = init_time;
    }
}

class Gantry {
    constructor(parent_scene, parent_obj, cubes_arr, width, env) {
        const start_pos = new THREE.Vector3(0, 6, 0);
        this.base_y = start_pos.y;
        this.paddle_base_y = -1.0;

        this.pound_motion_beats = 0.25;

        this.parent_obj = parent_obj;
        this.clock = new THREE.Clock(false);
        this.move_clock = new THREE.Clock(false);
        this.pound_clock = new THREE.Clock(false);
        this.start_sweep_time = null;
        this.end_sweep_time = null;
        this.start_sweep_pos = new THREE.Vector3();
        this.start_sweep_pos.copy(start_pos);
        this.end_sweep_pos = new THREE.Vector3();
        this.end_sweep_pos.copy(start_pos);
        this.segments = [];
        this.time_waypoints = [];
        // Paddle part
        this.mover = new THREE.Group();
        this.paddle = create_instanced_cube([3, 1, 3], "white");
        this.paddle.position.y = this.paddle_base_y;
        this.mover.add(this.paddle);

        this.cube_top = create_instanced_cube([1, 1, 1], "white");
        this.mover.add(this.cube_top);

        this.vertical_beam = create_instanced_cube([0.5, 6.0, 0.5], "white");
        this.vertical_beam.position.y = 3.5;
        this.paddle.add(this.vertical_beam);

        this.mover.position.copy(start_pos);
        parent_obj.add(this.mover);
        this.parent_scene = parent_scene;

        this.x_beam = create_instanced_cube([width, 0.5, 0.5], "white");
        this.x_beam.position.copy(start_pos);
        this.x_beam.position.x = 0;
        parent_obj.add(this.x_beam);

        this.cubes_arr = cubes_arr;
        this.env = env;

        this.clock.start();
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        const sweep_beats = 2;

        // Sweeping
        {
            let frac = Math.min(1, this.move_clock.getElapsedTime() * beats_per_sec / sweep_beats);

            let cur_seg = 0;
            let frac_seg = frac;
            let start_offset = new THREE.Vector3(0, 0, 0);
            let end_offset = start_offset.clone();
            this.time_waypoints.every((t, i) => {
                if (t >= frac || i == this.time_waypoints.length - 1) {
                    cur_seg = i;
                    if (t > 0.01) {
                        frac_seg = frac / t;
                    }
                    end_offset.copy(start_offset);
                    end_offset.add(this.segments[i]);
                    return false;
                }
                start_offset.add(this.segments[i]);
                frac -= t;
                return true;
            });
            start_offset.lerp(end_offset, frac_seg);
            start_offset.add(this.start_sweep_pos);
            this.set_cube_xz(start_offset);
        }

        // Pounding
        {
            const t = this.pound_clock.getElapsedTime() * beats_per_sec / this.pound_motion_beats;
            let start_y = this.paddle_base_y;
            let end_y = -4.0;
            const frac = (1 - Math.abs(Math.min(2, Math.max(0, t)) - 1)) ** 2;
            this.paddle.position.y = lerp_scalar(start_y, end_y, frac);
        }
    }

    set_cube_target_idx(i, j) {
        const pos = this.cubes_arr[i][j].position;
        this.target_indices = [i, j];
        this.end_sweep_pos.copy(pos);
        this.end_sweep_pos.y = this.base_y;
        this.start_sweep_pos.copy(this.mover.position);

        this.segments = this.segmentize_path_45deg(
            this.end_sweep_pos.clone().sub(this.start_sweep_pos));

        this.time_waypoints = [];
        let total_length = 0;
        for (const seg of this.segments) {
            total_length += seg.length();
        }
        for (const seg of this.segments) {
            let this_seg = seg.length() / total_length;
            if (isNaN(this_seg)) {
                this_seg = 0;
            }
            this.time_waypoints.push(this_seg);
        }
    }

    set_cube_xz(pos) {
        this.mover.position.x = pos.x;
        this.mover.position.z = pos.z;
        this.x_beam.position.z = pos.z;
    }

    move_system(offset) {
        this.mover.position.add(offset);
        this.x_beam.position.add(offset);
        this.start_sweep_pos.add(offset);
        this.end_sweep_pos.add(offset);
    }

    segmentize_path_45deg(offset) {
        const smallest_component = Math.min(Math.abs(offset.x), Math.abs(offset.z));
        const segments = [];
        segments.push(new THREE.Vector3(
            Math.sign(offset.x) * smallest_component,
            0,
            Math.sign(offset.z) * smallest_component));
        segments.push(offset.clone().sub(segments[0]));
        return segments;
    }

    start_pound() {
        console.log("HIT");
        const beats_per_sec = this.env.bpm / 60;
        this.pound_clock.start();
        setTimeout(() => {
            this.parent_scene.add_excitation(new THREE.Vector3(
                this.mover.position.x, 0, this.mover.position.z));
        }, 1000 / beats_per_sec * this.pound_motion_beats);
    }
}


export class GantryScene extends VisScene {
    constructor(env) {
        super(env);

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 16;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.half_beat_clock = new THREE.Clock(false);
        this.beat_clock = new THREE.Clock(false);
        this.beat_idx = 0;

        this.base_group = new THREE.Group();
        this.cubes_group = new THREE.Group();
        this.cubes = [];

        this.starting_scales = [];
        this.target_scales = [];
        this.cube_base_size = 3;
        this.cube_base_spacing = 1;
        this.drift_vel = 3.0;

        this.num_cubes_per_side = 10;


        this.excitations = [];



        const width = this.num_cubes_per_side * this.cube_base_size + 
            (this.num_cubes_per_side - 1) * this.cube_base_spacing;
        const center_offset = -(width - this.cube_base_size) / 2;
        for (let i = 0; i < this.num_cubes_per_side; i++) {
            const cube_row = [];
            const target_scale_row = [];
            const starting_scale_row = [];
            for (let j = 0; j < this.num_cubes_per_side; j++) {
                let position = new THREE.Vector3(
                    j * (this.cube_base_size + this.cube_base_spacing) + center_offset,
                    0,
                    i * (this.cube_base_size + this.cube_base_spacing) + center_offset);
                const cube_mesh = create_instanced_cube(Array(3).fill(this.cube_base_size), "cyan");
                cube_mesh.position.copy(position);
                cube_row.push(cube_mesh);
                starting_scale_row.push(1);
                target_scale_row.push(1);
                this.cubes_group.add(cube_mesh);
            }
            this.cubes.push(cube_row);
            this.starting_scales.push(starting_scale_row);
            this.target_scales.push(target_scale_row);
        }
        
        this.gantry = new Gantry(this, this.cubes_group, this.cubes, width, this.env);

        this.base_group.rotation.x = Math.PI / 8.0;
        this.base_group.rotation.y = Math.PI / 4.0;
        //this.base_group.rotation.x = Math.PI / 2.0;

        this.base_group.add(this.cubes_group);
        this.scene.add(this.base_group);

        this.camera = this.cam_orth;


        this.marker_cube = create_instanced_cube(Array(3).fill(1), "yellow");
        this.marker_cube.position.set(0, 6, 0);
        this.cubes_group.add(this.marker_cube);

    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        const cube_moves_per_beat = 4;
        let beat_time = Math.min(1, this.gantry.move_clock.getElapsedTime() * beats_per_sec * cube_moves_per_beat);


        //this.cubes_group.position.z += this.drift_vel * dt;
        //
        //this.base_group.rotation.y += 0.1 * dt;
        const max_offset = this.cube_base_size + this.cube_base_spacing;
        if (this.cubes_group.position.z > max_offset) {
            this.cubes_group.position.z -= max_offset;
            this.gantry.move_system(new THREE.Vector3(0, 0, max_offset));
            this.marker_cube.position.z += max_offset;
            for (let i = this.num_cubes_per_side - 1; i > 0; i--) {
                for (let j = 0; j < this.num_cubes_per_side; j++) {
                    this.target_scales[i][j] = this.target_scales[i - 1][j];
                    this.starting_scales[i][j] = this.starting_scales[i - 1][j];
                    //this.cubes[i][j].scale.y = this.cubes[i - 1][j].scale.y;
                }
            }

            for (const i in this.excitations) {
                this.excitations[i].position.z += max_offset;
            }
        }
        const elapsed_time = this.clock.getElapsedTime();
        const elapsed_beats = elapsed_time * beats_per_sec;
        for (let i = 0; i < this.num_cubes_per_side; i++) {
            for (let j = 0; j < this.num_cubes_per_side; j++) {
                /*this.cubes[i][j].scale.y = lerp_scalar(
                    this.starting_scales[i][j],
                    this.target_scales[i][j],
                    beat_time);*/
                let y_offset = 0.0;
                const keep_excitations = [];
                for (const e of this.excitations) {
                    const t = (elapsed_time - e.init_time) * beats_per_sec;
                    const cube_pos = this.cubes[i][j].position.clone();
                    cube_pos.y = 0;
                    const x = cube_pos.distanceTo(e.position);
                    y_offset -= Math.sin(Math.max(0, Math.min(2 * Math.PI,
                        -0.25 * x + 2 * Math.PI * t))) * Math.exp(-0.5 * t);
                }
                /*for (ex_idx < this.excitations.length) {
                    const e = this.excitations.pop();
                    this.cubes_group.remove(e);
                }*/
                this.cubes[i][j].position.y = y_offset;
            }
        }

        this.gantry.anim_frame(dt);
    }

    handle_sync(t, bpm, beat) {
        this.beat_idx++;
        //if (this.beat_idx % 2 == 0) {
        this.beat_clock.start();
        //}
        const elapsed_time = this.clock.getElapsedTime();
        if (beat == 0) {
            const cube_idx_i = Math.floor((0.2 + Math.random() * 0.4) * this.num_cubes_per_side);
            const cube_idx_j = Math.floor((0.2 + Math.random() * 0.4) * this.num_cubes_per_side);
            //.this.gantry.set_cube_target_pos(this.cubes[cube_idx_i][cube_idx_j].position);

            /*for (let i = 0; i < this.num_cubes_per_side; i++) {
                for (let j = 0; j < this.num_cubes_per_side; j++) {
                    this.starting_scales[i][j] = this.target_scales[i][j];
                    let target_scale = Math.random() < 0.25 ? 2 : 1.0;
                    this.target_scales[i][j] = target_scale;
                }
            }*/
            //this.target_scales[cube_idx_i][cube_idx_j] = 2;
            this.gantry.set_cube_target_idx(cube_idx_i, cube_idx_j);
            this.marker_cube.position.copy(this.cubes[cube_idx_i][cube_idx_j].position);
            this.marker_cube.position.y = 2;
            this.gantry.move_clock.start();
        }
    }

    handle_beat(t, channel) {
        if (channel == 0) {
            this.gantry.start_pound();
        }
    }

    add_excitation(pos) {
        const t = this.clock.getElapsedTime();
        const excitation = new Excitation(t);
        excitation.position.copy(pos);
        excitation.position.y = 0;
        this.excitations.push(excitation);
        this.cubes_group.add(excitation);
    }
}
