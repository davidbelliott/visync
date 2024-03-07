import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    create_instanced_cube,
    make_wireframe_rectangle,
    make_wireframe_cone,
    make_wireframe_circle,
    make_line,
    ShaderLoader,
    Spark,
    BeatClock
} from './util.js';
import { BoxDef } from './geom_def.js';


const RobotParts = {
    TORSO: 0,
    LEGS: [1, 2],
    HEAD: 3,
    HANDS: [4, 5],
    FEET: [6, 7],
    ARMS: [8, 9],
    EYES: 10,
    MAX: 11
}

function cube_at(pos, dims, color="white") {
    const created_mesh = create_instanced_cube(dims, color);
    created_mesh.position.set(...pos);
    return created_mesh;
}

class Robot extends THREE.Object3D {
    constructor(shoe_mesh, spinner_phase_offset) {
        super();
        this.arm_base_y = 0.0;
        this.body_base_y = 1.0;
        this.foot_base_y = -3.0;
        this.foot_base_z = 0.0;
        this.spinners = [
            cube_at([-0.5, 0, 1.25], [0.5, 0.5, 5.0]),
            cube_at([+0.5, 0, 1.25], [0.5, 0.5, 5.0])
        ];
        this.arms = [
            cube_at([-2.25, this.arm_base_y, 1.5], [0.5, 1.0, 3.0]),
            cube_at([+2.25, this.arm_base_y, 1.5], [0.5, 1.0, 3.0])
        ];
        this.eyes = cube_at([0, 0, 1.125], [2.0, 0.25, 0.25]);
        this.head = cube_at([0, 2.5, 0], [3, 1, 2]);
        this.head.add(this.eyes);
        this.torso = cube_at([0, this.body_base_y, 0], [4, 2, 2]);
        //this.head.add(this.eyes);
        this.torso.add(this.head);
        for (let i = 0; i < 2; i++) {
            this.arms[i].add(this.spinners[i]);
            this.spinners[i].rotation.x = spinner_phase_offset;
            this.torso.add(this.arms[i]);
        }

        this.feet = [];
        for (let i = 0; i < 2; i++) {
            const this_shoe = shoe_mesh.clone();
            this_shoe.position.set(1.5 * (2 * i - 1), this.foot_base_y, this.foot_base_z);
            this.torso.add(this_shoe);
            this.feet.push(this_shoe);
        }
        this.add(this.torso);

        this.clock = new THREE.Clock(true);

        this.throw_height = 8.0;
        this.throw_movement_beats = 4;
    }

    anim_frame(dt, half_beat_time, throw_time, bpm) {
        const beats_per_sec = bpm / 60;
        const elapsed = this.clock.getElapsedTime();

        const body_offset = this.get_body_shuffle_offset(half_beat_time);
        const arms_offset = this.get_arms_pump_offset(half_beat_time);

        const throw_frac = clamp(throw_time / this.throw_movement_beats, 0, 1);
        let cur_throw_y = this.throw_height * (1 - (2 * throw_frac - 1) ** 2);
        if (throw_frac > 0 && throw_frac < 1) {
            cur_throw_y - arms_offset;
        }

        for (let i = 0; i < 2; i++) {
            this.spinners[i].rotation.x += Math.PI * dt * beats_per_sec;
            this.spinners[i].position.y = cur_throw_y;
            this.spinners[i].material.color.setHSL(Math.sin(this.spinners[i].rotation.x / 32), 1, 0.5);
        }

        for (let side = 0; side < 2; side++) {
            const shuffle_offset = this.get_foot_shuffle_offset(side, half_beat_time);
            this.feet[side].position.y = this.foot_base_y + shuffle_offset[1];
            this.feet[side].position.z = this.foot_base_z + shuffle_offset[2];
            this.torso.position.y = this.body_base_y + body_offset;
            this.arms[side].position.y = this.arm_base_y + arms_offset;
        }
    }


    is_foot_forward(side_idx, t) {
        const t_period = 1.0 / 4.0;
        const pos_idx = (Math.floor(t / t_period) + 2 * side_idx) % 4;
        return (pos_idx == 1 || pos_idx == 2);
    }

    get_foot_shuffle_offset(side_idx, t) {
        // get shuffle offset for this side as an array [x, y, z]
        // side_idx: 0 for left, 1 for right
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            [0, ease(Math.min(1, dt / t_mov)), ease(Math.min(0, -1 + dt / t_mov))],
            [0, ease(Math.max(0, 1 - dt / t_mov)), ease(Math.min(1, dt / t_mov))],
            [0, 0, ease(Math.max(0, 1 - dt / t_mov))],
            [0, 0, ease(Math.max(-1, -dt / t_mov))]];
        /*const pos_idx = (Math.floor(t / t_period) +
            ((side_idx + beat_idx) % 2) * 2) % position_options.length;*/
        const pos_idx = (Math.floor(t / t_period) + 2 * side_idx) % position_options.length;
        return position_options[pos_idx];
    }

    get_body_shuffle_offset(t) {
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            ease(Math.min(1, dt / t_mov)),
            ease(Math.max(0, 1 - dt / t_mov))];
        /*const pos_idx = (Math.floor(t / t_period) +
            ((side_idx + beat_idx) % 2) * 2) % position_options.length;*/
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.8;
    }

    get_arms_pump_offset(t) {
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            ease(Math.min(1, dt / t_mov)),
            ease(Math.max(0, 1 - dt / t_mov))];
        /*const pos_idx = (Math.floor(t / t_period) +
            ((side_idx + beat_idx) % 2) * 2) % position_options.length;*/
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.6;
    }
}


export class SpinningRobotsScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_fg = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.camera = this.cam_fg;

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.base_group = new THREE.Group();

        this.curr_spacing = 8;
        this.robots_per_side = 10;
        this.robots = [];

        const this_class = this;

        const loader = new STLLoader();
        loader.load('stl/shoe.stl',
            function(geometry) {
                const wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );
                const fill_mat = new THREE.MeshBasicMaterial({
                    color: "black",
                    polygonOffset: true,
                    polygonOffsetFactor: 1, // positive value pushes polygon further away
                    polygonOffsetUnits: 1
                });
                const edges = new THREE.EdgesGeometry(geometry, 30);
                const mesh = new THREE.LineSegments(edges, wireframe_mat);
                const mesh_inner = new THREE.Mesh(geometry, fill_mat);
                mesh.add(mesh_inner);
                mesh.scale.set(0.01, 0.01, 0.01);
                mesh.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);


                for (let i = 0; i < this_class.robots_per_side; i++) {
                    for (let j = 0; j < this_class.robots_per_side; j++) {
                        const position = new THREE.Vector3((i - (this_class.robots_per_side - 1) / 2) * this_class.curr_spacing, 0,
                            (j - (this_class.robots_per_side - 1) / 2) * this_class.curr_spacing);
                        const robot = new Robot(mesh, Math.PI / 8 * (i + j));
                        robot.position.copy(position);
                        this_class.robots.push(robot);
                        this_class.base_group.add(robot);
                    }
                }

            },
            (xhr) => { },
            (error) => {
                console.log(error);
            }
        );

        this.scene.add(this.base_group);

        this.clock = new THREE.Clock(true);
        this.half_beat_clock = new BeatClock(this, false);
        this.throw_clock = new BeatClock(this, false);
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.base_group.rotation.y += 0.1 * dt;
        this.camera.rotation.x = -0.5 * (1 + Math.sin(this.clock.getElapsedTime() * 0.1)) * isom_angle;

        const half_beat_time = this.half_beat_clock.get_elapsed_beats() / 2.0;;
        const throw_time = this.throw_clock.get_elapsed_beats();
        for (const r of this.robots) {
            r.anim_frame(dt, half_beat_time, throw_time, this.get_local_bpm());
        }
    }

    handle_sync(t, bpm, beat) {
        if (beat % 2 == 0) {
            // half-note beat
            this.half_beat_clock.start();
        }
        if (beat % 16 == 0) {
            this.throw_clock.start();
        }
    }

    handle_beat(t, channel) {
    }
}
