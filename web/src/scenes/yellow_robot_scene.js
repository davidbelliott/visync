import * as THREE from 'three';
import {
    update_persp_camera_aspect,
    update_orth_camera_aspect
} from '../util.js';
import { Scene } from './scene.js';
import { YellowRobot } from '../components/yellow_robot.js';
import { Tesseract } from '../highdim.js';
import { SteppedRotation } from '../stepped_rotation.js';
import {
    CH_EXPAND_X, CH_EXPAND_Y, CH_ROT_Y, knob_with_zero_zone
} from '../controller_map.js';


// Nominal Y rotation rate in rad/s; knob 8 scales it to [-2, 2] x this.
// A 45 deg step roughly every 5 s at 1x, matching the gantry scene.
const NOM_ROT_RATE = 0.15;
// Robot grid spacing in scene units at full knob travel.
const MAX_SPREAD = 8;


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
        // Knob 8 sets the Y rotation rate, shown in eased 45 deg steps on top
        // of a half-turn base (robots face the camera). Negated to match the
        // physical knob's direction.
        this.yaw = new SteppedRotation(NOM_ROT_RATE);
        this.yaw.bind(this, CH_ROT_Y, -1);

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
    }

    anim_frame(dt) {
        this.tesseract.rot_xw -= 0.05;
        this.tesseract.update_geom();

        this.robot.rotation.y = Math.PI + this.yaw.update(dt);

        // Drive the robot grid's dance (and any other child components).
        super.anim_frame(dt);
    }
}
