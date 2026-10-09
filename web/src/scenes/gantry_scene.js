import * as THREE from 'three';
import { Scene } from './scene.js';
import {
    lerp_scalar,
    ease,
    create_instanced_cube_templates,
    create_instanced_cube,
    clamp,
    Spark,
    EasedFollower
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import { SpringFabric } from '../spring_fabric.js';
import { SteppedRotation, UPRIGHT_PITCHES, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
import { CH_EXPAND_X, CH_EXPAND_Y } from '../controller_map.js';

// Grid cells (scene units): cube size, and the spacing between cube centres.
const CUBE_SIZE = 3;
const CELL = 4;
// Cubes in the window laid out around the view (per side).
const NUM_CUBES_PER_SIDE = 32;

// Cube heights are a spring fabric (src/spring_fabric.js), tuned for pond
// ripples: a strike knocks its one cube down and rings spread out from it.
// Anchor/coupling in 1/s^2, damping in 1/s, strike velocity in units/s down;
// the edge band absorbs ripples inside the faded-out cells.
const FABRIC_ANCHOR = 10;
const FABRIC_COUPLING = 100;
const FABRIC_DAMPING = 1.0;
const FABRIC_STRIKE_VEL = 40;
const FABRIC_EDGE_CELLS = 5;

// Strike sparks: a ring of SPARKS_PER_STRIKE at SPARK_SPEED (units/s) and
// SPARK_ELEVATION, slightly jittered (speed +-10%, elevation +-4 deg, azimuth
// +-1/8 of the ring spacing), carrying on with the striking gantry's velocity.
const MAX_SPARKS = 64;
const SPARKS_PER_STRIKE = 16;
const SPARK_SPEED = 25 * Math.SQRT1_2;
const SPARK_GRAVITY = 40;
const SPARK_ELEVATION = Math.PI / 4;
const SPARK_SPEED_JITTER = 0.1;
const SPARK_ELEVATION_JITTER = Math.PI / 45;
const SPARK_AZIMUTH_JITTER = 0.125;
const SPARK_INHERIT_VEL = 1.0;
const SPARK_LIFE_S = 0.8;
const SPARK_FLICKER_FRAMES = 3;

// Cubes fade out towards the window's edges in square rings, reaching 0 where
// the window (re-centred by whole cells) stops being guaranteed to cover, so
// cells never pop in or out. EDGE_FADE_BAND: fraction of that half-width the
// fade spans (1 = all the way from the centre).
const EDGE_FADE_BAND = 1.0;
const CUBE_FADE_HALF_CELLS = NUM_CUBES_PER_SIDE / 2 - 1.5;

// View rotation (rad), in lockstep with the spinning robots scene.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;
// Cube colours, blended with yaw: A at 0/180 deg, B at 90/270 deg.
const COLOR_A = new THREE.Color("magenta");
const COLOR_B = new THREE.Color("blue");

// There is one global target block. After each strike it becomes the struck
// block plus the targeting vector, and the gantry that can get there soonest
// without crossing a neighbour's bridge strikes it on the next kick.
//
// Crane motion: the bridge (rows, z) and trolley (columns, x) each follow
// their own eased curve. A relaxed move of d cells takes TRAVEL_BASE_S +
// d * the axis's s/cell, never peaking above the axis's top speed (cells/s).
const TRAVEL_BASE_S = 0.35;
const BRIDGE_S_PER_CELL = 0.15;
const TROLLEY_S_PER_CELL = 0.11;
const BRIDGE_MAX_CELLS_PER_S = 5;
const TROLLEY_MAX_CELLS_PER_S = 6;
// The assignee hurries when the beat needs it, arriving TRAVEL_SAFETY_S before
// the next predicted touchdown at least MIN_TRAVEL_S away, but never peaking
// above MAX_HURRY_CELLS_PER_S (it misses the kick instead).
const TRAVEL_SAFETY_S = 0.05;
const MIN_TRAVEL_S = 0.2;
const MAX_HURRY_CELLS_PER_S = 16;
// Once kicks are coming, the assignee passes over the target at the predicted
// touchdown still moving, so successive strikes flow. A kick strikes if it is
// over the block within STRIKE_TOLERANCE_S of touchdown, re-timing the pass
// for errors up to RETIME_MAX_S; otherwise it skips. A pass can overshoot by
// its speed x OVERSHOOT_S, which neighbours keep clear of.
const STRIKE_TOLERANCE_S = 0.05;
const RETIME_MAX_S = 0.1;
const OVERSHOOT_S = 0.25;
// Touchdowns are predicted from the kicks: phase from the latest one, period
// from the median of the last KICK_HISTORY intervals in range (else the bpm).
const KICK_HISTORY = 6;
const MIN_KICK_PERIOD_S = 0.2;
const MAX_KICK_PERIOD_S = 1.5;
// Idle gantries glide (critically damped, settling in ~IDLE_SMOOTH_S) towards
// a formation spot that moves with the action, led by the action's velocity
// (smoothed over ACTION_VEL_SMOOTH_S) so they cruise with it, not behind.
const IDLE_SMOOTH_S = 0.8;
const IDLE_MAX_CELLS_PER_S = 12;
const ACTION_VEL_SMOOTH_S = 0.3;

// Paddle height h: 0 = up, 1 = on the block. The assignee's paddle eases down
// to READY_H over the ANTICIPATE_S before the predicted slam (holding until
// SLAM_GRACE_S after it); others glide back up (PADDLE_SMOOTH_S). A kick slams
// it onto the block over the drop time (MAX_POUND_S, shrunk towards
// MIN_POUND_S when there's no lookahead), accelerating into the hit.
const ANTICIPATE_S = 0.2;
const SLAM_GRACE_S = 0.1;
const READY_H = 0.6;
const PADDLE_SMOOTH_S = 0.1;
const MAX_POUND_S = 0.15;
const MIN_POUND_S = 0.06;

// GANTRY_COUNT gantries, bridges FORMATION_ROWS apart when idle (centred on
// the action, so the middle ones tend to strike) and at least MIN_ROW_GAP
// rows apart always.
const GANTRY_COUNT = 4;
const FORMATION_ROWS = 2;
const MIN_ROW_GAP = 1;
// An outer gantry that keeps striking hands over to its inner neighbour when
// both moves fit the beat at SWAP_CELLS_PER_S (see plan_swap). Assignees are
// preferred if they can make the touchdown at COMFORT_CELLS_PER_S.
const SWAP_CELLS_PER_S = 14;
const COMFORT_CELLS_PER_S = 9;

// The view eases to centre the target (s to settle); logical positions are
// shifted back towards the origin past REBASE_DIST (scene units).
const FOLLOW_SECS = 1.2;
const REBASE_DIST = 1000;

// Targeting vector: knob 3 its length (cells), knob 4 its direction (a full
// turn over the knob's travel, from +col towards +row).
const MIN_VECTOR_CELLS = 1;
const MAX_VECTOR_CELLS = 3;
const DEFAULT_VECTOR_ANGLE = Math.PI / 4;

// Strike trail over the last TRAIL_FADE_BEATS: each struck cube outlined in
// white (TRAIL_CUBES), and lines joining consecutive ones (TRAIL_LINKS) at
// their centres or all 8 corners (TRAIL_CORNERS).
const TRAIL_FADE_BEATS = 8;
const MAX_TRAIL = 24;
const TRAIL_LINKS = false;
const TRAIL_CORNERS = false;
const TRAIL_CUBES = true;

// Struck cubes fill solid, then dissolve over STAMP_BEATS.
const STAMP_BEATS = 8;
const STAMP_MAX_OPACITY = 0.5;
const MAX_STAMPS = 32;

// Target outlines (drawn over everything) fade in over OUTLINE_FADE_IN_BEATS
// and out over STAMP_BEATS.
const OUTLINE_FADE_IN_BEATS = 1;
const MAX_OUTLINES = 8;

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
const WHITE = new THREE.Color('white');

// Shortest time (s) for an eased move over `cells` that never exceeds
// `cells_per_s`: the curve peaks at 1.5x its average speed.
function min_move_secs(cells, cells_per_s) {
    return 1.5 * cells / cells_per_s;
}

// Relaxed travel time (s) for one axis to cover `cells`.
function axis_secs(cells, secs_per_cell, max_cells_per_s) {
    return cells < 1e-6 ? 0 : Math.max(TRAVEL_BASE_S + secs_per_cell * cells,
        min_move_secs(cells, max_cells_per_s));
}

// True if array a sorts before array b.
function lex_less(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] != b[i]) {
            return a[i] < b[i];
        }
    }
    return false;
}

class Gantry {
    constructor(scene, parent_obj, width) {
        this.scene = scene;
        this.base_y = 5.929;    // sqrt(2) * 5 * tan(pi / 8) + 1.5 + 0.5 + 1
        this.paddle_up_y = -1.0;
        this.paddle_down_y = (1.5 + 0.5) - this.base_y;

        this.bridge = new EasedFollower(0, 1);
        this.trolley = new EasedFollower(0, 1);
        this.end_sweep_pos = new THREE.Vector3(0, this.base_y, 0);     // where it's heading

        this.mover = new THREE.Group();
        this.mover.position.y = this.base_y;
        this.paddle = create_instanced_cube([3, 1, 3], "white", true, "black", 0.5);
        this.paddle.position.y = this.paddle_up_y;
        this.mover.add(this.paddle);
        const cube_top = create_instanced_cube([1, 1, 1], "white", true, "black", 0.5);
        const cross = create_instanced_cube([1.01, 0.5, 0.5], "white", true, "black", 0.5);
        cross.add(create_instanced_cube([0.5, 1.01, 0.5], "white", true, "black", 0.5));
        cube_top.add(cross);
        this.mover.add(cube_top);
        const vertical_beam = create_instanced_cube([0.5, 6.0, 0.5], "white", true, "black", 0.5);
        vertical_beam.position.y = 3.5;
        this.paddle.add(vertical_beam);
        parent_obj.add(this.mover);

        this.x_beam = create_instanced_cube([width, 0.5, 0.5], "white", true, "black", 0.5);
        this.x_beam.position.y = this.base_y;
        parent_obj.add(this.x_beam);

        // Paddle (see ANTICIPATE_S).
        this.paddle_h = 0;
        this.paddle_glide = new EasedFollower(0, 1);
        this.paddle_goal = 0;
        this.striking = false;
        this.slam_from = 0;
        this.pound_secs = MAX_POUND_S;
        this.pound_clock = new THREE.Clock(false);
        // Idle gantries track a goal set by the scene each frame instead of
        // making eased moves.
        this.tracking = false;
        this.goal_x = 0;
        this.goal_z = 0;
        this.yield_until = -Infinity;   // scene clock s; making way (plan_swap)
    }

    // Jump straight to (x, z), at rest.
    place_at(x, z) {
        this.trolley.reset(x);
        this.bridge.reset(z);
        this.end_sweep_pos.set(x, this.base_y, z);
        this.mover.position.x = x;
        this.mover.position.z = z;
        this.x_beam.position.z = z;
    }

    // Seconds until both axes settle (0 at rest).
    move_remaining_secs() {
        return Math.max(this.trolley.remaining_secs(), this.bridge.remaining_secs());
    }

    // Cells to (x, z) along the longer axis.
    cells_to(x, z) {
        return Math.max(Math.abs(x - this.trolley.value), Math.abs(z - this.bridge.value)) / CELL;
    }

    travel_secs_to(x, z) {
        return Math.max(
            axis_secs(Math.abs(x - this.trolley.value) / CELL, TROLLEY_S_PER_CELL, TROLLEY_MAX_CELLS_PER_S),
            axis_secs(Math.abs(z - this.bridge.value) / CELL, BRIDGE_S_PER_CELL, BRIDGE_MAX_CELLS_PER_S));
    }

    anim_frame(dt) {
        if (this.tracking) {
            const max_speed = IDLE_MAX_CELLS_PER_S * CELL;
            this.mover.position.x = this.trolley.track(this.goal_x, dt, IDLE_SMOOTH_S, max_speed);
            this.mover.position.z = this.bridge.track(this.goal_z, dt, IDLE_SMOOTH_S, max_speed);
        } else {
            this.mover.position.x = this.trolley.update(dt);
            this.mover.position.z = this.bridge.update(dt);
        }
        this.x_beam.position.z = this.mover.position.z;

        // Impact effects fire on the frame the slam reaches the block, so the
        // block never moves before it's hit.
        if (this.striking) {
            const u = Math.min(1, this.pound_clock.getElapsedTime() / this.pound_secs);
            this.paddle_h = this.slam_from + (1 - this.slam_from) * u * u;
            if (u >= 1) {
                this.striking = false;
                this.paddle_glide.reset(1);
                this.scene.on_contact(this);
            }
        } else {
            this.paddle_h = this.paddle_glide.track(this.paddle_goal, dt, PADDLE_SMOOTH_S, Infinity);
        }
        this.paddle.position.y = lerp_scalar(this.paddle_up_y, this.paddle_down_y, this.paddle_h);
    }

    // Pass over (x, z) after arrive_secs (or as soon as the hurry cap allows),
    // moving at end_vel ({x, z}) and coasting on after.
    pass_through(x, z, arrive_secs, end_vel) {
        this.end_sweep_pos.set(x, this.base_y, z);
        const secs = Math.max(arrive_secs, min_move_secs(this.cells_to(x, z), MAX_HURRY_CELLS_PER_S));
        this.trolley.move_time = this.bridge.move_time = secs;
        this.trolley.set_target(x, end_vel.x);
        this.bridge.set_target(z, end_vel.z);
    }

    // Seconds until over the target: negative once coasting past it.
    secs_to_pass() {
        const remaining = this.move_remaining_secs();
        return remaining > 0 ? remaining : -this.coast_secs();
    }

    // Re-time the current pass to be over the target in `secs`, keeping the
    // onward velocity. False (unchanged) if the hurry cap can't make it.
    retime_pass(secs) {
        const x = this.end_sweep_pos.x, z = this.end_sweep_pos.z;
        if (min_move_secs(this.cells_to(x, z), MAX_HURRY_CELLS_PER_S) > secs + STRIKE_TOLERANCE_S) {
            return false;
        }
        this.pass_through(x, z, secs, { x: this.trolley.to_vel, z: this.bridge.to_vel });
        return true;
    }

    at_rest_on_target() {
        return this.move_remaining_secs() == 0 && this.trolley.to_vel == 0 &&
            this.bridge.to_vel == 0;
    }

    // Seconds spent coasting past the last pass_through target (0 if not).
    coast_secs() {
        const coasting = this.trolley.to_vel != 0 || this.bridge.to_vel != 0;
        return coasting ? Math.min(this.trolley.coast, this.bridge.coast) : 0;
    }

    // Head for (x, z) and stop there, each axis at its relaxed pace but
    // within max_secs (and never above the hurry cap). Axes already headed
    // there keep going undisturbed.
    move_to(x, z, max_secs = Infinity) {
        this.end_sweep_pos.set(x, this.base_y, z);
        const axis = (follower, to, secs_per_cell, max_cells_per_s) => {
            if (to == follower.target && follower.to_vel == 0) {
                return;
            }
            const cells = Math.abs(to - follower.value) / CELL;
            follower.move_time = Math.max(
                Math.min(max_secs, axis_secs(cells, secs_per_cell, max_cells_per_s)),
                min_move_secs(cells, MAX_HURRY_CELLS_PER_S));
            follower.set_target(to);
        };
        axis(this.trolley, x, TROLLEY_S_PER_CELL, TROLLEY_MAX_CELLS_PER_S);
        axis(this.bridge, z, BRIDGE_S_PER_CELL, BRIDGE_MAX_CELLS_PER_S);
    }

    shift(offset) {
        this.mover.position.add(offset);
        this.x_beam.position.add(offset);
        this.end_sweep_pos.add(offset);
        this.trolley.shift(offset.x);
        this.bridge.shift(offset.z);
    }

    // Drop the paddle now, touching down drop_secs later (touchdown_s: that
    // scheduled scene-clock time).
    start_pound(drop_secs) {
        this.touchdown_s = this.scene.clock.getElapsedTime() + drop_secs;
        this.pound_secs = drop_secs;
        this.striking = true;
        this.slam_from = this.paddle_h;
        this.pound_clock.start();
    }
}


export class GantryScene extends Scene {
    constructor(context) {
        super(context, 'gantry');

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 25;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.clear();
        this.clock = new THREE.Clock(true);

        this.base_group = new THREE.Group();
        this.base_group.rotation.x = PITCH_BASE;
        this.base_group.rotation.y = YAW_BASE;
        this.yaw = new SteppedRotation();
        this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });
        this.cur_color = new THREE.Color();
        // Everything sits at logical positions (cell (row, col) at z = row *
        // CELL, x = col * CELL) in world_group, offset by -scroll so the
        // followed point is at the view's centre.
        this.world_group = new THREE.Group();
        this.base_group.add(this.world_group);
        this.add(this.base_group);

        this.sparks = [];
        this.next_spark = 0;
        for (let i = 0; i < MAX_SPARKS; i++) {
            const s = new Spark(0.2, "white", [0, 1]);
            s.active = false;
            s.flicker_frames = SPARK_FLICKER_FRAMES;
            s.life_s = 0;
            s.acceleration.set(0, -SPARK_GRAVITY, 0);
            this.world_group.add(s);
            this.sparks.push(s);
        }

        this.fabric = new SpringFabric(NUM_CUBES_PER_SIDE, {
            anchor: FABRIC_ANCHOR, coupling: FABRIC_COUPLING,
            damping: FABRIC_DAMPING, edge_cells: FABRIC_EDGE_CELLS,
        });

        // Cube window: instance i * N + j shows cell (win_row + i, win_col + j).
        const [cube_wire_geom, cube_solid_geom] = create_instanced_cube_templates(
            CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
        const num_cells = NUM_CUBES_PER_SIDE * NUM_CUBES_PER_SIDE;
        this.inst_cubes = new InstancedGeometryCollection(
            this.world_group, cube_wire_geom, 'Lines', num_cells);
        for (let k = 0; k < num_cells; k++) {
            this.inst_cubes.create_geom(new THREE.Vector3(), COLOR_A, UNIT_SCALE);
        }
        this.win_row = 0;
        this.win_col = 0;
        this.cube_pos = new THREE.Vector3();

        // Target outlines: a ring of slots, each on a cell with a fade in
        // [0, 1] and a direction (+1 in, -1 out).
        this.outlines = new InstancedGeometryCollection(
            this.world_group, cube_wire_geom, 'Lines', MAX_OUTLINES);
        this.outlines.mat.depthTest = false;
        this.outlines.mesh.renderOrder = 9;
        for (let k = 0; k < MAX_OUTLINES; k++) {
            this.outlines.create_geom(new THREE.Vector3(), WHITE, UNIT_SCALE, null, 0);
        }
        this.outline_row = new Int32Array(MAX_OUTLINES);
        this.outline_col = new Int32Array(MAX_OUTLINES);
        this.outline_fade = new Float32Array(MAX_OUTLINES);
        this.outline_dir = new Int8Array(MAX_OUTLINES);
        this.cur_outline = -1;      // slot outlining the current target

        // Stamps: a ring of struck cells, each fading from 1; hidden at zero
        // scale when spent.
        this.stamp_fills = new InstancedGeometryCollection(
            this.world_group, cube_solid_geom, 'DitherFill', MAX_STAMPS);
        for (let k = 0; k < MAX_STAMPS; k++) {
            this.stamp_fills.create_geom(new THREE.Vector3(), COLOR_A, ZERO_SCALE);
        }
        this.stamp_row = new Int32Array(MAX_STAMPS);
        this.stamp_col = new Int32Array(MAX_STAMPS);
        this.stamp_val = new Float32Array(MAX_STAMPS);
        this.next_stamp = 0;

        // Scroll: the logical (x, z) at the view centre.
        this.scroll_x = new EasedFollower(0, FOLLOW_SECS);
        this.scroll_z = new EasedFollower(0, FOLLOW_SECS);

        // Gantries, ordered by row.
        this.gantries = [];
        for (let k = 0; k < GANTRY_COUNT; k++) {
            const g = new Gantry(this, this.world_group, NUM_CUBES_PER_SIDE * CELL);
            g.place_at(0, Math.round((k - (GANTRY_COUNT - 1) / 2) * FORMATION_ROWS) * CELL);
            this.gantries.push(g);
        }

        this.vector_angle = DEFAULT_VECTOR_ANGLE;
        this.vector_cells = MAX_VECTOR_CELLS;
        this.bind(CH_EXPAND_X, (n) => { this.vector_cells = n; },
            (norm) => lerp_scalar(MIN_VECTOR_CELLS, MAX_VECTOR_CELLS, norm));
        this.bind(CH_EXPAND_Y, (a) => { this.vector_angle = a; },
            (norm) => norm * 2 * Math.PI);

        // Strike trail: a ring of struck cells with their strike times (beats).
        this.beats = 0;
        this.trail_row = new Int32Array(MAX_TRAIL);
        this.trail_col = new Int32Array(MAX_TRAIL);
        this.trail_beat = new Float32Array(MAX_TRAIL).fill(-Infinity);
        this.trail_next = 0;
        // Cube corners (index bits = x, y, z sign) and edges (corner pairs
        // differing in one bit).
        const h = CUBE_SIZE / 2;
        this.cube_corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
            [(i & 4 ? h : -h), (i & 2 ? h : -h), (i & 1 ? h : -h)]);
        this.cube_edges = [];
        for (let i = 0; i < 8; i++) {
            for (const bit of [1, 2, 4]) {
                if (!(i & bit)) {
                    this.cube_edges.push([i, i | bit]);
                }
            }
        }
        this.trail_offsets = !TRAIL_LINKS ? [] : TRAIL_CORNERS ? this.cube_corners : [[0, 0, 0]];
        this.trail_pts = Array.from({ length: MAX_TRAIL }, () => ({ x: 0, y: 0, z: 0, a: 0 }));
        const max_verts = 2 * ((MAX_TRAIL - 1) * this.trail_offsets.length +
            (TRAIL_CUBES ? MAX_TRAIL * this.cube_edges.length : 0));
        this.trail_positions = new Float32Array(max_verts * 3);
        this.trail_colors = new Float32Array(max_verts * 4).fill(1);
        const trail_geom = new THREE.BufferGeometry();
        trail_geom.setAttribute('position', new THREE.BufferAttribute(this.trail_positions, 3));
        trail_geom.setAttribute('color', new THREE.BufferAttribute(this.trail_colors, 4));
        trail_geom.setDrawRange(0, 0);
        this.trail = new THREE.LineSegments(trail_geom,
            new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
        this.trail.renderOrder = 10;
        this.trail.frustumCulled = false;
        this.world_group.add(this.trail);

        // Targeting. `assignee` is the gantry heading for the target (null
        // while none can reach it); `struck` is null until the first strike.
        this.target = [Math.round(this.row_of(this.gantries[0])), 0];
        this.struck = null;
        this.assignee = null;
        this.last_striker = null;
        this.last_drop_s = MAX_POUND_S; // drop time of the last kick's slam
        this.kick_td_s = null;          // scheduled touchdown of the latest kick
        this.kick_intervals = [];       // recent kick-to-kick intervals, s
        // Idle formation anchor: slides from `from` (row, col) at t0 to the
        // target at t1 (scene-clock s). action_vel: its smoothed velocity.
        this.action = { from_row: 0, from_col: 0, t0: 0, t1: 0 };
        this.action_vel = [0, 0];
        this.set_target(this.target);

        this.bind_zoom();
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;

        this.base_group.rotation.x = this.pitch.update(dt,
            PITCH_BASE + this.view_pitch(STEPPED_SCALE));
        const yaw = this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));
        this.base_group.rotation.y = YAW_BASE + yaw;
        const cur_color = this.cur_color.lerpColors(COLOR_A, COLOR_B, (1 - Math.cos(2 * yaw)) / 2);

        // The target follows the knobs only while its gantry waits on it, so
        // knob turns never yank a moving gantry around.
        const waiting = this.assignee === null ||
            (this.assignee.at_rest_on_target() && !this.assignee.striking);
        if (this.struck !== null && waiting) {
            const aim = this.aim_from(this.struck);
            if (aim[0] != this.target[0] || aim[1] != this.target[1]) {
                this.set_target(aim, false);
            }
        }
        if (this.assignee === null) {
            this.set_target(this.target);
        }

        // View follow, then the cube window around it.
        const sx = this.scroll_x.update(dt);
        const sz = this.scroll_z.update(dt);
        if (Math.abs(sx) > REBASE_DIST || Math.abs(sz) > REBASE_DIST) {
            this.rebase(Math.round(sz / CELL), Math.round(sx / CELL));
        }
        this.world_group.position.set(-this.scroll_x.value, 0, -this.scroll_z.value);
        const half = NUM_CUBES_PER_SIDE >> 1;
        this.win_row = Math.round(this.scroll_z.value / CELL) - half;
        this.win_col = Math.round(this.scroll_x.value / CELL) - half;
        this.fabric.set_origin(this.win_row, this.win_col);
        this.fabric.update(dt);

        const pos = this.cube_pos;
        for (let i = 0; i < NUM_CUBES_PER_SIDE; i++) {
            for (let j = 0; j < NUM_CUBES_PER_SIDE; j++) {
                this.cell_pos(this.win_row + i, this.win_col + j, pos);
                const idx = i * NUM_CUBES_PER_SIDE + j;
                this.inst_cubes.set_pos(idx, pos);
                this.inst_cubes.set_color(idx, cur_color, this.edge_alpha(pos));
            }
        }
        this.update_outlines(dt * beats_per_sec);
        this.update_stamps(dt * beats_per_sec, cur_color);

        // Passed over the target with no kick: ease back onto it and wait.
        const g_a = this.assignee;
        if (g_a !== null && !g_a.striking && g_a.coast_secs() > SLAM_GRACE_S) {
            g_a.move_to(this.target[1] * CELL, this.target[0] * CELL);
        }
        this.update_idle_goals(dt);
        this.update_paddle_goals();
        for (const g of this.gantries) {
            g.anim_frame(dt);
            g.x_beam.position.x = this.scroll_x.value;
        }

        for (const s of this.sparks) {
            if (s.active) {
                s.life_s -= dt;
                s.active = s.life_s > 0;
            }
            s.anim_frame(dt, this.cam_orth);
        }

        this.beats += dt * beats_per_sec;
        this.update_trail();
    }

    // Logical position of cell (row, col) at its fabric height, into `out`.
    cell_pos(row, col, out) {
        return out.set(col * CELL, this.fabric.height(row, col), row * CELL);
    }

    // Cube opacity at logical position pos (see EDGE_FADE_BAND).
    edge_alpha(pos) {
        const dist = Math.max(Math.abs(pos.x - this.scroll_x.value),
            Math.abs(pos.z - this.scroll_z.value)) / (CUBE_FADE_HALF_CELLS * CELL);
        return ease(clamp((1 - dist) / EDGE_FADE_BAND, 0, 1));
    }

    // Fade out the current target's outline and fade one in on (row, col):
    // reversing that cell's own outline if it is still fading out, else
    // reusing the faintest slot not fading in.
    outline_target(row, col) {
        if (this.cur_outline >= 0) {
            this.outline_dir[this.cur_outline] = -1;
        }
        let k = -1;
        for (let i = 0; i < MAX_OUTLINES; i++) {
            if (this.outline_fade[i] > 0 && this.outline_row[i] == row && this.outline_col[i] == col) {
                k = i;
                break;
            }
        }
        if (k < 0) {
            for (let i = 0; i < MAX_OUTLINES; i++) {
                if (this.outline_dir[i] <= 0 && (k < 0 || this.outline_fade[i] < this.outline_fade[k])) {
                    k = i;
                }
            }
            this.outline_row[k] = row;
            this.outline_col[k] = col;
            this.outline_fade[k] = 0;
        }
        this.outline_dir[k] = 1;
        this.cur_outline = k;
    }

    update_outlines(d_beats) {
        for (let k = 0; k < MAX_OUTLINES; k++) {
            const rate = this.outline_dir[k] > 0 ? 1 / OUTLINE_FADE_IN_BEATS : 1 / STAMP_BEATS;
            const fade = clamp(this.outline_fade[k] + this.outline_dir[k] * d_beats * rate, 0, 1);
            this.outline_fade[k] = fade;
            this.outlines.set_pos(k, this.cell_pos(this.outline_row[k], this.outline_col[k], this.cube_pos));
            this.outlines.set_color(k, WHITE, ease(fade));
        }
    }

    update_stamps(d_beats, color) {
        const decay = d_beats / STAMP_BEATS;
        for (let k = 0; k < MAX_STAMPS; k++) {
            if (this.stamp_val[k] <= 0) {
                continue;
            }
            const stamp = Math.max(0, this.stamp_val[k] - decay);
            this.stamp_val[k] = stamp;
            const i = this.stamp_row[k] - this.win_row;
            const j = this.stamp_col[k] - this.win_col;
            const shown = stamp > 0 && i >= 0 && i < NUM_CUBES_PER_SIDE &&
                j >= 0 && j < NUM_CUBES_PER_SIDE;
            if (shown) {
                const pos = this.cell_pos(this.stamp_row[k], this.stamp_col[k], this.cube_pos);
                this.stamp_fills.set_pos(k, pos);
                this.stamp_fills.set_color(k, color,
                    STAMP_MAX_OPACITY * ease(stamp) * this.edge_alpha(pos));
            }
            this.stamp_fills.set_scale(k, shown ? UNIT_SCALE : ZERO_SCALE);
        }
    }

    // Append a trail line from point a + offset oa to b + offset ob, each end
    // with its point's alpha.
    trail_line(a, oa, b, ob) {
        const p = this.trail_positions, c = this.trail_colors, n = this.trail_lines++;
        p[6 * n] = a.x + oa[0];
        p[6 * n + 1] = a.y + oa[1];
        p[6 * n + 2] = a.z + oa[2];
        p[6 * n + 3] = b.x + ob[0];
        p[6 * n + 4] = b.y + ob[1];
        p[6 * n + 5] = b.z + ob[2];
        c[8 * n + 3] = a.a;
        c[8 * n + 7] = b.a;
    }

    // Rebuild the trail, oldest to newest, fading each point by age.
    update_trail() {
        this.trail_lines = 0;
        let prev = null;
        for (let i = 0; i < MAX_TRAIL; i++) {
            const k = (this.trail_next + i) % MAX_TRAIL;
            const age = this.beats - this.trail_beat[k];
            if (age >= TRAIL_FADE_BEATS) {
                prev = null;
                continue;
            }
            const pt = this.trail_pts[k];
            this.cell_pos(this.trail_row[k], this.trail_col[k], this.cube_pos);
            pt.x = this.cube_pos.x;
            pt.y = this.cube_pos.y;
            pt.z = this.cube_pos.z;
            pt.a = ease(1 - age / TRAIL_FADE_BEATS);
            if (TRAIL_CUBES) {
                for (const [c0, c1] of this.cube_edges) {
                    this.trail_line(pt, this.cube_corners[c0], pt, this.cube_corners[c1]);
                }
            }
            if (prev !== null) {
                for (const o of this.trail_offsets) {
                    this.trail_line(prev, o, pt, o);
                }
            }
            prev = pt;
        }
        const geom = this.trail.geometry;
        geom.setDrawRange(0, 2 * this.trail_lines);
        geom.attributes.position.needsUpdate = true;
        geom.attributes.color.needsUpdate = true;
    }

    // Kick: if the assignee will be over the target at touchdown, it strikes,
    // the drop timed to touch down on the beat.
    handle_beat(t, channel) {
        if (channel != 1 && channel != 5) {
            return;
        }
        const delay = this.get_beat_delay(t);
        const drop_secs = clamp(delay, MIN_POUND_S, MAX_POUND_S);
        this.record_kick(this.clock.getElapsedTime() + Math.max(delay, drop_secs), drop_secs);
        setTimeout(() => {
            const g = this.assignee;
            if (g === null || g.striking) {
                return;
            }
            const late_s = Math.abs(g.secs_to_pass() - drop_secs);
            if (g.at_rest_on_target() || late_s <= STRIKE_TOLERANCE_S ||
                    (late_s <= RETIME_MAX_S && g.retime_pass(drop_secs))) {
                g.start_pound(drop_secs);
            }
        }, Math.max(0, delay - drop_secs) * 1000);
    }

    // Paddle touchdown: effects at the struck block, and the next target
    // straight away so another gantry can set off while this one lifts.
    on_contact(g) {
        this.last_striker = g;
        // The assignee may be passing over its block, so hit exactly there.
        const [row, col] = g === this.assignee ? this.target :
            [Math.round(g.mover.position.z / CELL), Math.round(g.mover.position.x / CELL)];
        this.create_sparks(col * CELL, row * CELL, g.trolley.vel, g.bridge.vel);
        this.fabric.kick(row, col, -FABRIC_STRIKE_VEL);
        this.stamp_at(row, col);
        this.add_trail_point(row, col);
        this.struck = [row, col];
        this.set_target(this.aim_from(this.struck));
    }

    // The struck block plus the targeting vector, rounded to a cell.
    aim_from([row, col]) {
        return [row + Math.round(this.vector_cells * Math.sin(this.vector_angle)),
            col + Math.round(this.vector_cells * Math.cos(this.vector_angle))];
    }

    // Make [row, col] the target and point the view there. With `reselect`
    // pick its gantry afresh; otherwise (the knobs re-aiming it) keep the
    // current one if it can still reach the row.
    set_target([row, col], reselect = true) {
        const k_cur = this.cur_outline;
        if (k_cur < 0 || this.outline_row[k_cur] != row || this.outline_col[k_cur] != col) {
            this.outline_target(row, col);
        }
        if (row != this.target[0] || col != this.target[1]) {
            // The idle anchor slides on to the new target, arriving at its
            // predicted touchdown.
            const now = this.clock.getElapsedTime();
            const [from_row, from_col] = this.action_point(now);
            const budget = this.travel_budget_secs();
            const span = Number.isFinite(budget) ? budget + TRAVEL_SAFETY_S : this.beat_period_s();
            this.action = { from_row, from_col, t0: now, t1: now + span };
        }
        this.target = [row, col];
        const keep = !reselect && this.assignee !== null && this.can_reach_row(this.assignee, row);
        if (!keep) {
            const best = this.choose_assignee(row, col);
            this.assignee = (reselect && this.plan_swap(best, row, col)) || best;
        }
        if (this.assignee !== null) {
            this.send_assignee();
        }
        this.scroll_x.set_target(col * CELL);
        this.scroll_z.set_target(row * CELL);
    }

    can_reach_row(g, row) {
        const [lo, hi] = this.row_limits(this.gantries.indexOf(g));
        return row >= lo && row <= hi;
    }

    // If `best` is an outer gantry that also struck last, hand the target to
    // its inner neighbour so a free gantry stays on each side of the action;
    // returns that neighbour, or null if it can't be done cleanly. The outer
    // one yields outward over the same budget, at least MIN_ROW_GAP beyond the
    // target and as far as the inner one travels, so their gap only grows.
    plan_swap(best, row, col) {
        const n = this.gantries.length;
        const centre = (n - 1) / 2;
        const k = this.gantries.indexOf(best);
        if (n < 3 || best === null || best !== this.last_striker || Math.abs(k - centre) <= 0.5) {
            return null;
        }
        const dir = k > centre ? 1 : -1;    // outward, in rows
        const inner = this.gantries[k - dir];
        if (inner.striking || best.bridge.vel * dir < 0) {
            return null;
        }
        const budget = this.travel_budget_secs();
        if (!Number.isFinite(budget) ||
                min_move_secs(inner.cells_to(col * CELL, row * CELL), SWAP_CELLS_PER_S) > budget) {
            return null;
        }
        // The inner gantry's own far side must leave it room for the row.
        const far = this.gantries[k - 2 * dir];
        if (far !== undefined) {
            const span = this.row_span(far);
            if (dir > 0 ? row < span[1] + MIN_ROW_GAP : row > span[0] - MIN_ROW_GAP) {
                return null;
            }
        }
        const inner_travel = Math.max(0, (row - this.row_of(inner)) * dir);
        const yield_row = this.row_of(best) + dir * Math.max(inner_travel,
            (row - this.row_of(best)) * dir + MIN_ROW_GAP);
        if (min_move_secs(Math.abs(yield_row - this.row_of(best)), SWAP_CELLS_PER_S) > budget) {
            return null;
        }
        const beyond = this.gantries[k + dir];
        if (beyond !== undefined) {
            const span = this.row_span(beyond);
            if (dir > 0 ? yield_row > span[0] - MIN_ROW_GAP : yield_row < span[1] + MIN_ROW_GAP) {
                return null;
            }
        }
        best.tracking = false;
        best.yield_until = this.clock.getElapsedTime() + budget;
        // Across the columns it eases to a stop from its current momentum
        // (covering v * budget / 2).
        best.move_to(best.mover.position.x + best.trolley.vel * budget / 2, yield_row * CELL, budget);
        return inner;
    }

    // The gantry to strike (row, col) among those that can reach its row
    // (null if none). Priority: making the touchdown at a comfortable speed
    // (else at the hurry cap), not having just struck, then shortest travel.
    choose_assignee(row, col) {
        const x = col * CELL;
        const z = row * CELL;
        const budget = this.travel_budget_secs();
        let best = null, best_key = null;
        for (const g of this.gantries) {
            if (!this.can_reach_row(g, row)) {
                continue;
            }
            const cells = g.cells_to(x, z);
            const speed_rank = min_move_secs(cells, COMFORT_CELLS_PER_S) <= budget ? 0 :
                min_move_secs(cells, MAX_HURRY_CELLS_PER_S) <= budget ? 1 : 2;
            const key = [speed_rank, g === this.last_striker ? 1 : 0, g.travel_secs_to(x, z)];
            if (best_key === null || lex_less(key, best_key)) {
                best = g;
                best_key = key;
            }
        }
        return best;
    }

    // Note a kick whose slam (drop_secs long) touches down at td_s.
    record_kick(td_s, drop_secs) {
        if (this.kick_td_s !== null) {
            const interval = td_s - this.kick_td_s;
            if (interval >= MIN_KICK_PERIOD_S && interval <= MAX_KICK_PERIOD_S) {
                this.kick_intervals.push(interval);
                if (this.kick_intervals.length > KICK_HISTORY) {
                    this.kick_intervals.shift();
                }
            }
        }
        this.kick_td_s = td_s;
        this.last_drop_s = drop_secs;
    }

    // Kick period (s): median of recent intervals, or the scene's beat.
    beat_period_s() {
        const n = this.kick_intervals.length;
        if (n < 2) {
            return 60 / this.get_local_bpm();
        }
        return [...this.kick_intervals].sort((a, b) => a - b)[n >> 1];
    }

    // First predicted touchdown (scene-clock s) at or after t_min; null
    // before any kick.
    next_touchdown_s(t_min) {
        if (this.kick_td_s === null) {
            return null;
        }
        const period = this.beat_period_s();
        return this.kick_td_s + Math.max(0, Math.ceil((t_min - this.kick_td_s) / period)) * period;
    }

    // Seconds the assignee has to reach the target (Infinity before any kick).
    travel_budget_secs() {
        const now = this.clock.getElapsedTime();
        const td = this.next_touchdown_s(now + MIN_TRAVEL_S + TRAVEL_SAFETY_S);
        return td === null ? Infinity : td - TRAVEL_SAFETY_S - now;
    }

    // Send the assignee to the target: before any kick it travels there and
    // stops; after, it passes over it at the predicted touchdown with its own
    // momentum, the bridge's share capped so its overshoot stays in its rows.
    send_assignee() {
        const g = this.assignee;
        g.tracking = false;
        const x = this.target[1] * CELL;
        const z = this.target[0] * CELL;
        if (this.kick_td_s === null) {
            g.move_to(x, z);
            return;
        }
        const arrive_secs = this.travel_budget_secs() + TRAVEL_SAFETY_S;
        const [lo, hi] = this.row_limits(this.gantries.indexOf(g));
        const row = this.target[0];
        const vz_limit = (rows) => Math.max(0, rows) * CELL / OVERSHOOT_S;
        g.pass_through(x, z, arrive_secs, {
            x: (x - g.mover.position.x) / arrive_secs,
            z: clamp((z - g.mover.position.z) / arrive_secs, -vz_limit(row - lo), vz_limit(hi - row)),
        });
    }

    // Paddles stay up except the assignee's (see ANTICIPATE_S).
    update_paddle_goals() {
        const now = this.clock.getElapsedTime();
        let anticipation = 0;
        const td = this.next_touchdown_s(now - SLAM_GRACE_S + this.last_drop_s);
        if (td !== null) {
            const to_ready = td - this.last_drop_s - PADDLE_SMOOTH_S - now;
            anticipation = ease(clamp(1 - to_ready / ANTICIPATE_S, 0, 1));
        }
        for (const g of this.gantries) {
            g.paddle_goal = g === this.assignee ? READY_H * anticipation : 0;
        }
    }

    // The idle formation's anchor (fractional [row, col]) at scene time t:
    // sliding at constant speed from where it was to the target, then resting.
    action_point(t) {
        const a = this.action;
        const u = a.t1 > a.t0 ? clamp((t - a.t0) / (a.t1 - a.t0), 0, 1) : 1;
        return [a.from_row + (this.target[0] - a.from_row) * u,
            a.from_col + (this.target[1] - a.from_col) * u];
    }

    // The anchor's velocity at t, [rows/s, cols/s].
    action_velocity(t) {
        const a = this.action;
        if (!(t >= a.t0 && t < a.t1)) {
            return [0, 0];
        }
        const span = a.t1 - a.t0;
        return [(this.target[0] - a.from_row) / span, (this.target[1] - a.from_col) / span];
    }

    // Set idle gantries' glide goals: bridges FORMATION_ROWS apart centred on
    // the anchor's row (clamped clear of their neighbours), trolleys level
    // with it, both led by its smoothed velocity.
    update_idle_goals(dt) {
        const now = this.clock.getElapsedTime();
        const [action_row, action_col] = this.action_point(now);
        const [v_row, v_col] = this.action_velocity(now);
        const k = 1 - Math.exp(-dt / ACTION_VEL_SMOOTH_S);
        const av = this.action_vel;
        av[0] += (v_row - av[0]) * k;
        av[1] += (v_col - av[1]) * k;
        const lead_row = action_row + av[0] * IDLE_SMOOTH_S;
        const ready_x = (action_col + av[1] * IDLE_SMOOTH_S) * CELL;
        const centre = (this.gantries.length - 1) / 2;
        for (let i = 0; i < this.gantries.length; i++) {
            const g = this.gantries[i];
            if (g === this.assignee || g.yield_until > now) {
                continue;
            }
            const [lo, hi] = this.row_limits(i);
            const home = lo <= hi ? clamp(lead_row + (i - centre) * FORMATION_ROWS, lo, hi) : this.row_of(g);
            g.tracking = true;
            g.goal_x = ready_x;
            g.goal_z = home * CELL;
            g.end_sweep_pos.set(g.goal_x, g.base_y, g.goal_z);
        }
    }

    // Fractional row under a gantry's bridge.
    row_of(g) {
        return g.mover.position.z / CELL;
    }

    // [min, max] rows g may occupy on its current move, including a
    // pass-through's overshoot.
    row_span(g) {
        const now = this.row_of(g);
        const target = g.end_sweep_pos.z / CELL;
        const coast = g.bridge.to_vel * OVERSHOOT_S / CELL;
        return [Math.min(now, target, target + coast), Math.max(now, target, target + coast)];
    }

    // [lo, hi] rows the k-th gantry may head for, MIN_ROW_GAP clear of both
    // neighbours' spans, so bridges never cross (lo > hi if squeezed shut).
    row_limits(k) {
        const up = this.gantries[k - 1];
        const down = this.gantries[k + 1];
        const lo = up ? Math.ceil(this.row_span(up)[1] + MIN_ROW_GAP) : -Infinity;
        const hi = down ? Math.floor(this.row_span(down)[0] - MIN_ROW_GAP) : Infinity;
        return [lo, hi];
    }

    stamp_at(row, col) {
        const k = this.next_stamp;
        this.next_stamp = (k + 1) % MAX_STAMPS;
        this.stamp_row[k] = row;
        this.stamp_col[k] = col;
        this.stamp_val[k] = 1;
    }

    add_trail_point(row, col) {
        const k = this.trail_next;
        this.trail_next = (k + 1) % MAX_TRAIL;
        this.trail_row[k] = row;
        this.trail_col[k] = col;
        this.trail_beat[k] = this.beats;
    }

    // Shift every logical position by (-d_row, -d_col) cells; nothing
    // visibly moves.
    rebase(d_row, d_col) {
        const offset = new THREE.Vector3(-d_col * CELL, 0, -d_row * CELL);
        for (const g of this.gantries) {
            g.shift(offset);
        }
        for (const s of this.sparks) {
            s.position.add(offset);
        }
        this.fabric.shift_labels(d_row, d_col);
        for (const [rows, cols] of [[this.stamp_row, this.stamp_col],
                [this.outline_row, this.outline_col], [this.trail_row, this.trail_col]]) {
            for (let k = 0; k < rows.length; k++) {
                rows[k] -= d_row;
                cols[k] -= d_col;
            }
        }
        this.target = [this.target[0] - d_row, this.target[1] - d_col];
        if (this.struck !== null) {
            this.struck = [this.struck[0] - d_row, this.struck[1] - d_col];
        }
        this.action.from_row -= d_row;
        this.action.from_col -= d_col;
        this.scroll_x.shift(offset.x);
        this.scroll_z.shift(offset.z);
    }

    // A ring of sparks thrown up and out from logical (x, z), carried along by
    // the striker's velocity (vx, vz).
    create_sparks(x, z, vx, vz) {
        for (let i = 0; i < SPARKS_PER_STRIKE; i++) {
            const spark = this.sparks[this.next_spark];
            this.next_spark = (this.next_spark + 1) % MAX_SPARKS;
            const speed = SPARK_SPEED * (1 + SPARK_SPEED_JITTER * (2 * Math.random() - 1));
            const elev = SPARK_ELEVATION + SPARK_ELEVATION_JITTER * (2 * Math.random() - 1);
            const azim = 2 * Math.PI / SPARKS_PER_STRIKE *
                (i + SPARK_AZIMUTH_JITTER * (2 * Math.random() - 1));
            const horiz = speed * Math.cos(elev);
            spark.velocity.set(
                horiz * Math.cos(azim) + SPARK_INHERIT_VEL * vx,
                speed * Math.sin(elev),
                -horiz * Math.sin(azim) + SPARK_INHERIT_VEL * vz);
            spark.position.set(x, 1.5, z);
            spark.active = true;
            spark.life_s = SPARK_LIFE_S;
        }
    }
}
