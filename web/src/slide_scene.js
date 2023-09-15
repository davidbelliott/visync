import * as THREE from 'three';
import { VisScene } from './vis_scene.js';


export class SlideScene extends VisScene {
    constructor(env, img_paths) {
        super(env, img_paths.length);
        this.img_paths = img_paths;
        this.full_overlay = document.getElementById("full-overlay");
        this.full_overlay.children[0].src = this.img_paths[0];
    }

    state_transition(old_state_idx, new_state_idx) {
        super.state_transition(old_state_idx, new_state_idx);
        this.full_overlay.children[0].src = this.img_paths[new_state_idx];
    }

    activate() {
        this.full_overlay.style.display = "block";
    }

    deactivate() {
        this.full_overlay.style.display = "none";
    }
}
