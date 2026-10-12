import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene } from './scene.js';
import { ScannedBrain } from '../components/scanned_brain.js';
import { InfiniteMaze, MAZE_DIRS } from '../infinite_maze.js';
import { MazeWalls } from '../components/maze_walls.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import { ISOMETRIC_TILT } from '../stepped_rotation.js';
import { CH_EXPAND_Y } from '../controller_map.js';
import { lerp_scalar, ease, clamp, ResourceLoader, Spark } from '../util.js';

// Rotation (rad): yaw in lockstep with the other stepped scenes (see
// stepped_rotation.js), every 45 deg from a diagonal base; pitch locked at
// the isometric tilt, looking down into the maze. The view pivots on the
// brain's centre, which stays in the middle of the screen.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// The maze (see InfiniteMaze, MazeWalls), world units: the walls' thickness
// and height. Walls run between posts at the cells' corners, drawn as one
// solid: a lit, dithered fill outlined along its true edges.
const WALL_T = 0.5;
const WALL_H = 4;
const WALL_COLOR = new THREE.Color('orange');
// The brain stands as tall as the walls (the model is ~162 units tall and
// ~153 wide, so ~3.8 wide here, and ~4.7 long: it still turns in a cell).
const BRAIN_MODEL_HEIGHT = 162;
const BRAIN_MODEL_WIDTH = 153;
const BRAIN_SCALE = WALL_H / BRAIN_MODEL_HEIGHT;
// Claustrophobic corridors, CORRIDOR_BRAINS times the brain's width between
// the walls (~5.7), which sets the cell pitch (~6.2).
const CORRIDOR_BRAINS = 1.5;
const CELL = CORRIDOR_BRAINS * BRAIN_MODEL_WIDTH * BRAIN_SCALE + WALL_T;
// Fog of war, world units: the walls are lit by nothing but the brain's
// light, whose range ends at FOG_FAR, so they darken to black with distance;
// their edges fade (eased) from FOG_NEAR to FOG_FAR. The maze window drawn
// spans whole cells past FOG_FAR, so nothing pops in.
const FOG_NEAR = 5;
const FOG_FAR = 30;
const WINDOW_HALF = Math.ceil(FOG_FAR / CELL) + 1;     // cells either side

// A translucent black floor under the maze (as in the drum kit scene), dimming
// any scene layered behind this one: its opacity, and its size (world units),
// enough to cover the screen at the widest shared zoom.
const FLOOR_OPACITY = 0.5;
const FLOOR_SIZE = 400;
// Over it, a lit, dithered orange floor fill fixed to the maze, its opacity
// following 2D simplex noise across the floor: from FLOOR_FILL_MIN where the
// noise is below FLOOR_NOISE_LO to FLOOR_FILL_MAX above FLOOR_NOISE_HI (noise
// in about [-1, 1]), in patches ~FLOOR_NOISE_SIZE world units across (a few
// cells). It fades with the fog of war, so no dither specks reach past the
// light.
const FLOOR_FILL_COLOR = new THREE.Color('orange');
const FLOOR_FILL_MIN = 0.1;
const FLOOR_FILL_MAX = 0.25;
const FLOOR_NOISE_LO = -0.3;
const FLOOR_NOISE_HI = 0.7;
const FLOOR_NOISE_SIZE = 25;

// Ice cream cones in a rare few cells (CONE_P of them, fixed per cell),
// standing at the cell's centre as tall as the walls, turning slowly
// (CONE_SPIN rad per beat). The model's long axis is z, CONE_MODEL_LENGTH
// long with its tip at z = CONE_TIP_Z: CONE_BASE_ANGLE about x stands it up,
// raised so the tip meets the floor.
const CONE_P = 0.06;
const CONE_SCALE = 0.10;
// Orange, as in the ice cream scene: a lit fill shaded through the house
// dither, outlined in the same colour.
const CONE_COLOR = new THREE.Color('orange');
// The edges' line batch (InstancedGeometryCollection) writes its colour to
// the screen as-is, with none of three's linear -> sRGB output conversion, so
// it is given the colour already in sRGB, matching the walls' edges.
const CONE_EDGE_COLOR = CONE_COLOR.clone().convertLinearToSRGB();
const CONE_EDGE_ANGLE = 1;          // deg: every facet edge (see ice cream)
const CONE_BASE_ANGLE = -Math.PI / 2;
const CONE_TIP_Z = -20;
const CONE_SPIN = Math.PI / 8;
// They bob gently up off the floor and back, BOB_HEIGHT world units at the
// top, once every BOB_BEATS (a bar), each at its own fixed phase (from its
// cell) so neighbours drift in and out of step.
const BOB_HEIGHT = 0.75;
const BOB_BEATS = 4;
// The brain heads straight for any cone in sight (down a straight run of
// open cells, up to SIGHT_CELLS away; the nearest if several).
const SIGHT_CELLS = WINDOW_HALF;
const MAX_CONES = 32;               // in the window at once; ~5 typical
// Cells whose cone has been picked up, oldest forgotten first.
const MAX_COLLECTED = 4096;
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
// over the first TURN_FRACTION of a step). At each
// cell it picks the open way that best follows its heading, never turning
// straight back unless at a dead end, and shunning cells by VISIT_PENALTY
// per earlier visit so it backs out of dead ends and doesn't circle; a
// little JITTER keeps the route from being too predictable.
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

// The only light, riding just over the brain (in brain_group's frame, origin
// at the brain's underside; the brain is WALL_H tall). Decay 1 for a soft
// falloff, cut off at FOG_FAR (see the fog of war).
const LIGHT_POS = new THREE.Vector3(0, WALL_H + 2, 0);
const LIGHT_INTENSITY = 6;
const LIGHT_DECAY = 1;

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
        // maze floor (and the brain standing on it) so that centre is at the
        // origin; maze_group slides the maze under the brain.
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
        this.brain = new ScannedBrain(BRAIN_SCALE);
        this.brain_group.add(this.brain);
        const light = new THREE.PointLight('white', LIGHT_INTENSITY, FOG_FAR, LIGHT_DECAY);
        light.position.copy(LIGHT_POS);
        this.brain_group.add(light);

        this.maze = new InfiniteMaze();
        this.walls = new MazeWalls(this.maze, {
            cell: CELL,
            thickness: WALL_T,
            height: WALL_H,
            half: WINDOW_HALF,
            color: WALL_COLOR,
            fog_near: FOG_NEAR,
            fog_far: FOG_FAR,
        });
        this.maze_group.add(this.walls);

        // The floor stays put under the brain (the maze slides over it). It
        // writes no depth and draws before the scene's other translucent
        // parts, so it dims only what lies behind the scene, never the
        // walls' edges drawn on it.
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
            new THREE.MeshBasicMaterial({
                color: 'black',
                transparent: true,
                opacity: FLOOR_OPACITY,
                depthWrite: false,
            }));
        floor.rotation.x = -Math.PI / 2;    // face up
        floor.renderOrder = -1;
        // Pushed back past the floor fill, which wins where it is solid.
        floor.material.polygonOffset = true;
        floor.material.polygonOffsetFactor = 4;
        floor.material.polygonOffsetUnits = 4;
        this.world_group.add(floor);

        // The noisy floor fill: stays put like the floor, its noise sampled
        // at maze coordinates (floor_origin: where world_group's origin is in
        // the maze, from the walk), so the pattern slides with the walls.
        // Pushed back so the walls' bottom edges, on the floor, draw over it.
        this.floor_uniforms = {
            floor_origin: { value: new THREE.Vector2() },
        };
        new ResourceLoader(['glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag',
            'glsl/chunks/simplex2d.glsl']).load().then(([dither_pars, dither, simplex2d]) => {
            const mat = new THREE.MeshLambertMaterial({
                color: FLOOR_FILL_COLOR,
                polygonOffset: true,
                polygonOffsetFactor: 2,
                polygonOffsetUnits: 2,
            });
            mat.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.floor_uniforms);
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'varying vec2 v_floor_xz;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    // The plane lies in xy, turned to face up: floor x, z.
                    '#include <begin_vertex>\nv_floor_xz = vec2(position.x, -position.y);'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars + '\n' + simplex2d + '\n' +
                    'uniform vec2 floor_origin;\nvarying vec2 v_floor_xz;'
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                ).replace(
                    '#include <clipping_planes_fragment>',
                    '#include <clipping_planes_fragment>\n' +
                    `float noise = snoise((v_floor_xz + floor_origin) / ${FLOOR_NOISE_SIZE.toFixed(1)});\n` +
                    `float fog = clamp((${FOG_FAR.toFixed(1)} - length(v_floor_xz)) / ` +
                    `${(FOG_FAR - FOG_NEAR).toFixed(1)}, 0.0, 1.0);\n` +
                    `float alpha = mix(${FLOOR_FILL_MIN.toFixed(2)}, ${FLOOR_FILL_MAX.toFixed(2)}, ` +
                    `smoothstep(${FLOOR_NOISE_LO.toFixed(2)}, ${FLOOR_NOISE_HI.toFixed(2)}, noise)) * ` +
                    '(0.5 - 0.5 * cos(3.14159265 * fog));\n' +
                    'if (dither4x4(gl_FragCoord.xy, alpha) < 0.5) discard;'
                );
            };
            const fill = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), mat);
            fill.rotation.x = -Math.PI / 2;
            this.world_group.add(fill);
        });

        // Cones: edges as an instanced line batch, fill as an instanced mesh
        // (black, pushed back so the edges draw), both posed each frame. The
        // window's cones are listed as cells relative to the centre one.
        this.cone_cells = [];       // [di, dj, bob phase (rad)] per uneaten cone in view
        this.collected = new Set();     // "i,j" of eaten cones
        this.cone_edges = null;
        this.cone_fill = null;      // once loaded
        this.cone_dummy = new THREE.Object3D();
        this.cone_dummy.rotation.order = 'YXZ';     // spin about the vertical
        this.cone_quat = new THREE.Quaternion();
        this.cone_scale = new THREE.Vector3();
        Promise.all([
            new STLLoader().loadAsync('stl/ice-cream-cone.stl'),
            new ResourceLoader(['glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag']).load(),
        ]).then(([geom, [dither_pars, dither]]) => {
            this.cone_edges = new InstancedGeometryCollection(this.maze_group,
                new THREE.EdgesGeometry(geom, CONE_EDGE_ANGLE), 'Lines', MAX_CONES);
            for (let k = 0; k < MAX_CONES; k++) {
                this.cone_edges.create_geom(new THREE.Vector3(), CONE_EDGE_COLOR, new THREE.Vector3(1, 1, 1));
            }
            const fill_mat = new THREE.MeshLambertMaterial({
                color: CONE_COLOR,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
            });
            fill_mat.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            this.cone_fill = new THREE.InstancedMesh(geom, fill_mat, MAX_CONES);
            this.maze_group.add(this.cone_fill);
        });

        // Plus-sign sparks: a ring of the shared Spark, in the maze window's
        // frame (shifted as the window re-centres), each live for life_s.
        this.sparks = [];
        this.next_spark = 0;
        for (let k = 0; k < MAX_SPARKS; k++) {
            const spark = new Spark(SPARK_SIZE, SPARK_COLOR, [0, 1], true, false, true);
            spark.active = false;
            spark.life_s = 0;
            this.maze_group.add(spark);
            this.sparks.push(spark);
        }

        // The walk: the cell the brain set out from, the step it is taking
        // (MAZE_DIRS entry), beats elapsed and when the step began, its
        // facing (rad) turning from facing_from to facing_to, and how often
        // it has entered each remembered cell ("i,j" -> count).
        this.heading = DEFAULT_HEADING;
        this.bind(CH_EXPAND_Y, (a) => { this.heading = a; },
            (norm) => norm * 2 * Math.PI);
        this.cell_i = 0;
        this.cell_j = 0;
        this.step = [0, 0];
        this.beats = 0;
        this.step_start = 0;
        this.visits = new Map();
        this.step = this.choose_step();
        this.facing_from = this.facing_to = this.facing_of(this.step);
        this.walls.build(this.cell_i, this.cell_j);
        this.list_cones();


        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        const d_beats = dt * this.get_local_bpm() / 60;
        this.beats += d_beats;
        while (this.beats - this.step_start >= MOVE_BEATS) {
            this.arrive();
        }
        const frac = (this.beats - this.step_start) / MOVE_BEATS;

        // Slide the maze under the brain, which is part way along its step
        // from the window's centre cell.
        const along = (EASED_STEPS ? ease(frac) : frac) * CELL;
        const bx = this.step[0] * along;
        const bz = this.step[1] * along;
        this.maze_group.position.set(-bx, 0, -bz);
        this.brain_group.rotation.y = lerp_scalar(this.facing_from, this.facing_to,
            ease(clamp(frac / TURN_FRACTION, 0, 1)));
        this.world_group.position.y = -this.brain.height / 2;
        this.walls.set_viewer(bx, bz);
        this.floor_uniforms.floor_origin.value.set(
            this.cell_i * CELL + bx, this.cell_j * CELL + bz);

        this.brain.update(d_beats);
        this.base_group.rotation.x = this.stepped_pitch();
        this.base_group.rotation.y = YAW_BASE + this.stepped_yaw();
        this.update_cones(bx, bz);
        for (const spark of this.sparks) {
            if (spark.active) {
                spark.life_s -= dt;
                spark.active = spark.life_s > 0;
            }
            spark.anim_frame(dt, this.camera);
        }
    }

    // List the uneaten cones in the window around the brain's cell.
    list_cones() {
        this.cone_cells.length = 0;
        for (let di = -WINDOW_HALF; di <= WINDOW_HALF; di++) {
            for (let dj = -WINDOW_HALF; dj <= WINDOW_HALF; dj++) {
                const i = this.cell_i + di, j = this.cell_j + dj;
                if (this.has_cone(i, j) && this.cone_cells.length < MAX_CONES) {
                    this.cone_cells.push([di, dj, 2 * Math.PI * this.maze.cell_random(i, j, 1)]);
                }
            }
        }
    }

    // Pose the cones (spin, bob) and fade them with the fog, by distance
    // from the brain at (bx, bz).
    update_cones(bx, bz) {
        if (this.cone_fill === null) {
            return;
        }
        const scale = CONE_SCALE;
        const bob_angle = 2 * Math.PI * this.beats / BOB_BEATS;
        const dummy = this.cone_dummy;
        dummy.rotation.set(CONE_BASE_ANGLE, this.beats * CONE_SPIN, 0);
        dummy.scale.setScalar(scale);
        this.cone_quat.setFromEuler(dummy.rotation);
        this.cone_scale.setScalar(scale);
        this.cone_cells.forEach(([di, dj, phase], k) => {
            const x = di * CELL, z = dj * CELL;
            const lift = BOB_HEIGHT * (0.5 - 0.5 * Math.cos(bob_angle + phase));
            dummy.position.set(x, -CONE_TIP_Z * scale + lift, z);
            dummy.updateMatrix();
            this.cone_fill.setMatrixAt(k, dummy.matrix);
            const d = Math.hypot(x - bx, z - bz);
            this.cone_edges.set_pos(k, dummy.position);
            this.cone_edges.set_quaternion(k, this.cone_quat);
            this.cone_edges.set_scale(k, this.cone_scale);
            this.cone_edges.set_color(k, CONE_EDGE_COLOR,
                ease(clamp((FOG_FAR - d) / (FOG_FAR - FOG_NEAR), 0, 1)));
        });
        this.cone_fill.count = this.cone_cells.length;
        this.cone_fill.instanceMatrix.needsUpdate = true;
        this.cone_edges.set_num_instances(this.cone_cells.length);
    }

    // Burst plus signs from the brain's centre, at the window's origin.
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

    // The step is done: stand in the next cell, remember it, pick the next
    // step, and re-centre the maze window on the new cell.
    arrive() {
        this.step_prev = this.step;
        this.cell_i += this.step[0];
        this.cell_j += this.step[1];
        const key = `${this.cell_i},${this.cell_j}`;
        this.visits.set(key, (this.visits.get(key) || 0) + 1);
        if (this.visits.size > MAX_REMEMBERED) {
            this.visits.delete(this.visits.keys().next().value);
        }
        this.step = this.choose_step();
        // Turn the short way round from the current facing.
        this.facing_from = this.facing_to;
        let to = this.facing_of(this.step);
        to += Math.round((this.facing_from - to) / (2 * Math.PI)) * 2 * Math.PI;
        this.facing_to = to;
        this.step_start += MOVE_BEATS;
        this.walls.build(this.cell_i, this.cell_j);

        // The window re-centred one cell on: keep the sparks where they were.
        for (const spark of this.sparks) {
            spark.position.x -= this.step_prev[0] * CELL;
            spark.position.z -= this.step_prev[1] * CELL;
        }
        // Eat any cone here.
        if (this.has_cone(this.cell_i, this.cell_j)) {
            this.collected.add(key);
            if (this.collected.size > MAX_COLLECTED) {
                this.collected.delete(this.collected.values().next().value);
            }
            this.brain.flash();
            this.spawn_sparks();
        }
        this.list_cones();
    }

    // Whether cell (i, j) holds an uneaten cone.
    has_cone(i, j) {
        return this.maze.cell_random(i, j) < CONE_P && !this.collected.has(`${i},${j}`);
    }

    // The way on from the current cell: towards the nearest cone in sight
    // (see SIGHT_CELLS), else by the rule at MOVE_BEATS.
    choose_step() {
        let nearest = SIGHT_CELLS + 1;
        let toward = null;
        for (const dir of MAZE_DIRS) {
            let i = this.cell_i, j = this.cell_j;
            for (let k = 1; k < nearest && this.maze.open(i, j, dir[0], dir[1]); k++) {
                i += dir[0];
                j += dir[1];
                if (this.has_cone(i, j)) {
                    nearest = k;
                    toward = dir;
                }
            }
        }
        if (toward !== null) {
            return toward;
        }
        const [pi, pj] = this.step;
        const hx = Math.cos(this.heading), hz = Math.sin(this.heading);
        let best = null;
        let best_score = -Infinity;
        for (const allow_back of [false, true]) {
            for (const dir of MAZE_DIRS) {
                const [di, dj] = dir;
                if (!this.maze.open(this.cell_i, this.cell_j, di, dj)) {
                    continue;
                }
                if (!allow_back && di == -pi && dj == -pj) {
                    continue;
                }
                const visits = this.visits.get(`${this.cell_i + di},${this.cell_j + dj}`) || 0;
                const score = di * hx + dj * hz - VISIT_PENALTY * visits + JITTER * Math.random();
                if (score > best_score) {
                    best_score = score;
                    best = dir;
                }
            }
            if (best !== null) {
                return best;
            }
        }
        return [0, 0];      // walled in on all sides: can't happen in this maze
    }

    // The brain's yaw (rad) to face along step (the model's front is +z).
    facing_of([di, dj]) {
        return Math.atan2(di, dj);
    }

    handle_beat(t, channel) {
        if (channel == 1) {
            setTimeout(() => {
                this.brain.start_scan();
            }, this.get_beat_delay(t) * 1000);
        }
    }
}
