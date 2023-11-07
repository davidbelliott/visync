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

export class TessellateScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.clock = new THREE.Clock();
        this.base_group = new THREE.Group();

        this.cur_rotation = 0;
        this.beat_clock = new THREE.Clock(false);

        this.cells = [];

        this.num_per_side = 3;

        this.scene = new THREE.Scene();
        this.scene = new THREE.Scene();
        const loader = new SVGLoader();
        // load a SVG resource
        loader.load(
            // resource URL
            'img/lizard.svg',
            // called when the resource is loaded
            (data) => {
                const group = new THREE.Group();

                let renderOrder = 0;

                for ( const path of data.paths ) {

                        const fillColor = path.userData.style.fill;
                        const brightness = 0.5;

                        if ( true && fillColor !== undefined && fillColor !== 'none' ) {


                                const material = new THREE.MeshBasicMaterial( {
                                        color: new THREE.Color("blue"),
                                        opacity: path.userData.style.fillOpacity,
                                        transparent: true,
                                        side: THREE.DoubleSide,
                                        depthWrite: false,
                                        wireframe: false,
                                } );

                                const shapes = SVGLoader.createShapes( path );

                                for ( const shape of shapes ) {

                                        const geometry = new THREE.ShapeGeometry( shape );
                                        const mesh = new THREE.Mesh( geometry, material );
                                        mesh.renderOrder = renderOrder ++;

                                        group.add( mesh );

                                }

                        }

                        const strokeColor = path.userData.style.stroke;
                        const material = new THREE.LineBasicMaterial( {
                                color: "blue",
                                linewidth: 1,
                        } );

                        const fill_mat = new THREE.MeshBasicMaterial({
                            color: "black",
                            polygonOffset: true,
                            polygonOffsetFactor: 1, // positive value pushes polygon further away
                            polygonOffsetUnits: 1
                        });

                        if ( true && strokeColor !== undefined && strokeColor !== 'none' ) {
                            const shapes = SVGLoader.createShapes( path );
                            for ( let j = 0; j < shapes.length; j ++ ) {

                                const shape = shapes[ j ];
                                const meshGeometry = new THREE.ExtrudeGeometry(shape, {
                                    depth: 1,
                                    bevelEnabled: false,
                                });
                                const linesGeometry = new THREE.EdgesGeometry(meshGeometry);
                                const mesh = new THREE.Mesh(meshGeometry, fill_mat);
                                const lines = new THREE.LineSegments(linesGeometry, material);

                                /*const shape3d = new THREE.BufferGeometry().setFromPoints( shape.getPoints() );
                                const line = new THREE.LineLoop( shape3d, material );
                                group.add( line );
                                line.renderOrder = 1;
                                for (const hole of shape.getPointsHoles()) {
                                    const hole3d = new THREE.BufferGeometry().setFromPoints( hole );
                                    const hole_line = new THREE.LineLoop( hole3d, material );
                                    group.add( hole_line );
                                    hole_line.renderOrder = 1;
                                }*/
                                group.add(mesh);
                                group.add(lines);
                            }
                        }
                }
                group.scale.multiplyScalar( 0.05 );
                group.scale.y *= - 1;
                group.position.set(-this.frustum_size / 2, this.frustum_size / 2, 0);


                for (let i = 0; i < this.num_per_side; i++) {
                    for (let j = 0; j < this.num_per_side; j++) {
                        const cell = group.clone();
                        const spacing = 10;
                        cell.position.set(i * spacing - spacing * this.num_per_side / 2, j * spacing - spacing * this.num_per_side / 2, 0);
                        cell.rotation.z = 2 * Math.PI / 3 * (this.num_per_side * i + j);
                        this.cells.push(cell);
                        this.base_group.add(cell);
                    }
                }

                this.isom_angle = -Math.asin(1 / Math.sqrt(3));
                this.base_group.rotation.x = this.isom_angle;     // isometric angle
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
        this.elapsed_time_beats = 0;
        update_orth_camera_aspect(this.camera, aspect, this.frustum_size);

    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        const clock_dt = this.clock.getDelta();
        this.elapsed_time_beats += clock_dt * beats_per_sec;
        const beat_elapsed = this.beat_clock.getElapsedTime() * beats_per_sec * 2;
        this.evolve_time += 0.5 * clock_dt * beats_per_sec;
        this.base_group.rotation.z = this.elapsed_time_beats * Math.PI * 2 / 32;
        this.base_group.rotation.x = this.isom_angle * 0.5 * (1 + Math.sin(this.elapsed_time_beats * Math.PI * 2 / 16));
        for (const i in this.cells) {
            this.cells[i].scale.z = 2 * (1 + Math.sin(this.elapsed_time_beats * Math.PI * 2 / 8 + i * Math.PI / 3));
        }
    }



    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        const delay = Math.max(60 / this.env.bpm / 2 - this.env.total_latency, 0);
        this.beat_clock.stop();
        //setTimeout(() => { this.beat_clock.start(); }, delay * 1000);
    }
}
