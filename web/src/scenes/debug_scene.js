import * as THREE from 'three';
import { Scene } from './scene.js';

const NUM_DIALS = 16;
const COLS = 4;
const ROWS = NUM_DIALS / COLS;

// Grid layout in world units (orthographic, frustum_size 20 => y in [-10, 10]).
const COL_SPACING = 8;
const ROW_SPACING = 4.5;

const INNER_R = 1.2;
const OUTER_R = 1.7;
const SEGMENTS = 128;          // circle smoothness
const DIAL_COLOR = 0xffffff;
const HALF_PI = Math.PI / 2;

// Outline circle as a 1px-wide line loop (WebGL lines are always single-pixel).
function circle_geometry(radius) {
    const pts = [];
    for (let i = 0; i < SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
}

// A round "filled dial": two concentric 1px circles with a RingGeometry sector
// fill that sweeps clockwise from the bottom (-90 deg).
class Dial {
    constructor() {
        this.group = new THREE.Group();

        const line_mat = new THREE.LineBasicMaterial({ color: DIAL_COLOR });
        this.group.add(new THREE.LineLoop(circle_geometry(INNER_R), line_mat));
        this.group.add(new THREE.LineLoop(circle_geometry(OUTER_R), line_mat));

        this.fill_material = new THREE.MeshBasicMaterial({
            color: DIAL_COLOR,
            side: THREE.DoubleSide,
        });
        this.fill = new THREE.Mesh(new THREE.BufferGeometry(), this.fill_material);
        this.fill.position.z = -0.02;   // sit just behind the outline circles
        this.group.add(this.fill);

        this.value = -1;
        this.set(0);
    }

    // value in [0, 1] -> fraction of the ring filled, clockwise from the bottom.
    set(value) {
        if (Math.abs(value - this.value) < 1e-4) {
            return;
        }
        this.value = value;
        const phi = value * Math.PI * 2;
        const segs = Math.max(1, Math.ceil(value * SEGMENTS));
        this.fill.geometry.dispose();
        // RingGeometry sweeps CCW from thetaStart; place the start phi clockwise
        // of the bottom so the trailing edge stays pinned at the bottom.
        this.fill.geometry = new THREE.RingGeometry(
            INNER_R, OUTER_R, segs, 1, -HALF_PI - phi, phi
        );
    }
}

// Debug scene: a grid of 16 round dials showing the live (normalized) values of
// MIDI knobs 1-16, driven through the standard knob -> property binding path.
export class DebugScene extends Scene {
    constructor(context) {
        super(context, 'debug');
        this.camera = this.cam_orth;
        this.camera.position.set(0, 0, 10);

        this.dials = [];
        for (let i = 0; i < NUM_DIALS; i++) {
            const dial = new Dial();
            const col = i % COLS;
            const row = Math.floor(i / COLS);
            dial.group.position.set(
                (col - (COLS - 1) / 2) * COL_SPACING,
                ((ROWS - 1) / 2 - row) * ROW_SPACING,
                0
            );
            this.add(dial.group);
            this.dials.push(dial);

            // One knob -> one dial here, but bind() supports many bindings per
            // knob for one-knob -> many-properties mappings.
            this.bind('apc', i, (v) => dial.set(v));
        }
    }

    anim_frame(dt) {
        this.update_bindings();
        this.controls.update();
    }
}
