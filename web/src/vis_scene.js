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
    constructor(num_states=1, max_bpm=140) {
        this.cur_divisor = 24;
        this.target_divisor = this.cur_divisor;
        this.bpm = 120;
        this.sync_rate_hz = this.bpm / 60 * this.cur_divisor;
        this.max_bpm = max_bpm;
        this.min_bpm = max_bpm / 2;
        this.div_change_hysteresis_bpm = 5;
        this.div_change_debounce_cnt = 4;
        this.div_change_debounce = 0;
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.cam_orth = null;
        this.frustum_size = 16;
        this.camera = this.cam_persp;
        this.yscale = 1.0;
        this.cur_state_idx = 0;
        this.num_states = num_states;
        this.active = false;
    }

    activate() {
        this.active = true;
    }

    deactivate() {
        this.active = false;
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

    handle_sync_raw(sync_rate_hz, beat) {
        this.sync_rate_hz = sync_rate_hz;
        let this_sync_divisor = this.cur_divisor;

        while (60 * sync_rate_hz / this_sync_divisor > this.max_bpm + this.div_change_hysteresis_bpm) {
            this_sync_divisor *= 2;
        }
        while (60 * sync_rate_hz / this_sync_divisor < this.min_bpm - this.div_change_hysteresis_bpm) {
            this_sync_divisor /= 2;
        }

        if (this_sync_divisor != this.cur_divisor) {
            if (this_sync_divisor == this.target_divisor) {
                // Decrement debounce counter or change divisor if it reached 0
                if (this.div_change_debounce > 0) {
                    this.div_change_debounce--;
                } else {
                    this.cur_divisor = this.target_divisor;
                }
            } else {
                // Restart debounce counter
                this.target_divisor = this_sync_divisor;
                this.div_change_debounce = this.div_change_debounce_cnt;
            }
        }

        this.bpm = 60 * sync_rate_hz / this.cur_divisor;

        if (beat % this.cur_divisor == 0) {
            //console.log(this.bpm)
            this.handle_sync(0, this.bpm,
                Math.floor(beat / this.cur_divisor));
        }
    }

    get_local_bpm() {
        return this.bpm;
    }

    // Returns the time in seconds between a beat event being received and the
    // beat audio being played, assuming midi events for the beat are placed
    // an eighth note earlier in the grid than the actual beats. Accounts for
    // network latency as measured by packet round-trip time.
    get_beat_delay(est_latency) {
        // 24 MIDI syncs per quarter note
        return 1.0 / this.sync_rate_hz * 24 / 2 - est_latency;
    }

    handle_sync(latency, sync_rate_hz, beat) {

    }

    handle_beat(latency, channel) {

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
