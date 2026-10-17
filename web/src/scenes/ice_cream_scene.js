import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene } from './scene.js';
import { LightningStrike } from '../lightning_strike.js';
import { ScannedBrain } from '../components/scanned_brain.js';
import { ISOMETRIC_TILT } from '../stepped_rotation.js';
import { CH_EXPAND_Y } from '../controller_map.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import {
    lerp_scalar,
    ease,
    rand_int,
    clamp,
    arr_eq,
    create_instanced_cube,
    make_wireframe_cylinder,
    make_wireframe_circle,
    ShaderLoader,
    Spark,
} from '../util.js';
import { SparkPool } from '../components/spark_pool.js';

// Rotation (rad): yaw in lockstep with the other stepped scenes (see
// stepped_rotation.js), every 45 deg from a diagonal base; pitch locked at
// the isometric tilt, looking down on the grid.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;
// The brain floats over the middle of the cone grid: its scale (model units
// to world units; ~13 tall), and the height of its underside above the
// grid's plane, world units, clear of the spinning cones (~3 in radius).
const BRAIN_SCALE = 0.08;
const BRAIN_LIFT = 0;
// The cone grid is endless: the brain stays centred while a window of
// CONES_PER_SIDE^2 cones (odd, so one sits under the brain), CONE_SPACING
// world units apart, slides beneath it, re-centring by whole cells. Cones
// fade out with distance from the brain through the dither, from
// CONE_FADE_NEAR to CONE_FADE_FAR world units; the far end stays a cell
// inside the window's edge, so no cone pops in or out as it re-centres.
const CONES_PER_SIDE = 15;
const CONE_SPACING = 7;
const CONE_SCALE = 0.25;
const CONE_COLOR = new THREE.Color('orange');
// Every cone is outlined in this: all the model's facet edges (it has ~18
// deg between facets, so a crease angle any higher keeps only its rims).
const CONE_EDGE_COLOR = new THREE.Color('orange');
const CONE_EDGE_ANGLE = 1;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const CONE_FADE_NEAR = 2 * CONE_SPACING;
const CONE_FADE_FAR = ((CONES_PER_SIDE - 1) / 2 - 1) * CONE_SPACING;
// The brain drifts over the grid at DRIFT_SPEED world units per beat. Its
// heading is knob 4's (CH_EXPAND_Y), mapped as gantry maps its next-target
// direction: a full turn over the knob's travel, from +x towards +z;
// DEFAULT_DRIFT_ANGLE until the knob moves.
const DRIFT_SPEED = 2;
const DEFAULT_DRIFT_ANGLE = Math.PI / 4;
// The only lights, both riding with the brain: one above it and a weaker
// one below, in brain_group's frame (origin at the brain's underside, which
// is ~13 tall). Decay 1 lets them spread a soft pool over the nearby cones.
const TOP_LIGHT_POS = new THREE.Vector3(0, 18, 0);
const TOP_LIGHT_INTENSITY = 20;
const BOTTOM_LIGHT_POS = new THREE.Vector3(0, -10, 0);
// Dim, for an eerie glow from underneath.
const BOTTOM_LIGHT_INTENSITY = 0;
const LIGHT_DECAY = 1;
// Cones all stand the same way up (rotation about x, rad; the model's long
// axis is z). Each kick sends a wave of half-turn flips out from under the
// brain: it travels WAVE_SPEED world units per beat (reaching the faded edge,
// CONE_FADE_FAR ~42 out, in under a beat and a half), and each cone takes
// FLIP_BEATS to turn over, eased (soft start and stop), so neighbours overlap
// into a rolling ripple. A whole beat lets the easing read; with a kick every
// beat, a cone can still be turning when the next wave reaches it, and the
// two flips simply add.
const CONE_BASE_ANGLE = -Math.PI / 2;
const WAVE_SPEED = 30;
const FLIP_BEATS = 1;
// The whole composition is lowered this far on screen, world units, so the
// raised brain sits near the middle rather than the grid's centre.
const VIEW_DROP = -4;

export class IceCreamScene extends Scene {
    constructor(context) {
        super(context, 'ice-cream');


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
        this.cones = null;          // InstancedMesh, once loaded
        this.cone_dummy = new THREE.Object3D();     // composes instance matrices
        // Where the brain is over the grid, world units (x, z).
        this.drift_x = 0;
        this.drift_z = 0;
        this.drift_angle = DEFAULT_DRIFT_ANGLE;
        this.bind(CH_EXPAND_Y, (a) => { this.drift_angle = a; },
            (norm) => norm * 2 * Math.PI);
        // Flip waves: beats elapsed (at the live bpm) while shown, the start
        // times of waves still passing through the grid, oldest first, and
        // how many have passed every cone (mod 2: a cone's settled facing).
        this.beats = 0;
        this.waves = [];
        this.settled_flips = 0;

        // Holds the brain, its sparks and the lights, lifted over the
        // grid's centre.
        this.brain_group = new THREE.Group();
        this.brain_group.position.y = BRAIN_LIFT;
        this.base_group.add(this.brain_group);
        this.brain = new ScannedBrain(BRAIN_SCALE);
        this.brain_group.add(this.brain);
        for (const [pos, intensity] of [[TOP_LIGHT_POS, TOP_LIGHT_INTENSITY],
                [BOTTOM_LIGHT_POS, BOTTOM_LIGHT_INTENSITY]]) {
            const light = new THREE.PointLight('white', intensity, 0, LIGHT_DECAY);
            light.position.copy(pos);
            this.brain_group.add(light);
        }

        const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = shader_loader.load();

        const cone_loader = new STLLoader();
        const cone_load_promise = cone_loader.loadAsync('stl/ice-cream-cone.stl');

        Promise.all([shader_load_promise, cone_load_promise]).then(
            ([[dither_pars, dither], cone_geom]) => {
                // Shade through the house dither instead of smooth gradients.
                const dither_shading = (shader) => {
                    shader.fragmentShader =
                        shader.fragmentShader.replace(
                            '#include <dithering_pars_fragment>',
                            dither_pars
                        ).replace(
                            '#include <dithering_fragment>',
                            dither
                        );
                };

                // Cones: opaque, so depth sorts them, with each one's fade
                // (an instance attribute) dissolving it through the dither.
                const num_cones = CONES_PER_SIDE * CONES_PER_SIDE;
                const cone_inst_geom = cone_geom.clone();
                this.cone_alphas = new THREE.InstancedBufferAttribute(
                    new Float32Array(num_cones), 1);
                this.cone_alphas.setUsage(THREE.DynamicDrawUsage);
                cone_inst_geom.setAttribute('instance_alpha', this.cone_alphas);
                // Pushed back so the edges, which lie on its surface, draw.
                const cone_mat = new THREE.MeshLambertMaterial({
                    color: CONE_COLOR,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 1,
                });
                cone_mat.onBeforeCompile = (shader) => {
                    dither_shading(shader);
                    shader.vertexShader = shader.vertexShader.replace(
                        '#include <common>',
                        'attribute float instance_alpha;\nvarying float v_alpha;\n#include <common>'
                    ).replace(
                        '#include <begin_vertex>',
                        '#include <begin_vertex>\nv_alpha = instance_alpha;'
                    );
                    shader.fragmentShader = shader.fragmentShader.replace(
                        'void main() {',
                        'varying float v_alpha;\nvoid main() {\n' +
                        'if (dither4x4(gl_FragCoord.xy, v_alpha) < 0.5) discard;'
                    );
                };
                this.cones = new THREE.InstancedMesh(cone_inst_geom, cone_mat, num_cones);
                // Their outlines, one batch, fading with the fills (blended,
                // so they fade smoothly); only cones not faded out are drawn.
                this.cone_edges = new InstancedGeometryCollection(this.base_group,
                    new THREE.EdgesGeometry(cone_geom, CONE_EDGE_ANGLE), 'Lines', num_cones);
                const edge_scale = new THREE.Vector3().setScalar(CONE_SCALE);
                for (let k = 0; k < num_cones; k++) {
                    this.cone_edges.create_geom(new THREE.Vector3(), CONE_EDGE_COLOR, edge_scale);
                }
                this.cone_quat = new THREE.Quaternion();
                // Beats for a wave to cross the window and finish flipping.
                const window_radius = Math.SQRT2 * (CONES_PER_SIDE + 1) / 2 * CONE_SPACING;
                this.wave_beats = window_radius / WAVE_SPEED + FLIP_BEATS;
                this.update_cones();
                this.base_group.add(this.cones);
        });

        this.lightning_strike_meshes = [];
        this.lightningColor = new THREE.Color("lightblue"); //new THREE.Color( 0xB0FFFF );
        this.lightningMaterial = new THREE.MeshBasicMaterial( { color: this.lightningColor, opacity: 0.25, transparent: true } );
        this.lightning_strikes = [];
        this.lightning_strike_meshes = [];

        this.ray_params = [];
        this.ray_dest_offset_scale = 5.0;

        this.ray_params_base = {
            sourceOffset: new THREE.Vector3(),
            destOffset: new THREE.Vector3(),
            radius0: 0.30,
            radius1: 0.15,
            minRadius: 0.05,
            maxIterations: 7,
            isEternal: true,

            timeScale: 0.3,

            propagationTimeFactor: 0.05,
            vanishingTimeFactor: 0.95,
            subrayPeriod: 3.5,
            subrayDutyCycle: 0.6,
            maxSubrayRecursion: 3,
            ramification: 7,
            recursionProbability: 0.3,

            roughness: 0.85,
            straightness: 0.4
        };


        // Sparks (SparkPool, toggling with the hi-hats).
        this.spark_pool = new SparkPool(this, () => new Spark(0.5, "white", [0, 1], false, true), 4);

        this.spark_pool.position.y = 8;
        this.brain_group.add(this.spark_pool);

        // The shared stepped view (see YAW_BASE), pitch locked at the tilt:
        // it holds the shared pitch there while it shows.
        this.stepped_pitches = [PITCH_BASE];
        this.base_group.rotation.x = PITCH_BASE;
        this.base_group.rotation.y = YAW_BASE;
        this.base_group.position.y = VIEW_DROP;
        this.add(this.base_group);

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        this.beats += dt * beats_per_sec;
        const drift = dt * beats_per_sec * DRIFT_SPEED;
        this.drift_x += drift * Math.cos(this.drift_angle);
        this.drift_z += drift * Math.sin(this.drift_angle);
        this.update_cones();
        this.brain.update(dt * beats_per_sec);
        this.base_group.rotation.x = this.stepped_pitch();
        this.base_group.rotation.y = YAW_BASE + this.stepped_yaw();

        this.spark_pool.anim_frame(dt);
    }

    // Write every cone in the window: its cell's position relative to the
    // brain, standing at CONE_BASE_ANGLE, turned half a turn for each wave
    // that has passed it and part way through any it is in, and its fade.
    // All a function of the cell's position and the time, so cells keep
    // their state as the window re-centres.
    update_cones() {
        if (this.cones === null) {
            return;
        }
        // Waves that have passed every cone settle into the base facing.
        while (this.waves.length > 0 && this.beats - this.waves[0] >= this.wave_beats) {
            this.waves.shift();
            this.settled_flips = (this.settled_flips + 1) % 2;
        }
        const dummy = this.cone_dummy;
        dummy.scale.setScalar(CONE_SCALE);
        const half = (CONES_PER_SIDE - 1) / 2;
        const col0 = Math.round(this.drift_x / CONE_SPACING) - half;
        const row0 = Math.round(this.drift_z / CONE_SPACING) - half;
        let k = 0;
        let n_edges = 0;
        for (let i = 0; i < CONES_PER_SIDE; i++) {
            for (let j = 0; j < CONES_PER_SIDE; j++, k++) {
                const x = (col0 + i) * CONE_SPACING - this.drift_x;
                const z = (row0 + j) * CONE_SPACING - this.drift_z;
                const dist = Math.hypot(x, z);
                let flips = this.settled_flips;
                for (const start of this.waves) {
                    flips += ease(clamp(
                        (this.beats - start - dist / WAVE_SPEED) / FLIP_BEATS, 0, 1));
                }
                const angle = CONE_BASE_ANGLE + Math.PI * flips;
                const alpha = ease(clamp(
                    (CONE_FADE_FAR - dist) / (CONE_FADE_FAR - CONE_FADE_NEAR), 0, 1));
                dummy.position.set(x, 0, z);
                dummy.rotation.x = angle;
                dummy.updateMatrix();
                this.cones.setMatrixAt(k, dummy.matrix);
                this.cone_alphas.setX(k, alpha);
                if (alpha > 0) {
                    this.cone_quat.setFromAxisAngle(X_AXIS, angle);
                    this.cone_edges.set_pos(n_edges, dummy.position);
                    this.cone_edges.set_quaternion(n_edges, this.cone_quat);
                    this.cone_edges.set_color(n_edges, CONE_EDGE_COLOR, alpha);
                    n_edges++;
                }
            }
        }
        this.cone_edges.set_num_instances(n_edges);
        this.cones.instanceMatrix.needsUpdate = true;
        this.cone_alphas.needsUpdate = true;
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        this.spark_pool.handle_beat(t, channel);
        const delay = this.get_beat_delay();
        setTimeout(() => {
            if (channel == 1) {
                this.waves.push(this.beats);
                this.brain.start_scan();
            } else if (channel == 9 || channel == 10) {
                for (let i = 0; i < 4; i++) {
                    this.create_spark();
                }
            }
        }, delay * 1000);
    }

    create_spark() {
        const r = 10;
        const theta = rand_int(0, 16) / 16 * 2 * Math.PI;
        const phi = rand_int(0, 16) / 16 * 2 * Math.PI;
        const pos = new THREE.Vector3(r * Math.sin(theta) * Math.cos(phi), r * Math.sin(theta) * Math.sin(phi), r * Math.cos(theta));
        const vel = new THREE.Vector3(0, 0, 0);//pos.clone().normalize().multiplyScalar(5);
        const spark = this.spark_pool.spawn();
        spark.position.copy(pos);
        spark.velocity = vel;
        spark.acceleration.set(0, 0, 0);
        spark.material.color.set("white");
    }
}
