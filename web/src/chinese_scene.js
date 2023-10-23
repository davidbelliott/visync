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
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock();
        this.base_group = new THREE.Group();

        this.cur_rotation = 0;

        this.shader_loader = new ResourceLoader(['glsl/hex_shader.vert', 'glsl/hex_shader.frag']);
        Promise.all([this.shader_loader.load(), load_texture('img/romaO.png')]).then(
            ([[vertex_shader, fragment_shader], texture]) => {
            this.uniforms = {
                time: { type: 'f', value: 0.0 },
                resolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                palette: { type: 't', value: texture },
            };
            let material = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: vertex_shader,
                fragmentShader: fragment_shader,
                transparent: true,
            });
            //material = new THREE.MeshBasicMaterial({ color: "red" });
            let geometry = new THREE.PlaneGeometry(this.cam_orth.right - this.cam_orth.left,
                this.cam_orth.top - this.cam_orth.bottom);
            this.plane = new THREE.Mesh(geometry, material);
            this.plane.position.z = -100;   // position in front of other objects
            this.scene.add(this.plane);
        });


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
                            console.log(mesh);
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

        this.scene.add(this.base_group);
        this.camera = this.cam_orth;
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

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
    }
}
