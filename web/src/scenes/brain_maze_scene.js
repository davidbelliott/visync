import * as THREE from 'three';
import { Scene } from './scene.js';
import { ScannedBrain } from '../components/scanned_brain.js';
import { InfiniteMaze, MAZE_DIRS } from '../infinite_maze.js';
import { MazeWalls } from '../components/maze_walls.js';
import { SteppedRotation, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
import { CH_EXPAND_Y } from '../controller_map.js';
import { lerp_scalar, ease, clamp } from '../util.js';

// Rotation (rad): yaw in lockstep with the other stepped scenes (see
// stepped_rotation.js), every 45 deg from a diagonal base; pitch locked at
// the isometric tilt, looking down into the maze. The view pivots on the
// brain's centre, which stays in the middle of the screen.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;
// World units per brain model unit: ~6.5 tall, ~7.6 long, to fit the
// corridors.
const BRAIN_SCALE = 0.04;

// The maze (see InfiniteMaze, MazeWalls), world units: cell pitch, and the
// walls' thickness and height (lower than the brain, so it looks out over
// them). Walls run between posts at the cells' corners, drawn as one solid:
// a lit, dithered fill outlined along its true edges.
const CELL = 10;
const WALL_T = 0.5;
const WALL_H = 4;
const WALL_COLOR = new THREE.Color('orange');
// Fog of war, world units: the walls are lit by nothing but the brain's
// light, whose range ends at FOG_FAR, so they darken to black with distance;
// their edges fade (eased) from FOG_NEAR to FOG_FAR. The maze window drawn
// spans whole cells past FOG_FAR, so nothing pops in.
const FOG_NEAR = 0.5 * CELL;
const FOG_FAR = 3 * CELL;
const WINDOW_HALF = Math.ceil(FOG_FAR / CELL) + 1;     // cells either side

// A translucent black floor under the maze (as in the drum kit scene), dimming
// any scene layered behind this one: its opacity, and its size (world units),
// enough to cover the screen at the widest shared zoom.
const FLOOR_OPACITY = 0.5;
const FLOOR_SIZE = 400;

// The brain walks the maze one cell per MOVE_BEATS, eased from rest to rest
// so each step lands on the beat, turning only at right angles (it faces
// the way it goes, turning over the first TURN_FRACTION of a step). At each
// cell it picks the open way that best follows its heading, never turning
// straight back unless at a dead end, and shunning cells by VISIT_PENALTY
// per earlier visit so it backs out of dead ends and doesn't circle; a
// little JITTER keeps the route from being too predictable.
const MOVE_BEATS = 1;
const TURN_FRACTION = 0.5;
const VISIT_PENALTY = 1.5;
const JITTER = 0.5;
// Cells remembered for VISIT_PENALTY, oldest forgotten first.
const MAX_REMEMBERED = 2048;
// The heading is knob 4's (CH_EXPAND_Y), mapped as gantry maps its
// next-target direction: a full turn over the knob's travel, from +x
// towards +z; DEFAULT_HEADING until the knob moves.
const DEFAULT_HEADING = Math.PI / 4;

// The only light, riding above the brain (in brain_group's frame, origin at
// the brain's underside). Decay 1 for a soft falloff, cut off at FOG_FAR
// (see the fog of war).
const LIGHT_POS = new THREE.Vector3(0, 12, 0);
const LIGHT_INTENSITY = 12;
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
        this.world_group.add(floor);

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

        this.yaw = new SteppedRotation();

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
        const along = ease(frac) * CELL;
        const bx = this.step[0] * along;
        const bz = this.step[1] * along;
        this.maze_group.position.set(-bx, 0, -bz);
        this.brain_group.rotation.y = lerp_scalar(this.facing_from, this.facing_to,
            ease(clamp(frac / TURN_FRACTION, 0, 1)));
        this.world_group.position.y = -this.brain.height / 2;
        this.walls.set_viewer(bx, bz);

        this.brain.update(d_beats);
        this.base_group.rotation.y = YAW_BASE + this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));
    }

    // The step is done: stand in the next cell, remember it, pick the next
    // step, and re-centre the maze window on the new cell.
    arrive() {
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
    }

    // The way on from the current cell (see MOVE_BEATS for the rule).
    choose_step() {
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
            setTimeout(() => this.brain.start_scan(), this.get_beat_delay(t) * 1000);
        }
    }
}
