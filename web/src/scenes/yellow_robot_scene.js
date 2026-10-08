import * as THREE from 'three';
import {
    update_persp_camera_aspect,
    update_orth_camera_aspect
} from '../util.js';
import { Scene } from './scene.js';
import { YellowRobot } from '../components/yellow_robot.js';
import { Tesseract } from '../highdim.js';
import { SteppedRotation, UPRIGHT_PITCHES, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
import {
    CH_EXPAND_X, CH_EXPAND_Y, knob_with_zero_zone
} from '../controller_map.js';


// Robot grid spacing in scene units at full knob travel.
const MAX_SPREAD = 8;



// Rotation (rad), identical in the spinning and yellow robot scenes apart from
// YAW_BASE: both step with the shared view at STEPPED_SCALE, yaw every 45 deg
// and pitch between upright views (isometric tilt up or down, or level)
// starting tilted towards the viewer (PITCH_BASE), applied to the robots'
// group the same way. This robot model faces -Z (the spinning robots' face
// +Z), so PI turns it to face the same way as theirs; the rest is their PI / 4
// base plus a quarter turn, so the two scenes' robots always face
// orthogonally.
const YAW_BASE = Math.PI + Math.PI / 4 + Math.PI / 2;
const PITCH_BASE = ISOMETRIC_TILT;

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
        // The shared view rotation in eased steps (see YAW_BASE).
        this.yaw = new SteppedRotation();
        this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });

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
        this.add(this.robot);

        // MIDI knob 3 -> x spacing, knob 4 -> y spacing (0..MAX_SPREAD),
        // updating the grid live. The bottom of each knob's travel is exactly
        // 0, collapsing that axis so the robots overlap perfectly.
        this.bind(CH_EXPAND_X, (v) => { this.robot.spread_x = v; },
            knob_with_zero_zone(MAX_SPREAD));
        this.bind(CH_EXPAND_Y, (v) => { this.robot.spread_y = v; },
            knob_with_zero_zone(MAX_SPREAD));

        this.cam_persp.position.set(0, 0, 8);
        this.cam_orth.position.set(0, 0, 8);

        this.camera = this.cam_orth;
        //this.camera = this.cam_persp;

        update_orth_camera_aspect(this.cam_orth, aspect, this.frustum_size);
        update_persp_camera_aspect(this.cam_persp, aspect);

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        this.tesseract.rot_xw -= 0.05;
        this.tesseract.update_geom();

        this.robot.rotation.x = this.pitch.update(dt,
            PITCH_BASE + this.view_pitch(STEPPED_SCALE));
        this.robot.rotation.y = YAW_BASE + this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));

        // Drive the robot grid's dance (and any other child components).
        super.anim_frame(dt);
    }
}
