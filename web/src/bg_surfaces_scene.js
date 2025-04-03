import { VisScene } from "./vis_scene.js";
import * as THREE from "three";
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import {
    create_instanced_cube,
    make_wireframe_special,
    make_point_cloud,
    ShaderLoader,
    BeatClock,
    Spark,
    ObjectPool,
    rand_int,
} from "./util.js";

function radial_wave(u, v, target, t) {
    const r = 50;
    
    const x = r * (u - 0.5);//Math.sin(u) * r;
    const z = r * (v - 0.5);//Math.sin(v / 2) * 2 * r;
    const y = (Math.sin(u * 4 * Math.PI - 0.1 * t) + Math.cos(v * 3 * Math.PI - 0.05 * t)) * 2.8;
    
    target.set(x, y, z);
}


export class BackgroundSurfacesScene extends VisScene {
    constructor() {
        super('param-surface');
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
        this.cam_persp.position.set(0, 0, 200);
        this.camera = this.cam_persp;
        this.frustum_size = 100;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.base_group = new THREE.Group();
        this.geoms = [];

        const radialWave = function(u, v, target) {
            radial_wave(u, v, target, 0);
        };

        const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = shader_loader.load();

        this.meshes = [];

        const pos_range = 150;
        const num_surfaces = 5;
        const num_spheres = 10;
        shader_load_promise.then(([dither_pars, dither]) => {
            const meshMaterial = new THREE.MeshPhongMaterial({
                color: "white",
                shininess: 20,
                specular: 0xffffff,
                flatShading: false,
                transparent: true,
                opacity: 0.5,
                depthTest: false,
            });
            meshMaterial.side = THREE.DoubleSide;

            meshMaterial.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            this.geom = new ParametricGeometry(radialWave, 32, 32);

            for (let i = 0; i < num_surfaces; i++) {
                const mesh = new THREE.Mesh(this.geom, meshMaterial);
                mesh.position.set((Math.random() - 0.5) * pos_range, (Math.random() - 0.5) * pos_range, (Math.random() - 0.5) * pos_range);
                mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
                mesh.scale.set(Math.random() * 2 + 1, Math.random() * 2 + 1, Math.random() * 2 + 1);
                this.base_group.add(mesh);
                this.add_mesh(mesh);
            }

            this.sphere_geom = new THREE.SphereGeometry(10, 32, 32);
            for (let i = 0; i < num_spheres; i++) {
                const mesh = new THREE.Mesh(this.sphere_geom, meshMaterial);
                mesh.position.set((Math.random() - 0.5) * pos_range, (Math.random() - 0.5) * pos_range, (Math.random() - 0.5) * pos_range);
                mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
                mesh.scale.setScalar(Math.random() * 2 + 1);
                this.add_mesh(mesh);
            }

        });

        this.beat_clock = new BeatClock(this);

        //this.base_group.rotation.x = Math.PI / 4;

        this.amb_color_hue = 0;
        const color_amb = new THREE.Color();
        color_amb.setHSL(this.amb_color_hue % 1, 1, 0.5);

        this.amblight = new THREE.AmbientLight(color_amb, 0.7);
        this.scene.add(this.amblight);

        this.dir_light = new THREE.DirectionalLight("white", 0.4);
        this.dir_light.position.set(1, 1, 0);
        this.scene.add(this.dir_light);

        const color_dir = new THREE.Color();
        color_dir.setHSL((this.amb_color_hue) % 1, 1, 0.5);
        this.dir_light_2 = new THREE.DirectionalLight(color_dir, 1.4);
        this.dir_light_2.position.set(-1, -1, -1);
        this.scene.add(this.dir_light_2);

        this.light = new THREE.PointLight("white", 20, 0, 2);
        //this.light.castShadow = true;
        this.scene.add(this.light);

        // Sparks
        const spark_constructor = () => { return new Spark(2, "white", [0, 1], false, true, true, false); };
        this.spark_pool = new ObjectPool(spark_constructor, 32);
        this.base_group.add(this.spark_pool);

        this.scene.add(this.base_group);
        this.evolve_time = 0;
    }

    add_mesh(mesh) {
        mesh.phase = Math.random() * 2 * Math.PI;
        mesh.velocity = new THREE.Vector3(0, 0, 0);
        mesh.initial_scale = mesh.scale.clone();
        this.meshes.push(mesh);
        this.base_group.add(mesh);
    }

    anim_frame(dt) {
        //this.base_group.rotation.x += 0.04 * dt;
        //this.base_group.rotation.z += 1.0 * dt;
        // Get the current time
        //
        let add_dt = dt;
        if (this.beat_clock.running) {
            add_dt *= (this.beat_clock.getElapsedBeats() < 0.5 ? 6 : 1);
        }
        this.evolve_time += add_dt;

        this.base_group.rotation.y += 0.1 * dt;
        this.amb_color_hue = 0.08 * this.evolve_time % 1;

        this.amblight.color.setHSL(this.amb_color_hue % 1, 1, 0.5);
        this.dir_light_2.color.setHSL((this.amb_color_hue) % 1, 1, 0.5);

        this.meshes.forEach((mesh, i) => {
            mesh.scale.copy(mesh.initial_scale);
            mesh.scale.multiplyScalar(0.75 + 0.25 * Math.sin(0.5 * this.evolve_time + mesh.phase));
        });

        if (this.geom) {
            const positionAttribute = this.geom.getAttribute( 'position' );

            let x = 0, y = 0, z = 0;

            const pos = new THREE.Vector3();
            for ( let i = 0; i < positionAttribute.count; i ++ ) {
                const u = positionAttribute.getX(i) / 50 + 0.5;
                const v = positionAttribute.getZ(i) / 50 + 0.5;
                radial_wave(u, v, pos, this.evolve_time);
                positionAttribute.setXYZ( i, pos.x, pos.y, pos.z );
            }

            positionAttribute.needsUpdate = true;
            this.geom.computeVertexNormals();
            this.geom.computeBoundingBox();
            this.geom.computeBoundingSphere();
        }

        this.spark_pool.foreach((spark) => { spark.anim_frame(dt, this.camera); });
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay();
        setTimeout(() => {
            if (channel == 1 || channel == 3) {
                this.beat_clock.start();
            } else if (channel == 4) {
                for (let i = 0; i < 2; i++) {
                    this.create_spark();
                }
            }
        }, delay * 1000);
    }

    render(renderer) {
        const is_shadow_enabled = renderer.shadowMap.enabled;
        renderer.shadowMap.enabled = true;
        renderer.render(this.scene, this.camera);
        renderer.shadowMap.enabled = is_shadow_enabled;
    }

    create_spark() {
        const half_grid = 8;
        const spacing = 10;
        const x = rand_int(-half_grid, half_grid) * spacing;
        const y = rand_int(-half_grid, half_grid) * spacing;
        const pos = new THREE.Vector3(x, y, 0);
        const vel = new THREE.Vector3(0, 0, 0);//pos.clone().normalize().multiplyScalar(5);
        const spark = this.spark_pool.get_pool_object();
        spark.active = true;
        spark.position.copy(pos);
        spark.velocity = vel;
        spark.acceleration.set(0, 0, 0);
        spark.material.color.set("white");
    }
}
