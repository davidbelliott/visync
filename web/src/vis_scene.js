import * as THREE from 'three';

import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    arr_eq
} from './util.js';

export class VisScene {
    constructor(env) {
        this.env = env;
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.cam_orth = null;
        this.frustum_size = 16;
        this.camera = this.cam_persp;
        this.yscale = 1.0;
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

    handle_sync(t, bpm, beat) {
        
    }

    handle_beat(t, channel) {

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
