import * as THREE from 'three';
import { Scene } from './scene.js';

const NUM_DISPLAYS = 16;
const COLS = 4;
const ROWS = NUM_DISPLAYS / COLS;

// Grid layout in world units (orthographic, frustum_size 20 => y in [-10, 10]).
const COL_SPACING = 8;
const ROW_SPACING = 4.5;
const SPRITE_W = 6;
const SPRITE_H = 3;

const CANVAS_W = 256;
const CANVAS_H = 128;

// A single numeric readout backed by a canvas texture.
class Display {
    constructor(label) {
        this.label = label;
        this.canvas = document.createElement('canvas');
        this.canvas.width = CANVAS_W;
        this.canvas.height = CANVAS_H;
        this.ctx = this.canvas.getContext('2d');
        this.texture = new THREE.CanvasTexture(this.canvas);
        const material = new THREE.SpriteMaterial({
            map: this.texture,
            transparent: true,
        });
        this.sprite = new THREE.Sprite(material);
        this.sprite.scale.set(SPRITE_W, SPRITE_H, 1);
        this.draw(0);
    }

    draw(value) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.fillStyle = '#00ff66';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 28px monospace';
        ctx.fillText(this.label, CANVAS_W / 2, CANVAS_H * 0.3);
        ctx.font = 'bold 52px monospace';
        ctx.fillText(value.toFixed(2), CANVAS_W / 2, CANVAS_H * 0.68);
        this.texture.needsUpdate = true;
    }
}

// Debug scene: a grid of numeric readouts showing the live (normalized) values
// of MIDI knobs 1-16, driven through the standard knob -> property binding path.
export class DebugScene extends Scene {
    constructor(context) {
        super(context, 'debug');
        this.camera = this.cam_orth;

        this.displays = [];
        for (let i = 0; i < NUM_DISPLAYS; i++) {
            const display = new Display(`K${i + 1}`);
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            display.sprite.position.set(
                (col - (COLS - 1) / 2) * COL_SPACING,
                ((ROWS - 1) / 2 - row) * ROW_SPACING,
                0
            );
            this.add(display.sprite);
            this.displays.push(display);

            // One knob -> one display here, but bind() supports many bindings
            // per knob for one-knob -> many-properties mappings.
            this.bind('midi', i, (v) => display.draw(v));
        }
    }

    anim_frame(dt) {
        this.update_bindings();
        this.controls.update();
    }
}
