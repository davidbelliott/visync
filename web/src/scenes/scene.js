import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Component } from '../components/component.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    arr_eq,
    clamp
} from '../util.js';

export class Knob {
    constructor(min_val=0, max_val=1, default_val=0) {
        this.min_val = min_val;
        this.max_val = max_val;
        this.default_val = this.cur_val;
        this.cur_val = default_val;
    }
}

export class Scene extends THREE.Scene {
    constructor(context, shortname='scene') {
        super();
        this.shortname = shortname;
        this.context = context;
        this.cur_divisor = 24;
        this.target_divisor = this.cur_divisor;
        this.bpm = 120;
        this.sync_rate_hz = this.bpm / 60 * this.cur_divisor;
        this.max_bpm = 144;
        this.min_bpm = 81;
        this.div_change_hysteresis_bpm = 5;
        this.div_change_debounce_cnt = 4;
        this.div_change_debounce = 0;
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.cam_orth = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100);
        this.frustum_size = 20;
        this.camera = this.cam_orth;

        this.controls = new OrbitControls(this.camera, this.context.renderer.domElement);
        this.controls.enableDamping = false;
        this.prev_sync_idx = 0;

        this.knobs = new Map();
    }

    add_knob(name, min_val=0.0, max_val=1.0, default_val=0.0) {
        this.knobs.set(name, new Knob(min_val, max_val, default_val));
    }

    get_knob_val(name) {
        return this.knobs.get(name).cur_val;
    }

    anim_frame(dt) {
        this.controls.update();
        this.camera.zoom = 2 + Math.sin(this.get_knob_val('camera_zoom'));
        this.camera.updateProjectionMatrix();
        this.children.forEach((child) => {
            if (child.anim_frame) {
                child.anim_frame(dt);
            }
        });
    }

    handle_sync_raw(sync_rate_hz, sync_idx) {
        this.sync_rate_hz = sync_rate_hz;
        let this_sync_divisor = this.cur_divisor;

        this.cur_divisor = 24;

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

        const cur_beat = Math.floor(sync_idx / this.cur_divisor);
        if (cur_beat != this.prev_beat) {
            //console.log(`beat: ${cur_beat}`);
            this.handle_sync(0, this.bpm, cur_beat);
            this.prev_beat = cur_beat;
        }
    }

    get_local_bpm() {
        return this.bpm;
    }

    // Returns the time in seconds between a beat event being received and the
    // beat audio being played, assuming midi events for the beat are placed
    // a quarter note earlier in the grid than the actual beats. Accounts for
    // latency passed in as an argument.
    get_beat_delay(est_latency=0) {
        // 24 MIDI syncs per quarter note
        return this.context.immediate_mode ? 0.0 : 1.0 / this.sync_rate_hz * 24 - est_latency;
    }

    handle_sync(latency, sync_rate_hz, sync_idx) {
        this.children.forEach((child) => {
            if (child.handle_sync) {
                child.handle_sync(latency, sync_rate_hz, sync_idx);
            }
        });
    }

    handle_beat(latency, channel) {
        this.children.forEach((child) => {
            if (child.handle_beat) {
                child.handle_beat(latency, channel);
            }
        });
    }

    state_transition(old_state_idx, new_state_idx) {

    }

    advance_state(steps) {
        const old_state_idx = this.cur_state_idx;
        this.cur_state_idx = clamp(this.cur_state_idx + steps, 0, this.num_states - 1);
        this.state_transition(old_state_idx, this.cur_state_idx);
    }

    render(renderer, underlying_buffer) {
        renderer.render(this, this.camera);
    }

    activate() {
        this.active = true;
    }

    deactivate() {
        this.active = false;
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
