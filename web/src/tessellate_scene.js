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
        this.frustum_size = 30;
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

        this.cells = [[], [], []];
        this.materials = [];

        this.num_per_side = 3;

        this.scene = new THREE.Scene();
        this.scene = new THREE.Scene();

        // Create a material for the lines

        for (let i = 0; i < 3; i++) {
            this.materials[i] = new THREE.LineBasicMaterial({
                        color: "blue",
                        linewidth: 1,
                        });
        }

        const fill_mat = new THREE.MeshBasicMaterial({
                                    color: "black",
                                    polygonOffset: true,
                                    polygonOffsetFactor: 1, // positive value pushes polygon further away
                                    polygonOffsetUnits: 1
                                });

        const loader = new SVGLoader();
        // load a SVG resource
        loader.load(
            // resource URL
            'img/lizard.svg',
            // called when the resource is loaded
            (data) => {
                const group = new THREE.Group();

                let renderOrder = 0;

                for (const path of data.paths) {

                    // Iterate over each subPath
                    for (const subPath of path.subPaths) {
                        // Use the getSpacedPoints method to get a set of points along the path
                        const points = subPath.getPoints();

                        // Create a geometry from the points
                        const geometry = new THREE.BufferGeometry().setFromPoints(points);

                        // Create a line from the geometry and the material
                        const line = new THREE.Line(geometry, this.materials[0]);
                        line.position.z = 0.5;
                        line.renderOrder = renderOrder++;

                        // Add the line to the group
                        group.add(line);





// Extrude the line by creating vertices at an offset (extrusion) along the Z-axis
                        /*const extrudeDepth = 1;
                        const vertices = [];
                        const indices = [];

                        // Loop over the points to create a "wall" of vertices
                        for (let i = 0; i < points.length; i++) {
                            const pt = points[i];
                            //const ptNext = points[i + 1] || points[0];
                            const ptNext = points[i + 1];

                            let baseIndex = 4 * i;

                            // Create two vertices for the current point, at different z positions
                            const v1 = new THREE.Vector3(pt.x, pt.y, 0);
                            const v2 = new THREE.Vector3(pt.x, pt.y, extrudeDepth);
                            vertices.push(v1, v2);

                            if (ptNext) {
                                // Same for the next point
                                const v3 = new THREE.Vector3(ptNext.x, ptNext.y, 0);
                                const v4 = new THREE.Vector3(ptNext.x, ptNext.y, extrudeDepth);

                                vertices.push(v3, v4);
                                indices.push(baseIndex, baseIndex + 1, baseIndex + 3, baseIndex + 2, baseIndex);
                            } else {
                                indices.push(baseIndex, baseIndex + 1);
                            }
                            //extrudeGeom.vertices.push(v1, v2, v3, v4);
                        }
                        const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
                        geometry.setIndex(indices);

                        // Create a mesh from the custom geometry
                        const edges = new THREE.EdgesGeometry( geometry );
                        const mesh = new THREE.Mesh(geometry, material);
                        const lines = new THREE.Line(edges, material);
                        group.add(lines);*/


                    }

                    const shapes = SVGLoader.createShapes( path );

                    for ( const shape of shapes ) {

                            //const geometry = new THREE.ShapeGeometry( shape );
                            //const mesh = new THREE.Mesh( geometry, material );
                            //mesh.renderOrder = renderOrder ++;

                            //group.add( mesh );
                            const meshGeometry = new THREE.ExtrudeGeometry(shape, {
                                depth: 0.5,
                                bevelEnabled: false,
                            });
                            const linesGeometry = new THREE.EdgesGeometry(meshGeometry, 10);
                            const mesh = new THREE.Mesh(meshGeometry, fill_mat);
                            const lines = new THREE.LineSegments(linesGeometry, this.materials[0]);
                            //group.add(mesh);
                            //group.add(lines);
                    }
                }
                group.scale.multiplyScalar( 0.05 );
                group.scale.y *= - 1;
                group.position.set(-this.frustum_size / 2, this.frustum_size / 2, 0);
                const spacing = 12.45;
                const spacing_y = spacing / 2;
                const spacing_x = Math.sqrt(3) * spacing / 2;

                for (let i = 0; i < 3; i++) {
                    const vector = new THREE.Vector3(-5.35, 1.65, 0);
                    const quaternion = new THREE.Quaternion();
                    quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), i * 2 * Math.PI / 3);
                    vector.applyQuaternion(quaternion);
                    for (let j = -5; j < 5; j++) {
                        for (let k = -5; k < 5; k++) {
                            const quaternion2 = new THREE.Quaternion();
                            quaternion2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 2 * Math.PI / 3);

                            const offset = new THREE.Vector3(spacing_x * j, spacing_y * j, 0);
                            offset.add(new THREE.Vector3(2 * spacing_x * k, 0, 0));
                            //offset.applyQuaternion(quaternion2);

                            if (k % 2 == 1) {
                                //offset.add(new THREE.Vector3(0, spacing_y / 2, 0));
                            }



                            const this_pos = vector.clone();
                            this_pos.add(offset);

                            //const vector = new THREE.Vector3(-5.35, 1.65, 0);
                            //vector.add(offset);

                            const cell = group.clone();
                            for (const child of cell.children) {
                                if (child.material.type == "LineBasicMaterial") {
                                    child.material = this.materials[i];
                                }
                            }
                            cell.position.copy(this_pos);
                            cell.applyQuaternion(quaternion);
                            cell.wave_idx = j;
                            this.cells[i].push(cell);
                            this.base_group.add(cell);
                        }
                    }
                }


                for (let i = 0; i < this.num_per_side; i++) {
                    for (let j = 0; j < this.num_per_side; j++) {
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

    get_palette_color(t) {
        const a = [0.5, 0.5, 0.5];
        const b = [0.5, 0.5, 0.5];
        const c = [2.0, 1.0, 0.0];
        const d = [0.5, 0.2, 0.25];

        const out = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            out[i] = a[i] + b[i] * Math.cos(2 * Math.PI * ( c[i] * t + d[i] ) );
        }
        console.log(out);
        return new THREE.Color(...out);
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        const clock_dt = this.clock.getDelta();
        this.elapsed_time_beats += clock_dt * beats_per_sec;
        const beat_elapsed = this.beat_clock.getElapsedTime() * beats_per_sec * 2;
        this.evolve_time += 0.5 * clock_dt * beats_per_sec;
        this.base_group.rotation.z = this.elapsed_time_beats * Math.PI * 2 / 128;
        //this.base_group.rotation.x = this.isom_angle * 0.5 * (1 + Math.sin(this.elapsed_time_beats * Math.PI * 2 / 16));

        const beats_per_color_cycle = 8.0;
        for (let i = 0; i < 3; i++) {
            const cur_color = new THREE.Color();
            const frac = (this.elapsed_time_beats / beats_per_color_cycle + i / 8) % 1;
            //cur_color.lerpColors(start_color, end_color, frac);




            //this.materials[i].color = this.get_palette_color(frac);
            //this.materials[i].color = cur_color;
        }

        const start_color = new THREE.Color("blue");
        const end_color = new THREE.Color("white");
        for (const i in this.cells) {
            for (const j in this.cells[i]) {
                const r = this.cells[i][j].position.x;
                const jump_frac = (Math.max(1, 2 * 
                    Math.sin(this.elapsed_time_beats / 8 * 2 * Math.PI + (2 / 3 * i + 1 / 200 * r) * Math.PI)) - 1)
                this.cells[i][j].position.z = 8 * jump_frac;
                this.materials[i].color.lerpColors(start_color, end_color, jump_frac);
            }
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
