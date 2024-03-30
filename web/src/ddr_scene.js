import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
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

const BODY_COLOR = new THREE.Color("red");
const ROT_BEATS = 3.75;
const ARROW_VEL = 5;
const ARROW_TOP_Y = 1.27;

function mirror_mesh(mesh, axis_idx) {
    const new_mesh = mesh.clone();

    // Mirror position
    const pos = new_mesh.position.toArray();
    pos[axis_idx] *= -1;

    // Mirror geometry
    const mat = new THREE.Matrix4().identity();
    mat.elements[axis_idx * 5] = -1;
    new_mesh.applyMatrix4(mat);
    new_mesh.position.fromArray(pos);

    // Record new base position, scale, and quaternion
    new_mesh.base_pos = new_mesh.position.clone();
    new_mesh.base_scale = new_mesh.scale.clone();
    new_mesh.base_quat = new_mesh.quaternion.clone();
    return new_mesh;
}

function mesh_from_gltf(gltf_mesh, fill_mat, wireframe_mat) {
    const gltf_geom = gltf_mesh.geometry;
    let edges = new THREE.EdgesGeometry(gltf_geom, 30);
    const mesh = new THREE.Object3D();
    const fill_mesh = new THREE.Mesh(gltf_geom, fill_mat);
    //mesh.add(fill_mesh);
    mesh.add(new THREE.LineSegments(edges, wireframe_mat));
    gltf_mesh.getWorldQuaternion(mesh.quaternion);
    gltf_mesh.getWorldPosition(mesh.position);
    gltf_mesh.getWorldScale(mesh.scale);
    mesh.base_pos = mesh.position.clone();
    mesh.base_quat = mesh.quaternion.clone();
    mesh.base_scale = mesh.scale.clone();
    return mesh;
}

class DDRRobot extends THREE.Object3D {
    constructor(gltf_parent_object, fill_mat, wireframe_mat) {
        super();
        this.body = mesh_from_gltf(gltf_parent_object, fill_mat, wireframe_mat)
        this.add(this.body);
        for (const child_mesh of gltf_parent_object.children) {
            if (child_mesh.name == "leg") {
                this.legs = [mesh_from_gltf(child_mesh, fill_mat, wireframe_mat)];
                this.legs.push(mirror_mesh(this.legs[0], 0));
                for (const leg of this.legs) {
                    this.add(leg);
                }
            } else if (child_mesh.name == "hand") {
                this.hands = [mesh_from_gltf(child_mesh, fill_mat, wireframe_mat)];
                this.hands.push(mirror_mesh(this.hands[0], 0));
                for (const hand of this.hands) {
                    this.add(hand);
                }
            } else if (child_mesh.name == "foot") {
                this.feet = [mesh_from_gltf(child_mesh, fill_mat, wireframe_mat)];
                this.feet.push(mirror_mesh(this.feet[0], 0));
                for (const foot of this.feet) {
                    this.add(foot);
                }
            }
        }
    }

    get_foot_offset(side_idx, t) {
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

    anim_frame(dt, half_beat_time, bpm) {
        const beats_per_sec = bpm / 60;

        const body_offset = this.get_body_shuffle_offset(half_beat_time);
        const arms_offset = this.get_arms_pump_offset(half_beat_time);

        for (let side = 0; side < 2; side++) {
            const shuffle_offset = this.get_foot_offset(side, half_beat_time);
            this.feet[side].position.y = this.feet[side].base_pos.y + shuffle_offset[1];
            this.feet[side].position.z = this.feet[side].base_pos.z + shuffle_offset[2];
            this.legs[side].position.y = this.legs[side].base_pos.y + shuffle_offset[1];
            this.legs[side].position.z = this.legs[side].base_pos.z + shuffle_offset[2];

            const leg_base_height = 1;
            const leg_scale_y = (body_offset - shuffle_offset[side]) / leg_base_height;
            this.legs[side].scale.y = leg_scale_y;


            this.body.position.y = this.body.base_pos.y + body_offset;
            this.hands[side].position.y = this.hands[side].base_pos.y + arms_offset;
        }
    }
}

class DDRArrow extends THREE.LineSegments {
    static global_clock = null;

    constructor(gltf_scene, parent_scene) {
        if (DDRArrow.global_clock == null) {
            DDRArrow.global_clock = new BeatClock(parent_scene, true);
        }
        const obj = gltf_scene.scene.getObjectByName("arrow");
        const arrow_geom = obj.geometry;
        const edges_geom = new THREE.EdgesGeometry(arrow_geom, 30);
        super(edges_geom, new THREE.LineBasicMaterial({ color: "orange", transparent: true}));
        obj.getWorldPosition(this.position);
        obj.getWorldQuaternion(this.quaternion);
        obj.getWorldScale(this.scale);
        this.base_pos = this.position.clone();
        this.base_quat = this.quaternion.clone();
        this.base_scale = this.scale.clone();
        this.clock = new BeatClock(parent_scene, false);
    }

    anim_frame() {
        const beats_elapsed = this.clock.get_elapsed_beats();
        const global_beats_elapsed = DDRArrow.global_clock.get_elapsed_beats();
        this.offset_vec = new THREE.Vector3(
            0,
            Math.min(ARROW_VEL * (beats_elapsed - this.time_till_impact), 0) - ARROW_TOP_Y,
            Math.max(ARROW_VEL * (beats_elapsed - this.time_till_impact), 0));
        this.offset_vec.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 * this.ddr_direction);
        this.position.copy(this.offset_vec);
        this.material.opacity = clamp(1 - (this.time_till_impact - beats_elapsed) / this.time_till_impact, 0, 1);
        this.material.color.setHSL(Math.sin((beats_elapsed + global_beats_elapsed) / 4), 1, 0.5);
    }

    start_anim(ddr_direction, time_till_impact) {
        this.ddr_direction = ddr_direction;
        this.quaternion.copy(this.base_quat);
        this.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 * this.ddr_direction));
        //const color_options = ["orange", "cyan", "lightgreen", "magenta"];
        //this.material.color = new THREE.Color(color_options[ddr_direction]);
        this.time_till_impact = time_till_impact;
        this.clock.start();
    }
}

export class DDRScene extends VisScene {
    constructor(env) {
        super(env, 1);
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
        this.scene = new THREE.Scene();

        const loader = new GLTFLoader();
        const stl_load_promise = loader.loadAsync('stl/ddr-robot.glb');
        this.shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = this.shader_loader.load();
        this.spacing = 8;
        this.num_per_side = 3;
        const this_class = this;
        Promise.all([stl_load_promise, shader_load_promise]).then((results) => {
            const gltf_scene = results[0];
            const dither_pars = results[1][0];
            const dither = results[1][1];
            this.fill_mat = new THREE.MeshLambertMaterial({
                color: BODY_COLOR,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1
            });
            this.wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );

            this.fill_mat.onBeforeCompile = (shader) => {
                shader.fragmentShader =
                    shader.fragmentShader.replace(
                        '#include <dithering_pars_fragment>',
                        dither_pars
                    ).replace(
                        '#include <dithering_fragment>',
                        dither
                    );
            };


            // Robots
            {
                this.robots = [];
                const offset = new THREE.Vector3(-this.spacing * (this.num_per_side - 1) / 2, 0, -this.spacing * (this.num_per_side - 1) / 2);
                for (let i = 0; i < this.num_per_side; i++) {
                    for (let j = 0; j < this.num_per_side; j++) {
                        const robot = new DDRRobot(
                            gltf_scene.scene.getObjectByName("robot"),
                            this.fill_mat, this.wireframe_mat);
                        robot.position.set(i * this.spacing, 2, j * this.spacing);
                        robot.position.add(offset);
                        this.base_group.add(robot);
                        this.robots.push(robot);
                    }
                }
            }

            // DDR arrows
            {
                this.arrows = [];
                this.cur_arrow_idx = 0;
                for (let i = 0; i < 24; i++) {
                    const arrow = new DDRArrow(gltf_scene, this_class);
                    this.base_group.add(arrow);
                    this.arrows.push(arrow);
                }
            }

            // Light
            {
                this.light = new THREE.PointLight("white", 200);
                this.light.position.set(0, 0, 24);
                this.base_group.add(this.light);
            }

            this.initialized = true;
        });

        this.camera.rotation.x = -Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.scene.add(this.base_group);

        // Robot rotation, in 90 degree increments starting from 45 degrees
        this.start_robot_rot = 0;
        this.target_robot_rot = 0;
        this.robot_rot_clock = new BeatClock(this);

        // Clock for robot shuffling movement
        this.half_beat_clock = new BeatClock(this);
    }

    anim_frame(dt) {
        if (!this.initialized) {
            return;
        }
        const rot_frac = ease(clamp(this.robot_rot_clock.get_elapsed_beats() / ROT_BEATS, 0, 1));
        const robot_rot = lerp_scalar(this.start_robot_rot, this.target_robot_rot, rot_frac);
        this.base_group.rotation.y = Math.PI / 4 + Math.PI / 2 * robot_rot;

        const half_beat_time = this.half_beat_clock.get_elapsed_beats() / 2.0;
        for (const r of this.robots) {
            r.anim_frame(dt, half_beat_time, this.get_local_bpm());
        }

        for (const a of this.arrows) {
            a.anim_frame(dt, half_beat_time, this.get_local_bpm());
        }
    }

    handle_beat(t, channel) {
        this.arrows[this.cur_arrow_idx].start_anim(rand_int(0, 4), 1);
        this.cur_arrow_idx = (this.cur_arrow_idx + 1) % this.arrows.length;
    }

    handle_sync(t, bpm, beat) {
        if (beat % 4 == 0) {
            this.start_robot_rot = this.target_robot_rot;
            this.target_robot_rot++;
            this.robot_rot_clock.start();
        }
        if (beat % 2 == 0) {
            // half-note beat
            this.half_beat_clock.start();
        }
    }

    state_transition(old_state_idx, new_state_idx) {
    }
}
