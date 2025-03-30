import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    ease, BeatClock, lerp_scalar, clamp, make_wireframe_cube
} from './util.js';
import { InstancedGeometryCollection } from './instanced_geom.js';

const CUBES_PER_SIDE = 10;
const CUBE_SIZE = 1;

function cosPalette(t, a, b, c, d) {
    // Create result color
    const result = new THREE.Color();
    
    // Calculate cosine terms for each channel
    const cosR = Math.cos(6.28318 * (c.r * t + d.r));
    const cosG = Math.cos(6.28318 * (c.g * t + d.g));
    const cosB = Math.cos(6.28318 * (c.b * t + d.b));
    
    // Set RGB values using the palette formula
    result.r = a.r + b.r * cosR;
    result.g = a.g + b.g * cosG;
    result.b = a.b + b.b * cosB;
    
    return result;
}

function palette(t) {
    // Define default palette colors
    const a = new THREE.Color(0.87, 0.38, 0.70);
    const b = new THREE.Color(0.83, 0.35, 0.05);
    const c = new THREE.Color(0.89, 0.65, 0.87);
    const d = new THREE.Color(0.69, 0.61, 0.01);
    
    // Alternative palette values (commented out as per original GLSL)
    // const a = new THREE.Color(0.5, 0.5, 0.5);
    // const b = new THREE.Color(0.5, 0.5, 0.5);
    // const c = new THREE.Color(1.0, 1.0, 1.0);
    // const d = new THREE.Color(0.0, 0.1, 0.2);
    
    return cosPalette(t, a, b, c, d);
}

function metaballs(x, y, z, time) {
    // Create 3 moving metaballs
    const balls = [
        {
            pos: new THREE.Vector3(
                Math.sin(time * 0.7) * 4,
                Math.cos(time * 0.8) * 4,
                Math.sin(time * 0.9) * 4
            ),
            strength: 12.0
        },
        {
            pos: new THREE.Vector3(
                Math.cos(time * 0.6) * 5,
                Math.sin(time * 1.1) * 5,
                Math.cos(time * 0.7) * 5
            ),
            strength: 8.0
        },
        {
            pos: new THREE.Vector3(
                Math.sin(time * 0.9) * 3,
                Math.cos(time * 0.5) * 3,
                Math.sin(time * 0.8) * 3
            ),
            strength: 8.0
        }
    ];

    // Calculate field value at point
    let value = 0;
    for (const ball of balls) {
        const dx = x - ball.pos.x;
        const dy = y - ball.pos.y;
        const dz = z - ball.pos.z;
        const dist_sq = dx * dx + dy * dy + dz * dz;
        value += ball.strength / dist_sq;
    }
    
    return value * 0.5; // Scale the result to get reasonable values
}

export class CellularAutomataScene extends VisScene {
    constructor() {
        super(3, 180);

        const aspect = window.innerWidth / window.innerHeight;
        this.frustumSize = 10;
        this.camera = new THREE.OrthographicCamera(
            -this.frustumSize * aspect / 2,
            this.frustumSize * aspect / 2,
            this.frustumSize / 2,
            -this.frustumSize / 2,
            -1000,
            1000
        );

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000);
        this.cube_group = new THREE.Group();
        this.scene.add(this.cube_group);

        this.light = new THREE.PointLight("white", 20, 0, 1.0);
        this.light.position.set(-10, 10, 0);
        this.scene.add(this.light);

        this.light2 = new THREE.DirectionalLight("white", 0.1);
        this.light2.position.set(100, 0, 0);
        this.scene.add(this.light2);

        // Create template for wireframe geometry
        {
            const template_wireframe = new THREE.BufferGeometry();
            // create a simple cube shape, using line segments
            const square_vertices = [
                [-0.5, -0.5],
                [0.5, -0.5],
                [0.5, 0.5],
                [-0.5, 0.5],
            ];
            const vert_buf = [];
            // Create the front and back faces of the cube
            for (let i = 0; i < 2; i++) {
                for (let j = 0; j < 4; j++) {
                    // Add a line between the current vertex and the next vertex
                    vert_buf.push(...square_vertices[j]);
                    vert_buf.push(i - 0.5);
                    vert_buf.push(...square_vertices[(j + 1) % 4]);
                    vert_buf.push(i - 0.5);
                }
            }
            // Create the lines between the front and back faces
            for (let j = 0; j < 4; j++) {
                // Add a line between the current vertex and the next vertex
                for (let i = 0; i < 2; i++) {
                    vert_buf.push(...square_vertices[j]);
                    vert_buf.push(i - 0.5);
                }
            }

            const vertices = new Float32Array(vert_buf);

            // itemSize = 3 because there are 3 values (components) per vertex
            template_wireframe.setAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
            template_wireframe.instanceCount = 1;


            this.inst_geom_wireframe = new InstancedGeometryCollection(
                this.cube_group, template_wireframe, 'Lines', 2000);
        }

        // Create template for fill cube
        {
            const template_fill = new THREE.SphereGeometry(CUBE_SIZE / 2, 15, 8);
            
            this.inst_geom_fill = new InstancedGeometryCollection(
                this.cube_group, template_fill, 'Triangles', 2000);
        }

        this.cell_values = [];
        const total_side_length = CUBES_PER_SIDE * CUBE_SIZE;
        for (let i = 0; i < CUBES_PER_SIDE; i++) {
            this.cell_values.push([]);
            for (let j = 0; j < CUBES_PER_SIDE; j++) {
                this.cell_values[i].push([]);
                for (let k = 0; k < CUBES_PER_SIDE; k++) {
                    this.cell_values[i][j].push(0);
                    const pos = new THREE.Vector3(
                        (i + 1 / 2) * CUBE_SIZE - total_side_length / 2,
                        (j + 1 / 2) * CUBE_SIZE - total_side_length / 2,
                        (k + 1 / 2) * CUBE_SIZE - total_side_length / 2);
                    this.inst_geom_wireframe.create_geom(pos, new THREE.Color("white"), new THREE.Vector3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), 0.0, 0.5);
                    this.inst_geom_fill.create_geom(pos, new THREE.Color("white"), new THREE.Vector3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE));
                }
            }
        }

        this.beat_clock = new BeatClock(this);

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.camera.rotation.x = isom_angle;
        this.elapsed_time = 0;
    }
    
    anim_frame(dt) {
        const adjusted_elapsed = (this.beat_clock.running && this.beat_clock.getElapsedBeats() < 0.5 ? 4 : 1) * dt;
        this.cube_group.rotation.y += 0.05 * dt;
        this.elapsed_time += adjusted_elapsed;

        const saturation = 1.0;
        const lightness = 0.5;

        for (let i = 0; i < CUBES_PER_SIDE; i++) {
            for (let j = 0; j < CUBES_PER_SIDE; j++) {
                for (let k = 0; k < CUBES_PER_SIDE; k++) {
                    const cell_val = this.cell_val_func(this.elapsed_time, i, j, k);
                    this.cell_values[i][j][k] = cell_val;
                    this.inst_geom_fill.set_scale(i * CUBES_PER_SIDE ** 2 + j * CUBES_PER_SIDE + k, new THREE.Vector3(cell_val, cell_val, cell_val));

                    let color = new THREE.Color();
                    //color.setHSL(Math.sin(1 / 8 * this.elapsed_time + 0.1 * j), saturation, lightness);
                    this.inst_geom_fill.set_scale(i * CUBES_PER_SIDE ** 2 + j * CUBES_PER_SIDE + k, new THREE.Vector3(cell_val, cell_val, cell_val));
                    if (this.cur_state_idx == 1) {
                        color = palette(1 / 8 * this.elapsed_time + 0.1 * j);
                    } else if (this.cur_state_idx == 0) {
                        color = new THREE.Color("white");
                    }
                    this.inst_geom_fill.set_color(i * CUBES_PER_SIDE ** 2 + j * CUBES_PER_SIDE + k, color);
                }
            }
        }

        if (this.cur_state_idx == 1 || this.cur_state_idx == 2) {
            this.light.intensity = 60;
            this.light2.intensity = 0.5;
        } else if (this.cur_state_idx == 0) {
            this.light.intensity = 40;
            this.light2.intensity = 0.1;
        }
    }

    cell_val_func(t, i, j, k) {
        if (this.cur_state_idx == 0) {
            return Math.cos(this.elapsed_time + i / 4);
        } else if (this.cur_state_idx == 1) {
            // Convert grid coordinates to world space coordinates
            const x = (i - CUBES_PER_SIDE/2);
            const y = (j - CUBES_PER_SIDE/2);
            const z = (k - CUBES_PER_SIDE/2);
            return Math.min(1.0, 2 * Math.tanh(metaballs(x, y, z, this.elapsed_time)) ** 4);
        }
    }


    handle_beat(t, channel) {
        if (channel == 1) {
            this.beat_clock.start();
        }
    }

    handle_sync(t, bpm, beat) {
        
    }

    handle_resize(width, height) {
        const aspect = width / height;
        this.camera.left = -this.frustumSize * aspect / 2;
        this.camera.right = this.frustumSize * aspect / 2;
        this.camera.top = this.frustumSize / 2;
        this.camera.bottom = -this.frustumSize / 2;
        this.camera.updateProjectionMatrix();
    }
}
