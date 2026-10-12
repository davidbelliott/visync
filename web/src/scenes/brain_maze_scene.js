import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene } from './scene.js';
import { ScannedBrain } from '../components/scanned_brain.js';
import { MAZE_DIRS } from '../infinite_maze.js';
import { MazeLevels } from '../maze_levels.js';
import { MazeLevel } from '../components/maze_level.js';
import { InstancedProps } from '../components/instanced_props.js';
import { ISOMETRIC_TILT } from '../stepped_rotation.js';
import { CH_EXPAND_Y } from '../controller_map.js';
import { lerp_scalar, ease, clamp, Spark } from '../util.js';

// Rotation (rad): yaw in lockstep with the other stepped scenes (see
// stepped_rotation.js), every 45 deg from a diagonal base; pitch locked at
// the isometric tilt, looking down into the maze. The view pivots on the
// brain's centre, which stays in the middle of the screen.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// The maze (see MazeLevels, MazeLevel), world units: the walls' thickness
// and standard height (a level's walls are a multiple of it, and each level
// stands on top of the walls of the one below). Each level has its own
// layout, colour and character; only the brain's level shows, crossfading to
// the next as it takes a staircase.
const WALL_T = 0.5;
const WALL_H = 4;
// The brain stands as tall as the walls (the model is ~162 units tall and
// ~153 wide, so ~3.8 wide here, and ~4.7 long: it still turns in a cell).
const BRAIN_MODEL_HEIGHT = 162;
const BRAIN_MODEL_WIDTH = 153;
const BRAIN_SCALE = WALL_H / BRAIN_MODEL_HEIGHT;
// Claustrophobic corridors, CORRIDOR_BRAINS times the brain's width between
// the walls (~5.7), which sets the cell pitch (~6.2).
const CORRIDOR_BRAINS = 1.5;
const CELL = CORRIDOR_BRAINS * BRAIN_MODEL_WIDTH * BRAIN_SCALE + WALL_T;
// Fog of war, world units: the maze is lit by nothing but the brain's
// light, whose range ends at FOG_FAR, so it darkens to black with distance;
// edges fade (eased) from FOG_NEAR to FOG_FAR, unless FOG_EDGES is false:
// then the maze's wireframe (walls, stairs, carpets) is drawn at full
// intensity everywhere, and only the fills darken. The cones fade
// with the fog either way, edges and all. The maze window drawn
// (cells either side of the brain's) spans whole cells past FOG_FAR, so
// nothing pops in; or, with unfogged edges, past the screen at the widest
// shared zoom (an isometric view ~50 units from centre to corner, plus a
// cell's walk before the window recentres).
const FOG_NEAR = 5;
const FOG_FAR = 30;
const FOG_EDGES = false;
const FOG_CELLS = Math.ceil(FOG_FAR / CELL) + 1;
const WINDOW_HALF = FOG_EDGES ? FOG_CELLS : 9;

// A translucent black floor under the brain (as in the drum kit scene),
// dimming any scene layered behind this one: its opacity, and its size
// (world units), enough to cover the screen at the widest shared zoom.
const FLOOR_OPACITY = 0.5;
const FLOOR_SIZE = 400;

// Ice cream cones in a rare few cells (CONE_P of them, fixed per cell and
// level), standing at the cell's centre, turning slowly (CONE_SPIN rad per
// beat), in orange as in the ice cream scene. The model's long axis is z,
// with its tip at z = CONE_TIP_Z: CONE_BASE_ANGLE about x stands it up,
// raised so the tip meets the floor.
const CONE_P = 0.06;
const CONE_SCALE = 0.10;
const CONE_COLOR = new THREE.Color('orange');
const CONE_EDGE_ANGLE = 1;          // deg: every facet edge (see ice cream)
const CONE_BASE_ANGLE = -Math.PI / 2;
const CONE_TIP_Z = -20;
const CONE_SPIN = Math.PI / 8;
// They bob gently up off the floor and back, BOB_HEIGHT world units at the
// top, once every BOB_BEATS (a bar), each at its own fixed phase (from its
// cell) so neighbours drift in and out of step.
const BOB_HEIGHT = 0.75;
const BOB_BEATS = 4;
// The brain heads straight for what it can see down a straight run of open
// cells, up to SIGHT_CELLS away (the nearest if several): first a staircase
// it has not taken, else a cone.
const SIGHT_CELLS = FOG_CELLS;
const MAX_CONES = 64;               // in view at once (two levels); ~20 typical
// Cells whose cone has been picked up, and staircases taken, oldest
// forgotten
// first.
const MAX_COLLECTED = 4096;
const MAX_TAKEN = 1024;
// When the brain reaches a cone it eats it: the brain flashes white, and
// plus-sign sparks (the shared Spark, as a cross facing the viewer, small as
// gantry's: SPARK_SIZE is its half-width) burst from it, one along each of
// SPARK_DIRS (an icosahedron's 12 vertices, spread evenly over every
// direction), at SPARK_SPEED world units per beat, then float up under
// negative gravity (SPARK_LIFT world units per beat per beat) for
// SPARK_BEATS.
const GOLDEN = (1 + Math.sqrt(5)) / 2;
const SPARK_DIRS = [
    [0, 1, GOLDEN], [0, 1, -GOLDEN], [0, -1, GOLDEN], [0, -1, -GOLDEN],
    [1, GOLDEN, 0], [1, -GOLDEN, 0], [-1, GOLDEN, 0], [-1, -GOLDEN, 0],
    [GOLDEN, 0, 1], [GOLDEN, 0, -1], [-GOLDEN, 0, 1], [-GOLDEN, 0, -1],
].map((v) => new THREE.Vector3(...v).normalize());
const MAX_SPARKS = 64;
const SPARK_SPEED = 6;
const SPARK_LIFT = 8;
const SPARK_BEATS = 1.5;
const SPARK_SIZE = 0.2;
const SPARK_COLOR = 'white';

// The brain walks the maze one cell per MOVE_BEATS, arriving in each cell on
// the beat, turning only at right angles (it faces the way it goes, turning
// over the first TURN_FRACTION of a step). A staircase is crossed in one move,
// from the cell before it to the one past it (its k cells and one more, over
// as many MOVE_BEATS), rising or sinking a level only while on the steps,
// the levels crossfading as it does; the brain never stops on the stairs. With nothing in
// sight (see SIGHT_CELLS) it picks the open way that best follows its heading, never
// turning straight back unless at a dead end, and shunning cells by
// VISIT_PENALTY per earlier visit so it backs out of dead ends and doesn't
// circle; a little JITTER keeps the route from being too predictable.
const MOVE_BEATS = 1;
// false: each step at constant speed, so steps chain into one continuous
// glide through the maze. true: each step eases from rest to rest, pausing
// in every cell on the beat.
const EASED_STEPS = true;
const TURN_FRACTION = 0.5;
const VISIT_PENALTY = 1.5;
const JITTER = 0.5;
// Cells remembered for VISIT_PENALTY, oldest forgotten first.
const MAX_REMEMBERED = 2048;
// The heading is knob 4's (CH_EXPAND_Y), mapped as gantry maps its
// next-target direction: a full turn over the knob's travel, from +x
// towards +z; DEFAULT_HEADING until the knob moves.
const DEFAULT_HEADING = Math.PI / 4;

// The only light, riding over the brain (in brain_group's frame, origin at
// the brain's underside), LIGHT_ABOVE_WALLS world units above the tops of its
// level's walls, so it rises with taller levels (blending between levels'
// heights on the stairs). Decay 1 for a soft falloff, cut off at FOG_FAR (see
// the fog of war). A spotlight pointing straight down, its cone (widened to
// suit its height) reaching FOG_FAR across the floor, so it casts shadows in
// one pass (a point light would need six): walls block it, so only what the
// brain can see is lit. LIGHT_PENUMBRA softens the cone's rim (out in the
// fog anyway).
const LIGHT_ABOVE_WALLS = 2;
const LIGHT_INTENSITY = 6;
const LIGHT_DECAY = 1;
const LIGHT_PENUMBRA = 0.2;
// Shadow map resolution (px a side; lower it on slow hardware), and biases
// against self-shadowing acne on the walls.
const SHADOW_MAP_SIZE = 1024;
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 0.02;
// Shadows also darken the scenes layered behind, through a shadow-only plane
// on the brain's floor: this dark where fully shadowed.
const FLOOR_SHADOW_OPACITY = 0.6;

export class BrainMazeScene extends Scene {
    constructor(context) {
        super(context, 'brainmaze');

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.clear();

        // base_group turns about the brain's centre; world_group drops the
        // floor the brain stands on (and the brain) so that centre is at the
        // origin, following the brain up and down stairs; maze_group slides
        // the maze under the brain, its origin on the brain's level's floor
        // under the window's centre cell.
        this.base_group = new THREE.Group();
        this.base_group.rotation.x = PITCH_BASE;
        // Pitch locked at the tilt: it holds the shared stepped view's pitch
        // there while it shows.
        this.stepped_pitches = [PITCH_BASE];
        this.base_group.rotation.y = YAW_BASE;
        this.add(this.base_group);
        this.world_group = new THREE.Group();
        this.base_group.add(this.world_group);
        this.maze_group = new THREE.Group();
        this.world_group.add(this.maze_group);

        this.brain_group = new THREE.Group();
        this.world_group.add(this.brain_group);
        this.brain = new ScannedBrain(BRAIN_SCALE, { shadows: true });
        this.brain_group.add(this.brain);
        // Placed (height and cone) each frame by place_light.
        const light = this.light = new THREE.SpotLight('white', LIGHT_INTENSITY, FOG_FAR,
            Math.PI / 4, LIGHT_PENUMBRA, LIGHT_DECAY);
        this.brain_group.add(light, light.target);     // target at the brain's feet
        light.castShadow = true;
        light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        light.shadow.camera.near = 0.5;
        light.shadow.bias = SHADOW_BIAS;
        light.shadow.normalBias = SHADOW_NORMAL_BIAS;

        // Two level views: the brain's level, and the one a staircase leads to
        // (shown, crossfading, only while taking it).
        this.levels = new MazeLevels();
        const view_options = {
            cell: CELL,
            thickness: WALL_T,
            height: WALL_H,
            half: WINDOW_HALF,
            fog_near: FOG_NEAR,
            fog_far: FOG_FAR,
            fog_edges: FOG_EDGES,
        };
        this.view = new MazeLevel(this.levels, view_options);
        this.next_view = new MazeLevel(this.levels, view_options);
        this.next_view.set_opacity(0);
        this.maze_group.add(this.view, this.next_view);

        // The black floor follows the brain's feet. It writes no depth and
        // draws before the scene's other translucent parts, so it dims only
        // what lies behind the scene, never the edges drawn on the floor;
        // pushed back past the levels' floor fills, which win where solid.
        this.floor = new THREE.Mesh(
            new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({
                color: 'black',
                transparent: true,
                opacity: FLOOR_OPACITY,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4,
            }));
        this.floor.renderOrder = -2;
        this.world_group.add(this.floor);
        // The shadow-only plane on the floor (see FLOOR_SHADOW_OPACITY),
        // pushed back between the levels' floor fills and the black floor.
        // It too writes no depth, so it must draw before the edges (which
        // don't either) or it darkens those in shadow wherever the dithered
        // floor fill leaves a gap: a flickering dither pattern along them,
        // as the translucent sort by distance swaps the two while moving.
        this.shadow_floor = new THREE.Mesh(
            new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2),
            new THREE.ShadowMaterial({
                opacity: FLOOR_SHADOW_OPACITY,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: 3,
                polygonOffsetUnits: 3,
            }));
        this.shadow_floor.receiveShadow = true;
        this.shadow_floor.renderOrder = -1;
        this.world_group.add(this.shadow_floor);

        // Cones, posed each frame from the lists of cones in view: [di, dj,
        // bob phase (rad), level offset (-1, 0, +1)].
        this.cone_cells = [];
        this.collected = new Set();     // "level,i,j" of eaten cones
        this.cones = null;              // InstancedProps, once loaded
        this.cone_dummy = new THREE.Object3D();
        this.cone_dummy.rotation.order = 'YXZ';     // spin about the vertical
        new STLLoader().loadAsync('stl/ice-cream-cone.stl').then((geom) => {
            this.cones = new InstancedProps(geom,
                { color: CONE_COLOR, max: MAX_CONES, edge_angle: CONE_EDGE_ANGLE, shadows: true });
            this.maze_group.add(this.cones);
        });

        // Plus-sign sparks: a ring of the shared Spark, in maze_group's frame
        // (shifted as it re-centres), each live for life_s.
        this.sparks = [];
        this.next_spark = 0;
        for (let k = 0; k < MAX_SPARKS; k++) {
            const spark = new Spark(SPARK_SIZE, SPARK_COLOR, [0, 1], true, false, true);
            spark.active = false;
            spark.life_s = 0;
            this.maze_group.add(spark);
            this.sparks.push(spark);
        }

        // The walk: the level and cell the brain set out from, the step it
        // is taking (MAZE_DIRS entry) and its climb (+1 up a staircase, -1 down,
        // 0 level), beats elapsed and when the step began, its facing (rad)
        // turning from facing_from to facing_to, how often it has entered
        // each remembered cell ("level,i,j" -> count), and the staircases taken.
        this.heading = DEFAULT_HEADING;
        this.bind(CH_EXPAND_Y, (a) => { this.heading = a; },
            (norm) => norm * 2 * Math.PI);
        this.level = 0;
        this.cell_i = 0;
        this.cell_j = 0;
        this.step = [0, 0];
        this.climb = 0;
        this.cells = 1;                 // cells the step covers (more on stairs)
        this.rise_h = 0;                // world units a staircase step climbs
        this.beats = 0;
        this.step_start = 0;
        this.visits = new Map();
        this.taken = new Set();
        this.view.set_level(this.level);
        this.set_step(this.choose_step());
        this.facing_from = this.facing_to;
        this.build_views();

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        const d_beats = dt * this.get_local_bpm() / 60;
        this.beats += d_beats;
        while (this.beats - this.step_start >= MOVE_BEATS * this.cells) {
            this.arrive();
        }
        const frac = (this.beats - this.step_start) / (MOVE_BEATS * this.cells);

        // Slide the maze under the brain, which is part way along its step
        // from the window's centre cell (and up or down stairs).
        const along = EASED_STEPS ? ease(frac) : frac;
        const bx = this.step[0] * along * this.cells * CELL;
        const bz = this.step[1] * along * this.cells * CELL;
        const rise = this.stairs_rise(along);
        this.maze_group.position.set(-bx, 0, -bz);
        this.brain_group.position.y = rise;
        this.floor.position.y = rise;
        this.shadow_floor.position.y = rise;
        this.world_group.position.y = -rise - this.brain.height / 2;
        this.brain_group.rotation.y = lerp_scalar(this.facing_from, this.facing_to,
            ease(clamp(frac / TURN_FRACTION, 0, 1)));

        // On stairs, the levels crossfade as the brain climbs.
        const fade = this.rise_h > 0 ? Math.abs(rise) / this.rise_h : 0;
        this.view.set_opacity(1 - fade);
        this.next_view.set_opacity(fade);
        this.place_light(fade);
        for (const view of [this.view, this.next_view]) {
            view.set_viewer(bx, bz);
            view.update();
        }

        this.brain.update(d_beats);
        this.base_group.rotation.x = this.stepped_pitch();
        this.base_group.rotation.y = YAW_BASE + this.stepped_yaw();
        this.update_cones(bx, bz, fade);
        for (const spark of this.sparks) {
            if (spark.active) {
                spark.life_s -= dt;
                spark.active = spark.life_s > 0;
            }
            spark.anim_frame(dt, this.camera);
        }
    }

    // Set the light LIGHT_ABOVE_WALLS over the walls of the brain's level,
    // blended `fade` (0..1) of the way to the next level's on the stairs,
    // its cone reaching FOG_FAR across the floor from there.
    place_light(fade) {
        const wall_h = (level) => WALL_H * this.levels.params(level).height;
        let h = wall_h(this.level);
        if (this.climb != 0) {
            h = lerp_scalar(h, wall_h(this.level + this.climb), fade);
        }
        const y = h + LIGHT_ABOVE_WALLS;
        this.light.position.set(0, y, 0);
        this.light.angle = Math.atan2(FOG_FAR, y);
    }

    // Height (world units) along a staircase move `along` (0..1) of the way
    // from the cell before the flight to the cell past it: level ground up to
    // its foot (the wall line half a cell on), then up its pitch (to the face
    // of the wall past its top, its k cells less half a wall on), then level
    // again; a move down is the same run backwards. 0 off stairs.
    stairs_rise(along) {
        const k = this.cells - 1;
        const up = (u) => clamp((u * this.cells * CELL - CELL / 2) / (k * CELL - WALL_T / 2), 0, 1);
        if (this.climb > 0) {
            return this.rise_h * up(along);
        }
        if (this.climb < 0) {
            return -this.rise_h * (1 - up(1 - along));
        }
        return 0;
    }

    // Lay out both views around the brain's cell: its level, and (if the
    // step under way is a staircase) the level it leads to, offset up or down.
    build_views() {
        this.view.build(this.cell_i, this.cell_j);
        if (this.climb != 0) {
            this.next_view.set_level(this.level + this.climb);
            this.next_view.position.y = this.climb * this.rise_h;
            this.next_view.build(this.cell_i, this.cell_j);
        }
        this.list_cones();
    }

    // List the uneaten cones in view: around the brain's cell on its level,
    // and on the level a staircase under way leads to.
    list_cones() {
        this.cone_cells.length = 0;
        for (const offset of this.climb != 0 ? [0, this.climb] : [0]) {
            const level = this.level + offset;
            for (let di = -WINDOW_HALF; di <= WINDOW_HALF; di++) {
                for (let dj = -WINDOW_HALF; dj <= WINDOW_HALF; dj++) {
                    const i = this.cell_i + di, j = this.cell_j + dj;
                    if (this.has_cone(level, i, j) && this.cone_cells.length < MAX_CONES) {
                        const phase = 2 * Math.PI * this.levels.maze(level).cell_random(i, j, 1);
                        this.cone_cells.push([di, dj, phase, offset]);
                    }
                }
            }
        }
    }

    // Pose the cones (spin, bob) and fade them with the fog, by distance
    // from the brain at (bx, bz), and with their level's crossfade.
    update_cones(bx, bz, fade) {
        if (this.cones === null) {
            return;
        }
        const bob_angle = 2 * Math.PI * this.beats / BOB_BEATS;
        const dummy = this.cone_dummy;
        dummy.rotation.set(CONE_BASE_ANGLE, this.beats * CONE_SPIN, 0);
        dummy.scale.setScalar(CONE_SCALE);
        this.cones.begin();
        for (const [di, dj, phase, offset] of this.cone_cells) {
            const x = di * CELL, z = dj * CELL;
            const lift = BOB_HEIGHT * (0.5 - 0.5 * Math.cos(bob_angle + phase));
            dummy.position.set(x, offset * this.rise_h - CONE_TIP_Z * CONE_SCALE + lift, z);
            dummy.updateMatrix();
            const d = Math.hypot(x - bx, z - bz);
            const level_alpha = offset == 0 ? 1 - fade : fade;
            const alpha = ease(clamp((FOG_FAR - d) / (FOG_FAR - FOG_NEAR), 0, 1)) * level_alpha;
            this.cones.add_instance(dummy.matrix, alpha);
        }
        this.cones.end();
    }

    // Burst plus signs from the brain's centre, at maze_group's origin.
    spawn_sparks() {
        const beats_per_sec = this.get_local_bpm() / 60;
        for (const dir of SPARK_DIRS) {
            const spark = this.sparks[this.next_spark];
            this.next_spark = (this.next_spark + 1) % MAX_SPARKS;
            spark.position.set(0, this.brain.height / 2, 0);
            spark.velocity.copy(dir).multiplyScalar(SPARK_SPEED * beats_per_sec);
            spark.acceleration.set(0, SPARK_LIFT * beats_per_sec * beats_per_sec, 0);
            spark.life_s = SPARK_BEATS / beats_per_sec;
            spark.active = true;
        }
    }

    // The step is done: stand in the next cell (on the next level, after a
    // staircase), remember it, eat any cone, pick the next step, and re-centre the
    // views on the new cell.
    arrive() {
        const [si, sj] = this.step;
        const climb = this.climb, cells = this.cells, rise_h = this.rise_h;
        this.cell_i += si * cells;
        this.cell_j += sj * cells;
        if (climb != 0) {
            // The view the staircase led to becomes the brain's level.
            this.level += climb;
            [this.view, this.next_view] = [this.next_view, this.view];
            this.view.position.y = 0;
            this.view.set_opacity(1);
            this.next_view.set_opacity(0);
        }
        // maze_group re-centred a cell on (and maybe a level up or down):
        // keep the sparks where they were.
        for (const spark of this.sparks) {
            spark.position.x -= si * cells * CELL;
            spark.position.z -= sj * cells * CELL;
            spark.position.y -= climb * rise_h;
        }

        const key = `${this.level},${this.cell_i},${this.cell_j}`;
        this.visits.set(key, (this.visits.get(key) || 0) + 1);
        if (this.visits.size > MAX_REMEMBERED) {
            this.visits.delete(this.visits.keys().next().value);
        }
        if (this.has_cone(this.level, this.cell_i, this.cell_j)) {
            this.collected.add(key);
            if (this.collected.size > MAX_COLLECTED) {
                this.collected.delete(this.collected.values().next().value);
            }
            this.brain.flash();
            this.spawn_sparks();
        }

        this.facing_from = this.facing_to;
        this.step_start += MOVE_BEATS * cells;
        this.set_step(this.choose_step());
        this.build_views();
    }

    // Start step = [di, dj, climb, stairs key, cells, height (standard
    // heights)]: note a staircase as taken, and turn to face it, the short
    // way round from the current facing.
    set_step([di, dj, climb, key, cells, height]) {
        this.step = [di, dj];
        this.climb = climb;
        this.cells = cells;
        this.rise_h = height * WALL_H;
        if (key !== null) {
            this.taken.add(key);
            if (this.taken.size > MAX_TAKEN) {
                this.taken.delete(this.taken.values().next().value);
            }
        }
        let to = Math.atan2(di, dj);       // the model's front is +z
        if (this.facing_to !== undefined) {
            to += Math.round((this.facing_to - to) / (2 * Math.PI)) * 2 * Math.PI;
        }
        this.facing_to = to;
    }

    // Whether cell (i, j) of level L holds an uneaten cone (never a staircase's
    // cell, which the brain can't stand in).
    has_cone(level, i, j) {
        return this.levels.maze(level).cell_random(i, j) < CONE_P &&
            !this.collected.has(`${level},${i},${j}`) && !this.levels.stairs_cell(level, i, j);
    }

    // The ways on from the current cell: [di, dj, climb, stairs key, cells,
    // height] (see set_step) for each passable direction.
    ways_on() {
        const ways = [];
        for (const [di, dj] of MAZE_DIRS) {
            const step = this.levels.step(this.level, this.cell_i, this.cell_j, di, dj);
            if (step !== null) {
                ways.push([di, dj, step.climb, step.key, step.cells, step.height]);
            }
        }
        return ways;
    }

    // The way on from the current cell: an untaken staircase from here,
    // else towards the nearest untaken staircase in sight, else the nearest cone in
    // sight (see SIGHT_CELLS), else by the rule at MOVE_BEATS.
    choose_step() {
        const ways = this.ways_on();
        const untaken = ways.find(([, , climb, key]) => climb != 0 && !this.taken.has(key));
        if (untaken) {
            return untaken;
        }
        // Look down each level run of open cells.
        let stairs_dist = SIGHT_CELLS + 1, cone_dist = SIGHT_CELLS + 1;
        let to_stairs = null, to_cone = null;
        for (const way of ways) {
            const [di, dj, climb] = way;
            if (climb != 0) {
                continue;
            }
            let i = this.cell_i, j = this.cell_j;
            for (let k = 1; k <= SIGHT_CELLS; k++) {
                i += di;
                j += dj;
                if (k < cone_dist && this.has_cone(this.level, i, j)) {
                    cone_dist = k;
                    to_cone = way;
                }
                if (k < stairs_dist && MAZE_DIRS.some(([ri, rj]) => {
                    const step = this.levels.step(this.level, i, j, ri, rj);
                    return step !== null && step.climb != 0 && !this.taken.has(step.key);
                })) {
                    stairs_dist = k;
                    to_stairs = way;
                }
                const on = this.levels.step(this.level, i, j, di, dj);
                if (on === null || on.climb != 0) {
                    break;
                }
            }
        }
        if (to_stairs !== null) {
            return to_stairs;
        }
        if (to_cone !== null) {
            return to_cone;
        }

        const [pi, pj] = this.step;
        const hx = Math.cos(this.heading), hz = Math.sin(this.heading);
        let best = null;
        let best_score = -Infinity;
        for (const allow_back of [false, true]) {
            for (const way of ways) {
                const [di, dj, climb, , cells] = way;
                if (!allow_back && di == -pi && dj == -pj) {
                    continue;
                }
                const visits = this.visits.get(
                    `${this.level + climb},${this.cell_i + di * cells},${this.cell_j + dj * cells}`) || 0;
                const score = di * hx + dj * hz - VISIT_PENALTY * visits + JITTER * Math.random();
                if (score > best_score) {
                    best_score = score;
                    best = way;
                }
            }
            if (best !== null) {
                return best;
            }
        }
        // Never reached: every open way is passable (a staircase's cells
        // are a dead end on both levels, open only to the cells that cross
        // it).
        return [0, 0, 0, null, 1, 0];
    }

    handle_beat(t, channel) {
        if (channel == 1) {
            setTimeout(() => {
                this.brain.start_scan();
            }, this.get_beat_delay(t) * 1000);
        }
    }
}
