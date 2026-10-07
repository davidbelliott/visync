import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene } from './scene.js';
import {
    CH_ROT_X, CH_ROT_Y, CH_EXPAND_X, CH_EXPAND_Y, knob_to_rate
} from '../controller_map.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import {
    ease,
    lerp_scalar,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    make_wireframe_cube,
    make_wireframe_cylinder,
    create_instanced_cube,
    make_wireframe_circle,
    create_instanced_cube_templates,
    ShaderLoader,
    Spark,
    ObjectPool,
    BeatClock
} from '../util.js';

// Nominal free-rotation rate in rad/s; knob_to_rate scales it to [-2, 2] x
// this. Chosen to match the old quarter-turn-per-8-beats pace at 120 bpm.
const NOM_ROT_RATE = 0.4;

// Tube geometry resolution: rings along the path x quads around each ring.
// A ring is TUBE_RADIAL quads = TUBE_RADIAL * 6 indices; draw ranges are
// snapped to whole quads (6 indices) so segment ends never split a triangle.
const TUBE_RINGS = 1024;
const TUBE_RADIAL = 32;
const IDX_PER_RING = TUBE_RADIAL * 6;
// Nominal speed of the moving tube segments, in rings/s; knob 4 scales it
// over [-1, 1] x this (centred = stopped). Matches the old fixed 360 indices
// per frame at 60 fps.
const NOM_TUBE_SPEED = 360 * 60 / IDX_PER_RING;
// Visible segment length in rings: the scene's original 9000 indices by
// default; knob 3 sweeps linearly from TUBE_MIN_LEN to TUBE_MAX_LEN. 16 rings
// (~4.6 units, about one tube diameter) keeps the shortest segment a clearly
// visible stub; 768 rings is three quarters of the loop: long, but with a
// gap left so the movement still reads.
const TUBE_DEFAULT_LEN = 9000 / IDX_PER_RING;
const TUBE_MIN_LEN = 16;
const TUBE_MAX_LEN = 768;
// The three tubes' heads start this many rings apart so they never move in
// lockstep (the original 39000-index offsets).
const TUBE_HEAD_SPACING = 39000 / IDX_PER_RING;

// Kick outline tracers (as in the vector field scene): a faded copy of the
// expanding outline is dropped every OUTLINE_TRACER_INTERVAL beats and fades
// out over OUTLINE_TRACER_LIFETIME beats, leaving a short echo trail behind
// the expansion. Beat-relative so the trail spacing scales with tempo.
const OUTLINE_TRACER_INTERVAL = 1 / 32;
const OUTLINE_TRACER_LIFETIME = 1 / 4;
const OUTLINE_TRACER_COUNT =
    Math.ceil(OUTLINE_TRACER_LIFETIME / OUTLINE_TRACER_INTERVAL) + 1;
// Fill point light for the underside, which the key (directional, from +y)
// and the existing point light (above, behind) never reach; both rotate with
// the assembly, so the dark side is always its -y faces. Half the existing
// point light's intensity with the same falloff, placed below and slightly
// off-axis so side faces catch it at different angles and keep their form.
const FILL_LIGHT_INTENSITY = 25;
const FILL_LIGHT_POS = new THREE.Vector3(10, -40, 20);

// Outline cube edge length (scene units) and its peak opacity on the kick.
const OUTLINE_SIZE = 24;
const OUTLINE_OPACITY = 0.8;
const WHITE = new THREE.Color('white');
const ZERO_SCALE = new THREE.Vector3(0, 0, 0);

// A length or position along a tube in rings -> draw-range indices, snapped
// down to a whole quad (6 indices).
function rings_to_draw_idx(rings) {
    return 6 * Math.floor(rings * IDX_PER_RING / 6);
}

// The tube path is a closed loop, so a segment crossing the seam should wrap
// to the start. Repeating the index buffer makes any window
// [start, start + len) with start < one loop and len <= one loop a single
// contiguous draw range.
function repeat_index_twice(geom) {
    const idx = geom.index.array;
    const doubled = new idx.constructor(idx.length * 2);
    doubled.set(idx);
    doubled.set(idx, idx.length);
    geom.setIndex(new THREE.BufferAttribute(doubled, 1));
}

class CustomSinCurve extends THREE.Curve {
    constructor( scale = 1 ) {
            super();
            this.scale = scale;
    }

    getPoint( t, optionalTarget = new THREE.Vector3() ) {
        const seg_idx = Math.floor(t * 8);
        const seg_frac = t * 8 - seg_idx;
        const separation = this.scale / 3;
        const r = separation / 2;
        const arc_frac_of_total_length = Math.PI * r / (Math.PI * r + this.scale);
        const arc_frac = clamp((seg_frac - (1 - arc_frac_of_total_length)) / arc_frac_of_total_length, 0, 1);
        const non_arc_frac = clamp(seg_frac / (1 - arc_frac_of_total_length), 0, 1);
        let tx = (this.scale * non_arc_frac - this.scale / 2) * (-1) ** seg_idx;
        let ty = separation * (seg_idx - 1);
        let tz = -separation;

        const sin_part = (Math.sin(Math.PI * arc_frac) * r) * (-1) ** seg_idx
        const cos_part = (Math.cos(Math.PI * arc_frac) - 1) * r;

        if (seg_idx < 3) {
            tx = (this.scale * non_arc_frac - this.scale / 2) * (-1) ** seg_idx;
            ty = separation * (seg_idx - 1);
            tz = -separation;

            if (arc_frac > 0) {
                if (seg_idx < 2) {
                    tx += sin_part;
                    ty -= cos_part;
                } else {
                    tx += sin_part;
                    tz -= cos_part;
                }
            }
        } else if (seg_idx < 5) {
            tx = (this.scale * non_arc_frac - this.scale / 2) * (-1) ** (seg_idx);
            ty = separation;
            tz = separation * (seg_idx - 3);;

            if (arc_frac > 0) {
                if (seg_idx < 4) {
                    tx += sin_part;
                    tz -= cos_part;
                } else {
                    tx += sin_part;
                    ty += cos_part;
                }
            }
        } else if (seg_idx < 7) {
            tx = (this.scale * non_arc_frac - this.scale / 2) * (-1) ** (seg_idx);
            ty = -(seg_idx - 5) * separation;
            tz = separation;

            if (arc_frac > 0) {
                if (seg_idx < 6) {
                    tx += sin_part;
                    ty += cos_part;
                } else {
                    tx += sin_part;
                    tz += cos_part;
                }
            }
        }else if (seg_idx <= 8) {
            tx = (this.scale * non_arc_frac - this.scale / 2) * (-1) ** (seg_idx);
            ty = -separation;
            tz = -(seg_idx - 7) * separation;

            if (arc_frac > 0) {
                tx += sin_part;
                tz += cos_part;
            }
        }

        return optionalTarget.set( tx, ty, tz );
    }
}


export class CubeLockingScene extends Scene {
    constructor(context) {
        super(context, 'cubetubes', 3);

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 40;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.cam_orth.position.set(0, 0, 100);
        this.camera = this.cam_orth;

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.clear();
        this.beat_clock = new BeatClock(this);

        this.base_group = new THREE.Group();

        this.light = new THREE.DirectionalLight("white", 0.5);
        this.light.position.set(0, 100, 20);
        this.base_group.add(this.light);

        this.light2 = new THREE.PointLight("white", 50, 100, 1.5);
        this.light2.position.set(0, 20, -20);
        this.base_group.add(this.light2);

        this.fill_light = new THREE.PointLight("white", FILL_LIGHT_INTENSITY, 100, 1.5);
        this.fill_light.position.copy(FILL_LIGHT_POS);
        this.base_group.add(this.fill_light);

        this.object_color = new THREE.Color("cyan");

        const stl_loader = new STLLoader();
        const stl_load_promise = stl_loader.loadAsync('stl/cube-locking.stl');
        const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = shader_loader.load();

        Promise.all([stl_load_promise, shader_load_promise]).then(
            (results) => {
                const geometry = results[0];
                const dither_pars = results[1][0];
                const dither = results[1][1];

                this.fill_mat = new THREE.MeshLambertMaterial({
                    color: this.object_color,
                    polygonOffset: true,
                    polygonOffsetFactor: 1, // positive value pushes polygon further away
                    polygonOffsetUnits: 1
                });
                this.fill_mat.flatShading = false;

                this.tube_mat = new THREE.MeshLambertMaterial({
                    color: 'white',
                    side: THREE.DoubleSide
                });
                this.tube_mat.flatShading = false;

                for (const mat of [this.fill_mat, this.tube_mat]) {
                    mat.onBeforeCompile = (shader) => {
                        shader.fragmentShader =
                            shader.fragmentShader.replace(
                                '#include <dithering_pars_fragment>',
                                dither_pars
                            ).replace(
                                '#include <dithering_fragment>',
                                dither
                            );
                    };
                }

                // Add cube assembly
                {
                    const mesh_inner = new THREE.Mesh(geometry, this.fill_mat)
                    const wireframe_mat = new THREE.LineBasicMaterial({
                        color: "white",
                        linewidth: 1,
                    });
                    let edges = new THREE.EdgesGeometry(geometry, 30);
                    let mesh = new THREE.LineSegments(edges, wireframe_mat);
                    this.base_group.add(mesh);
                    this.base_group.add(mesh_inner);
                    this.cube_thing = mesh;
                    this.light.target = this.cube_thing;
                }


                // Add tubes
                {
                    const path = new CustomSinCurve( 24 );
                    this.tube_geometries = [];

                    for (let i = 0; i < 3; i++) {
                        const tube_geom = new THREE.TubeGeometry(
                            path, TUBE_RINGS, 2, TUBE_RADIAL, false);
                        repeat_index_twice(tube_geom);
                        if (i == 1) {
                            tube_geom.rotateY(Math.PI / 2);
                        } else if (i == 2) {
                            tube_geom.rotateZ(Math.PI / 2);
                        }
                        this.tube_geometries.push(tube_geom);

                        const mesh = new THREE.Mesh(tube_geom, this.tube_mat);
                        this.base_group.add( mesh );
                    }
                }
        });

        this.cubes = [];
        this.cube_wireframe = new THREE.Group();
        for (let i = 1; i < 2; i++) {
            for (let j = 1; j < 2; j++) {
                for (let k = 1; k < 2; k++) {
                    //if ((i + j + k) % 2 == 0) {
                        const c = make_wireframe_cube(
                            [OUTLINE_SIZE, OUTLINE_SIZE, OUTLINE_SIZE], "white");
                        c.position.set((i - 1) * 8, (j - 1) * 8, (k - 1) * 8);
                        c.material.transparent = true;
                        c.material.opacity = OUTLINE_OPACITY;
                        this.cube_wireframe.add(c);
                        this.cubes.push(c);
                    //}
                }
            }
        }

        this.base_group.add(this.cube_wireframe);

        // Outline tracers: a ring of instanced wireframe cubes under
        // base_group (so the trail turns with the assembly). Each slot holds a
        // snapshot of the outline's scale and opacity, faded by age.
        const [outline_wire_template] = create_instanced_cube_templates(
            OUTLINE_SIZE, OUTLINE_SIZE, OUTLINE_SIZE);
        this.outline_tracers = new InstancedGeometryCollection(
            this.base_group, outline_wire_template, 'Lines', OUTLINE_TRACER_COUNT);
        this.tracer_birth = new Float32Array(OUTLINE_TRACER_COUNT).fill(-Infinity);
        this.tracer_opacity = new Float32Array(OUTLINE_TRACER_COUNT);
        for (let i = 0; i < OUTLINE_TRACER_COUNT; i++) {
            this.outline_tracers.create_geom(new THREE.Vector3(), WHITE,
                ZERO_SCALE, null, 0);
        }
        this.next_tracer = 0;
        this.beat_time = 0;             // beats elapsed, for tracer ages
        this.last_tracer_beat = -Infinity;
        this.tracer_scale = new THREE.Vector3();

        this.add(this.base_group);

        const spark_constructor = () => { return new Spark(1.0, "white", [0, 1]); };
        this.spark_pool = new ObjectPool(spark_constructor, 64);
        this.base_group.add(this.spark_pool);
        // Tube segments: each tube's tail position around its looped path in
        // rings, [0, TUBE_RINGS); the segment runs from there for tube_len
        // rings, wrapping across the loop's seam.
        this.tube_tails = [0, 1, 2].map((i) => (2 - i) * TUBE_HEAD_SPACING);
        this.tube_len = TUBE_DEFAULT_LEN;
        this.tube_speed = 1;
        this.bind(CH_EXPAND_X, (v) => { this.tube_len = v; },
            (norm) => lerp_scalar(TUBE_MIN_LEN, TUBE_MAX_LEN, norm));
        this.bind(CH_EXPAND_Y, (v) => { this.tube_speed = v; },
            (norm) => 2 * norm - 1);

        // Free rotation: knob 8 sets the yaw rate about the assembly's Y axis
        // and knob 9 the pitch rate about the viewport-horizontal (world X)
        // axis, each in [-2, 2] * NOM_ROT_RATE rad/s (knob centred = stopped).
        this.yaw = Math.PI / 2 * 2.5;
        this.pitch = isom_angle;
        this.rot_rate = 1;
        this.pitch_rate = 0;
        this.bind(CH_ROT_Y, (v) => { this.rot_rate = v; }, knob_to_rate);
        this.bind(CH_ROT_X, (v) => { this.pitch_rate = -v; }, knob_to_rate);

        this.buffer = new THREE.WebGLRenderTarget(width, height, {});

        // Knob CH_ZOOM scales the camera zoom (see Scene.bind_zoom).
        this.bind_zoom();
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        this.update_tubes(dt);

        // Free rotation (driven by the knob-8/9 bindings registered in the
        // ctor). The default XYZ euler order applies yaw about the group's Y
        // axis first, then pitch about the world X axis, so the pitch axis
        // stays horizontal in the viewport whatever the yaw.
        {
            this.yaw += dt * NOM_ROT_RATE * this.rot_rate;
            this.pitch += dt * NOM_ROT_RATE * this.pitch_rate;
            this.base_group.rotation.x = this.pitch;
            this.base_group.rotation.y = this.yaw;

            // Fill colour swings orange <-> magenta once per quarter turn of
            // yaw, as it did per discrete quarter-turn step.
            const turn = this.yaw / (Math.PI / 2) - 0.5;
            const frac = turn - Math.floor(turn);
            const from_orange = Math.floor(turn) % 2 == 0;
            const start_color = new THREE.Color(from_orange ? "orange" : "magenta");
            const end_color = new THREE.Color(from_orange ? "magenta" : "orange");
            const cur_color = new THREE.Color();
            cur_color.lerpColors(start_color, end_color, frac);
            if (this.fill_mat != null) {
                this.fill_mat.color.copy(cur_color);
            }
        }

        // Update sparks
        this.spark_pool.foreach((spark) => { spark.anim_frame(dt, this.camera); });

        // Handle expanding outline
        {
            const beats_per_expansion = 1.0;
            let frac = 1;
            if (this.beat_clock.running) {
                const t = this.beat_clock.getElapsedBeats();
                frac = clamp(t / beats_per_expansion - 0.1, 0, 1);
            }
            const opacity = OUTLINE_OPACITY * (1.0 - frac);
            const scale = 1 + 2 * frac;
            for (const c of this.cubes) {
                c.material.opacity = opacity;
                c.scale.setScalar(scale);
            }
            this.update_outline_tracers(dt * beats_per_sec, opacity, scale);
        }
    }

    // Advance the tube segments by dt seconds and set each tube's draw range
    // to its tube_len-ring window (in the doubled index buffer, so a window
    // crossing the loop's seam stays one draw).
    update_tubes(dt) {
        if (!this.tube_geometries) {
            return;
        }
        const len = rings_to_draw_idx(this.tube_len);
        for (let i = 0; i < 3; i++) {
            let tail = this.tube_tails[i] + dt * NOM_TUBE_SPEED * this.tube_speed;
            tail = ((tail % TUBE_RINGS) + TUBE_RINGS) % TUBE_RINGS;
            this.tube_tails[i] = tail;
            this.tube_geometries[i].setDrawRange(rings_to_draw_idx(tail), len);
        }
    }

    // Drop a tracer of the outline every OUTLINE_TRACER_INTERVAL beats while
    // it is visible, then fade every tracer by age. d_beats: beats this frame;
    // opacity/scale: the outline's current values.
    update_outline_tracers(d_beats, opacity, scale) {
        this.beat_time += d_beats;
        if (opacity > 0 &&
                this.beat_time - this.last_tracer_beat >= OUTLINE_TRACER_INTERVAL) {
            const i = this.next_tracer;
            this.next_tracer = (i + 1) % OUTLINE_TRACER_COUNT;
            this.last_tracer_beat = this.beat_time;
            this.tracer_birth[i] = this.beat_time;
            this.tracer_opacity[i] = opacity;
            this.outline_tracers.set_scale(i, this.tracer_scale.setScalar(scale));
        }
        for (let i = 0; i < OUTLINE_TRACER_COUNT; i++) {
            const age = this.beat_time - this.tracer_birth[i];
            const fade = clamp(1 - age / OUTLINE_TRACER_LIFETIME, 0, 1);
            this.outline_tracers.set_color(i, WHITE, this.tracer_opacity[i] * fade);
        }
    }

    handle_sync(t, bpm, beat) {
        this.beat_clock.updateBPM(bpm);
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay(t);
        setTimeout(() => {
            if (channel == 1) {
                this.beat_clock.start();
            } else if (channel == 4) {
                this.create_spark();
            }
        }, delay * 1000);
    }

    state_transition(old_state_idx, new_state_idx) {
        if (new_state_idx == 0) {
            this.do_rotation = false;
        } else if (new_state_idx == 1) {
            this.do_rotation = true;
        }
    }

    create_spark() {
        const vel = new THREE.Vector3(0, -20, 0);
        const pos = new THREE.Vector3(8 * rand_int(-1, 2), 40, 8 * rand_int(-1, 2));
        const spark = this.spark_pool.get_pool_object();
        spark.active = true;
        spark.position.copy(pos);
        spark.velocity = vel;
        spark.acceleration.set(0, 0, 0);
        spark.material.color.set("white");
    }
}
