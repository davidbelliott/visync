import * as THREE from 'three';
import { Scene } from './scene.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
    lerp_scalar,
    ease,
    clamp,
    BeatClock
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';

// Hue drift rate (cycles/sec) per scene state; 0 = hold the start color.
const COLOR_CHANGE_RATE = 0.08;
const DRIFT_VEL = 5;
const START_COLOR = new THREE.Color("red");
const PADDLE_COLOR = new THREE.Color("white");

// The STL exports are 8x larger than scene units; baked into the template
// geometry once so instances render at unit scale.
const STL_SCALE = 1 / 8;
// Edge-extraction threshold (degrees) for the white wireframe overlays.
const EDGE_THRESHOLD_DEG = 30;
// Fill opacity under the wireframes (matches the old 0.9 material opacity).
const FILL_ALPHA = 0.9;

// Lighting: the old scene hung two point lights off every paddle group (72
// lights total), which dominated the frame cost. The instanced grid is now
// lit by a single overhead point light — decay 1 (linear) so the pool of
// light reads across the whole 12x12 grid — plus a dim directional so no
// facet goes fully black.
const POINT_LIGHT_INTENSITY = 30;
const POINT_LIGHT_HEIGHT = 40;      // world units above the drum plane
const DIRECTIONAL_INTENSITY = 0.3;

// Scratch objects reused by per-frame instance updates (no per-frame alloc).
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();
const SCRATCH_COLOR_OFFSET = new THREE.Color();
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

class PaddleGroup {
    constructor(parent_scene, drum_indices) {
        this.parent_scene = parent_scene;
        this.cur_drum_idx = drum_indices;

        this.retreat_pos = new THREE.Vector3(40, 40, 0);
        this.position = this.retreat_pos.clone();
        this.rot_z = 0;

        // Instance handles into the scene's shared paddle collections: one
        // top paddle and four side paddles per group. Fill and wire
        // collections allocate in lockstep, so one index serves both.
        this.top_idx = parent_scene.paddle_top_fill.create_geom(
            this.retreat_pos, PADDLE_COLOR, UNIT_SCALE, null, FILL_ALPHA);
        parent_scene.paddle_top_wire.create_geom(
            this.retreat_pos, PADDLE_COLOR, UNIT_SCALE);
        this.side_idxs = [];
        for (let i = 0; i < 4; i++) {
            this.side_idxs.push(parent_scene.paddle_side_fill.create_geom(
                this.retreat_pos, PADDLE_COLOR, UNIT_SCALE, null, FILL_ALPHA));
            parent_scene.paddle_side_wire.create_geom(
                this.retreat_pos, PADDLE_COLOR, UNIT_SCALE);
        }

        // Last jump axis: 0 = x, 1 = y
        this.last_jump_axis = 0;

        // Physical constants for paddles
        this.top_paddle_strike_vel = 80;
        this.side_paddle_strike_vel = 20;

        this.top_paddle_pound_time = 0.08;
        this.side_paddle_pound_time = 0.15;
        this.movement_time_secs = 0.25;
        this.impacts = [];

        this.in_position = false;

        this.movement_clock = new THREE.Clock(false);
        this.movement_clock.start();

        this.movement_start_pos = this.parent_scene.drum_pos_in_array(...this.cur_drum_idx).clone();
        this.movement_end_pos = this.movement_start_pos.clone();
        this.retreat_movement_secs = 4;
        this.time_for_this_movement = this.retreat_movement_secs;
    }


    paddle_pos(t_till_impact, target_drum_z) {
        const t = t_till_impact;
        const plain_pos = 4 * (Math.abs(t + 0.5) - 0.5);
        if (plain_pos > target_drum_z) {
            return [plain_pos, false];
        } else {
            return [target_drum_z, true];
        }
    }
    side_paddle_pos(t_till_impact) {
        const t = t_till_impact;
        return 4 * (1 - (Math.abs(clamp(2 * t, -1, 1)) - 1) ** 2);
    }

    paddle_group_movement_y(t) {
        return 6 * (1 - (2 * t - 1) ** 2);
        //return 8 * Math.min(0.5, 1 - Math.abs(2 * t - 1));
    }

    offset_by(offset) {
        this.movement_start_pos.add(offset);
        this.movement_end_pos.add(offset);
        this.cur_drum_idx[0] = (this.cur_drum_idx[0] + Math.round(offset.x / this.parent_scene.spacing)) % this.parent_scene.num_per_side;
        this.cur_drum_idx[1] = (this.cur_drum_idx[1] + Math.round(offset.y / this.parent_scene.spacing)) % this.parent_scene.num_per_side;
    }

    anim_frame(dt) {
        // Discard old impacts
        while (this.impacts.length > 0 &&
                this.impacts[0][0] < -16 * this.top_paddle_pound_time) {
            this.impacts.shift();
        }

        const scene = this.parent_scene;
        const drum = scene.drums[this.cur_drum_idx[0]][this.cur_drum_idx[1]];
        const target_drum_z = drum.z;

        const frac = clamp(
            this.movement_clock.getElapsedTime() / this.time_for_this_movement, 0, 1);
        this.position.lerpVectors(this.movement_start_pos, this.movement_end_pos, frac);
        this.position.z = this.paddle_group_movement_y(frac);

        let top_paddle_pos = this.paddle_pos(1, target_drum_z)[0];
        let side_paddle_pos = this.side_paddle_pos(1, 0);

        this.in_position = frac > 0.9;

        for (let i = 0; i < this.impacts.length; i++) {
            const new_time = this.impacts[i][0] - dt;
            if (this.in_position && this.impacts[i][0] >= 0 && new_time < 0) {
                // Impact on target drum
                let strike_vel = 0;
                if (this.impacts[i][1] == 1 || this.impacts[i][1] == 3) {
                    strike_vel = this.top_paddle_strike_vel;
                } else if (this.impacts[i][1] == 2) {
                    strike_vel = this.side_paddle_strike_vel;
                }
                let new_vel = drum.vel_z;
                new_vel -= strike_vel;
                new_vel = clamp(new_vel, -this.top_paddle_strike_vel, this.top_paddle_strike_vel);
                drum.vel_z = new_vel;
                // It now takes a normal # of beats to move between drums
                this.time_for_this_movement = this.movement_time_secs;
            }
            this.impacts[i][0] = new_time;

            if (this.in_position) {
                // Look at channel associated with the upcoming impact
                if (this.impacts[i][1] == 1 || this.impacts[i][1] == 3) {
                    top_paddle_pos = Math.min(top_paddle_pos, this.paddle_pos(
                        this.impacts[i][0] / this.top_paddle_pound_time,
                        target_drum_z)[0]);
                } else if (this.impacts[i][1] == 2) {
                    side_paddle_pos = Math.min(side_paddle_pos, this.side_paddle_pos(
                        this.impacts[i][0] / this.side_paddle_pound_time));
                }
            }
        }

        // Track the target drum's spin, then write this group's five paddle
        // instances into the shared collections.
        this.rot_z = drum.rot_z;

        SCRATCH_POS.set(this.position.x, this.position.y,
            this.position.z + top_paddle_pos);
        scene.paddle_top_fill.set_pos(this.top_idx, SCRATCH_POS);
        scene.paddle_top_wire.set_pos(this.top_idx, SCRATCH_POS);
        scene.paddle_top_fill.set_rotation_z(this.top_idx, this.rot_z);
        scene.paddle_top_wire.set_rotation_z(this.top_idx, this.rot_z);

        for (let i = 0; i < 4; i++) {
            // Each side paddle sits at (1,1,1)/2 * side_paddle_pos in its own
            // quarter-turn frame; compose that quarter turn with the group
            // rotation to place it in drums_group space.
            const ang = this.rot_z + i * Math.PI / 2;
            const r = side_paddle_pos / 2;
            SCRATCH_POS.set(
                this.position.x + r * (Math.cos(ang) - Math.sin(ang)),
                this.position.y + r * (Math.sin(ang) + Math.cos(ang)),
                this.position.z + r);
            scene.paddle_side_fill.set_pos(this.side_idxs[i], SCRATCH_POS);
            scene.paddle_side_wire.set_pos(this.side_idxs[i], SCRATCH_POS);
            scene.paddle_side_fill.set_rotation_z(this.side_idxs[i], ang);
            scene.paddle_side_wire.set_rotation_z(this.side_idxs[i], ang);
        }
    }

    handle_sync(t, bpm, beat) {
        if (this.in_position) {
            if (beat % 4 == 3) {
                // Do a jump
                this.last_jump_axis = (this.last_jump_axis + 1) % 2;
                this.cur_drum_idx[this.last_jump_axis] -= 1;
                if (this.cur_drum_idx[this.last_jump_axis] < 0) {
                    this.cur_drum_idx[this.last_jump_axis] += this.parent_scene.num_per_side;
                } else {
                    this.movement_clock.start();
                }
                this.movement_start_pos.copy(this.position);
                this.movement_end_pos.copy(this.parent_scene.drum_pos_in_array(
                    this.cur_drum_idx[0], this.cur_drum_idx[1]));
            }
        }
    }
}

export class DrumboxScene extends Scene {
    constructor(context) {
        super(context, 'drumbox');
        this.frustum_size = 60;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.initialized = false;

        this.drums = [];
        this.paddle_groups = [];

        this.base_group = new THREE.Group();
        this.drums_group = new THREE.Group();
        this.base_group.add(this.drums_group);


        this.spacing = 16;
        this.num_per_side = 12;

        const stl_paths = [
            'stl/truncated-cuboctahedron.stl',
            'stl/drumbox-paddle-top.stl',
            'stl/drumbox-paddle-side-0.stl',
        ];
        Promise.all(stl_paths.map((path) => new STLLoader().loadAsync(path)))
            .then(([drum_geom, top_geom, side_geom]) => {
                for (const geom of [drum_geom, top_geom, side_geom]) {
                    geom.scale(STL_SCALE, STL_SCALE, STL_SCALE);
                }

                const num_drums = this.num_per_side * this.num_per_side;
                const num_paddle_groups = (this.num_per_side / 2) ** 2;

                // One fill + wireframe collection pair per repeated shape;
                // the whole scene renders in six draw calls.
                this.drum_fill = new InstancedGeometryCollection(
                    this.drums_group, drum_geom, 'Triangles', num_drums);
                this.drum_wire = new InstancedGeometryCollection(
                    this.drums_group,
                    new THREE.EdgesGeometry(drum_geom, EDGE_THRESHOLD_DEG),
                    'Lines', num_drums);
                this.paddle_top_fill = new InstancedGeometryCollection(
                    this.drums_group, top_geom, 'Triangles', num_paddle_groups);
                this.paddle_top_wire = new InstancedGeometryCollection(
                    this.drums_group,
                    new THREE.EdgesGeometry(top_geom, EDGE_THRESHOLD_DEG),
                    'Lines', num_paddle_groups);
                this.paddle_side_fill = new InstancedGeometryCollection(
                    this.drums_group, side_geom, 'Triangles', 4 * num_paddle_groups);
                this.paddle_side_wire = new InstancedGeometryCollection(
                    this.drums_group,
                    new THREE.EdgesGeometry(side_geom, EDGE_THRESHOLD_DEG),
                    'Lines', 4 * num_paddle_groups);

                for (let i = 0; i < this.num_per_side; i++) {
                    this.drums.push([]);
                    for (let j = 0; j < this.num_per_side; j++) {
                        const pos = this.drum_pos_in_array(i, j);
                        const idx = this.drum_fill.create_geom(
                            pos, START_COLOR, UNIT_SCALE, null, FILL_ALPHA);
                        this.drum_wire.create_geom(pos, START_COLOR, UNIT_SCALE);
                        // Per-drum spring state; rendering lives entirely in
                        // the instance buffers.
                        this.drums[i].push({
                            idx: idx, x: pos.x, y: pos.y,
                            z: 0, vel_z: 0, rot_z: 0,
                        });

                        if (i % 2 == 0 && j % 2 == 0) {
                            this.paddle_groups.push(new PaddleGroup(this, [i, j]));
                        }
                    }
                }
                this.initialized = true;
            });

        // Physical constants for drums
        this.damping_coeff = 2;
        this.spring_constant = 200;

        this.drums_group.rotation.z = Math.PI / 4;
        this.camera.rotation.x = Math.PI / 4;

        this.clear();
        this.add(this.base_group);

        this.point_light = new THREE.PointLight(
            "white", POINT_LIGHT_INTENSITY, 0, 1.0);
        this.point_light.position.set(0, 0, POINT_LIGHT_HEIGHT);
        this.base_group.add(this.point_light);
        this.directional_light = new THREE.DirectionalLight(
            "white", DIRECTIONAL_INTENSITY);
        this.directional_light.position.set(0, 0, 100);
        this.base_group.add(this.directional_light);

        this.color_hue = 0.0;

        // Camera zooming
        this.zoom_clock = new BeatClock(this);
        this.start_zoom = this.camera.zoom;
        this.target_zoom = this.camera.zoom;
        this.zoom_movement_beats = 1;
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
        return new THREE.Color(...out);
    }

    drum_spring_accel(x, v) {
        return -this.damping_coeff * v - this.spring_constant * x;
    }

    drum_pos_in_array(i, j) {
        return new THREE.Vector3(
            this.spacing * (i - this.num_per_side / 2),
            this.spacing * (j - this.num_per_side / 2),
            0);
    }

    anim_frame(dt) {
        if (!this.initialized) {
            return;
        }

        this.drums_group.position.y += DRIFT_VEL * dt;
        const max_offset = 2 * this.spacing * Math.sqrt(2);
        while (this.drums_group.position.y > max_offset) {
            this.drums_group.position.y -= max_offset;
            for (let idx = 0; idx < 2 * this.num_per_side - 1; idx++) {
                let i = clamp(idx, 0, this.num_per_side - 1);
                let j = clamp(2 * this.num_per_side - 1 - idx, 0, this.num_per_side - 1);
                while (i > 1 && j > 1) {
                    const prev_i = i - 2;
                    const prev_j = j - 2;
                    this.drums[i][j].z = this.drums[prev_i][prev_j].z;
                    this.drums[i][j].vel_z = this.drums[prev_i][prev_j].vel_z;
                    i = prev_i;
                    j = prev_j;
                }
            }
        }

        for (const paddle_group of this.paddle_groups) {
            paddle_group.anim_frame(dt);
        }

        // Advance the shared hue, then integrate the drum springs and write
        // position/rotation/color straight into the instance buffers.
        this.color_hue += dt * COLOR_CHANGE_RATE;
        SCRATCH_COLOR.copy(START_COLOR);
        SCRATCH_COLOR_OFFSET.setHSL(this.color_hue % 1, 1, 0.5);
        SCRATCH_COLOR.add(SCRATCH_COLOR_OFFSET);
        for (const row of this.drums) {
            for (const drum of row) {
                drum.rot_z += 0.01;
                drum.z += drum.vel_z * dt;
                drum.vel_z += this.drum_spring_accel(drum.z, drum.vel_z) * dt;
                SCRATCH_POS.set(drum.x, drum.y, drum.z);
                this.drum_fill.set_pos(drum.idx, SCRATCH_POS);
                this.drum_wire.set_pos(drum.idx, SCRATCH_POS);
                this.drum_fill.set_rotation_z(drum.idx, drum.rot_z);
                this.drum_wire.set_rotation_z(drum.idx, drum.rot_z);
                this.drum_fill.set_color(drum.idx, SCRATCH_COLOR, FILL_ALPHA);
                this.drum_wire.set_color(drum.idx, SCRATCH_COLOR);
            }
        }

        // Update camera zoom
        const zoom_frac = ease(Math.min(1, this.zoom_clock.getElapsedBeats() / this.zoom_movement_beats));
        const new_zoom = lerp_scalar(this.start_zoom, this.target_zoom, zoom_frac);
        if (new_zoom != this.camera.zoom) {
            this.camera.zoom = new_zoom;
            this.camera.updateProjectionMatrix();
        }
    }

    handle_beat(t, channel) {
        if (this.active) {
            const time_till_impact = this.get_beat_delay(t);
            for (const paddle_group of this.paddle_groups) {
                paddle_group.impacts.push([time_till_impact, channel]);
            }
        }
    }

    handle_sync(t, bpm, beat) {
        for (const paddle_group of this.paddle_groups) {
            paddle_group.handle_sync(t, bpm, beat);
        }
        if (beat % 8 == 0) {
            this.target_zoom = Math.random() * 0.5 + 0.85;
            this.start_zoom = this.camera.zoom;
            this.zoom_clock.start();
        }
    }
}
