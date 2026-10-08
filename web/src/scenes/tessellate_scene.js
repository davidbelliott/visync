import * as THREE from 'three';
import { Scene } from './scene.js';
import { SteppedRotation, UPRIGHT_PITCHES, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    load_texture,
    ResourceLoader
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";

// Rotation (rad), identical to the spinning robots scene's so the two step in
// lockstep: yaw every 45 deg from a quarter-turn diagonal base, pitch between
// upright views (isometric tilt up or down, or level, edge-on to the pattern)
// starting tilted towards the viewer. Applied to view_group, about the
// flat-laid pattern's normal.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// The lizard tiling (img/lizard.svg, an Escher-style 3-fold tessellation).
// TEMPLATE_SCALE: SVG units -> scene units (y flipped: SVG is y-down).
// TILE_SPACING: scene units between neighbouring lattice copies.
// TILE_OFFSET: where orientation 0's lizard sits within its lattice cell;
// orientations 1 and 2 sit at this turned by 120 / 240 deg. These three
// values are what make the outlines interlock exactly.
const TEMPLATE_SCALE = new THREE.Vector3(0.05, -0.05, 0.05);
const TILE_SPACING = 12.45;
const TILE_OFFSET = [-5.35, 1.65];
// Radius (scene units) of the tiled disc: enough that, fully zoomed out at a
// 21:9 aspect and either pitch stop, the view's corners are still inside it
// (about 116 units out in the pattern plane). EDGE_FADE_WIDTH: the outer band
// over which lizards fade to transparent (eased), so the disc's edge never
// shows; at the default zoom the whole view is inside the opaque part.
const FILL_RADIUS = 120;
const EDGE_FADE_WIDTH = 60;
// How far a lizard jumps out of the plane at the crest of its wave (scene
// units).
const JUMP_HEIGHT = 8;
const COLOR_A = new THREE.Color("blue");
const COLOR_B = new THREE.Color("magenta");
const WHITE = new THREE.Color("white");
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Scratch objects for the per-frame instance updates (no per-frame alloc).
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();
const START_COLOR = new THREE.Color();

export class TessellateScene extends Scene {
    constructor(context) {
        super(context, 'tessellate');

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 40;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.clock = new THREE.Clock();
        // view_group carries the shared view rotation (Y up); base_group
        // holds the pattern, built in its XY plane facing the camera, and
        // lays it flat in view_group (its normal, +Z, along +Y).
        this.view_group = new THREE.Group();
        this.base_group = new THREE.Group();
        this.base_group.rotation.x = -Math.PI / 2;
        this.view_group.add(this.base_group);
        this.yaw = new SteppedRotation();
        this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });
        this.view_group.rotation.x = PITCH_BASE;
        this.view_group.rotation.y = YAW_BASE;

        this.beat_clock = new THREE.Clock(false);

        this.clear();

        // Lizard tiling: one outline instance per lizard, laid on a disc of
        // the tiling's lattice (see FILL_RADIUS) with an edge fade.
        this.lizards = null;    // the instanced outline collection, once loaded
        this.liz_x = null;      // per-lizard rest position in the pattern plane
        this.liz_y = null;
        this.liz_turn = null;   // which of the 3 orientations (0-2)
        this.liz_alpha = null;  // edge fade (see edge_alpha)
        new SVGLoader().load('img/lizard.svg', (data) => {
            // All sub-paths merged into one line-segment template, so a
            // lizard is one instance in one draw call.
            const verts = [];
            for (const path of data.paths) {
                for (const sub_path of path.subPaths) {
                    const pts = sub_path.getPoints();
                    for (let k = 0; k + 1 < pts.length; k++) {
                        verts.push(pts[k].x, pts[k].y, 0, pts[k + 1].x, pts[k + 1].y, 0);
                    }
                }
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
            this.build_tiling(geom);
        }, undefined, (error) => {
            console.log('An error happened: ' + error);
        });

        this.base_group.scale.set(1, 1, 1);

        this.add(this.view_group);
        this.evolve_time = 0;
        this.elapsed_time_beats = 0;
        update_orth_camera_aspect(this.camera, aspect, this.frustum_size);

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    get_palette_color(t) {
        const a = [0.5, 0.5, 0.5];
        const b = [0.5, 0.5, 0.5];
        const c = [2.0, 1.0, 0.0];
        const d = [0.5, 0.2, 0.25];

        const out = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            out[i] = a[i] + b[i] * Math.cos(2 * Math.PI * ( c[i] * t + d[i] ) );
        }
        console.log(out);
        return new THREE.Color(...out);
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        const clock_dt = this.clock.getDelta();
        this.elapsed_time_beats += clock_dt * beats_per_sec;
        const beat_elapsed = this.beat_clock.getElapsedTime() * beats_per_sec * 8;
        let evolve_dt = 1.0 * clock_dt;
        if (this.beat_clock.running) {
            evolve_dt += clock_dt * (beat_elapsed < 2.0 ? 2.0 : 0.0);
        }
        this.evolve_time += evolve_dt;
        // The shared view rotation in eased steps (see YAW_BASE). Colour
        // stays tied to the yaw (cur_rot).
        this.view_group.rotation.x = this.pitch.update(dt,
            PITCH_BASE + this.view_pitch(STEPPED_SCALE));
        const cur_rot = this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));
        this.view_group.rotation.y = YAW_BASE + cur_rot;

        if (this.lizards === null) {
            return;
        }
        // Each lizard jumps out of the plane (+Z, towards the viewer when
        // tilted down) in a wave running across x, phased by orientation,
        // and flashes white with it.
        START_COLOR.lerpColors(COLOR_A, COLOR_B, Math.abs((3 * cur_rot / (2 * Math.PI) % 2) - 1));
        const t = this.evolve_time / 8;
        const pos = SCRATCH_POS;
        for (let k = 0; k < this.liz_x.length; k++) {
            const jump = Math.max(1, 2 * Math.sin(2 * Math.PI *
                (t - this.liz_turn[k] / 3 + this.liz_x[k] / 150))) - 1;
            pos.set(this.liz_x[k], this.liz_y[k], JUMP_HEIGHT * jump);
            this.lizards.set_pos(k, pos);
            SCRATCH_COLOR.lerpColors(START_COLOR, WHITE, jump);
            this.lizards.set_color(k, SCRATCH_COLOR, this.liz_alpha[k]);
        }
    }

    // Lay the lizards out: the tiling repeats on a hexagonal lattice of
    // spacing TILE_SPACING, three lizards per cell (one per orientation,
    // each the template turned by -120 deg i at offset R(120 deg i) *
    // TILE_OFFSET; the lattice is unchanged by those turns). Every lattice
    // copy within FILL_RADIUS of the centre is placed.
    build_tiling(template) {
        const s = TILE_SPACING;
        const b1 = [Math.sqrt(3) / 2 * s, s / 2];     // lattice basis, 60 deg apart
        const b2 = [0, s];
        const reach = Math.ceil(FILL_RADIUS / (Math.sqrt(3) / 2 * s)) + 1;
        const xs = [], ys = [], turns = [];
        for (let i = 0; i < 3; i++) {
            const ang = i * 2 * Math.PI / 3;
            const ox = TILE_OFFSET[0] * Math.cos(ang) - TILE_OFFSET[1] * Math.sin(ang);
            const oy = TILE_OFFSET[0] * Math.sin(ang) + TILE_OFFSET[1] * Math.cos(ang);
            for (let m = -reach; m <= reach; m++) {
                for (let n = -2 * reach; n <= 2 * reach; n++) {
                    const x = ox + m * b1[0] + n * b2[0];
                    const y = oy + m * b1[1] + n * b2[1];
                    if (Math.hypot(x, y) < FILL_RADIUS) {
                        xs.push(x);
                        ys.push(y);
                        turns.push(i);
                    }
                }
            }
        }
        const count = xs.length;
        this.lizards = new InstancedGeometryCollection(this.base_group, template, 'Lines', count);
        this.liz_x = Float32Array.from(xs);
        this.liz_y = Float32Array.from(ys);
        this.liz_turn = Uint8Array.from(turns);
        this.liz_alpha = new Float32Array(count);
        const quat = new THREE.Quaternion();
        for (let k = 0; k < count; k++) {
            // The cell offsets turn counter-clockwise while each outline
            // turns clockwise; that pairing is what makes the y-flipped
            // (negative-scale) template tessellate.
            quat.setFromAxisAngle(Z_AXIS, -turns[k] * 2 * Math.PI / 3);
            SCRATCH_POS.set(xs[k], ys[k], 0);
            this.lizards.create_geom(SCRATCH_POS, COLOR_A, TEMPLATE_SCALE, quat);
            const r = Math.hypot(xs[k], ys[k]);
            this.liz_alpha[k] = ease(clamp((FILL_RADIUS - r) / EDGE_FADE_WIDTH, 0, 1));
        }
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay();
        setTimeout(() => {
            if (channel == 1 || channel == 3) {
                this.beat_clock.start();
            }
        }, delay * 1000);
    }
}
