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
import { InstancedGeometryCollection } from './instanced_geom.js';
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader";

const USE_SHADER = true;
const SVG_SIZE = 80;

export class TessellateScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 40;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.clock = new THREE.Clock();
        this.base_group = new THREE.Group();

        this.beat_clock = new THREE.Clock(false);

        this.materials = [];

        this.num_per_side = 3;

        this.scene = new THREE.Scene();

          var light = new THREE.PointLight(0xffffff, 1, Infinity);

  this.scene.add(light);

        
        /*this.inst_geoms = new InstancedGeometryCollection(this.scene, 
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), true);*/

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
        this.inst_geoms = [];
        this.indices_of_cells = [];
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
                        this.inst_geoms.push(new InstancedGeometryCollection(this.base_group, geometry, false));


                        // Create a line from the geometry and the material
                        const line = new THREE.Line(geometry, this.materials[0]);
                        line.position.z = 0.5;
                        line.renderOrder = renderOrder++;

                        // Add the line to the group
                        group.add(line);
                    }
                }
                group.scale.multiplyScalar( 0.05 );
                group.scale.y *= - 1;


                //this.inst_geoms.push(new InstancedGeometryCollection(this.scene, new THREE.EdgesGeometry(new THREE.BoxGeometry(1)), true));


                group.position.set(-this.frustum_size / 2, this.frustum_size / 2, 0);
                const spacing = 12.45;
                const spacing_y = spacing / 2;
                const spacing_x = Math.sqrt(3) * spacing / 2;

                for (let i = 0; i < 3; i++) {
                    const vector = new THREE.Vector3(-5.35, 1.65, 0);
                    const quaternion = new THREE.Quaternion();
                    quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), i * 2 * Math.PI / 3);
                    vector.applyQuaternion(quaternion);
                    this.indices_of_cells.push([]);
                    for (let j = -6; j < 7; j++) {
                        for (let k = -6; k < 7; k++) {
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
                            this_pos.applyQuaternion(quaternion);

                            for (let l = 0; l < this.inst_geoms.length; l++) {
                                this.indices_of_cells[i].push([l,
                                        this.inst_geoms[l].create_geom(this_pos, new THREE.Color("blue"), new THREE.Vector3(0.05, -0.05, 0.05), i * 2 * Math.PI / 3)
                                    ]
                                );
                            }
                            cell.position.copy(this_pos);
                            cell.applyQuaternion(quaternion);
                            cell.wave_idx = j;
                            //this.cells[i].push(cell);
                            //this.base_group.add(cell);
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
                //console.log( 'SVG ' + ( xhr.loaded / xhr.total * 100 ) + '% loaded' );
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
        const beats_per_sec = this.get_local_bpm() / 60;
        const clock_dt = this.clock.getDelta();
        this.elapsed_time_beats += clock_dt * beats_per_sec;
        const beat_elapsed = this.beat_clock.getElapsedTime() * beats_per_sec * 2;
        this.evolve_time += 0.5 * clock_dt * beats_per_sec;
        const cur_rot = this.elapsed_time_beats * Math.PI * 2 / 128
        this.base_group.rotation.z = cur_rot;
        //this.base_group.rotation.x = this.isom_angle * 0.5 * (1 + Math.sin(this.elapsed_time_beats * Math.PI * 2 / 16));


        const get_jump_func = (i, r, t) => {
            const x = t - r / 100 - i;
            return Math.sin(Math.PI * Math.min(1, x % 3));
            return 1 * (Math.max(0, 2 * Math.sin(2 * Math.PI * (t + 1 / 3 * i + 1 / 200 * r) - 1)));
        }

        const color1 = new THREE.Color("blue");
        const color2 = new THREE.Color("magenta");
        const start_color = new THREE.Color();
        start_color.lerpColors(color1, color2, Math.abs((3 * cur_rot / (2 * Math.PI) % 2) - 1));
        const end_color = new THREE.Color("white");
        const t = this.elapsed_time_beats / 4;
        this.indices_of_cells.forEach((indices, i) => {
            for (const idx of indices) {
                const pos = this.inst_geoms[idx[0]].get_pos(idx[1]);
                const r = pos.x;
                const jump_frac = get_jump_func(i, r, t);
                pos.z = 8 * jump_frac;
                this.inst_geoms[idx[0]].set_pos(idx[1], pos);

                const this_color = new THREE.Color();
                this_color.lerpColors(start_color, end_color, jump_frac);
                this.inst_geoms[idx[0]].set_color(idx[1], this_color);
            }
        });
    }



    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        const delay = Math.max(60 / this.get_local_bpm() / 2 - this.env.total_latency, 0);
        this.beat_clock.stop();
        //setTimeout(() => { this.beat_clock.start(); }, delay * 1000);
    }
}
