import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene } from './scene.js';
import { LightningStrike } from '../lightning_strike.js';
import { ContourScan } from '../components/contour_scan.js';
import { SteppedRotation, ISOMETRIC_TILT, STEPPED_SCALE } from '../stepped_rotation.js';
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
    BeatClock,
    Spark,
    ObjectPool,
} from '../util.js';

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

// The brain is drawn as a scan (see ContourScan). Contour spacing, model
// units: the brain is ~160 tall, so ~27 slices. Contours scroll up this many
// slices per beat. Each kick sweeps a scan contour up the brain over
// SCAN_BEATS, lighting the contours below it over SCAN_TRAIL model units.
// Contours on faces turned away from the viewer are BRAIN_BACK_GAIN as
// bright (with the black fill in front, only visible at the silhouette).
const SLICE_SPACING = 6;
const SLICE_SCROLL_PER_BEAT = 0.25;
const SCAN_BEATS = 1;
const SCAN_TRAIL = 30;
const BRAIN_BACK_GAIN = 0.35;
const BRAIN_LINE_COLOR = new THREE.Color('cyan');
// The brain's solid fill under the contours: lit and dithered like the
// cones, dark enough that the contours stay the brightest thing on it.
const BRAIN_FILL_COLOR = new THREE.Color(0.0, 0.25, 0.25);
// The fill only occupies every other band between contours (the bands
// scroll with them); each solid band's cut faces are drawn flat in this
// colour, a touch brighter than the shaded sides so they read as cut faces.
const BRAIN_CAP_COLOR = new THREE.Color(0.0, 0.35, 0.35);
const BRAIN_SCAN_COLOR = new THREE.Color('white');

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

        this.scan_clock = new BeatClock(this);
        this.scan_running = false;
        this.brain = null;          // ContourScan, once loaded
        // Model units the contours have scrolled up, wrapping every two
        // bands so the solid/empty bands never swap at the wrap.
        this.slice_offset = 0;
        this.brain_fill_uniforms = {
            slice_offset: { value: 0 },
            slice_spacing: { value: SLICE_SPACING },
            cap_color: { value: BRAIN_CAP_COLOR },
        };
        this.scan_height = 0;       // model units

        // Holds the brain, its sparks and the lights, lifted over the
        // grid's centre.
        this.brain_group = new THREE.Group();
        this.brain_group.position.y = BRAIN_LIFT;
        this.base_group.add(this.brain_group);
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

        const brain_loader = new STLLoader();
        const brain_load_promise = brain_loader.loadAsync('stl/brain.stl');

        Promise.all([shader_load_promise, cone_load_promise, brain_load_promise]).then(
            ([[dither_pars, dither], cone_geom, brain_geom]) => {
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

                // Solid fill behind the contours, hiding the far side's, in
                // every other band between them (see BRAIN_CAP_COLOR).
                // Pushed back so the near contours, which lie exactly on its
                // surface, pass the depth test. Caps without a stencil
                // buffer: the fill is double-sided, so looking into a cut
                // band shows the inside of its far wall, and those back faces
                // drawn flat in the cap colour read as the band's solid top
                // or bottom (a flat face under a flat colour).
                const brain_fill_mat = new THREE.MeshLambertMaterial({
                    color: BRAIN_FILL_COLOR,
                    side: THREE.DoubleSide,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 1,
                });
                brain_fill_mat.onBeforeCompile = (shader) => {
                    dither_shading(shader);
                    Object.assign(shader.uniforms, this.brain_fill_uniforms);
                    shader.vertexShader = shader.vertexShader.replace(
                        '#include <common>',
                        'varying float v_height;\n#include <common>'
                    ).replace(
                        '#include <begin_vertex>',
                        '#include <begin_vertex>\nv_height = position.y;'
                    );
                    shader.fragmentShader = shader.fragmentShader.replace(
                        'void main() {',
                        'uniform float slice_offset;\nuniform float slice_spacing;\n' +
                        'uniform vec3 cap_color;\nvarying float v_height;\nvoid main() {\n' +
                        'if (mod(floor((v_height - slice_offset) / slice_spacing), 2.0) > 0.5) discard;'
                    ).replace(
                        '#include <opaque_fragment>',
                        '#include <opaque_fragment>\nif (!gl_FrontFacing) gl_FragColor.rgb = cap_color;'
                    );
                };
                const brain_fill = new THREE.Mesh(brain_geom, brain_fill_mat);
                this.brain_group.add(brain_fill);

                this.brain = new ContourScan(brain_geom, {
                    spacing: SLICE_SPACING,
                    line_color: BRAIN_LINE_COLOR,
                    scan_color: BRAIN_SCAN_COLOR,
                    back_gain: BRAIN_BACK_GAIN,
                    trail: SCAN_TRAIL,
                });
                // Underside on brain_group's origin.
                for (const obj of [brain_fill, this.brain]) {
                    obj.scale.setScalar(BRAIN_SCALE);
                    obj.position.y = -this.brain.min_y * BRAIN_SCALE;
                }
                this.brain_group.add(this.brain);
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


        const spark_constructor = () => { return new Spark(0.5, "white", [0, 1], false, true); };
        this.spark_pool = new ObjectPool(spark_constructor, 4);

        this.spark_pool.position.y = 8;
        this.brain_group.add(this.spark_pool);

        // The shared view rotation in eased steps (see YAW_BASE).
        this.yaw = new SteppedRotation();
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
        this.update_brain_scan(dt * beats_per_sec);
        this.base_group.rotation.y = YAW_BASE + this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));

        this.spark_pool.foreach((spark) => { spark.anim_frame(dt, this.camera); });
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

    // Scroll the brain's contours by d_beats, move any running scan, and
    // recut the contours.
    update_brain_scan(d_beats) {
        this.slice_offset = (this.slice_offset
            + d_beats * SLICE_SCROLL_PER_BEAT * SLICE_SPACING) % (2 * SLICE_SPACING);
        this.brain_fill_uniforms.slice_offset.value = this.slice_offset;
        if (this.brain === null) {
            return;
        }
        let strength = 0;
        if (this.scan_running) {
            const frac = this.scan_clock.getElapsedBeats() / SCAN_BEATS;
            this.scan_running = frac < 1;
            // Rises with eased motion; fades over the last quarter so the
            // glow left at the top doesn't cut out.
            this.scan_height = lerp_scalar(this.brain.min_y, this.brain.max_y,
                ease(clamp(frac, 0, 1)));
            strength = clamp((1 - frac) * 4, 0, 1);
        }
        this.brain.update(this.slice_offset, this.scan_height, strength);
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay();
        setTimeout(() => {
            if (channel == 1) {
                this.waves.push(this.beats);
                this.scan_clock.start();
                this.scan_running = true;
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
        const spark = this.spark_pool.get_pool_object();
        spark.active = true;
        spark.position.copy(pos);
        spark.velocity = vel;
        spark.acceleration.set(0, 0, 0);
        spark.material.color.set("white");
    }
}
