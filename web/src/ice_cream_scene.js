import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { VisScene } from './vis_scene.js';
import { LightningStrike } from './lightning_strike.js';
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
} from './util.js';

export class IceCreamScene extends VisScene {
    constructor() {
        super();

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

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(false);
        this.beat_clock = new BeatClock(this);

        this.base_group = new THREE.Group();
        this.cones = [];

        this.ice_cream_color = new THREE.Color("orange");

        this.cones_per_side = 7;
        this.cone_spacing = 7;
        this.cone_scale = 0.25;

        this.light = new THREE.PointLight("white", 80, 0, 0.8);
        this.light.position.set(0, 40, 20);
        this.scene.add(this.light);

        this.fg_group = new THREE.Group();
        this.fg_group.rotation.x = Math.PI / 8;
        this.fg_group.position.y = -8;
        this.fg_group.position.z = 10;
        this.scene.add(this.fg_group);

        const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = shader_loader.load();

        const cone_loader = new STLLoader();
        const cone_load_promise = cone_loader.loadAsync('stl/ice-cream-cone.stl');

        const brain_loader = new STLLoader();
        const brain_load_promise = brain_loader.loadAsync('stl/brain.stl');

        Promise.all([shader_load_promise, cone_load_promise, brain_load_promise]).then(
            ([[dither_pars, dither], cone_geom, brain_geom]) => {
                const center_offset = -this.cone_spacing * (this.cones_per_side - 1) / 2;

                this.ice_cream_cone_mat = new THREE.MeshLambertMaterial({
                    color: this.ice_cream_color,
                    transparent: true,
                    opacity: 0.8
                });

                this.brain_mat = new THREE.MeshLambertMaterial({
                    color: '#40a0a0',
                });

                for (const mat of [this.ice_cream_cone_mat, this.brain_mat]) {
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

                const cone_mesh = new THREE.Mesh(cone_geom, this.ice_cream_cone_mat)
                for (let i = 0; i < this.cones_per_side; i++) {
                    for (let j = 0; j < this.cones_per_side; j++) {
                        const offset = (i % 2 == 0 ? 0 : this.cone_spacing / 2);
                        const cone = cone_mesh.clone();
                        cone.scale.set(this.cone_scale, this.cone_scale, this.cone_scale);
                        cone.position.set(i * this.cone_spacing + center_offset, 0, j * this.cone_spacing + center_offset);
                        cone.rotation.x = Math.PI / 2 * Math.pow(-1, i % 2)
                        this.cones.push(cone);
                        this.base_group.add(cone);
                    }
                }

                const brain_mesh = new THREE.Mesh(brain_geom, this.brain_mat)
                brain_mesh.scale.setScalar(0.08);
                this.brain = brain_mesh;
                this.fg_group.add(brain_mesh);
        });

        this.target_rot_multiplier = 1;

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

        // Create a cylinder
        const cylinder_geom = new THREE.CylinderGeometry(8, 8, 16, 32);
        const material = new THREE.MeshBasicMaterial( {color: 0xffff00} );
        const cylinder = new THREE.Mesh( cylinder_geom, material );
        cylinder.rotation.x = Math.PI / 2;
        this.spark_pool.position.y = 8;
        //this.spark_pool.add( cylinder );


        this.fg_group.add(this.spark_pool);


        this.base_group.rotation.y = Math.PI / 4;

        this.scene.add(this.base_group);
        this.base_group.rotation.x = Math.PI / 4;

        this.rot = 512 / 4;
        this.elapsed_time = 0.0;
    }

    anim_frame(dt) {
        this.rot++;
    
        const beats_per_sec = this.get_local_bpm() / 60;
        const clock_dt = this.clock.getDelta();
        const t = this.beat_clock.getElapsedBeats();
        const rot_movement_beats = 2.0;
        const frac = clamp(t / rot_movement_beats, 0, 1);


        this.cones.forEach((cone, i) => {
            cone.rotation.x += clock_dt * beats_per_sec / rot_movement_beats * Math.PI / 2 * this.target_rot_multiplier;
        });
        this.fg_group.rotation.y += clock_dt * 0.2 * this.target_rot_multiplier;

        this.spark_pool.foreach((spark) => { spark.anim_frame(dt, this.camera); });

        this.elapsed_time += dt;
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay();
        setTimeout(() => {
            if (channel == 1) {
                this.beat_clock.start();
                this.target_rot_multiplier *= -1;
            } else if (channel == 4) {
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
