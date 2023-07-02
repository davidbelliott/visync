import * as THREE from 'three';
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
    ShaderLoader
} from './util.js';
import { Tesseract } from './highdim.js';


export class IntroScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.camera = this.cam_orth;

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(false);
        this.beat_clock = new THREE.Clock(false);

        this.base_group = new THREE.Group();
        this.tesseract = new Tesseract(10.0, this.cam_orth);

        this.base_group.add(this.tesseract);

        const cube = create_instanced_cube([3, 3, 3], 0x00ff00);
        //this.base_group.add(cube);

        this.tesseract.rot_yz = isom_angle;
        this.tesseract.rot_xz = Math.PI / 4;
        this.tesseract.rot_xw = Math.PI / 4;

        this.scene.add(this.base_group);

        this.rot = 1024 / 4;

        this.elapsed_beats = 0.0;
    }

    anim_frame(dt) {
        this.rot++;
    
        const beats_per_sec = this.env.bpm / 60;
        const clock_dt = this.clock.getDelta();
        const t_elapsed_since_beat = this.beat_clock.getElapsedTime();
        const t = t_elapsed_since_beat * beats_per_sec;
        const bounce_beats = 2;

        //const frac = 1 - clamp(beats_since_last_beat / recoil_beats, 0, 1);
        let frac = clamp(16 * t / bounce_beats * Math.exp(-5 * t / bounce_beats) * (1 - t / bounce_beats), 0, 1);
        frac = Math.sin(t * Math.PI / bounce_beats);
        //frac = 1 - Math.abs(2 * (t / bounce_beats) - 1);
        frac *= 4;

        //this.tesseract.rot_xw += 0.01;
        //this.tesseract.rot_xz += 0.01;
        //this.tesseract.rot_xz += 0.01;
        let arr = [];
        for (let i = 0; i < 4; i++) {
            const this_val = clamp(frac, 0, 1);
            arr.push(this_val);
            frac -= this_val;
        }

        this.tesseract.scale_vec.set(...arr);
        this.tesseract.update_geom(this.camera);
        //this.tesseract.rotation.x = this.rot * Math.PI / 1024;
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        this.beat_clock.start();
    }
}
