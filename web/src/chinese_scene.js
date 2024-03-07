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

const USE_SHADER = true;
const SVG_SIZE = 80;

export class ChineseScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 20;
        this.inner_camera = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
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
        this.beat_clock = new THREE.Clock(false);

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
                            /*const material = new THREE.MeshBasicMaterial( {
                                    color: "white",
                                    side: THREE.DoubleSide,
                                    //depthWrite: false
                            } );*/
                            const material = new THREE.LineBasicMaterial( {
                                color: "white",
                                side: THREE.DoubleSide,
                                depthTest: false,
                                linewidth: 2 } );
                            const mesh_mat = new THREE.MeshBasicMaterial( {
                                color: "white",
                                side: THREE.DoubleSide,
                                depthWrite: false,
                                depthTest: false,
                            })
                            const shapes = SVGLoader.createShapes( path );
                            for ( let j = 0; j < shapes.length; j ++ ) {
                                const shape = shapes[ j ];
                                const shape3d = new THREE.BufferGeometry().setFromPoints( shape.getPoints() );
                                const line = new THREE.LineLoop( shape3d, material );
                                group.add( line );
                                line.renderOrder = 1;
                                for (const hole of shape.getPointsHoles()) {
                                    const hole3d = new THREE.BufferGeometry().setFromPoints( hole );
                                    const hole_line = new THREE.LineLoop( hole3d, material );
                                    group.add( hole_line );
                                    hole_line.renderOrder = 1;
                                }
                                const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mesh_mat);
                                mesh.renderOrder = 0;
                                group.add(mesh);
                            }
                    }
                    group.rotation.y = Math.PI;
                    group.rotation.z = Math.PI;
                    group.scale.setScalar(this.frustum_size / SVG_SIZE);
                    group.position.set(-this.frustum_size / 2, this.frustum_size / 2, 0);
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
            this.create_buffer(4096, 4096);
        }

        // Create top-level scene
        this.shader_loader = new ResourceLoader(['glsl/chinese.vert', 'glsl/chinese.frag']);
        Promise.all([this.shader_loader.load(), load_texture('img/chinese.png')]).then(
            ([[vertex_shader, fragment_shader], texture]) => {
            texture.minFilter = THREE.LinearFilter;
            this.uniforms = {
                time: { type: 'f', value: 0.0 },
                scroll_time: { type: 'f', value: 0.0 },
                resolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                tex: { type: 't', value: texture },
                tex_dims: { type: 'v2', value: new THREE.Vector2(texture.image.width, texture.image.height) }
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

        this.evolve_time = 0;
        this.elapsed_time_beats = 0;
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        const clock_dt = this.clock.getDelta();
        this.elapsed_time_beats += clock_dt * beats_per_sec;
        const beat_elapsed = this.beat_clock.getElapsedTime() * beats_per_sec * 2;
        this.evolve_time += 0.5 * clock_dt * beats_per_sec;
        if (this.beat_clock.running) {
            this.evolve_time += (beat_elapsed < 1.0 ? 0.1 : 0.0);
        }
        
        if (this.uniforms != null) {
            this.uniforms.time.value = this.evolve_time;
            this.uniforms.scroll_time.value = this.elapsed_time_beats;
        }
        //this.plane.position.z -= 0.02;
        //this.base_group.rotation.y += 0.01;
        //this.base_group.rotation.z += 0.01;
    }

    handle_resize(width, height) {
        const aspect = width / height;
        if (this.plane) {
            this.plane.scale.set(width, height, 1);
        }
        update_orth_camera_aspect(this.camera, aspect, this.frustum_size);
        console.log(`Width/height: ${width}/${height}`);
    }

    create_buffer(width, height) {
        const aspect = width / height;
        update_orth_camera_aspect(this.inner_camera, aspect, this.frustum_size);
        this.buffer = new THREE.WebGLRenderTarget(width, height);
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        const delay = Math.max(60 / this.get_local_bpm() / 2 - this.env.total_latency, 0);
        setTimeout(() => { this.beat_clock.start(); }, delay * 1000);
    }


    render(renderer) {
        const prev_render_target = renderer.getRenderTarget();
        const prev_autoclear = renderer.autoClearColor;
        const prev_clear_color = new THREE.Color();
        renderer.getClearColor(prev_clear_color);
        if (USE_SHADER) {
            renderer.autoClearColor = false;
            renderer.setRenderTarget(this.buffer);
            renderer.clear();
        }
        renderer.render(this.inner_scene, this.inner_camera);
        if (USE_SHADER) {
            if (this.uniforms != null) {
                //this.uniforms.tex.value = this.buffer.texture;
            }
            renderer.setRenderTarget(prev_render_target);
            renderer.clear();
            renderer.clearDepth();
            renderer.render(this.scene, this.camera);
            renderer.autoClearColor = prev_autoclear;
            renderer.setClearColor(prev_clear_color);
        }
    }
}
