import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    load_texture,
    ResourceLoader
} from './util.js';
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";

export class ChineseScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 20;
        this.inner_camera = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        /*this.camera = new THREE.OrthographicCamera(
            -width / 2,
            width / 2,
            height / 2,
            -height / 2, -1000, 1000);*/
        this.camera = this.inner_camera.clone();
        this.clock = new THREE.Clock();
        this.base_group = new THREE.Group();

        this.cur_rotation = 0;

        // Create interior scene
        {
            this.inner_scene = new THREE.Scene();
            this.scene = new THREE.Scene();
            const loader = new SVGLoader();
            // load a SVG resource
            loader.load(
                // resource URL
                'img/chinese.svg',
                // called when the resource is loaded
                (data) => {
                    const paths = data.paths;
                    const group = new THREE.Group();

                    for ( let i = 0; i < paths.length; i ++ ) {
                            const path = paths[ i ];
                            const material = new THREE.MeshBasicMaterial( {
                                    color: "white",
                                    side: THREE.DoubleSide,
                                    //depthWrite: false
                            } );
                            const shapes = SVGLoader.createShapes( path );
                            for ( let j = 0; j < shapes.length; j ++ ) {
                                const shape = shapes[ j ];
                                const geometry = new THREE.ShapeGeometry( shape );
                                const mesh = new THREE.Mesh( geometry, material );
                                group.add( mesh );
                            }
                    }
                    group.rotation.y = Math.PI;
                    group.rotation.z = Math.PI;
                    group.scale.set(0.5, 0.5, 0.5);
                    group.position.set(-20, 20, 0);
                    this.base_group.add(group);
                },
                // called when loading is in progresses
                function ( xhr ) {
                    console.log( 'SVG ' + ( xhr.loaded / xhr.total * 100 ) + '% loaded' );
                },
                // called when loading has errors
                function ( error ) {
                    console.log( 'An error happened: ' + error);
                }
            );

            this.base_group.scale.set(1, 1, 1);

            this.inner_scene.add(this.base_group);
        }

        // Create top-level scene
        this.shader_loader = new ResourceLoader(['glsl/chinese.vert', 'glsl/chinese.frag']);
        Promise.all([this.shader_loader.load(), load_texture('img/romaO.png')]).then(
            ([[vertex_shader, fragment_shader], texture]) => {
            this.uniforms = {
                time: { type: 'f', value: 0.0 },
                resolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                tex: { type: 't', value: null }
            };
            let material = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: vertex_shader,
                fragmentShader: fragment_shader,
                transparent: true,
            });
            //material = new THREE.MeshBasicMaterial({ color: "red" });
            let geometry = new THREE.PlaneGeometry(1, 1);
            this.plane = new THREE.Mesh(geometry, material);
            this.plane.position.z = -100;   // position in front of other objects
            this.scene.add(this.plane);
            this.plane.scale.set(width, height, 1);
        });
        this.handle_resize(width, height);

        this.elapsed_beats = 0;
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        const clock_dt = this.clock.getDelta();
        this.elapsed_beats += clock_dt * beats_per_sec;
        if (this.uniforms != null) {
            this.uniforms.time.value = this.elapsed_beats / 16;
        }
        //this.plane.position.z -= 0.02;
        //this.base_group.rotation.y += 0.01;
        //this.base_group.rotation.x += 0.01;
    }

    handle_resize(width, height) {
        const aspect = width / height;
        if (this.plane) {
            this.plane.scale.set(width, height, 1);
        }
        update_orth_camera_aspect(this.inner_camera, aspect, this.frustum_size);
        update_orth_camera_aspect(this.camera, aspect, this.frustum_size);
        this.create_buffer(width, height);
        console.log(`Width/height: ${width}/${height}`);
    }

    create_buffer(width, height) {
        this.buffer = new THREE.WebGLRenderTarget(width, height);
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
    }


    render(renderer) {
        const prev_render_target = renderer.getRenderTarget();
        const prev_autoclear = renderer.autoClearColor;
        renderer.autoClearColor = false;
        renderer.setRenderTarget(this.buffer);
        renderer.clear();
        renderer.render(this.inner_scene, this.inner_camera);
        if (this.uniforms != null) {
            this.uniforms.tex.value = this.buffer.texture;
        }
        renderer.setRenderTarget(prev_render_target);
        renderer.clear();
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClearColor = prev_autoclear;
    }
}
