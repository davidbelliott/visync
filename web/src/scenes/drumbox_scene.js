import * as THREE from 'three';
import { Scene } from './scene.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
    clamp,
    ease,
    BeatClock
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import { SteppedRotation, UPRIGHT_PITCHES, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';

// Hue drift rate of the drum color (cycles/sec).
const COLOR_CHANGE_RATE = 0.08;
// Drift of the drum grid along its diagonal, away from the viewer at rest
// (world units/sec; drums sit 16 apart).
const DRIFT_VEL = 5;
// Unit drift direction in grid (drums_group) coordinates: the grid diagonal.
const DRIFT_DIR = new THREE.Vector3(1, 1, 0).normalize();
// Rotation (rad), identical to the spinning robots scene's so the two step in
// lockstep: yaw every 45 deg from a quarter-turn diagonal base (which sets the
// grid diagonal to the view), pitch between upright views (isometric tilt up
// or down, or level) starting tilted towards the viewer.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// Jump timing within the 4-beat cycle. Paddles strike ON the beat, then hop
// to the next drum in the gap before the following beat: the hop starts
// JUMP_DELAY_BEATS after the strike and lasts JUMP_DURATION_BEATS, so the
// paddle is planted again (in_position needs frac > 0.9) with margin to
// wind up for beat 1.
const JUMP_DELAY_BEATS = 0.25;
const JUMP_DURATION_BEATS = 0.5;
const START_COLOR = new THREE.Color("red");
const PADDLE_COLOR = new THREE.Color("white");

// The STL exports are 8x larger than scene units; baked into the template
// geometry once so instances render at unit scale.
const STL_SCALE = 1 / 8;
// Edge-extraction threshold (degrees) for the white wireframe overlays.
const EDGE_THRESHOLD_DEG = 30;
// Edge fade: the grid is finite and scrolls by wrapping, so boxes fade out
// towards its perimeter (in square rings, like the robot grids) and are
// invisible wherever a box only exists for part of the scroll cycle; boxes
// that wrap from the leading edge to the trailing one jump while invisible.
// Fraction of the always-occupied half-width over which opacity ramps from 1
// to 0 at its edge, eased at both ends. 1 = the whole way from the view's
// centre: opacity peaks there and boxes emerge imperceptibly from zero, with
// no plateau whose edge shows as the lattice drifts through it.
const EDGE_FADE_BAND = 0.0;
// Cells the grid jumps back by when its drift wraps (along both grid axes).
const WRAP_CELLS = 2;

// Lighting: the old scene hung two point lights off every paddle group (72
// lights total), which dominated the frame cost. The instanced grid is now
// lit by a single overhead point light — decay 1 (linear) so the pool of
// light reads across the visible grid — plus a dim directional so no
// facet goes fully black.
const POINT_LIGHT_INTENSITY = 30;
const POINT_LIGHT_HEIGHT = 40;      // world units above the drum plane
const DIRECTIONAL_INTENSITY = 0.3;

// A gap this long (s) between frames means the scene was off screen; strikes
// queued before it froze with the scene and are dropped rather than all
// landing on the first frames back.
const HIDDEN_GAP_S = 0.5;

// Scratch objects reused by per-frame instance updates (no per-frame alloc).
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();
const SCRATCH_COLOR_OFFSET = new THREE.Color();
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

class PaddleGroup {
    constructor(parent_scene, drum_indices) {
        this.parent_scene = parent_scene;
        this.cur_drum_idx = drum_indices;

        this.position = parent_scene.drum_pos_in_array(
            drum_indices[0], drum_indices[1]);
        this.rot_z = 0;

        // Instance handles into the scene's shared paddle collections: one
        // top paddle and four side paddles per group. Fill and wire
        // collections allocate in lockstep, so one index serves both.
        this.top_idx = parent_scene.paddle_top_fill.create_geom(
            this.position, PADDLE_COLOR, UNIT_SCALE);
        parent_scene.paddle_top_wire.create_geom(
            this.position, PADDLE_COLOR, UNIT_SCALE);
        this.side_idxs = [];
        for (let i = 0; i < 4; i++) {
            this.side_idxs.push(parent_scene.paddle_side_fill.create_geom(
                this.position, PADDLE_COLOR, UNIT_SCALE));
            parent_scene.paddle_side_wire.create_geom(
                this.position, PADDLE_COLOR, UNIT_SCALE);
        }

        // Physical constants for paddles
        this.top_paddle_strike_vel = 80;
        this.side_paddle_strike_vel = 20;

        this.top_paddle_pound_time = 0.08;
        this.side_paddle_pound_time = 0.15;
        this.impacts = [];

        this.in_position = false;

        // Paces the hop between drums in beats (JUMP_DURATION_BEATS).
        // Started here so frac clamps to 1 and strikes land from the start.
        this.movement_clock = new BeatClock(parent_scene);
        this.movement_clock.start();

        this.movement_start_pos = this.position.clone();
        this.movement_end_pos = this.position.clone();
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

    // Move along by `cells` drums on both grid axes, for when the grid's
    // drift wraps back by that much: keeps the paddles in place on screen
    // (on the same drums, whose state moves with them). A group pushed past
    // the far edge re-enters at the near one, snapping across while invisible
    // (see EDGE_FADE_BAND).
    offset_by(cells) {
        const scene = this.parent_scene;
        let wrapped = false;
        for (const axis of [0, 1]) {
            this.cur_drum_idx[axis] += cells;
            if (this.cur_drum_idx[axis] >= scene.num_per_side) {
                this.cur_drum_idx[axis] -= scene.num_per_side;
                wrapped = true;
            }
        }
        if (wrapped) {
            const pos = scene.drum_pos_in_array(this.cur_drum_idx[0], this.cur_drum_idx[1]);
            this.movement_start_pos.copy(pos);
            this.movement_end_pos.copy(pos);
        } else {
            const d = cells * scene.spacing;
            this.movement_start_pos.x += d;
            this.movement_start_pos.y += d;
            this.movement_end_pos.x += d;
            this.movement_end_pos.y += d;
        }
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
            this.movement_clock.getElapsedBeats() / JUMP_DURATION_BEATS, 0, 1);
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
            }
            this.impacts[i][0] = new_time;

            if (this.in_position) {
                // Look at channel associated with the upcoming impact
                if (this.impacts[i][1] == 1) {
                    top_paddle_pos = Math.min(top_paddle_pos, this.paddle_pos(
                        this.impacts[i][0] / this.top_paddle_pound_time,
                        target_drum_z)[0]);
                } else if (this.impacts[i][1] == 4) {
                    side_paddle_pos = Math.min(side_paddle_pos, this.side_paddle_pos(
                        this.impacts[i][0] / this.side_paddle_pound_time));
                }
            }
        }

        // Track the target drum's spin, then write this group's five paddle
        // instances into the shared collections, faded like the drums.
        this.rot_z = drum.rot_z;
        const alpha = scene.edge_alpha(this.position.x, this.position.y);
        scene.paddle_top_fill.set_color(this.top_idx, PADDLE_COLOR, alpha);
        scene.paddle_top_wire.set_color(this.top_idx, PADDLE_COLOR, alpha);
        for (const idx of this.side_idxs) {
            scene.paddle_side_fill.set_color(idx, PADDLE_COLOR, alpha);
            scene.paddle_side_wire.set_color(idx, PADDLE_COLOR, alpha);
        }

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

    // Hop one drum along the given axis (0 = x, 1 = y). Unconditional: the
    // scene commands all groups together, so even a group that is still
    // mid-move just retargets and the checkerboard cover stays in phase.
    jump(axis) {
        this.cur_drum_idx[axis] -= 1;
        if (this.cur_drum_idx[axis] < 0) {
            // Wrapping to the far side: leave the movement clock alone so
            // frac stays at 1 and the paddle snaps across instead of
            // lerping the whole width of the grid.
            this.cur_drum_idx[axis] += this.parent_scene.num_per_side;
        } else {
            this.movement_clock.start();
        }
        this.movement_start_pos.copy(this.position);
        this.movement_end_pos.copy(this.parent_scene.drum_pos_in_array(
            this.cur_drum_idx[0], this.cur_drum_idx[1]));
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
        // One axis toggle shared by every paddle group so their jumps stay
        // in lockstep; per-group toggles could fall out of phase.
        this.last_jump_axis = 0;    // 0 = x, 1 = y
        // Delays each hop until the strike on the jump beat has landed
        // (see JUMP_DELAY_BEATS); checked in anim_frame.
        this.jump_clock = new BeatClock(this);
        this.jump_pending = false;

        // base_group carries the shared view rotation (Y up); plane_group
        // lays the drum plane, built Z-up (drums bounce along Z), flat in
        // it; drums_group drifts the grid within that plane.
        this.base_group = new THREE.Group();
        this.plane_group = new THREE.Group();
        this.plane_group.rotation.x = -Math.PI / 2;
        this.base_group.add(this.plane_group);
        this.drums_group = new THREE.Group();
        this.plane_group.add(this.drums_group);
        this.drift = 0;     // distance along DRIFT_DIR, wrapped (world units)


        this.spacing = 16;
        // Drums per grid side (even: paddle groups sit on every other drum).
        // Big enough that, with the gradual EDGE_FADE_BAND, the zero-opacity
        // edge stays outside the view even fully zoomed out.
        this.num_per_side = 20;
        // The square (in grid axes, drift-free coordinates) that drums occupy
        // throughout the scroll cycle: the grid's extent minus the WRAP_CELLS
        // it drifts by before wrapping. Opacity fades to 0 at its edge.
        const lo = this.spacing * (WRAP_CELLS - this.num_per_side / 2);
        const hi = this.spacing * (this.num_per_side / 2 - 1);
        this.fade_center = (lo + hi) / 2;
        this.fade_half = (hi - lo) / 2;

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
                    this.drums_group, drum_geom, 'LitDitherFill', num_drums);
                this.drum_wire = new InstancedGeometryCollection(
                    this.drums_group,
                    new THREE.EdgesGeometry(drum_geom, EDGE_THRESHOLD_DEG),
                    'Lines', num_drums);
                this.paddle_top_fill = new InstancedGeometryCollection(
                    this.drums_group, top_geom, 'LitDitherFill', num_paddle_groups);
                this.paddle_top_wire = new InstancedGeometryCollection(
                    this.drums_group,
                    new THREE.EdgesGeometry(top_geom, EDGE_THRESHOLD_DEG),
                    'Lines', num_paddle_groups);
                this.paddle_side_fill = new InstancedGeometryCollection(
                    this.drums_group, side_geom, 'LitDitherFill', 4 * num_paddle_groups);
                this.paddle_side_wire = new InstancedGeometryCollection(
                    this.drums_group,
                    new THREE.EdgesGeometry(side_geom, EDGE_THRESHOLD_DEG),
                    'Lines', 4 * num_paddle_groups);

                for (let i = 0; i < this.num_per_side; i++) {
                    this.drums.push([]);
                    for (let j = 0; j < this.num_per_side; j++) {
                        const pos = this.drum_pos_in_array(i, j);
                        const idx = this.drum_fill.create_geom(
                            pos, START_COLOR, UNIT_SCALE);
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

        // The shared view rotation in eased steps (see YAW_BASE).
        this.yaw = new SteppedRotation();
        this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });
        this.base_group.rotation.x = PITCH_BASE;
        this.base_group.rotation.y = YAW_BASE;

        this.clear();
        this.add(this.base_group);

        this.point_light = new THREE.PointLight(
            "white", POINT_LIGHT_INTENSITY, 0, 1.0);
        this.point_light.position.set(0, 0, POINT_LIGHT_HEIGHT);
        this.plane_group.add(this.point_light);
        this.directional_light = new THREE.DirectionalLight(
            "white", DIRECTIONAL_INTENSITY);
        this.directional_light.position.set(0, 0, 100);
        this.plane_group.add(this.directional_light);

        this.color_hue = 0.0;
        this.last_frame_ms = null;      // performance.now() of the last frame

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
        return new THREE.Color(...out);
    }

    drum_spring_accel(x, v) {
        return -this.damping_coeff * v - this.spring_constant * x;
    }

    // Opacity [0, 1] at (x, y) in drums_group coordinates: 1 inside, easing
    // to 0 over the outer EDGE_FADE_BAND of the always-occupied square, in
    // square rings (Chebyshev distance), measured with the drift applied so
    // the fade stays put while the grid scrolls through it.
    edge_alpha(x, y) {
        const off = this.drift * DRIFT_DIR.x;   // same along both grid axes
        const dist = Math.max(Math.abs(x + off - this.fade_center),
            Math.abs(y + off - this.fade_center)) / this.fade_half;
        return ease(clamp((1 - dist) / EDGE_FADE_BAND, 0, 1));
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
        const now_ms = performance.now();
        if (this.last_frame_ms !== null && now_ms - this.last_frame_ms > HIDDEN_GAP_S * 1000) {
            for (const paddle_group of this.paddle_groups) {
                paddle_group.impacts.length = 0;
            }
        }
        this.last_frame_ms = now_ms;

        this.base_group.rotation.x = this.pitch.update(dt,
            PITCH_BASE + this.view_pitch(STEPPED_SCALE));
        this.base_group.rotation.y = YAW_BASE + this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));

        this.drift += DRIFT_VEL * dt;
        const max_offset = WRAP_CELLS * this.spacing * Math.sqrt(2);
        while (this.drift > max_offset) {
            this.drift -= max_offset;
            for (const paddle_group of this.paddle_groups) {
                paddle_group.offset_by(WRAP_CELLS);
            }
            for (let idx = 0; idx < 2 * this.num_per_side - 1; idx++) {
                let i = clamp(idx, 0, this.num_per_side - 1);
                let j = clamp(2 * this.num_per_side - 1 - idx, 0, this.num_per_side - 1);
                while (i >= WRAP_CELLS && j >= WRAP_CELLS) {
                    const prev_i = i - WRAP_CELLS;
                    const prev_j = j - WRAP_CELLS;
                    this.drums[i][j].z = this.drums[prev_i][prev_j].z;
                    this.drums[i][j].vel_z = this.drums[prev_i][prev_j].vel_z;
                    i = prev_i;
                    j = prev_j;
                }
            }
        }

        // Drift, with the faded square's centre held at the view's centre.
        this.drums_group.position.copy(DRIFT_DIR).multiplyScalar(this.drift);
        this.drums_group.position.x -= this.fade_center;
        this.drums_group.position.y -= this.fade_center;

        // Start the scheduled hop once the jump beat's strike has landed,
        // partway into the gap before the next beat.
        if (this.jump_pending &&
                this.jump_clock.getElapsedBeats() >= JUMP_DELAY_BEATS) {
            this.jump_pending = false;
            this.last_jump_axis = (this.last_jump_axis + 1) % 2;
            for (const paddle_group of this.paddle_groups) {
                paddle_group.jump(this.last_jump_axis);
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
                const alpha = this.edge_alpha(drum.x, drum.y);
                this.drum_fill.set_color(drum.idx, SCRATCH_COLOR, alpha);
                this.drum_wire.set_color(drum.idx, SCRATCH_COLOR, alpha);
            }
        }
    }

    handle_beat(t, channel) {
        const time_till_impact = this.get_beat_delay(t);
        for (const paddle_group of this.paddle_groups) {
            paddle_group.impacts.push([time_till_impact, channel]);
        }
    }

    handle_sync(t, bpm, beat) {
        if (beat % 4 == 3) {
            // Don't jump yet — let this beat's strike land first. The hop
            // itself starts from anim_frame once JUMP_DELAY_BEATS elapse.
            this.jump_clock.start();
            this.jump_pending = true;
        }
    }
}
