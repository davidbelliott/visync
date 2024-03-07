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
    ShaderLoader,
    BeatClock,
} from './util.js';
import { Tesseract } from './highdim.js';


export class IntroScene extends VisScene {
    constructor(env) {
        super(env, 8);

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
        this.sync_clock = new BeatClock(this, false);
        this.beat_clock = new BeatClock(this, false);
        this.dim_change_clock = new BeatClock(this, false);

        this.base_group = new THREE.Group();
        this.tesseract = new Tesseract(10.0, this.cam_orth);

        this.base_group.add(this.tesseract);

        const cube = create_instanced_cube([3, 3, 3], 0x00ff00);
        //this.base_group.add(cube);

        this.tesseract.rot_yz = isom_angle;
        this.tesseract.rot_xz = Math.PI / 4;
        this.tesseract.rot_xw = Math.PI / 4;

        this.scene.add(this.base_group);

        this.start_rot = 0;
        this.end_rot = 0;
        this.rot_dir = 1;

        this.cur_dim = 1;
        this.dim_change_direction = 0;

        this.elapsed_beats = 0.0;
        this.do_rotation = false;

        this.scales = new Array(4).fill(0);
    }

    anim_frame(dt) {
        const beats_per_lerp = 1.0;

        // Handle rotation
        {
            const t_sync = this.sync_clock.get_elapsed_beats();
            const frac = clamp((t_sync - (1 - beats_per_lerp)) / beats_per_lerp, 0, 1);
            if (this.cur_dim == 4) {
                this.tesseract.rot_xw = Math.PI / 8 * (2 + this.start_rot +
                    lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot));
            } else {
                this.tesseract.rot_xw = 0;
            }
            this.tesseract.rotation.y = Math.PI / 4 * (this.start_rot +
                lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot));
        }



        this.rot++;
    
        const t = this.beat_clock.get_elapsed_beats();
        const bounce_beats = 4;
        const state_change_beats = 8;

        //const frac = 1 - clamp(beats_since_last_beat / recoil_beats, 0, 1);
        let frac = clamp(16 * t / bounce_beats * Math.exp(-5 * t / bounce_beats) * (1 - t / bounce_beats), 0, 1);
        frac = Math.sin(t * Math.PI / bounce_beats);
        //frac = 1 - Math.abs(2 * (t / bounce_beats) - 1);

        //this.tesseract.rot_xw += 0.01;
        //this.tesseract.rot_xz += 0.01;
        //this.tesseract.rot_xz += 0.01;
        /*let arr = [];
        frac *= 4;
        for (let i = 0; i < 4; i++) {
            const this_val = clamp(frac, 0, 1);
            arr.push(this_val);
            frac -= this_val;
        }*/
        let state_change_frac = clamp(this.dim_change_clock.get_elapsed_beats() / state_change_beats, 0, 1);
        const scaling_idx = this.cur_dim - 1 - this.dim_change_direction;

        this.scales[this.cur_dim - 1] = frac;
        if (this.dim_change_direction == -1) {
            // Going down from higher dim
            this.scales[this.cur_dim - 1] *= 1;
            this.scales[this.cur_dim] = Math.min(this.scales[this.cur_dim],
                1 - state_change_frac);
            for (let i = this.cur_dim + 1; i < this.scales.length; i++) {
                this.scales[i] = 0;
            }
            for (let i = 0; i < this.cur_dim - 1; i++) {
                this.scales[i] = 1;
            }
        } else if (this.dim_change_direction == 1) {
            // Going up from lower dim
            this.scales[this.cur_dim - 1] *= state_change_frac;
            this.scales[this.cur_dim - 2] = Math.max(this.scales[this.cur_dim - 2],
                state_change_frac);

            for (let i = this.cur_dim; i < this.scales.length; i++) {
                this.scales[i] = 0;
            }
            for (let i = 0; i < this.cur_dim - 2; i++) {
                this.scales[i] = 1;
            }
        }

        this.tesseract.scale_vec.set(...this.scales);
        this.tesseract.update_geom(this.camera);
    }

    handle_sync(t, bpm, beat) {
        if (beat % 2 == 0) {
            if (this.do_rotation) {
                this.start_rot = this.end_rot;
                this.end_rot = this.start_rot + this.rot_dir;
            } else {
                this.start_rot = this.end_rot;
                this.end_rot = Math.floor((this.end_rot + this.rot_dir) / 2) * 2;
            }

            this.sync_clock.start();
        }
        if (beat % 4 == 0) {
            this.beat_clock.start();
        }
    }

    handle_beat(t, channel) {
    }


    state_transition(old_state_idx, new_state_idx) {
        this.do_rotation = (new_state_idx % 2 == 1);
        const new_dims = Math.floor(this.cur_state_idx / 2) + 1
        if (new_dims != this.cur_dim) {
            this.dim_change_clock.start();
        }
        this.cur_dim = new_dims;
        if (old_state_idx < new_state_idx) {
            this.dim_change_direction = 1;
        } else if (old_state_idx > new_state_idx) {
            this.dim_change_direction = -1;
        } else {
            this.dim_change_direction = 0;
        }
        //this.do_rotation = false;
    }

}
