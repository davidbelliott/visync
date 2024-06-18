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

export const EXTRA_LATENCY = 0.1;

export class VisScene {
    constructor(num_states=1, max_bpm=125) {
        this.raw_bpm = 120;
        this.bpm = this.raw_bpm;
        this.max_bpm = max_bpm;
        this.est_latency = 0.0;
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.cam_orth = null;
        this.frustum_size = 16;
        this.camera = this.cam_persp;
        this.yscale = 1.0;
        this.cur_state_idx = 0;
        this.num_states = num_states;
    }

    activate() {
    }

    deactivate() {
    }

    anim_frame(dt) {
    }

    handle_key(key) {
        if (key == "ArrowLeft") {
            this.advance_state(-1);
        } else if (key == "ArrowRight") {
            this.advance_state(1);
        }
    }

    handle_sync_raw(bpm, beat) {
        this.raw_bpm = bpm;
        let divisor = 1;
        while (bpm > this.max_bpm) {
            bpm /= 2;
            divisor *= 2;
        }
        if (beat % divisor == 0) {
            this.handle_sync(0, bpm, Math.floor(beat / divisor));
        }
        this.bpm = bpm;
    }

    get_local_bpm() {
        return this.bpm;
    }

    // Returns the time in seconds between a beat event being received and the
    // beat audio being played, assuming midi events for the beat are placed
    // an eighth note earlier in the grid than the actual beats. Accounts for
    // network latency as measured by packet round-trip time.
    get_beat_delay() {
        return 2 * 60.0 / this.raw_bpm - this.est_latency - EXTRA_LATENCY;
    }

    handle_sync(t, bpm, beat) {

    }

    handle_beat(t, channel) {

    }

    state_transition(old_state_idx, new_state_idx) {

    }

    render(renderer) {
        renderer.render(this.scene, this.camera);
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
