import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Tesseract } from './highdim.js';

var cur_scene_idx = 0;

//var canvas = null;
//var renderer = null;
//const clock = new THREE.Clock(false);

var mesh = null;
var cube_started = false;

// audio
var audioCtx = null;
var oscs = null;
var audio_src_vecs = null;
var pans = null;
var gain = null;

var n_dimensions = null;

const bpm = 150;

const move_clock = new THREE.Clock(false);

function playNote(osc_idx, frequency) {
    oscs[osc_idx].type = 'sine';
    oscs[osc_idx].frequency.value = frequency; // value in hertz
    oscs[osc_idx].start();
}


const demo = {
    robots: [],
    all_group: null,
    robot_group: null,
    anaman_group: null,
    tesseract_group: null,
}

const Channels = {
    FOOT_0_Y: 0,
    FOOT_0_Z: 1,
    FOOT_1_Y: 2,
    FOOT_1_Z: 3,
    ARM_MODE: 5,
    ARM_MOVEMENT: 4,
    MAN_HEIGHT: 6,
    MAX: 7
}

const ArmMode = {
    PUMP: 0,
    CLAP: 1,
    HOLD: 2
}

let curr_spacing = 0;
let curr_tesseract_scale = 0;
let curr_man_scale = 0;
let curr_arm_rot = 0;



function rand_int(max) {
    return Math.floor(Math.random() * max);
}

function arr_eq(a, b) {
    if (a.length != b.length) {
        return false;
    }
    for (const i in a) {
        if (a[i] != b[i]) {
            return false;
        }
    }
    return true;
}

var start_rot = [0, 0];
var target_rot = [0, 0];
var go_to_target = false;
var rot = [0, 0];       // rotation in divs
var ang_vel = [0, 0];   // angular velocity in divs per second
let song_beat_prev = 0;
function update_demo(paused, song_time, ch_amps) {
    const div = 512;    // # of divisions per pi radians
    const float_rate = 1;
    const track_rate = 2;
    const snap_mult = 64;

    const beats_per_sec = bpm / 60.0;
    const song_beat = Math.floor(song_time * beats_per_sec);

    demo.tesseract.rot_xw -= 0.05;
    demo.tesseract.update_geom();

    if (song_beat != song_beat_prev && song_beat % 2 == 0 || paused) {// && rand_int(2) == 0) {
        if (go_to_target) {
            const manhattan_dist = Math.abs(target_rot[0] - rot[0]) +
                Math.abs(target_rot[1] - rot[1], );
            if ((!paused && manhattan_dist <= 8) || manhattan_dist <= 4) {
                go_to_target = false;
            }
        }
        if (!go_to_target) {
            for (var i = 0; i < 2; i++) {
                start_rot[i] = Math.round(rot[i] / snap_mult) * snap_mult;
            }
            let motion_idx = rand_int(8);   // -1, 0, 1 about 2 axes, but no 0, 0
            if (motion_idx > 3) {
                motion_idx += 1;            // make it 0-8 (9 options) for ease
            }
            let rot_dirs = [motion_idx % 3 - 1, Math.floor(motion_idx / 3) - 1];
            target_rot = [(Math.round(start_rot[0] / snap_mult) + rot_dirs[0]) * snap_mult,
                (Math.round(start_rot[1] / snap_mult) + rot_dirs[1]) * snap_mult];
            go_to_target = true;
            move_clock.start();
        }
    }

    if (go_to_target) {
        const num_track_beats = 2;
        let elapsed = move_clock.getElapsedTime();
        for (var i = 0; i < 2; i++) {
            const full_time = 1.0 / beats_per_sec * num_track_beats;
            ang_vel = (target_rot[i] - start_rot[i]) * 1.0 / full_time;
            const sign_before = Math.sign(target_rot[i] - rot[i]);
            rot[i] = start_rot[i] + ang_vel * elapsed;
            const sign_after = Math.sign(target_rot[i] - rot[i]);
            if (sign_after != sign_before) {
                rot[i] = target_rot[i];
            }
        }
        if (arr_eq(rot, target_rot)) {
            /*for (var i = 0; i < 2; i++) {
                rot[i] = target_rot[i];
            }*/
            go_to_target = false;
        }
    }

    let coeff = 0.10;

    let target_spacing = 0;
    let target_man_scale = 0;
    let target_man_pos = new THREE.Vector3(0, 2.15, -0.2);

    let target_tesseract_scale = 0;
    let target_tesseract_pos = new THREE.Vector3();

    if ((song_beat < 4 * 48 || song_beat >= 4 * 176) &&
            stellated.get_cam() != cam_persp) {
        stellated.set_cam(cam_persp);
    } else if ((song_beat >= 4 * 48 && song_beat < 4 * 176) &&
            stellated.get_cam() != cam_orth) {
        stellated.set_cam(cam_orth);
    }

    if (song_beat >= 4 * 8 && song_beat < 4 * 16) {
        target_tesseract_scale = 1;
        target_tesseract_pos.set(0, 0.5, 2.75);
        target_man_scale = 0;
        target_man_pos.set(0, -4, -0.2);
    } else if (song_beat >= 4 * 16 && song_beat < 4 * 48) {
        target_spacing = 7;
        target_tesseract_scale = 0;
        target_tesseract_pos.set(0, 0, 0);
        target_man_scale = 0;
        target_man_pos.set(0, -4, -0.2);
    } else if (song_beat >= 4 * 48 && song_beat < 4 * 80) {
        coeff = 0.003;
        target_spacing = 0;
        target_tesseract_scale = 1;
        target_tesseract_pos.set(0, 0.5, 2.75);
        target_man_scale = 0;
        target_man_pos.set(0, -4, -0.2);
    } else if (song_beat >= 4 * 80 && song_beat < 4 * 96) {
        target_spacing = 7;
        target_tesseract_scale = 0;
        target_tesseract_pos.set(0, 0, 0);
        target_man_scale = 2;
        target_man_pos.set(0, 2.15, -0.2);
    } else if (song_beat >= 4 * 96 && song_beat < 4 * 112) {
        target_spacing = 7;
        target_tesseract_scale = 4;
        target_tesseract_pos.set(0, 0, 0);
        target_man_scale = 0;
        target_man_pos.set(0, -4, -0.2);
    } else if (song_beat >= 4 * 112 && song_beat < 4 * 144) {
        coeff = 0.0025;
        target_spacing = 0;
        target_tesseract_scale = 1;
        target_tesseract_pos.set(0, 0.5, 2.75);
        target_man_scale = 2;
        target_man_pos.set(0, 2.15, -0.2);
    } else if (song_beat >= 4 * 144 && song_beat < 4 * 184) {
        target_spacing = 7;
        target_tesseract_scale = 4;
        target_tesseract_pos.set(0, 0, 0);
        target_man_scale = 2;
        target_man_pos.set(0, 2.15, -0.2);
    } else if (song_beat >= 4 * 184) {
        coeff = 0.011;
        target_spacing = 0;
        target_man_scale = 0;
        target_man_pos.set(0, -4, -0.2);
        target_tesseract_scale = 1;
        target_tesseract_pos.set(0, 0.5, 2.75);
    }

    curr_spacing = lerp(curr_spacing, target_spacing, coeff);
    curr_tesseract_scale = lerp(curr_tesseract_scale, target_tesseract_scale, 0.05);
    curr_man_scale = lerp(curr_man_scale, target_man_scale, 0.05);
    demo.tesseract_group.scale.set(curr_tesseract_scale, curr_tesseract_scale, curr_tesseract_scale);
    let tess_pos = demo.tesseract_group.position.toArray();
    let target_tess_pos = target_tesseract_pos.toArray();
    let man_pos_arr = demo.anaman_group.position.toArray();
    let target_man_pos_arr = target_man_pos.toArray();
    for (let i = 0; i < 3; i++) {
        tess_pos[i] = lerp(tess_pos[i], target_tess_pos[i], 0.05);
        man_pos_arr[i] = lerp(man_pos_arr[i], target_man_pos_arr[i], 0.05);
    }
    demo.tesseract_group.position.fromArray(tess_pos);
    demo.anaman_group.position.fromArray(man_pos_arr);

    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let position = new THREE.Vector3((i - 1) * curr_spacing, 0,
                (j - 1) * curr_spacing);
            demo.robots[i * 3 + j].obj.position.copy(position);
        }
    }

    demo.robots[4].obj.visible = (song_beat < 4 * 80);
    let curr_man_scale_y = curr_man_scale;

    if (!paused) {
        for (let i in demo.robots) {
            let ch_idx = 0;
            const robot = demo.robots[i];
            // Foot and leg movement
            for (let side = 0; side < 2; side++) {
                const foot_base_y = robot.cube_defs[RobotParts.FEET[side]].coords[1];
                const foot_base_z = robot.cube_defs[RobotParts.FEET[side]].coords[2];
                const leg_base_y = robot.cube_defs[RobotParts.LEGS[side]].coords[1];
                const leg_base_z = robot.cube_defs[RobotParts.LEGS[side]].coords[2];
                const leg_base_height = robot.cube_defs[RobotParts.LEGS[side]].dims[1];
                const offset_y = 0.80 * ch_amps[ch_idx++];
                const offset_z = ch_amps[ch_idx++] - 0.5;

                const leg_scale_y = 1 - offset_y / leg_base_height;
                const leg_offset_y = offset_y / 2;
                robot.meshes[RobotParts.FEET[side]].position.y = foot_base_y + offset_y;
                robot.meshes[RobotParts.FEET[side]].position.z = foot_base_z + offset_z;
                robot.meshes[RobotParts.LEGS[side]].position.y = leg_base_y + leg_offset_y;
                robot.meshes[RobotParts.LEGS[side]].position.z = leg_base_z + offset_z;
                robot.meshes[RobotParts.LEGS[side]].scale.y = leg_scale_y;
            }
            // Arm movement
            const arm_mode = ch_amps[ch_idx++];
            const arm_move = ch_amps[ch_idx++];

            const man_height = ch_amps[ch_idx++];

            curr_man_scale_y = 2 * man_height * curr_man_scale;

            let target_arm_rot = 0;
            let arm_extension = 0;
            let arm_closeness = 0;
            if (arm_mode < 0.5) {
                target_arm_rot = -Math.PI / 2.0;
                arm_extension = arm_move - 0.25;
                arm_closeness = 1;
            } else {
                target_arm_rot = 0.0;
                arm_extension = 0;
                arm_closeness = arm_move;
            }
            curr_arm_rot = lerp(curr_arm_rot, target_arm_rot, 0.005);
            for (let side = 0; side < 2; side++) {
                //arm_rot = -arm_extension * Math.PI / 2.0;
                const rot_axis = new THREE.Vector3(1, 0, 0);
                const side_sign = side * 2 - 1
                const translation = new THREE.Vector3(side_sign * (arm_closeness - 1),
                    0, arm_extension);
                const arm_base_coords = new THREE.Vector3(...robot.cube_defs[RobotParts.ARMS[side]].coords);
                const pivot = new THREE.Vector3(arm_base_coords.x, arm_base_coords.y, 0);
                const ARM = 0;
                const HAND = 1;
                for (let i = 0; i < 2; i++) {
                    if (i == ARM) {
                        var idx = RobotParts.ARMS[side];
                    } else {
                        var idx = RobotParts.HANDS[side];
                    }
                    const base_coords = new THREE.Vector3(...robot.cube_defs[idx].coords);
                    let this_trans = base_coords.clone();
                    this_trans.sub(pivot);
                    this_trans.add(translation);
                    this_trans.applyAxisAngle(rot_axis, curr_arm_rot);
                    this_trans.add(pivot);
                    robot.meshes[idx].quaternion.setFromAxisAngle(rot_axis, curr_arm_rot);
                    robot.meshes[idx].position.copy(this_trans);
                }
            }
        }
    }
    demo.anaman_group.scale.set(curr_man_scale, curr_man_scale_y, curr_man_scale);
    //demo.cubes_group.rotation.y = Math.pow((1 - Math.sin((song_time / 60.0 * 110 * 2) * Math.PI)) / 2, 2) * Math.PI / 32;
    demo.all_group.rotation.x = rot[0] * Math.PI / div;
    demo.all_group.rotation.y = rot[1] * Math.PI / div;
    //total_elapsed += 1;
    song_beat_prev = song_beat;
}

var scene_names = ['cube', 'demo'];
var init_funcs = [init_demo];
var update_funcs = [update_demo];

function animate() {
    stellated.frame(update_funcs);
    window.requestAnimationFrame(animate);
}

var tracks = ["p16-b"];
var player = populate_tracks(tracks, false)[0];

player.on("pause", stellated.pause);
player.on("play", stellated.play);
player.on("playing", stellated.play);
player.on("seeked", stellated.seeked);
player.on("waiting", stellated.pause);
player.on("timeupdate", stellated.time_update);

stellated.init(tracks, init_funcs);

if (stellated.webgl_available()) {
    animate();
}
