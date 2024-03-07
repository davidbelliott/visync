import * as THREE from 'three';

import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    arr_eq,
    clamp
} from './util.js';

export class VisScene {
    constructor(env, num_states=1, max_bpm=150) {
        this.env = env;
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.cam_orth = null;
        this.frustum_size = 16;
        this.camera = this.cam_persp;
        this.yscale = 1.0;
        this.cur_state_idx = 0;
        this.num_states = num_states;
        this.max_bpm = max_bpm;
        this.bpm_divisor = 1;
        this.last_bpm_recorded = 0;
    }

    activate() {
    }

    deactivate() {
    }

    anim_frame(dt) {
    }

    render(renderer) {
        renderer.render(this.scene, this.camera);
    }

    handle_key(key) {

    }

    _handle_sync_raw(t, bpm, beat) {
        this.bpm_divisor = 1;
        let div_bpm = bpm;
        while (div_bpm > this.max_bpm) {
            div_bpm /= 2;
            this.bpm_divisor *= 2;
        }

        if (beat % this.bpm_divisor == 0) {
            const beat_idx = Math.floor(beat / this.bpm_divisor);
            this.handle_sync(t, div_bpm, beat_idx);
        }
    }

    get_local_bpm() {
        return this.env.bpm / this.bpm_divisor;
    }

    handle_sync(t, bpm, beat) {

    }

    handle_beat(t, channel) {

    }

    state_transition(old_state_idx, new_state_idx) {

    }

    advance_state(steps) {
        const old_state_idx = this.cur_state_idx;
        this.cur_state_idx = clamp(this.cur_state_idx + steps, 0, this.num_states - 1);
        this.state_transition(old_state_idx, this.cur_state_idx);
    }

    handle_resize(width, height) {
        const aspect = width / height;
        if (this.cam_persp != null) {
            update_persp_camera_aspect(this.cam_persp, aspect);
        }
        if (this.cam_orth != null) {
            update_orth_camera_aspect(this.cam_orth, aspect, this.frustum_size);
        }
    }
}
