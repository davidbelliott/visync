import * as THREE from 'three';
import { Scene } from './scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    create_instanced_cube_templates,
    create_instanced_cube,
    clamp,
    Spark,
    EasedFollower
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import { SteppedRotation } from '../stepped_rotation.js';
import { CH_ROT_Y, CH_EXPAND_X, CH_EXPAND_Y } from '../controller_map.js';

const CUBE_WAVE_SPEED = 1.5;
// Nominal Y rotation rate in rad/s; knob_to_rate scales it to [-2, 2] x this.
const NOM_ROT_RATE = 0.15;
const NUM_CUBES_PER_SIDE = 32;

// There is one global target block (outlined in white, drawn over
// everything). After each strike it
// becomes the struck block plus the targeting vector, and the gantry that can
// get there soonest (counting a paddle still lifting) without crossing a
// neighbour's bridge travels over and strikes it on the next kick.
//
// Crane motion: the bridge (along the rows) and the trolley (across the
// columns) each travel on their own eased curve (smooth start and stop,
// momentum kept through retargets), so paths curve like a real overhead
// crane's. A move of d cells takes TRAVEL_BASE_S + d * the axis's s/cell
// (the heavier bridge is slower than the trolley), and at least long enough
// that the eased curve's peak speed (1.5x its average) stays under the axis's
// top speed in cells/s, so long moves don't fly. A 3-cell hop takes ~0.75-0.9 s.
const TRAVEL_BASE_S = 0.35;
const BRIDGE_S_PER_CELL = 0.15;
const TROLLEY_S_PER_CELL = 0.11;
const BRIDGE_MAX_CELLS_PER_S = 5;
const TROLLEY_MAX_CELLS_PER_S = 6;
// That relaxed pace is the default, but the gantry assigned to the target
// hurries when the beat needs it: it sets off as the last paddle touches down
// (lifting as it accelerates) and arrives TRAVEL_SAFETY_S before the next
// scheduled touchdown (one beat on, or more if that's under MIN_TRAVEL_S
// away), so it can strike every kick at 140+ bpm. No move ever peaks above
// MAX_HURRY_CELLS_PER_S: a gantry that is too far away misses a kick rather
// than teleporting.
const TRAVEL_SAFETY_S = 0.05;
const MIN_TRAVEL_S = 0.2;
const MAX_HURRY_CELLS_PER_S = 16;
// Once the beat is established the assignee doesn't stop on its blocks: it is
// timed to pass over the target exactly at the predicted touchdown, still
// moving with its own momentum (the direction it approached from, at its
// average approach speed; gantries know only the current target, not where
// the knobs will send the next one), and redirects from there when the next
// target appears, so a gantry striking successive blocks flows through them
// while its paddle slams. On a kick the gantry is re-timed if needed so it is over the
// block (within STRIKE_TOLERANCE_S) exactly at touchdown, keeping its onward
// velocity; if the speed cap can't manage that it skips the strike rather
// than hit beside the block. With no kick within SLAM_GRACE_S of passing the
// block, the gantry eases back onto it and waits.
const STRIKE_TOLERANCE_S = 0.05;
// A passing gantry can overshoot its target by about its passing speed x
// OVERSHOOT_S (coasting SLAM_GRACE_S plus a frame, then the ease-back curve
// carrying on briefly before it turns); neighbours keep clear of that much
// (see row_span), and the bridge's passing speed is capped so the overshoot
// fits the room it has.
const OVERSHOOT_S = 0.25;
// Touchdowns are predicted from the kicks themselves, not the scene tempo:
// the phase from every kick's scheduled touchdown (struck or not, so a run of
// misses can't leave the prediction stale) and the period from the median of
// the last KICK_HISTORY kick intervals within [MIN_KICK_PERIOD_S,
// MAX_KICK_PERIOD_S] (outliers like fills or gaps are ignored), falling back
// to the scene's bpm until there are two.
const KICK_HISTORY = 6;
const MIN_KICK_PERIOD_S = 0.2;
const MAX_KICK_PERIOD_S = 1.5;
// Idle gantries move with inertia: each frame they glide (critically damped,
// at most IDLE_MAX_CELLS_PER_S) towards a formation spot that moves with the
// action (see update_idle_goals), settling in ~IDLE_SMOOTH_S, slow enough
// that small shifts in the spot are smoothed away. A glide that slow trails
// a moving spot by its velocity x IDLE_SMOOTH_S, so the spot is led by that
// much along the action's known velocity (itself smoothed over
// ACTION_VEL_SMOOTH_S) and the gantries cruise on it rather than behind.
// 12 cells/s keeps pace with a 3-cell step per beat at 175 bpm.
const IDLE_SMOOTH_S = 0.8;
const IDLE_MAX_CELLS_PER_S = 12;
const ACTION_VEL_SMOOTH_S = 0.3;

// Paddle motion, as a height fraction h (0 = up, 1 = on the block):
//   - Anticipation: over the ANTICIPATE_S before the predicted next slam (the
//     last touchdown plus whole beats, less the drop time, less the glide's
//     settling time so it is actually there), the assigned gantry's paddle
//     eases down to READY_H while it is still travelling, and holds there
//     until SLAM_GRACE_S past the predicted slam; it eases back up if the
//     beat passes without a kick. Paddles otherwise glide (smooth start, no
//     overshoot) to their goal height, settling in ~PADDLE_SMOOTH_S.
//   - Slam: on a kick, from wherever the paddle is to the block over the drop
//     time, accelerating into the hit. The full MAX_POUND_S lands exactly on
//     the beat when the beat is delayed enough to schedule it; in immediate
//     mode (no lookahead) it shrinks to MIN_POUND_S so contact is at most that
//     late, which from READY_H is only the last stretch. Impact effects fire
//     on the frame the paddle actually touches down.
//   - Lift: the paddle simply glides from the block towards its goal again,
//     while the gantry already moves off. With strikes every beat that goal
//     turns back to READY_H before it reaches the top, so a runner bobs
//     smoothly (up, ease down, short slam) instead of snapping.
const ANTICIPATE_S = 0.2;
const SLAM_GRACE_S = 0.1;
const READY_H = 0.6;
const PADDLE_SMOOTH_S = 0.1;
const MAX_POUND_S = 0.15;
const MIN_POUND_S = 0.06;

// GANTRY_COUNT gantries work the grid (fixed for now; knob 3 is free). The
// count-change path is kept: if target_count changes, one gantry every
// ROLL_BEATS rolls in from the window's upstream (low-row) edge or off its
// downstream edge.
const MAX_GANTRIES = 4;
const GANTRY_COUNT = 4;
const ROLL_BEATS = 2;
// Idle gantries move with the action, ready for the next strike: bridges
// FORMATION_ROWS apart centred on an anchor that slides steadily from target
// to target (2 keeps a clear row between paddles), trolleys level with it
// (see action_point).
// Centring the formation leaves the middle gantries closest to the action, so
// they tend to get the strikes while the outer ones cover turns either side.
const FORMATION_ROWS = 2;
// An outer gantry that keeps striking (running ahead of the rest) hands over
// to its inner neighbour when that can be done cleanly (see plan_swap), so a
// free gantry stays on each side of the action. Swap moves may peak at
// SWAP_CELLS_PER_S: brisk but not violent.
const SWAP_CELLS_PER_S = 14;
// Gantry choice (see choose_assignee) favours gantries that can make the
// next touchdown without peaking above COMFORT_CELLS_PER_S, so strikes don't
// need lurching moves; the MAX_HURRY_CELLS_PER_S cap is only a fallback.
const COMFORT_CELLS_PER_S = 9;
// A kick only re-times the striking gantry's pass for small timing errors
// (within RETIME_MAX_S); bigger ones skip the strike rather than lurch.
const RETIME_MAX_S = 0.1;
// Minimum rows between neighbouring gantries' bridges: one cell pitch clears
// a 3-wide paddle.
const MIN_ROW_GAP = 1;

// The grid is unbounded: blocks, gantries, stamps and ripples live at fixed
// logical positions (cell (row, col) at z = row * pitch, x = col * pitch),
// the view eases to keep the target block centred, and the
// NUM_CUBES_PER_SIDE^2 cube instances are laid out as a window of cells
// around the view. FOLLOW_SECS: s for the view to settle on a new target.
const FOLLOW_SECS = 1.2;
// Logical distance (scene units) after which everything is shifted back
// towards the origin, keeping coordinates small through hours of travel.
const REBASE_DIST = 1000;

// Targeting vector: knob 4 sets its direction in the grid plane (a full turn
// over the knob's travel) and knob 3 its length in cells, from
// MIN_VECTOR_CELLS (a 1-cell step can't round back onto the struck block) to
// MAX_VECTOR_CELLS (steps clearly visible but staying on screen; the default).
// The target is the last struck block plus this vector, rounded to a cell,
// and follows the knobs until it is struck.
const MIN_VECTOR_CELLS = 1;
const MAX_VECTOR_CELLS = 3;
const DEFAULT_VECTOR_ANGLE = Math.PI / 4;   // rad from +col towards +row

// Strike trail: white lines joining the centres of recently struck blocks in
// strike order, each point riding its block's bounce (cubes are centred on
// the ripple height; the trail draws over them) and fading out on the
// stamp's eased curve over TRAIL_FADE_BEATS from its strike, so the trail is
// brightest at the latest hit and dissolves towards the oldest. MAX_TRAIL
// points cover every strike still visible (more than one per beat over
// TRAIL_FADE_BEATS, so the oldest fade out rather than being overwritten).
// With TRAIL_CORNERS each step joins all 8 corresponding corners of the two
// cubes instead of their centres (tesseract-style extrusion along the path);
// with TRAIL_CUBES each struck cube's own 12 edges are drawn too, so it stays
// outlined in white (over its usual colour) for as long as its trail lasts.
const TRAIL_FADE_BEATS = 8;
const MAX_TRAIL = 24;
const TRAIL_CORNERS = false;
const TRAIL_CUBES = true;

// Pounded cubes turn solid in the wireframe colour, then dissolve through the
// dither to transparent over STAMP_BEATS, leaving a trail along the vector.
// MAX_STAMPS live at once (a ring), plenty at one strike per kick.
const STAMP_BEATS = 8;
const MAX_STAMPS = 32;

// Target outlines (white wireframes drawn over everything): a new target's
// fades in over OUTLINE_FADE_IN_BEATS, one beat so it brightens while its
// gantry travels there and peaks at the strike; a former target's (struck or
// re-aimed away from) fades out over STAMP_BEATS on the same eased curve as a
// stamp's fill. MAX_OUTLINES covers every outline still fading at once.
const OUTLINE_FADE_IN_BEATS = 1;
const MAX_OUTLINES = 8;

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
const WHITE = new THREE.Color('white');

// True if array a sorts before array b, comparing element by element.
function lex_less(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] != b[i]) {
            return a[i] < b[i];
        }
    }
    return false;
}

class Excitation extends THREE.Object3D {
    constructor(init_time) {
        super();
        this.init_time = init_time;
    }
}

class Gantry {
    constructor(parent_scene, parent_obj, width, start_xz) {
        const start_pos = new THREE.Vector3(start_xz.x,
            5.929,  // sqrt(2) * 5 * tan(pi / 8) + 1.5 + 0.5 + 1
            start_xz.z);
        this.base_y = start_pos.y;
        this.paddle_base_y = -1.0;
        this.paddle_start_y = this.paddle_base_y;
        this.paddle_end_y = (1.5 + 0.5) - this.base_y;

        this.parent_obj = parent_obj;
        this.clock = new THREE.Clock(false);
        this.pound_clock = new THREE.Clock(false);
        // Crane axes (see TRAVEL_BASE_S): bridge = z, trolley = x.
        // end_sweep_pos is where the gantry is heading.
        this.bridge = new EasedFollower(start_pos.z, 1);
        this.trolley = new EasedFollower(start_pos.x, 1);
        this.end_sweep_pos = new THREE.Vector3();
        this.end_sweep_pos.copy(start_pos);
        // Paddle part
        this.mover = new THREE.Group();
        this.paddle = create_instanced_cube([3, 1, 3], "white", true, "black", 0.5);
        this.paddle.position.y = this.paddle_base_y;
        this.mover.add(this.paddle);

        this.cube_top = create_instanced_cube([1, 1, 1], "white", true, "black", 0.5);
        this.mover.add(this.cube_top);

        this.cube_intersection = create_instanced_cube([1.01, 0.5, 0.5], "white", true, "black", 0.5);
        this.cube_intersection.add(create_instanced_cube([0.5, 1.01, 0.5], "white", true, "black", 0.5));
        this.cube_top.add(this.cube_intersection);

        this.vertical_beam = create_instanced_cube([0.5, 6.0, 0.5], "white", true, "black", 0.5);
        this.vertical_beam.position.y = 3.5;
        this.paddle.add(this.vertical_beam);

        this.mover.position.copy(start_pos);
        parent_obj.add(this.mover);
        this.parent_scene = parent_scene;

        this.x_beam = create_instanced_cube([width, 0.5, 0.5], "white", true, "black", 0.5);
        this.x_beam.position.copy(start_pos);
        this.x_beam.position.x = 0;
        parent_obj.add(this.x_beam);

        this.clock.start();
        this.pound_movement_secs = MAX_POUND_S;

        // 'parked' (hidden, unused), 'active' (in the rotation) or 'exiting'
        // (rolling off the grid before parking).
        this.state = 'parked';
        // Paddle (see ANTICIPATE_S): height h, its glide follower and goal,
        // and the phase: 'free' (gliding) or 'slam' (striking = true).
        this.paddle_h = 0;
        this.paddle_glide = new EasedFollower(0, 1);
        this.paddle_goal = 0;
        this.pound_phase = 'free';
        this.striking = false;
        this.slam_from = 0;
        // Idle gantries track a moving goal (set by the scene each frame)
        // instead of making eased moves.
        this.tracking = false;
        this.goal_x = start_pos.x;
        this.goal_z = start_pos.z;
        this.yield_until = -Infinity;   // scene clock s; making way (plan_swap)
        this.set_visible(false);
    }

    set_visible(visible) {
        this.mover.visible = visible;
        this.x_beam.visible = visible;
    }

    // Jump straight to local (x, z), at rest.
    place_at(x, z) {
        this.trolley.reset(x);
        this.bridge.reset(z);
        this.end_sweep_pos.set(x, this.base_y, z);
        this.set_cube_xz(this.end_sweep_pos);
    }

    move_done() {
        return this.move_remaining_secs() == 0;
    }

    // Seconds until both axes settle (0 at rest).
    move_remaining_secs() {
        return Math.max(this.trolley.remaining_secs(), this.bridge.remaining_secs());
    }

    // Travel time (s) for one axis to cover `dist` scene units.
    static axis_secs(dist, pitch, secs_per_cell, max_cells_per_s) {
        const cells = dist / pitch;
        return dist < 1e-6 ? 0 : Math.max(TRAVEL_BASE_S + secs_per_cell * cells,
            1.5 * cells / max_cells_per_s);
    }

    // Relaxed travel time (s) from the current position to local (x, z).
    travel_secs_to(x, z) {
        const pitch = this.parent_scene.pitch;
        return Math.max(
            Gantry.axis_secs(Math.abs(x - this.trolley.value), pitch,
                TROLLEY_S_PER_CELL, TROLLEY_MAX_CELLS_PER_S),
            Gantry.axis_secs(Math.abs(z - this.bridge.value), pitch,
                BRIDGE_S_PER_CELL, BRIDGE_MAX_CELLS_PER_S));
    }

    // Fastest possible travel time (s) to local (x, z), at full hurry.
    fastest_secs_to(x, z) {
        const cells = Math.max(Math.abs(x - this.trolley.value),
            Math.abs(z - this.bridge.value)) / this.parent_scene.pitch;
        return 1.5 * cells / MAX_HURRY_CELLS_PER_S;
    }

    anim_frame(dt) {
        if (this.tracking) {
            const max_speed = IDLE_MAX_CELLS_PER_S * this.parent_scene.pitch;
            this.mover.position.x = this.trolley.track(this.goal_x, dt, IDLE_SMOOTH_S, max_speed);
            this.mover.position.z = this.bridge.track(this.goal_z, dt, IDLE_SMOOTH_S, max_speed);
        } else {
            this.mover.position.x = this.trolley.update(dt);
            this.mover.position.z = this.bridge.update(dt);
        }
        this.x_beam.position.z = this.mover.position.z;

        // Paddle (see ANTICIPATE_S). Impact effects fire on the frame the
        // slam reaches the block, so the block never moves before it's hit.
        if (this.pound_phase == 'slam') {
            const u = Math.min(1, this.pound_clock.getElapsedTime() / this.pound_movement_secs);
            this.paddle_h = this.slam_from + (1 - this.slam_from) * u * u;
            if (u >= 1) {
                this.striking = false;
                this.pound_phase = 'free';
                this.paddle_glide.reset(1);
                this.parent_scene.on_contact(this);
            }
        } else {
            this.paddle_h = this.paddle_glide.track(this.paddle_goal, dt,
                PADDLE_SMOOTH_S, Infinity);
        }
        this.paddle.position.y = lerp_scalar(this.paddle_start_y, this.paddle_end_y,
            this.paddle_h);
    }

    // Pass over local (x, z) after exactly arrive_secs (or as soon as the
    // speed cap allows), both axes together, moving at end_vel (an {x, z}
    // velocity) on arrival and coasting on after (see STRIKE_TOLERANCE_S).
    pass_through(x, z, arrive_secs, end_vel) {
        const pitch = this.parent_scene.pitch;
        this.end_sweep_pos.set(x, this.base_y, z);
        const cap_secs = 1.5 * Math.max(Math.abs(x - this.trolley.value),
            Math.abs(z - this.bridge.value)) / pitch / MAX_HURRY_CELLS_PER_S;
        const secs = Math.max(arrive_secs, cap_secs);
        this.trolley.move_time = this.bridge.move_time = secs;
        this.trolley.set_target(x, end_vel.x);
        this.bridge.set_target(z, end_vel.z);
    }

    // Seconds until the gantry is over its target: positive while on the way,
    // negative once coasting past it (see pass_through).
    secs_to_pass() {
        const remaining = this.move_remaining_secs();
        return remaining > 0 ? remaining : -this.coast_secs();
    }

    // Re-time the current pass to be over the target in exactly `secs`,
    // keeping the onward velocity. False (and unchanged) if the speed cap
    // can't make it.
    retime_pass(secs) {
        const x = this.end_sweep_pos.x, z = this.end_sweep_pos.z;
        const cap_secs = 1.5 * Math.max(Math.abs(x - this.trolley.value),
            Math.abs(z - this.bridge.value)) / this.parent_scene.pitch / MAX_HURRY_CELLS_PER_S;
        if (cap_secs > secs + STRIKE_TOLERANCE_S) {
            return false;
        }
        this.pass_through(x, z, secs, { x: this.trolley.to_vel, z: this.bridge.to_vel });
        return true;
    }

    // Parked exactly on its target (not passing through it).
    at_rest_on_target() {
        return this.move_remaining_secs() == 0 && this.trolley.to_vel == 0 &&
            this.bridge.to_vel == 0;
    }

    // Seconds spent coasting past the last pass_through target (0 if not).
    coast_secs() {
        const coasting = this.trolley.to_vel != 0 || this.bridge.to_vel != 0;
        return coasting ? Math.min(this.trolley.coast, this.bridge.coast) : 0;
    }

    // Head for local (x, z) and stop there: each axis whose target changes
    // sets off (or redirects, keeping its momentum) with its own travel time,
    // shortened to max_secs when the gantry has a beat to make, but never so
    // short that the eased curve peaks above MAX_HURRY_CELLS_PER_S.
    move_to(x, z, max_secs = Infinity) {
        const pitch = this.parent_scene.pitch;
        this.end_sweep_pos.set(x, this.base_y, z);
        const secs = (dist, secs_per_cell, max_cells_per_s) => Math.max(
            Math.min(max_secs, Gantry.axis_secs(dist, pitch, secs_per_cell, max_cells_per_s)),
            1.5 * dist / pitch / MAX_HURRY_CELLS_PER_S);
        if (x != this.trolley.target || this.trolley.to_vel != 0) {
            this.trolley.move_time = secs(Math.abs(x - this.trolley.value),
                TROLLEY_S_PER_CELL, TROLLEY_MAX_CELLS_PER_S);
            this.trolley.set_target(x);
        }
        if (z != this.bridge.target || this.bridge.to_vel != 0) {
            this.bridge.move_time = secs(Math.abs(z - this.bridge.value),
                BRIDGE_S_PER_CELL, BRIDGE_MAX_CELLS_PER_S);
            this.bridge.set_target(z);
        }
    }

    set_cube_xz(pos) {
        this.mover.position.x = pos.x;
        this.mover.position.z = pos.z;
        this.x_beam.position.z = pos.z;
    }

    move_system(offset) {
        this.mover.position.add(offset);
        this.x_beam.position.add(offset);
        this.end_sweep_pos.add(offset);
        this.trolley.shift(offset.x);
        this.bridge.shift(offset.z);
    }

    // Drop the paddle now, touching down drop_secs later (touchdown_s, on
    // the scene clock: the exact scheduled time, which frame-quantised
    // contact detection can trail slightly).
    start_pound(drop_secs) {
        this.touchdown_s = this.parent_scene.clock.getElapsedTime() + drop_secs;
        this.pound_movement_secs = drop_secs;
        this.striking = true;
        this.pound_phase = 'slam';
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
        this.clear();
        this.clock = new THREE.Clock(true);
        this.beat_idx = 0;

        this.base_group = new THREE.Group();
        // Everything at logical positions; offset by -scroll so the followed
        // point sits at the centre of the view.
        this.world_group = new THREE.Group();
        this.sparks = [];
        this.max_num_sparks = 64;
        this.cur_spark_idx = 0;
        for (let i = 0; i < this.max_num_sparks; i++) {
            const s = new Spark(0.2, "white", [0, 1]);
            s.active = false;
            this.world_group.add(s);
            this.sparks.push(s);
        }

        this.cube_base_size = 3;
        this.cube_base_height = 3;
        this.cube_base_spacing = 1;
        this.pitch = this.cube_base_size + this.cube_base_spacing;

        this.excitations = [];
        this.max_num_excitations = 8;
        for (let i = 0; i < this.max_num_excitations; i++) {
            const e = new Excitation(-100);
            this.world_group.add(e);
            this.excitations.push(e);
        }
        this.cur_excitation = 0;

        // Free Y rotation: knob 8 sets the signed rate (centred = stopped).
        // yaw is the angle in rad on top of the PI/4 iso offset, shown in
        // eased 45 deg steps of the continuously integrated knob rate.
        this.yaw = new SteppedRotation(NOM_ROT_RATE);
        this.yaw.bind(this, CH_ROT_Y);

        // Cube colour blends between these with yaw: color_a when the grid
        // sits at 0/180 deg, color_b at 90/270 deg.
        this.color_a = new THREE.Color("magenta");
        this.color_b = new THREE.Color("blue");
        this.cur_color = new THREE.Color();

        // Cube window: instance i * N + j shows cell (win_row + i, win_col + j),
        // re-laid out every frame around the view (see anim_frame).
        const [cube_wire_geom, cube_solid_geom] = create_instanced_cube_templates(
            this.cube_base_size, this.cube_base_height, this.cube_base_size);
        const num_cells = NUM_CUBES_PER_SIDE * NUM_CUBES_PER_SIDE;
        this.inst_cubes = new InstancedGeometryCollection(
            this.world_group, cube_wire_geom, 'Lines', num_cells);
        for (let k = 0; k < num_cells; k++) {
            this.inst_cubes.create_geom(new THREE.Vector3(), this.color_a, UNIT_SCALE);
        }
        this.win_row = 0;
        this.win_col = 0;
        this.cube_pos = new THREE.Vector3();

        // Target outlines (see OUTLINE_FADE_IN_BEATS): a ring of instanced
        // white wireframes, each on a cell with a fade level in [0, 1] and a
        // direction (+1 fading in, -1 fading out). Depth testing is off and
        // the render order high so they draw over the cube wireframes.
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

        // Stamps: a ring of MAX_STAMPS struck cells, each with remaining stamp
        // in [0, 1], drawn as dithered solids hidden at zero scale when spent.
        this.stamp_fills = new InstancedGeometryCollection(
            this.world_group, cube_solid_geom, 'DitherFill', MAX_STAMPS);
        for (let k = 0; k < MAX_STAMPS; k++) {
            this.stamp_fills.create_geom(new THREE.Vector3(), this.color_a, ZERO_SCALE);
        }
        this.stamp_row = new Int32Array(MAX_STAMPS);
        this.stamp_col = new Int32Array(MAX_STAMPS);
        this.stamp_val = new Float32Array(MAX_STAMPS);
        this.next_stamp = 0;

        // View follow: scroll is the logical (x, z) at the view centre.
        this.scroll_x = new EasedFollower(0, FOLLOW_SECS);
        this.scroll_z = new EasedFollower(0, FOLLOW_SECS);

        // Gantry pool. `active_gantries` is ordered upstream -> downstream (by row);
        // `exiting` ones roll off before parking.
        const width = NUM_CUBES_PER_SIDE * this.pitch;
        this.gantries = [];
        for (let i = 0; i < MAX_GANTRIES; i++) {
            this.gantries.push(new Gantry(this, this.world_group, width,
                new THREE.Vector3(0, 0, 0)));
        }
        this.active_gantries = [];
        this.exiting = [];
        this.target_count = GANTRY_COUNT;
        for (let k = 0; k < GANTRY_COUNT; k++) {
            const g = this.gantries[k];
            const row = Math.round((k - (GANTRY_COUNT - 1) / 2) * FORMATION_ROWS);
            g.place_at(0, this.cell_z(row));
            this.activate_gantry(g);
            this.active_gantries.push(g);
        }
        this.vector_angle = DEFAULT_VECTOR_ANGLE;   // knob 4, bound below
        this.vector_cells = MAX_VECTOR_CELLS;       // knob 3, bound below
        // Global target and last struck block, as [row, col] (struck null
        // until the first strike); `assignee` is the gantry heading for the
        // target (null while none can reach it yet).
        this.target = [Math.round(this.row_of(this.active_gantries[0])), 0];
        this.struck = null;
        this.assignee = null;
        this.last_striker = null;
        this.last_contact_s = null;     // scheduled scene-clock s of the last touchdown
        this.last_drop_s = MAX_POUND_S; // drop time of the last kick's slam
        this.kick_td_s = null;          // scheduled touchdown of the latest kick
        this.kick_intervals = [];       // recent kick-to-kick intervals, s
        // Idle formation anchor (see action_point): slides from `from` (row,
        // col) at t0 to the target at t1 (scene-clock s).
        this.action = { from_row: 0, from_col: 0, t0: 0, t1: 0 };
        this.action_vel = [0, 0];   // its velocity smoothed (ACTION_VEL_SMOOTH_S), cells/s
        this.set_target(this.target);

        // Targeting vector: knob 3 its length, knob 4 its direction.
        this.bind(CH_EXPAND_X, (n) => { this.vector_cells = n; },
            (norm) => lerp_scalar(MIN_VECTOR_CELLS, MAX_VECTOR_CELLS, norm));
        this.bind(CH_EXPAND_Y, (a) => { this.vector_angle = a; },
            (norm) => norm * 2 * Math.PI);

        // Strike trail (see TRAIL_FADE_BEATS): a ring of struck cells with
        // their strike times (beats), drawn as one segment per consecutive
        // pair with per-vertex RGBA, over everything.
        this.beats = 0;     // beats elapsed, for trail ages
        this.trail_row = new Int32Array(MAX_TRAIL);
        this.trail_col = new Int32Array(MAX_TRAIL);
        this.trail_beat = new Float32Array(MAX_TRAIL).fill(-Infinity);
        this.trail_next = 0;
        // Cube corners (index bits = x, y, z sign) and its 12 edges (corner
        // pairs differing in one bit); the offsets joined between consecutive
        // points are the 8 corners, or just the centre.
        const hx = this.cube_base_size / 2, hy = this.cube_base_height / 2;
        this.cube_corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
            [(i & 4 ? 1 : -1) * hx, (i & 2 ? 1 : -1) * hy, (i & 1 ? 1 : -1) * hx]);
        this.cube_edges = [];
        for (let i = 0; i < 8; i++) {
            for (const bit of [1, 2, 4]) {
                if (!(i & bit)) {
                    this.cube_edges.push([i, i | bit]);
                }
            }
        }
        this.trail_offsets = TRAIL_CORNERS ? this.cube_corners : [[0, 0, 0]];
        this.trail_pts = Array.from({ length: MAX_TRAIL }, () => ({ x: 0, y: 0, z: 0, a: 0 }));
        const max_verts = 2 * ((MAX_TRAIL - 1) * this.trail_offsets.length +
            (TRAIL_CUBES ? MAX_TRAIL * this.cube_edges.length : 0));
        this.trail_positions = new Float32Array(max_verts * 3);
        this.trail_colors = new Float32Array(max_verts * 4).fill(1);
        const trail_geom = new THREE.BufferGeometry();
        trail_geom.setAttribute('position',
            new THREE.BufferAttribute(this.trail_positions, 3));
        trail_geom.setAttribute('color',
            new THREE.BufferAttribute(this.trail_colors, 4));
        trail_geom.setDrawRange(0, 0);
        this.trail = new THREE.LineSegments(trail_geom,
            new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false,
                transparent: true }));
        this.trail.renderOrder = 10;
        this.trail.frustumCulled = false;
        this.world_group.add(this.trail);

        const isom_angle = Math.asin(1 / Math.sqrt(3));
        this.base_group.rotation.x = isom_angle;
        this.base_group.rotation.y = Math.PI / 4.0;
        this.base_group.add(this.world_group);
        this.add(this.base_group);

        this.camera = this.cam_orth;

        // Knob CH_ZOOM scales the camera zoom (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;

        // Y rotation (rate from the knob-8 binding registered in the ctor).
        const yaw = this.yaw.update(dt);
        this.base_group.rotation.y = Math.PI / 4 + yaw;
        const cur_color = this.cur_color.lerpColors(this.color_a, this.color_b,
            (1 - Math.cos(2 * yaw)) / 2);

        // The target tracks the knob only while its gantry is waiting parked
        // on it; once a gantry sets off for a target that target holds (the
        // next target takes the knobs' vector at the strike), so knob turns
        // never yank a moving gantry around. If no gantry could take the
        // target yet, keep trying.
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
            this.rebase(Math.round(sz / this.pitch), Math.round(sx / this.pitch));
        }
        this.world_group.position.set(-this.scroll_x.value, 0, -this.scroll_z.value);
        const half = NUM_CUBES_PER_SIDE >> 1;
        this.win_row = Math.round(this.scroll_z.value / this.pitch) - half;
        this.win_col = Math.round(this.scroll_x.value / this.pitch) - half;

        const elapsed_time = this.clock.getElapsedTime();
        const cube_pos = this.cube_pos;
        for (let i = 0; i < NUM_CUBES_PER_SIDE; i++) {
            for (let j = 0; j < NUM_CUBES_PER_SIDE; j++) {
                cube_pos.set(this.cell_x(this.win_col + j), 0,
                    this.cell_z(this.win_row + i));
                cube_pos.y = this.wave_y(cube_pos, elapsed_time);
                const idx = i * NUM_CUBES_PER_SIDE + j;
                this.inst_cubes.set_pos(idx, cube_pos);
                this.inst_cubes.set_color(idx, cur_color);
            }
        }
        this.update_outlines(dt * beats_per_sec, elapsed_time);

        // Stamps follow their cube and dissolve (eased) to transparent;
        // hidden at zero scale once spent or outside the window.
        const stamp_decay = dt * beats_per_sec / STAMP_BEATS;
        for (let k = 0; k < MAX_STAMPS; k++) {
            if (this.stamp_val[k] <= 0) {
                continue;
            }
            const stamp = Math.max(0, this.stamp_val[k] - stamp_decay);
            this.stamp_val[k] = stamp;
            const i = this.stamp_row[k] - this.win_row;
            const j = this.stamp_col[k] - this.win_col;
            const shown = stamp > 0 && i >= 0 && i < NUM_CUBES_PER_SIDE &&
                j >= 0 && j < NUM_CUBES_PER_SIDE;
            if (shown) {
                cube_pos.set(this.cell_x(this.stamp_col[k]), 0,
                    this.cell_z(this.stamp_row[k]));
                cube_pos.y = this.wave_y(cube_pos, elapsed_time);
                this.stamp_fills.set_pos(k, cube_pos);
                this.stamp_fills.set_color(k, cur_color, ease(stamp));
            }
            this.stamp_fills.set_scale(k, shown ? UNIT_SCALE : ZERO_SCALE);
        }

        // Passed over the target with no kick: ease back onto it and wait.
        const g_a = this.assignee;
        if (g_a !== null && !g_a.striking &&
                g_a.coast_secs() > SLAM_GRACE_S) {
            g_a.move_to(this.cell_x(this.target[1]), this.cell_z(this.target[0]));
        }
        this.update_idle_goals(dt);
        this.update_paddle_goals();
        for (const g of this.active_gantries) {
            g.anim_frame(dt);
        }
        for (const g of this.exiting) {
            g.anim_frame(dt);
        }
        // Exited gantries park (hidden) once they've rolled off the window.
        for (let k = this.exiting.length - 1; k >= 0; k--) {
            const g = this.exiting[k];
            if (g.move_done()) {
                g.state = 'parked';
                g.set_visible(false);
                this.exiting.splice(k, 1);
            }
        }
        // Bridges span the window, centred on the view.
        for (const g of this.gantries) {
            g.x_beam.position.x = this.scroll_x.value;
        }

        for (const s of this.sparks) {
            s.anim_frame(dt, this.cam_orth);
        }

        this.beats += dt * beats_per_sec;
        this.update_trail(elapsed_time);
    }

    // Ripple height at logical position pos (y ignored): the sum of every
    // excitation's expanding, decaying ring.
    wave_y(pos, elapsed_time) {
        let y_offset = 0.0;
        for (const e of this.excitations) {
            const t = (elapsed_time - e.init_time) * CUBE_WAVE_SPEED;
            const x = Math.hypot(pos.x - e.position.x, pos.z - e.position.z);
            y_offset -= 3 * Math.sin(Math.max(0, Math.min(2 * Math.PI,
                -0.2 * x + 7 * t))) * Math.exp(-1.5 * t);
        }
        return y_offset;
    }

    // Start fading out the current target's outline and fade one in on
    // (row, col). If that cell's outline is still fading out, reverse it
    // (so it brightens from where it is rather than a second one appearing
    // over it); otherwise reuse the faintest slot not fading in.
    outline_target(row, col) {
        if (this.cur_outline >= 0) {
            this.outline_dir[this.cur_outline] = -1;
        }
        let k = -1;
        for (let i = 0; i < MAX_OUTLINES; i++) {
            if (this.outline_fade[i] > 0 && this.outline_row[i] == row &&
                    this.outline_col[i] == col) {
                k = i;
                break;
            }
        }
        if (k < 0) {
            for (let i = 0; i < MAX_OUTLINES; i++) {
                if (this.outline_dir[i] <= 0 &&
                        (k < 0 || this.outline_fade[i] < this.outline_fade[k])) {
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

    // Advance the outline fades by d_beats and place each outline on its
    // cell at the ripple height, with alpha eased like a stamp's fill.
    update_outlines(d_beats, elapsed_time) {
        const pos = this.cube_pos;
        for (let k = 0; k < MAX_OUTLINES; k++) {
            const rate = this.outline_dir[k] > 0 ? 1 / OUTLINE_FADE_IN_BEATS : 1 / STAMP_BEATS;
            const fade = clamp(this.outline_fade[k] + this.outline_dir[k] * d_beats * rate, 0, 1);
            this.outline_fade[k] = fade;
            pos.set(this.cell_x(this.outline_col[k]), 0, this.cell_z(this.outline_row[k]));
            pos.y = this.wave_y(pos, elapsed_time);
            this.outlines.set_pos(k, pos);
            this.outlines.set_color(k, WHITE, ease(fade));
        }
    }

    // Record a strike at (row, col) on the trail.
    add_trail_point(row, col) {
        const k = this.trail_next;
        this.trail_next = (k + 1) % MAX_TRAIL;
        this.trail_row[k] = row;
        this.trail_col[k] = col;
        this.trail_beat[k] = this.beats;
    }

    // Append a trail line from point a + offset oa to point b + offset ob,
    // each end with its point's alpha (written straight into the buffers).
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

    // Rebuild the trail lines, oldest to newest: each live point at its
    // block's centre and current ripple height with alpha eased down by age;
    // its cube's edges (TRAIL_CUBES), and lines from the previous live point
    // (one per corner, or centre to centre).
    update_trail(elapsed_time) {
        const pos = this.cube_pos;
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
            pos.set(this.cell_x(this.trail_col[k]), 0, this.cell_z(this.trail_row[k]));
            pt.x = pos.x;
            pt.y = this.wave_y(pos, elapsed_time);
            pt.z = pos.z;
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

    // Every ROLL_BEATS, apply one step of any gantry-count change: roll a
    // parked gantry in from the window's upstream edge (it then joins the
    // formation), or roll the most downstream one off the window.
    handle_sync(t, bpm, beat) {
        this.beat_idx++;
        if (beat % ROLL_BEATS != 0) {
            return;
        }
        const parked = this.gantries.find((g) => g.state == 'parked');
        if (this.active_gantries.length < this.target_count && parked !== undefined) {
            // (none parked while every gantry is still rolling out: retry
            // next time)
            parked.place_at(this.cell_x(this.target[1]), this.cell_z(this.win_row));
            this.activate_gantry(parked);
            this.active_gantries.unshift(parked);
        } else if (this.active_gantries.length > this.target_count) {
            const g = this.active_gantries.pop();
            g.state = 'exiting';
            g.tracking = false;
            g.paddle_goal = 0;
            g.move_to(g.end_sweep_pos.x,
                this.cell_z(this.win_row + NUM_CUBES_PER_SIDE - 1));
            this.exiting.push(g);
            if (g === this.assignee) {
                this.set_target(this.target);
            }
        }
    }

    // Kick: if the assigned gantry will be over the target by touchdown, it
    // strikes; the drop is scheduled to touch down on the beat.
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
            // Parked on the block, over it at touchdown, or a small re-time
            // makes it so.
            const late_s = Math.abs(g.secs_to_pass() - drop_secs);
            if (g.at_rest_on_target() || late_s <= STRIKE_TOLERANCE_S ||
                    (late_s <= RETIME_MAX_S && g.retime_pass(drop_secs))) {
                g.start_pound(drop_secs);
            }
        }, Math.max(0, delay - drop_secs) * 1000);
    }

    // Paddle touchdown: ripple, sparks, stamp and a trail point at the struck
    // block; the next target is chosen straight away so another gantry can
    // start for it while this one lifts.
    on_contact(g) {
        this.last_striker = g;
        // The assignee may be passing over its block rather than parked on
        // it, so place the hit exactly at the target block.
        const pos = g === this.assignee ?
            new THREE.Vector3(this.cell_x(this.target[1]), 0, this.cell_z(this.target[0])) :
            g.mover.position;
        this.create_sparks(new THREE.Vector3(pos.x, 1.5, pos.z), 5, 25, "white");
        this.add_excitation(new THREE.Vector3(pos.x, 0, pos.z));
        this.stamp_at(pos);
        this.struck = [Math.round(pos.z / this.pitch), Math.round(pos.x / this.pitch)];
        this.add_trail_point(...this.struck);
        this.last_contact_s = g.touchdown_s;
        this.set_target(this.aim_from(this.struck));
    }

    // The struck block plus the targeting vector, rounded to a cell.
    aim_from([row, col]) {
        return [row + Math.round(this.vector_cells * Math.sin(this.vector_angle)),
            col + Math.round(this.vector_cells * Math.cos(this.vector_angle))];
    }

    // Make [row, col] the target and point the view there. With `reselect`
    // (a new target after a strike, or none assigned yet) pick its gantry
    // afresh; otherwise (the knob re-aiming it) keep the current one if it
    // can still reach the row. Then send it.
    set_target([row, col], reselect = true) {
        const k_cur = this.cur_outline;
        if (k_cur < 0 || this.outline_row[k_cur] != row || this.outline_col[k_cur] != col) {
            this.outline_target(row, col);
        }
        if (this.target === undefined || row != this.target[0] || col != this.target[1]) {
            // The idle anchor slides on from wherever it is now to the new
            // target, arriving at its predicted touchdown.
            const now = this.clock.getElapsedTime();
            const [from_row, from_col] = this.target === undefined ? [row, col] :
                this.action_point(now);
            const budget = this.travel_budget_secs();
            const span = Number.isFinite(budget) ? budget + TRAVEL_SAFETY_S : this.beat_period_s();
            this.action = { from_row, from_col, t0: now, t1: now + span };
        }
        this.target = [row, col];
        const keep = !reselect && this.assignee !== null &&
            this.can_reach_row(this.assignee, row);
        if (!keep) {
            const best = this.choose_assignee(row, col);
            this.assignee = (reselect && this.plan_swap(best, row, col)) || best;
        }
        if (this.assignee !== null) {
            this.send_assignee();
        }
        this.scroll_x.set_target(this.cell_x(col));
        this.scroll_z.set_target(this.cell_z(row));
    }

    // Whether g can head for `row` without crossing a neighbour's bridge.
    can_reach_row(g, row) {
        const [lo, hi] = this.row_limits(this.active_gantries.indexOf(g));
        return row >= lo && row <= hi;
    }

    // If `best` (chosen for cell (row, col)) is an outer gantry that also
    // struck last, hand the target to its inner neighbour instead, so that a
    // free gantry stays on each side of the action; returns that neighbour,
    // or null if the swap can't be done cleanly. The outer gantry yields
    // outward over the same time the inner one takes to reach the target, to
    // a row at least MIN_ROW_GAP beyond it and at least as far as the inner
    // one travels: both moves start together, so the gap between their
    // bridges only grows. Only when both moves fit the beat at
    // SWAP_CELLS_PER_S (once swapped, the inner one keeps the run), the outer
    // one isn't moving inward, and both have room.
    plan_swap(best, row, col) {
        const n = this.active_gantries.length;
        const centre = (n - 1) / 2;
        const k = this.active_gantries.indexOf(best);
        if (n < 3 || best === null || best !== this.last_striker ||
                Math.abs(k - centre) <= 0.5) {
            return null;
        }
        const dir = k > centre ? 1 : -1;    // outward, in rows
        const inner = this.active_gantries[k - dir];
        if (inner.striking || best.bridge.vel * dir < 0) {
            return null;
        }
        const x = this.cell_x(col);
        const z = this.cell_z(row);
        const budget = this.travel_budget_secs();
        const swap_secs = (cells) => 1.5 * cells / SWAP_CELLS_PER_S;
        if (!Number.isFinite(budget) ||
                swap_secs(inner.fastest_secs_to(x, z) * MAX_HURRY_CELLS_PER_S / 1.5) > budget) {
            return null;
        }
        // The inner gantry's own far side must leave it room for the row.
        const far = this.active_gantries[k - 2 * dir];
        if (far !== undefined) {
            const span = this.row_span(far);
            if (dir > 0 ? row < span[1] + MIN_ROW_GAP : row > span[0] - MIN_ROW_GAP) {
                return null;
            }
        }
        const inner_travel = Math.max(0, (row - this.row_of(inner)) * dir);
        const yield_row = this.row_of(best) + dir * Math.max(inner_travel,
            (row - this.row_of(best)) * dir + MIN_ROW_GAP);
        // It must get clear at least as fast as the inner one closes in.
        if (swap_secs(Math.abs(yield_row - this.row_of(best))) > budget) {
            return null;
        }
        const beyond = this.active_gantries[k + dir];
        if (beyond !== undefined) {
            const span = this.row_span(beyond);
            if (dir > 0 ? yield_row > span[0] - MIN_ROW_GAP : yield_row < span[1] + MIN_ROW_GAP) {
                return null;
            }
        }
        best.tracking = false;
        best.yield_until = this.clock.getElapsedTime() + budget;
        // Across the columns it just eases to a stop from its current
        // momentum (a smooth stop from v over the budget covers v * budget / 2).
        best.move_to(best.mover.position.x + best.trolley.vel * budget / 2,
            this.cell_z(yield_row), budget);
        return inner;
    }

    // The gantry to strike cell (row, col), among those that can reach its
    // row without crossing a bridge (null if none yet; anim_frame retries).
    // Priority: making the next touchdown at a comfortable speed (else at
    // the hurry cap), not having just struck (taking turns, for visual
    // interest, where the bridges allow), then the shortest relaxed travel.
    choose_assignee(row, col) {
        const x = this.cell_x(col);
        const z = this.cell_z(row);
        const budget = this.travel_budget_secs();
        let best = null, best_key = null;
        for (const g of this.active_gantries) {
            if (!this.can_reach_row(g, row)) {
                continue;
            }
            const fastest = g.fastest_secs_to(x, z);
            const comfortable = fastest * MAX_HURRY_CELLS_PER_S / COMFORT_CELLS_PER_S;
            const key = [comfortable <= budget ? 0 : fastest <= budget ? 1 : 2,
                g === this.last_striker ? 1 : 0, g.travel_secs_to(x, z)];
            if (best_key === null || lex_less(key, best_key)) {
                best = g;
                best_key = key;
            }
        }
        return best;
    }

    // Note a kick whose slam (drop_secs long) would touch down at td_s (see
    // KICK_HISTORY).
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
        const sorted = [...this.kick_intervals].sort((a, b) => a - b);
        return sorted[n >> 1];
    }

    // The first predicted touchdown (scene-clock s) at or after t_min: the
    // latest kick's touchdown plus whole periods. Null before any kick.
    next_touchdown_s(t_min) {
        if (this.kick_td_s === null) {
            return null;
        }
        const period = this.beat_period_s();
        return this.kick_td_s + Math.max(0, Math.ceil((t_min - this.kick_td_s) / period)) * period;
    }

    // Seconds the assignee has to reach the target: until TRAVEL_SAFETY_S
    // before the next predicted touchdown at least MIN_TRAVEL_S away.
    // Unlimited before the first kick.
    travel_budget_secs() {
        const now = this.clock.getElapsedTime();
        const td = this.next_touchdown_s(now + MIN_TRAVEL_S + TRAVEL_SAFETY_S);
        return td === null ? Infinity : td - TRAVEL_SAFETY_S - now;
    }

    // Send the assignee to the target (leaving any idle glide with its
    // momentum). Before the first kick it travels there and stops; after that
    // it passes over it at the predicted touchdown, still moving (see
    // STRIKE_TOLERANCE_S).
    send_assignee() {
        const g = this.assignee;
        g.tracking = false;
        const x = this.cell_x(this.target[1]);
        const z = this.cell_z(this.target[0]);
        if (this.kick_td_s === null) {
            g.move_to(x, z);
            return;
        }
        // It knows only the target, so it passes over it keeping its own
        // momentum: the direction it approaches from, at its average speed,
        // with the bridge's share capped so its overshoot stays in its rows.
        const arrive_secs = this.travel_budget_secs() + TRAVEL_SAFETY_S;
        const [lo, hi] = this.row_limits(this.active_gantries.indexOf(g));
        const row = this.target[0];
        const vz_limit = (rows) => Math.max(0, rows) * this.pitch / OVERSHOOT_S;
        g.pass_through(x, z, arrive_secs, {
            x: (x - g.mover.position.x) / arrive_secs,
            z: clamp((z - g.mover.position.z) / arrive_secs,
                -vz_limit(row - lo), vz_limit(hi - row)),
        });
    }

    // Paddles stay up, except the assignee's, which eases down to READY_H as
    // the predicted next touchdown comes within ANTICIPATE_S (while still
    // travelling) so the kick's slam only has the last stretch to go.
    update_paddle_goals() {
        const now = this.clock.getElapsedTime();
        let anticipation = 0;
        // Next predicted slam start (still counting it until SLAM_GRACE_S
        // after it was due), and when to be at READY_H.
        const td = this.next_touchdown_s(now - SLAM_GRACE_S + this.last_drop_s);
        if (td !== null) {
            const to_ready = td - this.last_drop_s - PADDLE_SMOOTH_S - now;
            anticipation = ease(clamp(1 - to_ready / ANTICIPATE_S, 0, 1));
        }
        for (const g of this.active_gantries) {
            const ready = g === this.assignee;
            g.paddle_goal = ready ? READY_H * anticipation : 0;
        }
    }

    // The idle formation's anchor (fractional [row, col]) at scene time t: it
    // slides at constant speed from where it was when the target last
    // changed to that target, arriving at the predicted touchdown, then rests
    // there. Built from targets only (no knob prediction): with steady
    // strikes it moves continuously with the action, and with no new target
    // it waits on the current one, ready to head anywhere.
    action_point(t) {
        const a = this.action;
        const u = a.t1 > a.t0 ? clamp((t - a.t0) / (a.t1 - a.t0), 0, 1) : 1;
        return [a.from_row + (this.target[0] - a.from_row) * u,
            a.from_col + (this.target[1] - a.from_col) * u];
    }

    // The anchor's velocity at scene time t, [rows/s, cols/s] (0 once it
    // has arrived).
    action_velocity(t) {
        const a = this.action;
        if (!(t >= a.t0 && t < a.t1)) {
            return [0, 0];
        }
        const span = a.t1 - a.t0;
        return [(this.target[0] - a.from_row) / span, (this.target[1] - a.from_col) / span];
    }

    // Set every idle gantry's glide goal for this frame: bridges
    // FORMATION_ROWS apart centred on the anchor's row by bridge order (so the
    // middle gantries flank it and the outer ones cover either side), clamped
    // clear of their neighbours; trolleys level with it. Both lead the anchor
    // along its smoothed velocity (see IDLE_SMOOTH_S).
    update_idle_goals(dt) {
        const now = this.clock.getElapsedTime();
        const [action_row, action_col] = this.action_point(now);
        const [v_row, v_col] = this.action_velocity(now);
        const k = 1 - Math.exp(-dt / ACTION_VEL_SMOOTH_S);
        const av = this.action_vel;
        av[0] += (v_row - av[0]) * k;
        av[1] += (v_col - av[1]) * k;
        const lead_row = action_row + av[0] * IDLE_SMOOTH_S;
        const ready_x = this.cell_x(action_col + av[1] * IDLE_SMOOTH_S);
        const centre = (this.active_gantries.length - 1) / 2;
        for (let i = 0; i < this.active_gantries.length; i++) {
            const g = this.active_gantries[i];
            if (g === this.assignee || g.yield_until > now) {
                continue;
            }
            const [lo, hi] = this.row_limits(i);
            const home = lo <= hi ?
                clamp(lead_row + (i - centre) * FORMATION_ROWS, lo, hi) :
                this.row_of(g);
            g.tracking = true;
            g.goal_x = ready_x;
            g.goal_z = this.cell_z(home);
            g.end_sweep_pos.set(g.goal_x, g.base_y, g.goal_z);
        }
    }

    // Put gantry g to work.
    activate_gantry(g) {
        g.state = 'active';
        g.striking = false;
        g.pound_phase = 'free';
        g.paddle_h = 0;
        g.paddle_glide.reset(0);
        g.paddle_goal = 0;
        g.set_visible(true);
    }

    cell_x(col) {
        return col * this.pitch;
    }

    cell_z(row) {
        return row * this.pitch;
    }

    // Fractional grid row under a gantry's bridge, and the row it's heading to.
    row_of(g) {
        return g.mover.position.z / this.pitch;
    }

    target_row_of(g) {
        return g.end_sweep_pos.z / this.pitch;
    }

    // [min, max] rows g may occupy on its current move: from where it is to
    // its target, plus how far a pass-through can overshoot the target
    // (OVERSHOOT_S at its passing speed).
    row_span(g) {
        const now = this.row_of(g);
        const target = this.target_row_of(g);
        const coast = g.bridge.to_vel * OVERSHOOT_S / this.pitch;
        return [Math.min(now, target, target + coast), Math.max(now, target, target + coast)];
    }

    // [lo, hi] rows the k-th active gantry may head for: MIN_ROW_GAP clear of
    // both neighbours' row spans (see row_span). With every move kept inside
    // these limits bridges never cross, however many gantries are moving.
    // Empty (lo > hi) if squeezed shut.
    row_limits(k) {
        const up = this.active_gantries[k - 1];
        const down = this.active_gantries[k + 1];
        const lo = up ? Math.ceil(this.row_span(up)[1] + MIN_ROW_GAP) : -Infinity;
        const hi = down ? Math.floor(this.row_span(down)[0] - MIN_ROW_GAP) : Infinity;
        return [lo, hi];
    }

    // Stamp the cell under a pounding paddle (logical position `pos`).
    stamp_at(pos) {
        const k = this.next_stamp;
        this.next_stamp = (k + 1) % MAX_STAMPS;
        this.stamp_row[k] = Math.round(pos.z / this.pitch);
        this.stamp_col[k] = Math.round(pos.x / this.pitch);
        this.stamp_val[k] = 1;
    }

    // Shift every logical position by (-d_row, -d_col) cells so coordinates
    // stay near the origin; nothing visibly moves.
    rebase(d_row, d_col) {
        const offset = new THREE.Vector3(-d_col * this.pitch, 0, -d_row * this.pitch);
        for (const g of this.gantries) {
            g.move_system(offset);
        }
        for (const e of this.excitations) {
            e.position.add(offset);
        }
        for (const s of this.sparks) {
            s.position.add(offset);
        }
        for (let k = 0; k < MAX_STAMPS; k++) {
            this.stamp_row[k] -= d_row;
            this.stamp_col[k] -= d_col;
        }
        this.target = [this.target[0] - d_row, this.target[1] - d_col];
        this.action.from_row -= d_row;
        this.action.from_col -= d_col;
        for (let k = 0; k < MAX_OUTLINES; k++) {
            this.outline_row[k] -= d_row;
            this.outline_col[k] -= d_col;
        }
        for (let k = 0; k < MAX_TRAIL; k++) {
            this.trail_row[k] -= d_row;
            this.trail_col[k] -= d_col;
        }
        if (this.struck !== null) {
            this.struck = [this.struck[0] - d_row, this.struck[1] - d_col];
        }
        this.scroll_x.shift(offset.x);
        this.scroll_z.shift(offset.z);
    }

    add_excitation(pos) {
        const t = this.clock.getElapsedTime();
        const excitation = this.excitations[this.cur_excitation];
        this.cur_excitation = (this.cur_excitation + 1) % this.max_num_excitations;
        excitation.init_time = t;
        excitation.position.copy(pos);
        excitation.position.y = 0;
    }

    create_sparks(pos, num, avg_vel, color) {
        for (let i = 0; i < 16; i++) {
            /*const vel = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() * 0.5,
                Math.random() - 0.5);*/
            //vel.normalize();
            const vel = new THREE.Vector3(0.5, 0.5, 0);

            vel.applyEuler(new THREE.Euler(0, Math.PI / 8 * i, 0));
            vel.multiplyScalar(avg_vel);
            this.sparks[this.cur_spark_idx].active = true;
            this.sparks[this.cur_spark_idx].position.copy(pos);
            this.sparks[this.cur_spark_idx].velocity = vel;
            this.sparks[this.cur_spark_idx].acceleration.set(0, -40, 0);
            this.sparks[this.cur_spark_idx].material.color.set(color);

            this.cur_spark_idx = (this.cur_spark_idx + 1) % this.max_num_sparks;
        }
    }
}
