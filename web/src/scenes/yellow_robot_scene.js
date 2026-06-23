import * as THREE from 'three';
import {
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    arr_eq,
    BeatClock
} from '../util.js';
import { Scene } from './scene.js';
import { YellowRobot } from '../components/yellow_robot.js';
import { Tesseract } from '../highdim.js';


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
        this.move_clock = new BeatClock(this);

        this.start_rot = [0, 0];
        this.target_rot = [0, 0];
        this.rot = [0, 512 / 2];

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

        this.cam_persp.position.set(0, 0, 8);
        this.cam_orth.position.set(0, 0, 8);

        this.camera = this.cam_orth;
        //this.camera = this.cam_persp;

        update_orth_camera_aspect(this.cam_orth, aspect, this.frustum_size);
        update_persp_camera_aspect(this.cam_persp, aspect);
    }

    handle_sync(t, bpm, beat) {
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

        // Drive the robot grid's dance.
        super.handle_sync(t, bpm, beat);
    }

    anim_frame(dt) {
        const div = 512;    // # of divisions per pi radians

        this.tesseract.rot_xw -= 0.05;
        this.tesseract.update_geom();

        if (this.go_to_target) {
            let elapsed = this.move_clock.getElapsedBeats();
            for (var i = 0; i < 2; i++) {
                const ang_vel = (this.target_rot[i] - this.start_rot[i]);
                const sign_before = Math.sign(this.target_rot[i] - this.rot[i]);
                this.rot[i] = this.start_rot[i] + ang_vel * elapsed;
                const sign_after = Math.sign(this.target_rot[i] - this.rot[i]);
                if (sign_after != sign_before) {
                    this.rot[i] = this.target_rot[i];
                }
            }
            if (arr_eq(this.rot, this.target_rot)) {
                this.go_to_target = false;
            }
        }

        //this.robot.rotation.x = this.rot[0] * Math.PI / div;
        this.robot.rotation.y = this.rot[1] * Math.PI / div;

        // Drive the robot grid's dance (and any other child components).
        super.anim_frame(dt);
    }
}
