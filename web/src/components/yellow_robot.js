import * as THREE from 'three';
import { Component } from './component.js';
import { BoxDef } from '../geom_def.js';
import {
    lerp_scalar,
    ease,
    make_wireframe_circle,
    BeatClock
} from '../util.js';


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


class Robot {
    constructor(parent_obj, position) {
        this.obj = new THREE.Group();
        this.meshes = Array(RobotParts.MAX);

        this.cube_defs = new Map();
        for (const side of [0, 1]) {
            const sign = (2 * side - 1);
            this.cube_defs[RobotParts.HANDS[side]] = new BoxDef([sign * -0.5, 0, 1], [0.5, 1, 1]);
            const arm_children = new Map([
                [RobotParts.HANDS[side], this.cube_defs[RobotParts.HANDS[side]]]
            ]);
            this.cube_defs[RobotParts.ARMS[side]] = new BoxDef([sign * 1.75, 0.5, 1.75], [0.5, 0.5, 2.0],
                "yellow", arm_children);
        }

        this.cube_defs[RobotParts.LEGS[0]] = new BoxDef([-0.75, -2, 0],
            [0.5, 1.5, 1.0]);
        this.cube_defs[RobotParts.LEGS[1]] = new BoxDef([0.75, -2, 0],
            [0.5, 1.5, 1.0]);
        this.cube_defs[RobotParts.EYES] = new BoxDef([0, 0, 1.125], [1.5, 0.25, 0.25]);

        const head_children = new Map([
            [RobotParts.EYES, this.cube_defs[RobotParts.EYES]]]);

        this.cube_defs[RobotParts.HEAD] = new BoxDef([0, 1.75, 0], [2.0, 1.0, 2.0],
            "yellow", head_children);

        const torso_children = new Map([
            [RobotParts.HEAD, this.cube_defs[RobotParts.HEAD]],
            [RobotParts.ARMS[0], this.cube_defs[RobotParts.ARMS[0]]],
            [RobotParts.ARMS[1], this.cube_defs[RobotParts.ARMS[1]]],
            [RobotParts.LEGS[0], this.cube_defs[RobotParts.LEGS[0]]],
            [RobotParts.LEGS[1], this.cube_defs[RobotParts.LEGS[1]]]]);

        this.cube_defs[RobotParts.TORSO] = new BoxDef([0, 1, 0], [3, 2, 1], "yellow", torso_children);

        this.cube_defs[RobotParts.FEET[0]] = new BoxDef([-0.75, -2, 0], [1.5, 0.5, 2.0]);
        this.cube_defs[RobotParts.FEET[1]] = new BoxDef([0.75, -2, 0], [1.5, 0.5, 2.0]);

        const offset = [0, -1, 0];
        for (const i of [RobotParts.TORSO, RobotParts.FEET[0], RobotParts.FEET[1]]) {
            for (const j in offset) {
                this.cube_defs[i].coords[j] += offset[j];
            }
        }

        for (const i of [RobotParts.TORSO, RobotParts.FEET[0], RobotParts.FEET[1]]) {
            let mesh = this.cube_defs[i].create();
            this.obj.add(mesh);
            this.meshes[i] = mesh;
        }
        this.obj.position.copy(position);
        parent_obj.add(this.obj);
    }
}


// A square grid of dancing yellow robots. `spread_x` / `spread_y` control the
// spacing between robots along each grid axis (0 = all robots overlap exactly),
// and `n_per_side` is the number of robots along each side of the square.
export class YellowRobot extends Component {
    constructor({ spread_x = 0, spread_y = 0, n_per_side = 3 } = {}) {
        super();

        this._spread_x = spread_x;
        this._spread_y = spread_y;
        this._n_per_side = n_per_side;

        this.half_beat_clock = new BeatClock(this);
        this.beat_clock = new BeatClock(this);

        this.robot_group = new THREE.Group();
        this.circle_group = new THREE.Group();
        // position circle group right below feet
        this.circle_group.position.y = -3.26;
        this.add(this.circle_group);
        this.add(this.robot_group);

        this.circle_scale_base = 0.1;
        this.circle_scale_max = 1.0;
        this.circle_scale = this.circle_scale_base;

        this.build();
    }

    // BeatClock pulls the local bpm from its parent_scene; delegate to the
    // scene this component has been added to.
    get_local_bpm() {
        return this.parent ? this.parent.get_local_bpm() : 120;
    }

    get spread_x() { return this._spread_x; }
    set spread_x(v) { this._spread_x = v; }

    get spread_y() { return this._spread_y; }
    set spread_y(v) { this._spread_y = v; }

    get n_per_side() { return this._n_per_side; }
    set n_per_side(v) {
        if (v !== this._n_per_side) {
            this._n_per_side = v;
            this.build();
        }
    }

    // (Re)create the grid of robots and their ground circles.
    build() {
        this.robot_group.clear();
        this.circle_group.clear();
        this.robots = [];
        this.circles = [];

        for (let i = 0; i < this._n_per_side; i++) {
            for (let j = 0; j < this._n_per_side; j++) {
                const position = this.grid_position(i, j);
                this.robots.push(new Robot(this.robot_group, position));

                const circle = make_wireframe_circle(6, 32, new THREE.Color("cyan"));
                circle.position.copy(position);
                circle.rotation.x = Math.PI / 2.0;
                this.circles.push(circle);
                this.circle_group.add(circle);
            }
        }
    }

    // Centered grid position for the robot at column i, row j.
    grid_position(i, j) {
        const center = (this._n_per_side - 1) / 2;
        return new THREE.Vector3(
            (i - center) * this._spread_x, 0,
            (j - center) * this._spread_y);
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
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.6;
    }

    handle_sync(t, bpm, beat) {
        this.beat_clock.start();
        if (beat % 2 == 0) {
            // half-note beat
            this.half_beat_clock.start();
            this.circle_group.position.x = 0.75;
        } else {
            this.circle_group.position.x = -0.75;
        }
    }

    anim_frame(dt) {
        // Lay out the grid from the current spread so spacing can be animated
        // by setting spread_x / spread_y from the scene.
        let idx = 0;
        for (let i = 0; i < this._n_per_side; i++) {
            for (let j = 0; j < this._n_per_side; j++) {
                const position = this.grid_position(i, j);
                this.robots[idx].obj.position.copy(position);
                this.circles[idx].position.copy(position);
                idx++;
            }
        }

        let half_beat_time = this.half_beat_clock.getElapsedBeats() / 2.0;
        let furthest_forward_z_touching_ground = null;
        for (let side = 0; side < 2; side++) {
            const shuffle_offset = this.get_foot_shuffle_offset(side, half_beat_time);
            const body_offset = this.get_body_shuffle_offset(half_beat_time);
            const arms_offset = this.get_arms_pump_offset(half_beat_time);
            this.robots.forEach((robot, i) => {
                const leg = robot.cube_defs[RobotParts.TORSO].children.get(
                    RobotParts.LEGS[side]).mesh;

                const foot_base_y = robot.cube_defs[RobotParts.FEET[side]].coords[1];
                const foot_base_z = robot.cube_defs[RobotParts.FEET[side]].coords[2];
                const leg_base_y = robot.cube_defs[RobotParts.LEGS[side]].coords[1];
                const leg_base_z = robot.cube_defs[RobotParts.LEGS[side]].coords[2];
                const leg_base_height = robot.cube_defs[RobotParts.LEGS[side]].dims[1];

                const leg_scale_y = 1 + (body_offset - shuffle_offset[1]) / leg_base_height;
                const leg_offset_y = (1 - leg_scale_y) * leg_base_height / 2;
                robot.meshes[RobotParts.FEET[side]].position.y = foot_base_y + shuffle_offset[1];
                robot.meshes[RobotParts.FEET[side]].position.z = foot_base_z + shuffle_offset[2];
                leg.position.y = leg_base_y + leg_offset_y;
                leg.position.z = leg_base_z + shuffle_offset[2];
                leg.scale.y = leg_scale_y;

                const torso_base_y = robot.cube_defs[RobotParts.TORSO].coords[1];
                robot.meshes[RobotParts.TORSO].position.y = torso_base_y + body_offset;

                const arm_base_y = robot.cube_defs[RobotParts.ARMS[side]].coords[1];
                const arm = robot.cube_defs[RobotParts.TORSO].children.get(
                    RobotParts.ARMS[side]).mesh;
                arm.position.y = arm_base_y + arms_offset;
            });
            if (shuffle_offset[1] == 0 &&
                (shuffle_offset[2] > furthest_forward_z_touching_ground ||
                furthest_forward_z_touching_ground === null)) {
                // if this is the furthest-forward side touching the ground,
                // track it with the circles
                furthest_forward_z_touching_ground = shuffle_offset[2];
            }
        }
        this.circle_group.position.z = furthest_forward_z_touching_ground;

        let beat_time = this.beat_clock.getElapsedBeats();
        this.circle_scale = lerp_scalar(this.circle_scale_base, this.circle_scale_max, beat_time);
        for (const circle of this.circles) {
            circle.scale.setScalar(this.circle_scale);
            circle.material.opacity = 1.0 - beat_time;
        }
    }
}
