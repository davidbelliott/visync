import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    make_wireframe_cube,
    make_wireframe_cylinder,
    create_instanced_cube,
    make_wireframe_circle,
    ShaderLoader,
    Spark,
    ObjectPool,
    BeatClock
} from './util.js';

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


export class CubeLockingScene extends VisScene {
    constructor() {
        super('cubetubes', 3);

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

        this.scene = new THREE.Scene();
        this.rot_clock = new BeatClock(this);
        this.beat_clock = new BeatClock(this);

        this.beats_per_rotation = 8;

        this.base_group = new THREE.Group();

        this.light = new THREE.DirectionalLight("white", 0.5);
        this.light.position.set(0, 100, 20);
        this.base_group.add(this.light);

        this.light2 = new THREE.PointLight("white", 50, 100, 1.5);
        this.light2.position.set(0, 20, -20);
        this.base_group.add(this.light2);

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
                        const tube_geom = new THREE.TubeGeometry( path, 1024, 2, 32, false );
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
                        const c = make_wireframe_cube([24, 24, 24], "white");
                        c.position.set((i - 1) * 8, (j - 1) * 8, (k - 1) * 8);
                        c.material.transparent = true;
                        c.material.opacity = 0.8;
                        this.cube_wireframe.add(c);
                        this.cubes.push(c);
                    //}
                }
            }
        }

        this.base_group.rotation.x = isom_angle;

        this.base_group.add(this.cube_wireframe);
        this.scene.add(this.base_group);

        const spark_constructor = () => { return new Spark(1.0, "white", [0, 1]); };
        this.spark_pool = new ObjectPool(spark_constructor, 64);
        this.base_group.add(this.spark_pool);
        this.draw_range = 0;

        // rotation
        this.start_rot = 2;
        this.cur_rot = 2;
        this.end_rot = 2;
        this.rot_dir = 1;



        this.buffer = new THREE.WebGLRenderTarget(width, height, {});
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        if (this.tube_geometries) {
            this.draw_range = (this.draw_range + 360);
            for (let i = 0; i < 3; i++) {
                const offset = (2 - i) * 39000;
                const this_range = (this.draw_range + offset) % (this.tube_geometries[0].index.count);
                this.tube_geometries[i].setDrawRange(this_range, 9000);
            }
        }

        // Handle rotation
        {
            const t = this.rot_clock.getElapsedBeats();
            let frac = t / this.beats_per_rotation;
            this.cur_rot = this.start_rot +
                lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot);
            this.base_group.rotation.y = Math.PI / 2 * (0.5 + this.cur_rot);

            const start_color = new THREE.Color((Math.round(this.start_rot) % 2 == 0 ? "orange" : "magenta"));
            const end_color = new THREE.Color((Math.round(this.start_rot) % 2 == 0 ? "magenta" : "orange"));
            const cur_color = new THREE.Color();
            cur_color.lerpColors(start_color, end_color, clamp(frac, 0, 1));
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
            for (const c of this.cubes) {
                c.material.opacity = 0.8 * (1.0 - frac);
                c.scale.setScalar(1 + 2 * frac);
            }
        }
    }

    handle_sync(t, bpm, beat) {
        this.rot_clock.updateBPM(bpm);
        this.beat_clock.updateBPM(bpm);
        if (beat % this.beats_per_rotation == 0 && this.do_rotation) {
            this.rot_clock.start();
            this.start_rot = this.cur_rot;
            this.end_rot = this.start_rot + this.rot_dir;
        }
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay(t);
        setTimeout(() => {
            if (channel == 1) {
                this.beat_clock.start();
            } else if (channel == 2) {
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
