import * as THREE from 'three';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    create_instanced_cube,
    make_wireframe_circle,
    rand_int,
    arr_eq,
    clamp
} from './util.js';
import { BoxDef } from './geom_def.js';
import { VisScene } from './vis_scene.js';
import { Tesseract } from './highdim.js';


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


export class YellowRobotScene extends VisScene {
    constructor(env) {
        super(env, 4);

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 10;
        this.cam_persp = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 10000 );
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -8, 1000);
        this.scene = new THREE.Scene();
        this.move_clock = new THREE.Clock(false);
        this.half_beat_clock = new THREE.Clock(false);
        this.beat_clock = new THREE.Clock(false);
        this.state_change_clock = new THREE.Clock(false);

        this.beat_idx = 0;

        this.start_rot = [0, 0];
        this.target_rot = [0, 0];
        this.rot = [0, 512 / 2];

        this.robots = [];
        this.circles = [];

        this.all_group = new THREE.Group();
        this.robot_group = new THREE.Group();
        this.circle_group = new THREE.Group();
        this.anaman_group = new THREE.Group();
        this.tesseract_group = new THREE.Group();

        this.tesseract = new Tesseract(this.tesseract_group, 4);
        this.tesseract_group.position.set(0, 0.5, 2.75);
        //this.all_group.add(this.tesseract_group);

        this.start_spacing = 0;
        this.curr_spacing = 0;
        this.target_spacing = 0;

        this.start_zoom = 1;
        this.curr_zoom = 1;
        this.target_zoom = 1;

        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                let position = new THREE.Vector3((i - 1) * this.curr_spacing, 0,
                    (j - 1) * this.curr_spacing);
                this.robots.push(new Robot(this.robot_group, position));

                const circle = make_wireframe_circle(6, 32, new THREE.Color("cyan"));
                circle.position.copy(position);
                //circle.position.z += 1.2;   // foot forward offset
                circle.rotation.x = Math.PI / 2.0;
                this.circles.push(circle);
                this.circle_group.add(circle);

            }
        }
        // position circle group right below feet
        this.circle_group.position.y = -3.26;

        this.all_group.add(this.circle_group);
        this.all_group.add(this.robot_group);


        this.circle_scale_base = 0.1;
        this.circle_scale_max = 1.0;

        this.all_group.position.y = 0.5;

        this.scene.add(this.all_group);

        /*let loader = new GLTFLoader();
        loader.load( 'static/obj/anaman.glb', function ( gltf ) {
            const wireframe_mat = new THREE.LineBasicMaterial( { color: "cyan", linewidth: 1 } );
            for (var i in gltf.scene.children) {
                let edges = new THREE.EdgesGeometry(gltf.scene.children[i].geometry, 30);
                let mesh = new THREE.LineSegments(edges, wireframe_mat);
                this.anaman_group.add(mesh);
                this.anaman_group.position.set(0, 2.15, -0.2);
                this.anaman_group.scale.set(2.0, 2.0, 2.0);
                this.anaman_group.rotation.set(Math.PI / 2.0, 0, 0);
            }
            this.all_group.add(this.anaman_group);
        }, undefined, function ( error ) {
                console.error( error );
        } );*/

        this.cam_persp.position.set(0, 0, 8);
        this.cam_orth.position.set(0, 0, 8);

        this.camera = this.cam_orth;
        //this.camera = this.cam_persp;

        update_orth_camera_aspect(this.cam_orth, aspect, this.frustum_size);
        update_persp_camera_aspect(this.cam_persp, aspect);
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

    handle_sync(t, bpm, beat) {
        this.beat_clock.start();
        if (beat % 2 == 0) {
            // half-note beat
            this.half_beat_clock.start();
            this.circle_group.position.x = 0.75;
        } else {
            this.circle_group.position.x = -0.75;
        }
        this.beat_idx++;
        const snap_mult = 64;
        if (rand_int(0, 4) == 0) {//(song_beat != song_beat_prev && song_beat % 2 == 0 || paused) {// && rand_int(0, 2) == 0) {
            // if close enough, can clear the existing movement to start a new one
            if (this.go_to_target) {
                const manhattan_dist = Math.abs(this.target_rot[0] - this.rot[0]) +
                    Math.abs(this.target_rot[1] - this.rot[1]);
                if (manhattan_dist <= 8) {
                    this.go_to_target = false;
                }
            }
            // if done moving to target, start a new movement
            if (!this.go_to_target) {
                for (var i = 0; i < 2; i++) {
                    this.start_rot[i] = Math.round(this.rot[i] / snap_mult) * snap_mult;
                }
                let motion_idx = rand_int(0, 8);   // -1, 0, 1 about 2 axes, but no 0, 0
                if (motion_idx > 3) {
                    motion_idx += 1;            // make it 0-8 (9 options) for ease
                }
                let rot_dirs = [motion_idx % 3 - 1, Math.floor(motion_idx / 3) - 1];
                this.target_rot = [(Math.round(this.start_rot[0] / snap_mult) + rot_dirs[0]) * snap_mult,
                    (Math.round(this.start_rot[1] / snap_mult) + rot_dirs[1]) * snap_mult];
                this.go_to_target = true;
                this.move_clock.start();
            }
        }
    }

    state_transition(old_state_idx, new_state_idx) {
        if (new_state_idx == 0) {
            this.start_spacing = this.curr_spacing;
            this.target_spacing = 0;

            this.start_zoom = this.curr_zoom;
            this.target_zoom = 1;
        } else if (new_state_idx == 1) {
            this.start_spacing = this.curr_spacing;
            this.target_spacing = 0;

            this.start_zoom = this.curr_zoom;
            this.target_zoom = 1;

        } else if (new_state_idx == 2) {
            this.start_spacing = this.curr_spacing;
            this.target_spacing = 3;

            this.start_zoom = this.curr_zoom;
            this.target_zoom = 0.8;
        }
        this.state_change_clock.start();
    }

    anim_frame(dt) {
        const div = 512;    // # of divisions per pi radians
        const float_rate = 1;
        const track_rate = 2;
        const beats_per_sec = this.get_local_bpm() / 60;

        this.tesseract.rot_xw -= 0.05;
        this.tesseract.update_geom();


        if (this.go_to_target) {
            const num_beats_to_lerp = 1.0;
            let elapsed = this.move_clock.getElapsedTime();
            for (var i = 0; i < 2; i++) {
                const full_time = 1.0 / beats_per_sec * num_beats_to_lerp;
                const ang_vel = (this.target_rot[i] - this.start_rot[i]) * 1.0 / full_time;
                const sign_before = Math.sign(this.target_rot[i] - this.rot[i]);
                this.rot[i] = this.start_rot[i] + ang_vel * elapsed;
                const sign_after = Math.sign(this.target_rot[i] - this.rot[i]);
                if (sign_after != sign_before) {
                    this.rot[i] = this.target_rot[i];
                }
            }
            if (arr_eq(this.rot, this.target_rot)) {
                /*for (var i = 0; i < 2; i++) {
                    rot[i] = target_rot[i];
                }*/
                this.go_to_target = false;
            }
        }


        // Update spacing
        const spacing_change_beats = 4;
        {
            const frac = clamp(this.state_change_clock.getElapsedTime() * beats_per_sec / spacing_change_beats, 0, 1);
            this.curr_spacing = lerp_scalar(this.start_spacing, this.target_spacing, frac);
            let idx = 0;
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 3; j++) {
                    let position = new THREE.Vector3((i - 1) * this.curr_spacing, 0,
                        (j - 1) * this.curr_spacing);
                    this.robots[idx].obj.position.copy(position);
                    this.circles[idx].position.copy(position);
                    idx++;
                }
            }
        }

        // Update zoom
        const zoom_change_beats = 1;
        {
            const frac = clamp((this.state_change_clock.getElapsedTime() * beats_per_sec - spacing_change_beats) / zoom_change_beats, 0, 1);
            this.curr_zoom = lerp_scalar(this.start_zoom, this.target_zoom, frac);
            this.cam_orth.zoom = this.curr_zoom;
            this.cam_orth.updateProjectionMatrix();
        }


        let half_beat_time = this.half_beat_clock.getElapsedTime() * beats_per_sec / 2.0;
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
                const leg_offset_y = (1 - leg_scale_y) * leg_base_height / 2;//shuffle_offset[1] - body_offset;
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

        let beat_time = this.beat_clock.getElapsedTime() * beats_per_sec;
        this.circle_scale = lerp_scalar(this.circle_scale_base, this.circle_scale_max, beat_time);
        for (const circle of this.circles) {
            circle.scale.setScalar(this.circle_scale);
            circle.material.opacity = 1.0 - beat_time;
        }

        this.all_group.rotation.x = this.rot[0] * Math.PI / div;
        this.all_group.rotation.y = this.rot[1] * Math.PI / div;

    }
}
