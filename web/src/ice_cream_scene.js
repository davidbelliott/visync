import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { VisScene } from './vis_scene.js';
import { LightningStrike } from './lightning_strike.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    create_instanced_cube,
    make_wireframe_cylinder,
    make_wireframe_circle,
    ShaderLoader,
    BeatClock,
} from './util.js';
import { Tesseract } from './highdim.js';

export class IceCreamScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_vbo = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.camera = this.cam_vbo.clone();

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(false);
        this.beat_clock = new BeatClock(this, false);
        this.scoop_clock = new BeatClock(this, false);

        this.base_group = new THREE.Group();
        this.cones = [];


        this.shader_loader = new ShaderLoader('glsl/default.vert', 'glsl/dither.frag');
        this.shader_loader.load().then(([vertex_shader, fragment_shader]) => {
            this.vbo_material = new THREE.ShaderMaterial({
                uniforms: {
                    uTexture: { value: null }
                },
                vertexShader: vertex_shader,
                fragmentShader: fragment_shader
            });
            let geometry = new THREE.PlaneGeometry(this.camera.right - this.camera.left,
                this.camera.top - this.camera.bottom);
            this.plane = new THREE.Mesh(geometry, this.vbo_material);
            this.plane.position.z = -100;
            this.scene.add(this.plane);
        });

        this.vbo_scene = new THREE.Scene();
        this.ice_cream_color = new THREE.Color("orange");


        const loader = new STLLoader();
        this.ice_cream_cone_mat = new THREE.MeshLambertMaterial({
            color: this.ice_cream_color,
        });
        this.ice_cream_cone_mat.flatShading = false;
        this.light = new THREE.PointLight("white", 5000);
        this.light.position.set(0, 40, 20);
        this.vbo_scene.add(this.light);
        this.cones_per_side = 7;
        this.cone_spacing = 7;
        this.cone_scale = 0.25;

        const this_class = this;
        this.target_rot_multiplier = 1;

        this.lightning_strike_meshes = [];
        this.lightningColor = new THREE.Color("lightblue"); //new THREE.Color( 0xB0FFFF );
        this.lightningMaterial = new THREE.MeshBasicMaterial( { color: this.lightningColor, opacity: 0.25, transparent: true } );
        this.lightning_strikes = [];
        this.lightning_strike_meshes = [];

        loader.load(
            'stl/ice-cream-cone.stl',
            function (geometry) {
                const mesh = new THREE.Mesh(geometry, this_class.ice_cream_cone_mat)
                const center_offset = -this_class.cone_spacing * (this_class.cones_per_side - 1) / 2;
                for (let i = 0; i < this_class.cones_per_side; i++) {
                    for (let j = 0; j < this_class.cones_per_side; j++) {
                        const offset = (i % 2 == 0 ? 0 : this_class.cone_spacing / 2);
                        const cone = mesh.clone();
                        cone.scale.set(this_class.cone_scale, this_class.cone_scale, this_class.cone_scale);
                        cone.position.set(i * this_class.cone_spacing + center_offset, 0, j * this_class.cone_spacing + center_offset);
                        cone.rotation.x = Math.PI / 2 * Math.pow(-1, i % 2)
                        this_class.cones.push(cone);
                        this_class.base_group.add(cone);
                    }
                }
            },
            (xhr) => { },
            (error) => {
                console.log(error)
            }
        )

        this.fg_group = new THREE.Group();
        this.fg_group.rotation.x = Math.PI / 8;
        this.fg_group.position.y = -8;
        this.fg_group.position.z = 10;
        this.vbo_scene.add(this.fg_group);

        this.brain_mat = new THREE.MeshLambertMaterial({
            color: 'lightblue',
        });

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

        const brain_loader = new STLLoader();
        brain_loader.load(
            'stl/brain.stl',
            function (geometry) {
                const mesh = new THREE.Mesh(geometry, this_class.brain_mat)
                mesh.scale.setScalar(0.08);
                this_class.brain = mesh;
                this_class.fg_group.add(mesh);

                
                for (let i = 0; i < 4; i++) {
                    let ray_params = Object.assign({}, this_class.ray_params_base);

                    const dest_offset = new THREE.Vector3(1, 0, 0);
                    dest_offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 * i);
                    dest_offset.normalize();
                    dest_offset.multiplyScalar(50);
                    ray_params.destOffset = dest_offset;
                    this_class.ray_params.push(ray_params);

                    const lightning_strike = new LightningStrike(ray_params);
                    this_class.lightning_strikes.push(lightning_strike);

                    const lightning_strike_mesh = new THREE.Mesh(lightning_strike, this_class.lightningMaterial );
                    lightning_strike_mesh.position.set(0, 10, 0);
                    this_class.lightning_strike_meshes.push(lightning_strike_mesh);
                    this_class.fg_group.add(lightning_strike_mesh);
                }
            },
            (xhr) => { },
            (error) => {
                console.log(error)
            }
        )

        //const cube = create_instanced_cube([3, 3, 3], 0x00ff00);
        //this.base_group.add(cube);
        this.base_group.rotation.y = Math.PI / 4;

        this.vbo_scene.add(this.base_group);
        this.buffer = new THREE.WebGLRenderTarget(width, height, {});
        //this.base_group.rotation.x = isom_angle;
        this.base_group.rotation.x = Math.PI / 4;
        this.lid_base_y = 4.25;

        this.rot = 512 / 4;
        this.elapsed_time = 0.0;

        /*{
            this.fg_group = new THREE.Group();
            //this.tub = make_wireframe_cylinder(4, 3, 7, "white");
            this.tub = make_wireframe_cylinder(4, 4, 8, "orange");
            this.front_decal = make_wireframe_circle(2, 32, this.ice_cream_color);
            this.front_decal.position.z = 3.5;
            this.front_decal.rotation.x = Math.atan(1 / 7);
            //this.tub.add(this.front_decal);
            this.lid = make_wireframe_cylinder(4.25, 4.25, 1.5, "orange");
            this.lid.position.y = this.lid_base_y;
            this.fg_group.add(this.tub);
            this.fg_group.add(this.lid);
            this.fg_group.rotation.x = Math.PI / 8;
            this.fg_group.position.y = -3;
            //this.scene.add(this.fg_group);
            this.base_group.add(this.fg_group);
        }*/

        this.start_lid_y_offset = 0;
        this.target_lid_y_offset = 0;
        this.vibe_ampl = 0.0;
        this.frame_idx = 0;
    }

    anim_frame(dt) {
        this.frame_idx++;
        this.rot++;
    
        const beats_per_sec = this.get_local_bpm() / 60;
        const clock_dt = this.clock.getDelta();
        const t = this.beat_clock.get_elapsed_beats();
        const rot_movement_beats = 2.0;
        const frac = clamp(t / rot_movement_beats, 0, 1);

        this.vibe_ampl = (1.0 - frac) ** 2;

        this.cones.forEach((cone, i) => {
            //cone.rotation.z = this.rot * Math.PI / 512;
            //cone.rotation.y = this.rot * Math.PI / 512;
            cone.rotation.x += clock_dt * beats_per_sec / rot_movement_beats * Math.PI / 2 * this.target_rot_multiplier;
        });
        this.fg_group.rotation.y += clock_dt * 0.2 * this.target_rot_multiplier;
        //this.fg_group.position.y = -3 + (2 * Math.random() - 1) * this.vibe_ampl * 0.2;


        const scoop_elapsed_beats = this.scoop_clock.get_elapsed_beats();
        const lid_open_movement_beats = 2.0;
        const lid_frac = clamp(scoop_elapsed_beats / lid_open_movement_beats, 0, 1);
        //this.lid.position.y = this.lid_base_y + lerp_scalar(this.start_lid_y_offset, this.target_lid_y_offset, lid_frac);
        //
        this.elapsed_time += dt;
        for (const ls of this.lightning_strikes) {
            ls.update(this.elapsed_time);
        }
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        if (channel == 1) {
            this.beat_clock.start();
            this.target_rot_multiplier *= -1;
        }

        if (channel == 2) {
            this.set_scooping(!this.scooping);
        }
    }

    set_scooping(scooping) {
        if (scooping == this.scooping) {
            return;
        }
        if (scooping) {
            this.target_lid_y_offset = this.lid_base_y;
            this.start_lid_y_offset = 0;
        } else {
            this.target_lid_y_offset = 0;
            this.start_lid_y_offset = this.lid_base_y;
        }
        this.scoop_clock.start();
        this.scooping = scooping;
    }

    render(renderer) {
        if (this.vbo_material == null) {
            return;
        }
        const prev_render_target = renderer.getRenderTarget();
        const prev_autoclear = renderer.autoClearColor;
        renderer.autoClearColor = false;
        super.render(renderer);
        renderer.setRenderTarget(this.buffer);
        renderer.clear();
        renderer.render(this.vbo_scene, this.cam_vbo);
        this.vbo_material.uniforms.uTexture.value = this.buffer.texture;
        renderer.setRenderTarget(prev_render_target);
        renderer.clear();
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClearColor = prev_autoclear;
    }
}
