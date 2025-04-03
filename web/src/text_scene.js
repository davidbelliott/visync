"use strict";
import * as THREE from 'three';
import { VisScene } from './vis_scene.js'

export class TextScene extends VisScene {
    constructor(text_file_path='/txt/drums.txt') {
        super('text', 0);

        this.paragraphs = [''];
        this.text_div = document.getElementById('textbox');
        this.text_div_inner = document.createElement('div');
        this.text_div_inner.setAttribute("class", "textbox-inner");
        this.text_div.replaceChildren(this.text_div_inner);
        this.cur_state_idx = 0;
        const this_obj = this;
        fetch(text_file_path).then( resp => {
            if (resp.ok) {
                resp.text().then( textData => {
                    const pars = textData.split('\n');
                    this_obj.paragraphs = pars;
                    this_obj.text_div_inner.textContent = this_obj.paragraphs[this_obj.cur_state_idx];
                    this_obj.num_states = this_obj.paragraphs.length;
                });
            }
        });

    }

    state_transition(old_state_idx, new_state_idx) {
        super.state_transition(old_state_idx, new_state_idx);
        this.text_div_inner.textContent = this.paragraphs[this.cur_state_idx];
    }

    activate() {
        this.text_div.style.display = "block";
    }

    deactivate() {
        this.text_div.style.display = "none";
    }
}
