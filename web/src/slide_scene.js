import * as THREE from 'three';
import { VisScene } from './vis_scene.js';


export class SlideScene extends VisScene {
    constructor(img_paths) {
        super('slides', img_paths.length);
        this.img_paths = img_paths;
        this.imgbox = document.getElementById("imgbox");
        const img = document.createElement('img');
        img.src = this.img_paths[0];
        this.imgbox.replaceChildren(img);
    }

    state_transition(old_state_idx, new_state_idx) {
        super.state_transition(old_state_idx, new_state_idx);
        this.imgbox.children[0].src = this.img_paths[new_state_idx];
    }

    activate() {
        this.imgbox.style.display = "block";
    }

    deactivate() {
        this.imgbox.style.display = "none";
    }
}
