import * as THREE from 'three';

export class VisScene {
    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
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

    handle_beat() {

    }

    handle_resize(width, height) {
        const aspect = width / height;
        update_persp_camera_aspect(this.camera, aspect);
    }
}
