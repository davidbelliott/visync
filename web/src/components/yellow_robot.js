import * as THREE from 'three';
import { Component } from './component.js';
import {
    lerp_scalar,
    ease,
    make_wireframe_circle,
    create_instanced_cube_templates,
    BeatClock
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';


// Each robot is built from this many cubes. They used to live in a THREE
// scene-graph hierarchy (torso -> head/arms/legs, arm -> hand, head -> eyes);
// here that hierarchy is flattened into world-local instance transforms so the
// whole grid of robots renders from a single InstancedGeometryCollection.
const CUBES_PER_ROBOT = 11;


// A square grid of dancing yellow robots. `spread_x` / `spread_y` control the
// spacing between robots along each grid axis (0 = all robots overlap exactly),
// and `n_per_side` is the number of robots along each side of the square.
//
// All robots dance in lockstep, so each frame we compute one robot's pose (11
// cube offsets/scales) and replicate it across the grid as instances.
export class YellowRobot extends Component {
    constructor({ spread_x = 0, spread_y = 0, n_per_side = 3 } = {}) {
        super();

        this._spread_x = spread_x;
        this._spread_y = spread_y;
        this._n_per_side = n_per_side;

        this.half_beat_clock = new BeatClock(this);
        this.beat_clock = new BeatClock(this);

        this.cube_group = new THREE.Group();
        this.circle_group = new THREE.Group();
        // position circle group right below feet
        this.circle_group.position.y = -3.26;
        this.add(this.circle_group);
        this.add(this.cube_group);

        this.cube_color = new THREE.Color("yellow");

        this.circle_scale_base = 0.1;
        this.circle_scale_max = 1.0;
        this.circle_scale = this.circle_scale_base;

        // Furthest-forward foot z that is touching the ground; the circles track
        // it. Set as a side effect of compute_robot_pose().
        this._furthest_forward = 0;

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

    // (Re)create the instanced cubes and per-robot ground circles.
    build() {
        this.cube_group.clear();
        this.circle_group.clear();
        this.circles = [];
        // Per-robot opacity (fades toward the edges of the grid). Baked into the
        // cube instances; reused each frame for the circles.
        this.robot_alphas = [];

        const n = this._n_per_side;
        const num_cubes = n * n * CUBES_PER_ROBOT;

        // A single unit-cube wireframe template, instanced once per cube.
        const [wire_template] = create_instanced_cube_templates(1, 1, 1);
        this.inst_cubes = new InstancedGeometryCollection(
            this.cube_group, wire_template, 'Lines', num_cubes);

        const rest_pose = this.compute_robot_pose(0);
        const tmp = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const g = this.grid_position(i, j);
                const alpha = this.robot_alpha(i, j);
                this.robot_alphas.push(alpha);
                for (let k = 0; k < CUBES_PER_ROBOT; k++) {
                    tmp.copy(rest_pose[k].pos).add(g);
                    this.inst_cubes.create_geom(tmp, this.cube_color, rest_pose[k].scale, 0, alpha);
                }

                const circle = make_wireframe_circle(6, 32, new THREE.Color("cyan"));
                // These ground circles are transparent and overlap nearly
                // coplanar, so depth-writing makes whichever draws first cull
                // the others (a dim outer circle can occlude a brighter inner
                // one). Disable it so they blend by opacity instead.
                circle.material.depthWrite = false;
                circle.position.copy(g);
                circle.rotation.x = Math.PI / 2.0;
                this.circles.push(circle);
                this.circle_group.add(circle);
            }
        }
    }

    // Opacity for the robot at grid cell (i, j): fully opaque at the center,
    // fading radially to nearly transparent at the outermost corners.
    robot_alpha(i, j) {
        const n = this._n_per_side;
        const center = (n - 1) / 2;
        if (center === 0) {
            return 1;
        }
        const dx = i - center;
        const dy = j - center;
        const dist_sq = dx * dx + dy * dy;
        const max_dist_sq = 2 * center * center;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const max_dist = center * Math.SQRT2;   // center -> corner
        return Math.max(0.05, (1 - dist/max_dist) ** 2);
    }

    // Centered grid position for the robot at column i, row j.
    grid_position(i, j) {
        const center = (this._n_per_side - 1) / 2;
        return new THREE.Vector3(
            (i - center) * this._spread_x, 0,
            (j - center) * this._spread_y);
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

    // Compute one robot's pose at dance-time t: an array of CUBES_PER_ROBOT
    // { pos, scale } in robot-local space. The body bob shifts every
    // torso-descendant (head, eyes, arms, hands, legs) in y; the feet stay on
    // the ground. Replicated across the grid by build()/anim_frame().
    compute_robot_pose(t) {
        const body = this.get_body_shuffle_offset(t);
        const arms = this.get_arms_pump_offset(t);

        const pose = [
            // torso, head, eyes (centered; descendants of torso get +body in y)
            { pos: new THREE.Vector3(0, body, 0), scale: new THREE.Vector3(3, 2, 1) },
            { pos: new THREE.Vector3(0, 1.75 + body, 0), scale: new THREE.Vector3(2, 1, 2) },
            { pos: new THREE.Vector3(0, 1.75 + body, 1.125), scale: new THREE.Vector3(1.5, 0.25, 0.25) },
        ];

        let furthest = null;
        for (let side = 0; side < 2; side++) {
            const sign = 2 * side - 1;   // -1 for left, +1 for right
            const shuffle = this.get_foot_shuffle_offset(side, t);   // [0, y, z]

            const leg_base_height = 1.5;
            const leg_scale_y = 1 + (body - shuffle[1]) / leg_base_height;
            const leg_offset_y = (1 - leg_scale_y) * leg_base_height / 2;

            // arm (torso child: + body + arm pump)
            pose.push({ pos: new THREE.Vector3(sign * 1.75, 0.5 + arms + body, 1.75),
                        scale: new THREE.Vector3(0.5, 0.5, 2.0) });
            // hand (arm child: moves with arm)
            pose.push({ pos: new THREE.Vector3(sign * 1.25, 0.5 + arms + body, 2.75),
                        scale: new THREE.Vector3(0.5, 1, 1) });
            // leg (torso child: + body, stretches/shuffles)
            pose.push({ pos: new THREE.Vector3(sign * 0.75, body + (-2 + leg_offset_y), shuffle[2]),
                        scale: new THREE.Vector3(0.5, leg_base_height * leg_scale_y, 1.0) });
            // foot (top-level: shuffles on the ground, no body bob)
            pose.push({ pos: new THREE.Vector3(sign * 0.75, -3 + shuffle[1], shuffle[2]),
                        scale: new THREE.Vector3(1.5, 0.5, 2.0) });

            if (shuffle[1] == 0 &&
                (furthest === null || shuffle[2] > furthest)) {
                // furthest-forward side touching the ground; circles track it
                furthest = shuffle[2];
            }
        }
        this._furthest_forward = furthest;
        return pose;
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
        const half_beat_time = this.half_beat_clock.getElapsedBeats() / 2.0;
        const pose = this.compute_robot_pose(half_beat_time);

        // Replicate the pose across the grid, updating cube instances and the
        // ground circles. Spread can change live (MIDI), so positions are laid
        // out every frame.
        const n = this._n_per_side;
        const tmp = new THREE.Vector3();
        let inst = 0;
        let ci = 0;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                const g = this.grid_position(i, j);
                for (let k = 0; k < CUBES_PER_ROBOT; k++) {
                    tmp.copy(pose[k].pos).add(g);
                    this.inst_cubes.set_pos(inst, tmp);
                    this.inst_cubes.set_scale(inst, pose[k].scale);
                    inst++;
                }
                this.circles[ci].position.copy(g);
                ci++;
            }
        }

        this.circle_group.position.z = this._furthest_forward;

        const beat_time = this.beat_clock.getElapsedBeats();
        this.circle_scale = lerp_scalar(this.circle_scale_base, this.circle_scale_max, beat_time);
        this.circles.forEach((circle, idx) => {
            circle.scale.setScalar(this.circle_scale);
            circle.material.opacity = (1.0 - beat_time) * this.robot_alphas[idx];
        });
    }
}
