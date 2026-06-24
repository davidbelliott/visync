import * as THREE from 'three';
import {
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    BeatClock
} from '../util.js';
import { Scene } from './scene.js';
import { YellowRobot } from '../components/yellow_robot.js';
import { Tesseract } from '../highdim.js';


// Rotation is tracked in "divisions": ROT_DIV units == pi radians (180 deg).
const ROT_DIV = 512;
// Knob-driven targets snap to multiples of 45 deg (= pi/4 = ROT_DIV/4 units).
const SNAP_UNITS = ROT_DIV / 4;
// Each knob sweeps a full turn (360 deg) across its 0..1 range, in 45 deg steps.
const SNAP_STEPS = 8;
// norm 0..1 -> nearest 45 deg multiple, in rotation units.
// (negate to match physical knob rotation direction)
const snap_to_45 = (norm) => Math.round(-norm * SNAP_STEPS) * SNAP_UNITS;


export class YellowRobotScene extends Scene {
    constructor(context) {
        super(context, 'ogrobot');

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 10;
        this.cam_persp = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 10000 );
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -8, 1000);
        this.clear();
        // One move_clock per rotation axis; each is (re)started when that
        // axis's target changes, so the two axes interpolate independently.
        this.move_clocks = [new BeatClock(this), new BeatClock(this)];

        this.rot = [0, ROT_DIV / 2];
        // Start the targets where the rotation already is, so nothing moves
        // until a knob asserts a new target.
        this.start_rot = [...this.rot];
        this.target_rot = [...this.rot];

        this.tesseract_group = new THREE.Group();
        this.tesseract = new Tesseract(this.tesseract_group, 4);
        this.tesseract_group.position.set(0, 0.5, 2.75);
        //this.add(this.tesseract_group);

        // The dancing robot grid is a self-contained component. Its grid size
        // and spacing are driven live by MIDI knobs 3, 4 and 5 (see below).
        this.robot = new YellowRobot({
            spread_x: 0,
            spread_y: 0,
            n_per_side: 9,
        });
        this.robot.position.y = 0.5;
        const isom_angle = Math.asin(1 / Math.sqrt(3));
        this.robot.rotation.x = isom_angle;
        this.add(this.robot);

        // MIDI knob 3 -> x spacing (0..8), knob 4 -> y spacing (0..8).
        // Evaluated every frame as part of update_bindings(), so turning a
        // knob updates the grid spacing live.
        this.bind('apc', 3, (v) => { this.robot.spread_x = v; },
            (norm) => norm * 8);
        this.bind('apc', 4, (v) => { this.robot.spread_y = v; },
            (norm) => norm * 8);

        // APC knobs 8 and 9 drive the two rotation-axis targets. Each knob's
        // 0..1 range sweeps a full turn, snapped to the nearest 45 deg.
        // Evaluated every frame; set_target_axis ignores no-op repeats and
        // only restarts an axis when its snapped target actually changes.
        this.bind('apc', 8, (v) => this.set_target_axis(1, v), snap_to_45);
        this.bind('apc', 9, (v) => this.set_target_axis(0, v), snap_to_45);

        this.cam_persp.position.set(0, 0, 8);
        this.cam_orth.position.set(0, 0, 8);

        this.camera = this.cam_orth;
        //this.camera = this.cam_persp;

        update_orth_camera_aspect(this.cam_orth, aspect, this.frustum_size);
        update_persp_camera_aspect(this.cam_persp, aspect);
    }

    // Point one rotation axis at a new target. Recording start_rot and
    // (re)starting that axis's move_clock together restarts interpolation
    // cleanly from wherever the axis currently is.
    set_target_axis(axis, target) {
        if (target === this.target_rot[axis]) {
            return;
        }
        this.start_rot[axis] = this.rot[axis];
        this.target_rot[axis] = target;
        this.move_clocks[axis].start();
    }

    anim_frame(dt) {
        this.tesseract.rot_xw -= 0.05;
        this.tesseract.update_geom();

        // Interpolate every axis whose current rotation hasn't reached its
        // target, each at a constant angular velocity timed by its own clock.
        for (let i = 0; i < 2; i++) {
            if (this.rot[i] === this.target_rot[i]) {
                continue;
            }
            const elapsed = this.move_clocks[i].getElapsedBeats();
            const ang_vel = this.target_rot[i] - this.start_rot[i];
            const sign_before = Math.sign(this.target_rot[i] - this.rot[i]);
            this.rot[i] = this.start_rot[i] + ang_vel * elapsed;
            const sign_after = Math.sign(this.target_rot[i] - this.rot[i]);
            if (sign_after != sign_before) {
                this.rot[i] = this.target_rot[i];
            }
        }

        //this.robot.rotation.x = this.rot[0] * Math.PI / ROT_DIV;
        this.robot.rotation.y = this.rot[1] * Math.PI / ROT_DIV;

        // Drive the robot grid's dance (and any other child components).
        super.anim_frame(dt);
    }
}
