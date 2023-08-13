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
    create_instanced_cube,
    make_wireframe_cylinder,
    make_wireframe_circle,
    ShaderLoader
} from './util.js';
import { Tesseract } from './highdim.js';

export class CubeLockingScene extends VisScene {
    constructor(env) {
        super(env, 3);

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 60;
        this.cam_vbo = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.camera = this.cam_vbo.clone();
        this.cam_vbo.position.set(20, 6, 0);

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.vbo_scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(false);
        this.beat_clock = new THREE.Clock(false);
        this.cam_clock = new THREE.Clock(false);

        this.base_group = new THREE.Group();
        this.object_group = new THREE.Group();
        this.cones = [];

        this.ice_cream_color = new THREE.Color("white");


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

        const loader = new STLLoader();
        this.ice_cream_cone_mat = new THREE.MeshLambertMaterial({
            color: this.ice_cream_color,
            polygonOffset: true,
            polygonOffsetFactor: 1, // positive value pushes polygon further away
            polygonOffsetUnits: 1
        });
        /*this.ice_cream_cone_mat = new THREE.MeshBasicMaterial({
            color: "black",
            polygonOffset: true,
            polygonOffsetFactor: 1, // positive value pushes polygon further away
            polygonOffsetUnits: 1
        });*/
        this.ice_cream_cone_mat.flatShading = false;
        this.light = new THREE.PointLight("magenta", 0.7, 100 );
        this.light.position.set(0, 0, 40);
        this.base_group.add(this.light);

        this.light2 = new THREE.PointLight("blue", 0.75, 100 );
        this.light2.position.set(50, 0, 0);
        this.cones_per_side = 7;
        this.cone_spacing = 7;
        this.cone_scale = 0.25;

        this.start_cam_pos = this.cam_vbo.position.clone();
        this.target_cam_pos = this.start_cam_pos.clone();
        this.cam_movement_beats = 8;

        const this_class = this;

        loader.load(
            'stl/cube-locking.stl',
            function (geometry) {
                const mesh_inner = new THREE.Mesh(geometry, this_class.ice_cream_cone_mat)

                const wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );
                let edges = new THREE.EdgesGeometry(geometry, 30);
                let mesh = new THREE.LineSegments(edges, wireframe_mat);
                this_class.object_group.add(mesh);
                this_class.object_group.add(mesh_inner);
                this_class.cube_thing = mesh;
            },
            (xhr) => { },
            (error) => {
                console.log(error)
            }
        )

        loader.load(
            'stl/text.stl',
            function (geometry) {
                const mesh_inner = new THREE.Mesh(geometry, this_class.ice_cream_cone_mat)

                const wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );
                let edges = new THREE.EdgesGeometry(geometry, 30);
                let mesh = new THREE.LineSegments(edges, wireframe_mat);
                let obj = new THREE.Object3D();
                obj.add(mesh);
                obj.add(mesh_inner);

                obj.position.set(32, 0, 20);
                obj.scale.setScalar(5);

                this_class.object_group.add(obj);
                this_class.text = obj;
            },
            (xhr) => { },
            (error) => {
                console.log(error)
            }
        )

        //const cube = create_instanced_cube([3, 3, 3], 0x00ff00);
        //this.base_group.add(cube);

        // rotation
        this.start_rot = 2;
        this.end_rot = 2;
        this.rot_dir = 1;
        this.object_group.rotation.y = this.start_rot * Math.PI / 8;

        this.base_group.add(this.object_group);
        this.vbo_scene.add(this.base_group);
        this.base_group.rotation.x = isom_angle;

        /*{
            this.fg_group = new THREE.Group();
            this.tub = make_wireframe_cylinder(4, 3, 7, "white");
            this.front_decal = make_wireframe_circle(2, 32, this.ice_cream_color);
            this.front_decal.position.z = 3.5;
            this.front_decal.rotation.x = Math.atan(1 / 7);
            this.tub.add(this.front_decal);
            this.lid = make_wireframe_cylinder(4.25, 4.25, 1.5, "white");
            this.lid.position.y = this.lid_base_y;
            this.fg_group.add(this.tub);
            this.fg_group.add(this.lid);
            this.fg_group.rotation.x = Math.PI / 8;
            this.fg_group.position.y = -3;
            this.scene.add(this.fg_group);
        }*/


        this.buffer = new THREE.WebGLRenderTarget(width, height, {});
    }

    anim_frame(dt) {
        //this.base_group.rotation.y += dt * 0.1;

        const beats_per_sec = this.env.bpm / 60;
        const beats_per_rotation = 1.0;
        const t = this.sync_clock.getElapsedTime() * beats_per_sec;
        const frac = clamp((t - (1 - beats_per_rotation)) / beats_per_rotation, 0, 1);
        this.object_group.rotation.y = Math.PI / 8 * (this.start_rot +
            lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot));

        const start_color = new THREE.Color((this.start_rot % 2 == 0 ? "magenta" : "cyan"));
        const end_color = new THREE.Color((this.start_rot % 2 == 0 ? "cyan" : "magenta"));
        const cur_color = new THREE.Color();
        cur_color.lerpColors(start_color, end_color, frac);
        this.light.color.copy(cur_color);

        const cam_frac = clamp(this.cam_clock.getElapsedTime() * beats_per_sec / this.cam_movement_beats, 0, 1);
        this.cam_vbo.position.lerpVectors(this.start_cam_pos, this.target_cam_pos, cam_frac);
    }

    handle_sync(t, bpm, beat) {
        this.sync_clock.start();
        const beats_per_sec = this.env.bpm / 60;

        if (this.do_rotation) {
            if (Math.abs(this.end_rot) == 4) {
                this.rot_dir *= -1;
            }
            this.start_rot = this.end_rot;
            this.end_rot = this.start_rot + this.rot_dir;
        }

        if (this.do_movement) {
            if (rand_int(0, 4) == 0 &&
                    (!this.cam_clock.running) ||
                    (this.cam_clock.getElapsedTime() * beats_per_sec > this.cam_movement_beats)) {
                this.start_cam_pos.copy(this.target_cam_pos);
                this.target_cam_pos.x *= -1;
                this.cam_clock.start();
            }
        } else {
            this.start_cam_pos.copy(this.target_cam_pos);
            this.target_cam_pos.set(20, 6, 0);
        }
    }

    state_transition(old_state_idx, new_state_idx) {
        if (new_state_idx == 0) {
            this.do_rotation = false;
            this.do_movement = false;
        } else if (new_state_idx == 1) {
            this.do_rotation = true;
            this.do_movement = false;
        } else if (new_state_idx == 2) {
            this.do_rotation = true;
            this.do_movement = true;
        }
    }

    render(renderer) {
        if (this.vbo_material == null) {
            return;
        }
        renderer.autoClearColor = false;
        super.render(renderer);
        renderer.setRenderTarget(this.buffer);
        renderer.clear();
        renderer.render(this.vbo_scene, this.cam_vbo);
        this.vbo_material.uniforms.uTexture.value = this.buffer.texture;
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClearColor = true;
    }
}
