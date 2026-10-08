import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene } from './scene.js';
import {
    CH_EXPAND_X, CH_EXPAND_Y, CH_ROT_X, CH_ROT_Y, knob_with_zero_zone
} from '../controller_map.js';
import { SteppedRotation, ISOMETRIC_PITCHES } from '../stepped_rotation.js';
import {
    lerp_scalar,
    ease,
    clamp,
    rand_int,
    create_instanced_cube_templates,
    BeatClock
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';


// Wireframe opacity [0, 1] for the robots at the middle edges of the grid; the
// center robot stays at 1.0 and opacity falls off linearly with distance
// (clamped to 0, so the far corners fade out completely).
// 0.15 keeps the mid-edge robots just visible against the black background.
const EDGE_WIREFRAME_OPACITY = 0.15;

// Robot grid spacing in scene units at full knob travel (the scene's original
// spacing: robots ~5 units wide sit just clear of each other).
const MAX_SPREAD = 8;

// Nominal grid yaw / camera pitch rate in rad/s; knobs 8/9 scale it to
// [-2, 2] x this. The scene's original drift speed (a 45 deg step every ~8 s).
const NOM_ROT_RATE = 0.1;

// Robot-local geometry (y up, robot faces +z), in scene units. The torso
// center sits BODY_BASE_Y above the robot origin; arms and shoes hang off the
// torso, so the body bob shifts every part (the shoes ride the bob too).
const ARM_BASE_Y = 0.0;             // arm center y, relative to torso center
const BODY_BASE_Y = 1.0;            // torso center y, relative to robot origin
const FOOT_BASE_Y = -3.0;           // shoe center y, relative to torso center
const FOOT_BASE_Z = 0.0;            // shoe center z, relative to torso center
const THROW_HEIGHT = 8.0;           // peak spinner height above the arm mid-throw
const THROW_MOVEMENT_BEATS = 4;     // beats a full spinner throw arc takes

// The robot hierarchy (torso -> head -> eyes, torso -> arm -> spinner) is
// flattened into per-instance transforms so the whole grid of robots renders
// from one InstancedGeometryCollection (same approach as
// components/yellow_robot.js). Instance index = robot * MAX + part.
const CubeParts = {
    TORSO: 0,
    HEAD: 1,
    EYES: 2,
    ARMS: [3, 4],       // left, right
    SPINNERS: [5, 6],   // left, right
    MAX: 7
};

// Static per-part instance scale (= cube dims), indexed by CubeParts.
const CUBE_SCALES = [
    new THREE.Vector3(4, 2, 2),             // torso
    new THREE.Vector3(3, 1, 2),             // head
    new THREE.Vector3(2.0, 0.25, 0.25),     // eyes
    new THREE.Vector3(0.5, 1.0, 3.0),       // arms
    new THREE.Vector3(0.5, 1.0, 3.0),
    new THREE.Vector3(0.5, 0.5, 5.0),       // spinners
    new THREE.Vector3(0.5, 0.5, 5.0)
];

// Beat channels that flash a visor: the Analog Rytm's closed (9) and open (10)
// hi-hat tracks, as in the ice cream / bg surfaces scenes.
const HIHAT_CHANNELS = [9, 10];
// Beats a hi-hat visor flash takes to dither back out from solid white.
const VISOR_FLASH_BEATS = 1;
// Only robots at least this opaque (wireframe opacity, see
// EDGE_WIREFRAME_OPACITY) are picked to flash, so hits land where they show.
const VISOR_FLASH_MIN_OPACITY = 0.3;
// Ambient light intensity for the visor fills, the scene's only lit geometry.
// The Lambert fill reflects intensity / pi, and the dither chunk (output x2,
// threshold 1 on luma = 1.73 x grey) needs grey >= 0.58 to render every pixel,
// so 2.0 (grey 0.64) makes a full flash solid white.
const VISOR_LIGHT_INTENSITY = 2.0;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);
const WHITE = new THREE.Color('white');


export class SpinningRobotsScene extends Scene {
    constructor(context) {
        super(context);

        // Knob 8 sets the grid's yaw rate, knob 9 the camera's pitch rate
        // (negated to match the knob's direction), shown in eased steps: yaw
        // every 45 deg, pitch only between isometric views (+-35.26 deg
        // either side of the horizontal).
        this.yaw = new SteppedRotation(NOM_ROT_RATE);
        this.yaw.bind(this, CH_ROT_Y);
        this.pitch = new SteppedRotation(NOM_ROT_RATE, { stops: ISOMETRIC_PITCHES });
        this.pitch.bind(this, CH_ROT_X, -1);

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
        this.base_group = new THREE.Group();

        this.robots_per_side = 12;

        // Grid spacing along x / z, driven live by MIDI knobs 3 and 4 like
        // the yellow robot grid; starts at the scene's original spacing. The
        // bottom of each knob's travel is exactly 0, collapsing that axis so
        // the robots overlap perfectly.
        this.spread_x = MAX_SPREAD;
        this.spread_y = MAX_SPREAD;
        this.bind(CH_EXPAND_X, (v) => { this.spread_x = v; },
            knob_with_zero_zone(MAX_SPREAD));
        this.bind(CH_EXPAND_Y, (v) => { this.spread_y = v; },
            knob_with_zero_zone(MAX_SPREAD));

        // Per-robot statics, in the same (i, j) row-major order as the
        // instance layout below.
        this.grid_coords = [];      // unit grid coords, centered; the live
                                    // spread_x/spread_y scale them per frame
        this.robot_alphas = [];     // wireframe opacity, fading toward the edges
        this.spinner_phases = [];   // spin phase, so the grid shimmers instead
                                    // of strobing in unison

        const half_side = (this.robots_per_side - 1) / 2;
        // Center to mid-edge distance: dist_from_center_norm reaches 1 at the
        // middle of each grid edge and overshoots at the corners.
        const edge_dist = Math.max(half_side, 1e-6);
        for (let i = 0; i < this.robots_per_side; i++) {
            for (let j = 0; j < this.robots_per_side; j++) {
                this.grid_coords.push(new THREE.Vector2(
                    i - half_side, j - half_side));
                const dist_from_center_norm = Math.hypot(i - half_side, j - half_side) / edge_dist;
                this.robot_alphas.push(clamp(
                    lerp_scalar(1.0, EDGE_WIREFRAME_OPACITY, dist_from_center_norm), 0, 1));
                this.spinner_phases.push(Math.PI / 8 * (i + j));
            }
        }
        const num_robots = this.grid_coords.length;

        // Robot-local cube centers, refilled by compute_robot_pose each frame
        // and shared by every robot (only spinner rotation/color are per-robot).
        this.pose = [];
        for (let k = 0; k < CubeParts.MAX; k++) {
            this.pose.push(new THREE.Vector3());
        }
        this.compute_robot_pose(0, 0);

        // All body cubes of all robots draw from one wireframe collection.
        const [cube_wire_template, cube_fill_template] =
            create_instanced_cube_templates(1, 1, 1);
        this.inst_cubes = new InstancedGeometryCollection(
            this.base_group, cube_wire_template, 'Lines',
            num_robots * CubeParts.MAX);

        const tmp = new THREE.Vector3();
        for (let r = 0; r < num_robots; r++) {
            const gc = this.grid_coords[r];
            for (let k = 0; k < CubeParts.MAX; k++) {
                const p = this.pose[k];
                tmp.set(p.x + gc.x * this.spread_x, p.y,
                    p.z + gc.y * this.spread_y);
                this.inst_cubes.create_geom(tmp, WHITE, CUBE_SCALES[k], null,
                    this.robot_alphas[r]);
            }
        }

        // Visor fills: one solid box per robot over its eyes, shown (non-zero
        // scale) only while a hi-hat flash is fading. visor_flash holds each
        // robot's remaining flash in [0, 1], 1 = just hit.
        this.visor_fills = new InstancedGeometryCollection(
            this.base_group, cube_fill_template, 'Triangles', num_robots);
        for (let r = 0; r < num_robots; r++) {
            this.visor_fills.create_geom(tmp, WHITE, ZERO_SCALE);
        }
        this.visor_flash = new Float32Array(num_robots);
        this.visor_color = new THREE.Color();
        this.flashable_robots = [];
        for (let r = 0; r < num_robots; r++) {
            if (this.robot_alphas[r] >= VISOR_FLASH_MIN_OPACITY) {
                this.flashable_robots.push(r);
            }
        }
        this.base_group.add(new THREE.AmbientLight('white', VISOR_LIGHT_INTENSITY));

        // Shoes: the STL's edges instanced as lines, wireframe-only like the
        // body cubes. Stays null until the mesh loads; instance index =
        // robot * 2 + side.
        this.shoe_wires = null;
        const loader = new STLLoader();
        loader.load('stl/shoe.stl',
            (geometry) => {
                // Bake the mesh-local transform (the STL is mm-scale and
                // z-up) into the templates so instances only carry a position.
                geometry.scale(0.01, 0.01, 0.01);
                geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(
                    new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2)));
                const edges = new THREE.EdgesGeometry(geometry, 30);

                this.shoe_wires = new InstancedGeometryCollection(
                    this.base_group, edges, 'Lines', num_robots * 2);

                const shoe_pos = new THREE.Vector3();
                for (let r = 0; r < num_robots; r++) {
                    const gc = this.grid_coords[r];
                    for (let side = 0; side < 2; side++) {
                        shoe_pos.set(
                            1.5 * (2 * side - 1) + gc.x * this.spread_x,
                            BODY_BASE_Y + FOOT_BASE_Y,
                            FOOT_BASE_Z + gc.y * this.spread_y);
                        this.shoe_wires.create_geom(shoe_pos, WHITE, UNIT_SCALE,
                            null, this.robot_alphas[r]);
                    }
                }
            },
            (xhr) => { },
            (error) => {
                console.log(error);
            }
        );

        this.add(this.base_group);

        this.clock = new THREE.Clock(true);
        this.half_beat_clock = new BeatClock(this);
        this.throw_clock = new BeatClock(this);

        this.spinner_angle = 0;     // accumulated spinner rotation, radians
        this.spinner_quat = new THREE.Quaternion();
        this.spinner_color = new THREE.Color();
        this.tmp_vec = new THREE.Vector3();

        // Knob CH_ZOOM scales the camera zoom (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        this.base_group.rotation.y = this.yaw.update(dt);
        this.camera.rotation.x = this.pitch.update(dt);

        const half_beat_time = this.half_beat_clock.getElapsedBeats() / 2.0;
        const throw_time = this.throw_clock.getElapsedBeats();

        this.compute_robot_pose(half_beat_time, throw_time);
        this.spinner_angle += Math.PI * dt * beats_per_sec;

        // Every robot shuffles in lockstep: one offset per side per frame.
        const shuffles = [
            this.get_foot_shuffle_offset(0, half_beat_time),
            this.get_foot_shuffle_offset(1, half_beat_time)
        ];
        const torso_y = this.pose[CubeParts.TORSO].y;

        // Spread can change live (MIDI knobs), so grid positions are laid
        // out every frame.
        const visor_decay = dt * beats_per_sec / VISOR_FLASH_BEATS;
        const tmp = this.tmp_vec;
        for (let r = 0; r < this.grid_coords.length; r++) {
            const gc = this.grid_coords[r];
            const gx = gc.x * this.spread_x;
            const gz = gc.y * this.spread_y;
            const base = r * CubeParts.MAX;
            for (let k = 0; k < CubeParts.MAX; k++) {
                const p = this.pose[k];
                tmp.set(p.x + gx, p.y, p.z + gz);
                this.inst_cubes.set_pos(base + k, tmp);
            }

            // A flashing visor tracks the eyes and dithers from solid white
            // to black, then hides (zero scale) once the flash is spent.
            if (this.visor_flash[r] > 0) {
                const flash = Math.max(0, this.visor_flash[r] - visor_decay);
                this.visor_flash[r] = flash;
                const eyes = this.pose[CubeParts.EYES];
                tmp.set(eyes.x + gx, eyes.y, eyes.z + gz);
                this.visor_fills.set_pos(r, tmp);
                this.visor_fills.set_scale(r,
                    flash > 0 ? CUBE_SCALES[CubeParts.EYES] : ZERO_SCALE);
                this.visor_color.setScalar(ease(flash) * this.robot_alphas[r]);
                this.visor_fills.set_color(r, this.visor_color);
            }

            // Spinners spin about x and slowly cycle hue with their angle.
            const angle = this.spinner_angle + this.spinner_phases[r];
            this.spinner_quat.setFromAxisAngle(X_AXIS, angle);
            this.spinner_color.setHSL(Math.sin(angle / 32), 1, 0.5);
            for (const k of CubeParts.SPINNERS) {
                this.inst_cubes.set_quaternion(base + k, this.spinner_quat);
                this.inst_cubes.set_color(base + k, this.spinner_color,
                    this.robot_alphas[r]);
            }

            if (this.shoe_wires !== null) {
                for (let side = 0; side < 2; side++) {
                    tmp.set(1.5 * (2 * side - 1) + gx,
                        torso_y + FOOT_BASE_Y + shuffles[side][1],
                        FOOT_BASE_Z + shuffles[side][2] + gz);
                    this.shoe_wires.set_pos(2 * r + side, tmp);
                }
            }
        }
    }

    // Fill this.pose with robot-local cube centers for the shared dance pose:
    // half_beat_time is normalized time since the half-note beat, throw_time
    // beats since the last spinner throw (both from the scene's BeatClocks).
    compute_robot_pose(half_beat_time, throw_time) {
        const body_offset = this.get_body_shuffle_offset(half_beat_time);
        const arms_offset = this.get_arms_pump_offset(half_beat_time);

        // Parabolic throw arc: 0 at the ends, THROW_HEIGHT at the midpoint.
        const throw_frac = clamp(throw_time / THROW_MOVEMENT_BEATS, 0, 1);
        const cur_throw_y = THROW_HEIGHT * (1 - (2 * throw_frac - 1) ** 2);

        const torso_y = BODY_BASE_Y + body_offset;
        this.pose[CubeParts.TORSO].set(0, torso_y, 0);
        this.pose[CubeParts.HEAD].set(0, torso_y + 2.5, 0);
        this.pose[CubeParts.EYES].set(0, torso_y + 2.5, 1.125);
        for (let side = 0; side < 2; side++) {
            const sign = 2 * side - 1;      // -1 left, +1 right
            const arm_y = torso_y + ARM_BASE_Y + arms_offset;
            this.pose[CubeParts.ARMS[side]].set(sign * 2.25, arm_y, 1.5);
            this.pose[CubeParts.SPINNERS[side]].set(
                sign * 2.75, arm_y + cur_throw_y, 2.75);
        }
    }

    get_foot_shuffle_offset(side_idx, t) {
        // get shuffle offset for this side as an array [x, y, z]
        // side_idx: 0 for left, 1 for right
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            [0, ease(Math.min(1, dt / t_mov)), ease(Math.min(0, -1 + dt / t_mov))],
            [0, ease(Math.max(0, 1 - dt / t_mov)), ease(Math.min(1, dt / t_mov))],
            [0, 0, ease(Math.max(0, 1 - dt / t_mov))],
            [0, 0, ease(Math.max(-1, -dt / t_mov))]];
        const pos_idx = (Math.floor(t / t_period) + 2 * side_idx) % position_options.length;
        return position_options[pos_idx];
    }

    get_body_shuffle_offset(t) {
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            ease(Math.min(1, dt / t_mov)),
            ease(Math.max(0, 1 - dt / t_mov))];
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.8;
    }

    get_arms_pump_offset(t) {
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            ease(Math.min(1, dt / t_mov)),
            ease(Math.max(0, 1 - dt / t_mov))];
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.6;
    }

    handle_sync(t, bpm, beat) {
        if (beat % 2 == 0) {
            // half-note beat
            this.half_beat_clock.start(this.get_local_bpm());
        }
        if (beat % 16 == 0) {
            this.throw_clock.start(this.get_local_bpm());
        }
    }

    handle_beat(t, channel) {
        if (HIHAT_CHANNELS.includes(channel)) {
            setTimeout(() => {
                const pick = rand_int(0, this.flashable_robots.length);
                this.visor_flash[this.flashable_robots[pick]] = 1;
            }, this.get_beat_delay(t) * 1000);
        }
    }
}
