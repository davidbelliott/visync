import * as THREE from 'three';
import { Scene } from './scene.js';
import { UPRIGHT_PITCHES, ISOMETRIC_TILT } from '../stepped_rotation.js';
import { CH_EXPAND_X, CH_EXPAND_Y, CH_EXPAND_Z } from '../controller_map.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import {
    lerp_scalar,
    ease,
    clamp,
    create_instanced_cube_templates,
    EasedFollower,
} from '../util.js';

// Free yaw (STEPPED_VIEW false): this x the shared view yaw.
const YAW_SCALE = 1;
// true: rotate in lockstep with the other stepped scenes (gantry, cubeman,
// cubetubes, spinning robots...): eased 45 deg yaw steps and upright pitch
// stops, same pace and base angles. false: free yaw at YAW_SCALE under a
// fixed isometric tilt (pitch locked).
const STEPPED_VIEW = true;
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// Edge length of every cube, world units. The ortho frustum is 20 tall, so
// one cube is a tenth of the screen height at 1x zoom.
const CUBE_SIZE = 2;
// Centre-to-neighbour distance of a group's seven cubes at full expansion,
// world units: a half-cube gap between them.
const FULL_SPACING = 1.5 * CUBE_SIZE;
// How much further apart a level leaves everything older: at full
// expansion each level is a 3x3x3 cell lattice (the 3D Vicsek fractal).
const LEVEL_GROWTH = 3;
// Progress through a level, 0..1, at each state: single (all seven
// coincide), expanded, full. Moves are linear in progress, and the spread
// grows exponentially with it (LEVEL_GROWTH ** progress, see anim_frame),
// so with a steady beat everything streams outwards at one constant
// relative rate, across kicks and levels alike. That puts expanded at a
// sqrt(3) spread: neighbours ~0.55 cube out, overlapping the centre by ~45%
// (near the old half-overlap solid).
const STATE_PROGRESS = [0, 0.5, 1];
// A group's six outer cubes never overlap its centre: below a whole cube's
// spacing each is a slab glued to the centre's face, growing outwards to
// where the overlapping cube's outer face would be (the same silhouette,
// with no edges buried inside other cubes for the fade to reveal). A slab
// fades in over this much width, world units, so splitting a faded cube
// doesn't darken it in a step; a tenth of a cube, too thin to see into.
const SLAB_FADE_IN_WIDTH = 0.1 * CUBE_SIZE;
// Each kick moves to the next state over this many beats, starting on the
// (latency-compensated) beat. At 1, kicks on every beat chain into one
// unbroken motion.
const MOVE_BEATS = 1.0;
// false: each move is linear in progress, so a steady beat streams the
// fractal outwards at one constant rate. true: each move eases in and out
// (smoothstep, as EasedFollower's moves from rest), surging and settling
// with every kick.
const EASED_MOVES = true;
// Camera glide towards the cube it tracks, s to settle (critically damped);
// the max speed only stops a pathological jump, world units/s.
const CAM_SMOOTH_S = 0.5;
const CAM_MAX_SPEED = 200;
// true: the camera sits exactly on the tracked cube's centre, which then
// never moves on screen. false: it glides after it as above.
const CAM_LOCKED = true;
// Cubes fade with distance from the camera's focus, world units: opaque
// within FADE_NEAR (a fully expanded group reaches ~5 from its centre), gone
// by FADE_FAR (an eased ramp between), so nothing pops in or out, whether at
// the screen's edges or on the line of sight as the view turns.
const FADE_NEAR = 40;
const FADE_FAR = 60;
// Groups whose centre lies further than this from the tracked group when a
// new level starts are dropped, world units. Everything only moves outwards
// from there, so their cubes (within a cube's half-diagonal of the centre
// at that moment) have already faded out for good.
const CULL_RADIUS = FADE_FAR + CUBE_SIZE;
// Cubes stored at most; the culled fractal peaks at ~10-12k (simulated),
// fewer of them drawn since fully faded cubes are skipped.
const MAX_CUBES = 7 * 2400;
const MAX_GROUPS = MAX_CUBES / 7;
const FILL_COLOR = new THREE.Color('black');
const EDGE_COLOR = new THREE.Color('white');
// The tracked cube's edges, drawn over everything so it stays in sight
// behind other cubes. When it splits, its seven children all start outlined
// like this, on top (so the outline carries on unbroken), and all but the
// new target fade to their ordinary outlines by the time they're
// SPAWN_FADE_SPACING apart, world units (half a cube: about halfway through
// the first move).
const TARGET_COLOR = new THREE.Color('cyan');
const SPAWN_FADE_SPACING = CUBE_SIZE / 2;
// Knobs steering which child the camera follows, one per axis of the
// group's (spinning) frame. Each reads as a 3-way switch, like a rate
// knob's centre stop: the bottom third of its travel picks that axis's
// negative child, the top third the positive, the middle leaves it free.
// Set axes are chosen from at random each level (two set axes walk a
// staircase between them); with none set, any of the six goes. The choice
// is made as a level starts and holds for the whole level.
const FOLLOW_KNOBS = [CH_EXPAND_X, CH_EXPAND_Y, CH_EXPAND_Z];
function knob_to_follow_sign(norm) {
    return norm < 1 / 3 ? -1 : norm > 2 / 3 ? 1 : 0;
}

// A group's seven cubes as offsets from its centre: the centre itself, then
// +-x, +-y, +-z. Targets are picked from 1..6 so tracking always moves.
const DIRS = [
    [0, 0, 0],
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
];

// The newest level's spacing, world units, when older levels have spread to
// g x where they sat as it began: the pairing that keeps the gap between
// neighbouring groups at FULL_SPACING - CUBE_SIZE throughout (0 at g = 1,
// FULL_SPACING at g = LEVEL_GROWTH).
function spacing_for_spread(g) {
    return FULL_SPACING * (g - 1) / 2;
}

export class CubeFractalScene extends Scene {
    constructor(context) {
        super(context, 'cubefractal');

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.clear();

        // Turns with the shared view (see STEPPED_VIEW) about the camera's
        // focus: instances are written relative to it each frame.
        this.base_group = new THREE.Group();
        this.base_group.rotation.x = PITCH_BASE;
        this.base_group.rotation.y = YAW_BASE;
        this.stepped_pitches = UPRIGHT_PITCHES;
        this.add(this.base_group);

        const [wire_geom, fill_geom] = create_instanced_cube_templates(1, 1, 1);
        this.fills = new InstancedGeometryCollection(
            this.base_group, fill_geom, 'Triangles', MAX_CUBES, true);
        this.edges = new InstancedGeometryCollection(
            this.base_group, wire_geom, 'Lines', MAX_CUBES);
        // The tracked cube's edges and its fading children's (see
        // SPAWN_FADE_SPACING), on top: no depth test, and drawn after the
        // fills (renderOrder 1) so none dims them.
        this.target_edges = new InstancedGeometryCollection(
            this.base_group, wire_geom, 'Lines', DIRS.length);
        for (let k = 0; k < DIRS.length; k++) {
            this.target_edges.create_geom(new THREE.Vector3(), TARGET_COLOR,
                new THREE.Vector3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE));
        }
        this.target_edges.mat.depthTest = false;
        this.target_edges.mesh.renderOrder = 2;
        // Order-independent translucency: every edge draws first, writing
        // depth, then the black fills blend over it without writing depth.
        // Blending black only scales what's behind by (1 - alpha), which
        // commutes, so the fills need no sorting and nothing flickers as the
        // view turns. A fill dims the edges behind it, hiding them at full
        // opacity, but never those in front of it, its own included (fills
        // sit pushed back by polygonOffset). Overlapping faded cubes darken
        // together, smoothly, as real translucent ones would.
        this.edges.mat.depthWrite = true;
        this.fills.ready.then(() => {
            this.fills.mat.depthWrite = false;
            this.fills.mesh.renderOrder = 1;
        });
        const scale = new THREE.Vector3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
        const origin = new THREE.Vector3();
        for (let k = 0; k < MAX_CUBES; k++) {
            this.fills.create_geom(origin, FILL_COLOR, scale);
            this.edges.create_geom(origin, EDGE_COLOR, scale);
        }
        this.fills.set_num_instances(0);
        this.edges.set_num_instances(0);

        // The newest level: group centres, flat xyz, relative to the tracked
        // cube's group (always group 0) and at the spread they had when the
        // level began; each group draws its seven cubes. Double-buffered for
        // rebuilding at each new level.
        this.groups = new Float32Array(MAX_GROUPS * 3);
        this.next_groups = new Float32Array(MAX_GROUPS * 3);
        this.num_groups = 1;
        // Per axis -1/0/+1 from FOLLOW_KNOBS, and scratch for the children
        // they allow.
        this.follow_signs = FOLLOW_KNOBS.map((ch) =>
            knob_to_follow_sign(this.context.knobs.get(ch).cur_val));
        this.follow_choices = new Int8Array(6);
        // Which of group 0's cubes the camera follows (index into DIRS).
        this.target_dir = this.pick_target();
        // Knob turns take effect when the next level starts (start_level),
        // while the children still coincide, so the view never jumps between
        // cubes; only before the first kick can that be right away.
        FOLLOW_KNOBS.forEach((ch, axis) => {
            this.bind(ch, (sign) => {
                this.follow_signs[axis] = sign;
                if (this.state == 0 && !this.follow_allows(this.target_dir)) {
                    this.target_dir = this.pick_target();
                }
            }, knob_to_follow_sign);
        });
        // World position of group 0's centre in a frame that never moves,
        // so the camera can glide continuously across new levels.
        this.group_origin = new THREE.Vector3();
        this.cam = [0, 1, 2].map(() => new EasedFollower(0, 1));
        this.cube_pos = new THREE.Vector3();
        this.cube_scale = new THREE.Vector3();

        // 0 single, 1 expanded, 2 full; full is also seven singles, which
        // the next kick turns into the next level's first expansion.
        this.state = 0;
        // The current move through the level: from/to progress (see
        // STATE_PROGRESS), elapsed and duration in s.
        this.move_from = 0;
        this.move_to = 0;
        this.move_elapsed = 0;
        this.move_secs = 0;

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    // Whether the follow knobs allow child dir (index into DIRS, 1..6): any
    // child when no axis is set, else only the set axes' chosen sides.
    follow_allows(dir) {
        const signs = this.follow_signs;
        if (signs[0] == 0 && signs[1] == 0 && signs[2] == 0) {
            return true;
        }
        const axis = (dir - 1) >> 1;
        return signs[axis] == DIRS[dir][axis];
    }

    pick_target() {
        let n = 0;
        for (let dir = 1; dir < DIRS.length; dir++) {
            if (this.follow_allows(dir)) {
                this.follow_choices[n++] = dir;
            }
        }
        return this.follow_choices[Math.floor(Math.random() * n)];
    }

    // Every cube of the fully expanded level becomes a group of its own:
    // the tracked cube's group goes first, at the origin, then the rest
    // within CULL_RADIUS of it.
    start_level() {
        const [tx, ty, tz] = DIRS[this.target_dir];
        const s = FULL_SPACING;
        const g = LEVEL_GROWTH;
        this.group_origin.x += tx * s;
        this.group_origin.y += ty * s;
        this.group_origin.z += tz * s;

        const out = this.next_groups;
        out[0] = out[1] = out[2] = 0;
        let n = 1;
        for (let i = 0; i < this.num_groups && n < MAX_GROUPS; i++) {
            const px = g * this.groups[3 * i];
            const py = g * this.groups[3 * i + 1];
            const pz = g * this.groups[3 * i + 2];
            for (let j = 0; j < DIRS.length && n < MAX_GROUPS; j++) {
                if (i == 0 && j == this.target_dir) {
                    continue;
                }
                const x = px + s * (DIRS[j][0] - tx);
                const y = py + s * (DIRS[j][1] - ty);
                const z = pz + s * (DIRS[j][2] - tz);
                if (x * x + y * y + z * z <= CULL_RADIUS * CULL_RADIUS) {
                    out[3 * n] = x;
                    out[3 * n + 1] = y;
                    out[3 * n + 2] = z;
                    n++;
                }
            }
        }
        this.next_groups = this.groups;
        this.groups = out;
        this.num_groups = n;
        this.target_dir = this.pick_target();
    }

    // A kick lands: move on to the next state, from wherever a move still in
    // flight has got to. From full expansion that starts a new level,
    // snapping such a move to its end first (the new level is built from the
    // full spacing).
    kick() {
        let from = this.level_progress();
        if (this.state == 2) {
            this.start_level();
            this.state = 0;
            from = STATE_PROGRESS[0];
        }
        this.state++;
        this.move_from = from;
        this.move_to = STATE_PROGRESS[this.state];
        this.move_elapsed = 0;
        this.move_secs = MOVE_BEATS * 60 / this.get_local_bpm();
    }

    // Progress through the newest level now (see STATE_PROGRESS).
    level_progress() {
        const t = this.move_secs > 0 ? Math.min(this.move_elapsed / this.move_secs, 1) : 1;
        const frac = EASED_MOVES ? t * t * (3 - 2 * t) : t;
        return lerp_scalar(this.move_from, this.move_to, frac);
    }

    anim_frame(dt) {
        if (STEPPED_VIEW) {
            this.base_group.rotation.x = this.stepped_pitch();
            this.base_group.rotation.y = YAW_BASE + this.stepped_yaw();
        } else {
            this.base_group.rotation.y = this.view_yaw(YAW_SCALE);
        }

        this.move_elapsed += dt;
        const g = Math.pow(LEVEL_GROWTH, this.level_progress());
        const u = spacing_for_spread(g);

        // Follow the tracked cube (see CAM_LOCKED); draw everything relative
        // to the camera so the spin pivots on it.
        const target = DIRS[this.target_dir];
        const offset = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
            const goal = this.group_origin.getComponent(a) + target[a] * u;
            const cam = CAM_LOCKED ? goal :
                this.cam[a].track(goal, dt, CAM_SMOOTH_S, CAM_MAX_SPEED);
            offset[a] = this.group_origin.getComponent(a) - cam;
        }

        // Outer cubes' width along their axis and centre distance from the
        // group's (see SLAB_FADE_IN_WIDTH): the outer face sits at u + half a
        // cube, the inner face on the centre's face until the width reaches
        // a whole cube. The camera follows u itself, which the tracked cube's
        // centre joins once it is whole, so nothing jumps at a new level.
        const width = Math.min(u, CUBE_SIZE);
        const along = u + (CUBE_SIZE - width) / 2;
        const slab_alpha = ease(clamp(width / SLAB_FADE_IN_WIDTH, 0, 1));

        const spawn_alpha = 1 - ease(clamp(u / SPAWN_FADE_SPACING, 0, 1));
        let n_top = 0;
        let n = 0;
        for (let i = 0; i < this.num_groups; i++) {
            const gx = g * this.groups[3 * i] + offset[0];
            const gy = g * this.groups[3 * i + 1] + offset[1];
            const gz = g * this.groups[3 * i + 2] + offset[2];
            for (let j = 0; j < DIRS.length; j++) {
                if (i == 0 && j == this.target_dir) {
                    continue;
                }
                this.place_cube(gx, gy, gz, j, width, along);
                const alpha = this.write_cube(n, EDGE_COLOR, j == 0 ? 1 : slab_alpha);
                if (alpha > 0) {
                    n++;
                    if (i == 0 && spawn_alpha > 0) {
                        this.write_edges(this.target_edges, n_top++,
                            TARGET_COLOR, alpha * spawn_alpha);
                    }
                }
            }
        }
        this.place_cube(offset[0], offset[1], offset[2], this.target_dir, width, along);
        this.edges.set_num_instances(n);
        const target_alpha = this.write_cube(n, TARGET_COLOR, slab_alpha,
            this.target_edges, n_top);
        this.fills.set_num_instances(target_alpha > 0 ? n + 1 : n);
        this.target_edges.set_num_instances(target_alpha > 0 ? n_top + 1 : n_top);
    }

    // Set this.cube_pos/cube_scale to cube dir (index into DIRS) of the group
    // centred at (gx, gy, gz), outer cubes being width wide along their axis
    // with their centre `along` from the group's.
    place_cube(gx, gy, gz, dir, width, along) {
        const [dx, dy, dz] = DIRS[dir];
        this.cube_pos.set(gx + along * dx, gy + along * dy, gz + along * dz);
        this.cube_scale.set(
            dx == 0 ? CUBE_SIZE : width,
            dy == 0 ? CUBE_SIZE : width,
            dz == 0 ? CUBE_SIZE : width);
    }

    // Draw a cube at this.cube_pos (camera-relative) and this.cube_scale as
    // fill instance n, with its edges as instance edge_idx of `edges`
    // (default: the same n of this.edges), faded by its distance (see
    // FADE_NEAR) times alpha. Returns the opacity drawn at, 0 (drawing
    // nothing) for cubes faded out entirely.
    write_cube(n, edge_color, alpha, edges = this.edges, edge_idx = n) {
        alpha *= ease(clamp(
            (FADE_FAR - this.cube_pos.length()) / (FADE_FAR - FADE_NEAR), 0, 1));
        if (alpha <= 0) {
            return 0;
        }
        this.fills.set_pos(n, this.cube_pos);
        this.fills.set_scale(n, this.cube_scale);
        this.fills.set_color(n, FILL_COLOR, alpha);
        this.write_edges(edges, edge_idx, edge_color, alpha);
        return alpha;
    }

    // Outline this.cube_pos/cube_scale as instance idx of `edges`.
    write_edges(edges, idx, color, alpha) {
        edges.set_pos(idx, this.cube_pos);
        edges.set_scale(idx, this.cube_scale);
        edges.set_color(idx, color, alpha);
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        if (channel == 1) {
            setTimeout(() => this.kick(), this.get_beat_delay() * 1000);
        }
    }
}
