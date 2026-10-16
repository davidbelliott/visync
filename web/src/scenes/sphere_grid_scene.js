import * as THREE from 'three';
import { Scene } from './scene.js';
import {
    ease, BeatClock, lerp_scalar, clamp, make_wireframe_cube
} from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';

const CUBES_PER_SIDE = 10;
const CUBE_SIZE = 1;

// The cosine palette a + b cos(2 pi (c t + d)), per channel, into target.
function cosPalette(t, a, b, c, d, target) {
    return target.setRGB(
        a.r + b.r * Math.cos(6.28318 * (c.r * t + d.r)),
        a.g + b.g * Math.cos(6.28318 * (c.g * t + d.g)),
        a.b + b.b * Math.cos(6.28318 * (c.b * t + d.b)));
}

// Default palette colors (alternatives, as in the original GLSL: a and b
// 0.5 grey, c white, d (0, 0.1, 0.2)).
const PALETTE_A = new THREE.Color(0.87, 0.38, 0.70);
const PALETTE_B = new THREE.Color(0.83, 0.35, 0.05);
const PALETTE_C = new THREE.Color(0.89, 0.65, 0.87);
const PALETTE_D = new THREE.Color(0.69, 0.61, 0.01);

function palette(t, target) {
    return cosPalette(t, PALETTE_A, PALETTE_B, PALETTE_C, PALETTE_D, target);
}

// 3 moving metaballs: centres set once a frame by place_metaballs (they move
// with time only), then sampled per cube by metaballs.
const METABALLS = [
    { x: 0, y: 0, z: 0, strength: 12.0 },
    { x: 0, y: 0, z: 0, strength: 8.0 },
    { x: 0, y: 0, z: 0, strength: 8.0 },
];

function place_metaballs(time) {
    const [b0, b1, b2] = METABALLS;
    b0.x = Math.sin(time * 0.7) * 4; b0.y = Math.cos(time * 0.8) * 4; b0.z = Math.sin(time * 0.9) * 4;
    b1.x = Math.cos(time * 0.6) * 5; b1.y = Math.sin(time * 1.1) * 5; b1.z = Math.cos(time * 0.7) * 5;
    b2.x = Math.sin(time * 0.9) * 3; b2.y = Math.cos(time * 0.5) * 3; b2.z = Math.sin(time * 0.8) * 3;
}

// The field at (x, y, z), from the centres place_metaballs last set.
function metaballs(x, y, z) {
    let value = 0;
    for (const ball of METABALLS) {
        const dx = x - ball.x;
        const dy = y - ball.y;
        const dz = z - ball.z;
        value += ball.strength / (dx * dx + dy * dy + dz * dz);
    }
    return value * 0.5; // Scale the result to get reasonable values
}

const WHITE = new THREE.Color('white');

export class SphereGridScene extends Scene {
    constructor(context) {
        super(context, 'spheregrid', 2);


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

        this.clear();
        this.background = new THREE.Color(0x000000);
        this.cell_scale = new THREE.Vector3();     // per-cube scratch (anim_frame)
        this.cell_color = new THREE.Color();
        this.cube_group = new THREE.Group();
        this.add(this.cube_group);

        this.light = new THREE.PointLight("white", 20, 0, 1.0);
        this.light.position.set(-10, 10, 0);
        this.add(this.light);

        this.light2 = new THREE.DirectionalLight("white", 0.1);
        this.light2.position.set(100, 0, 0);
        this.add(this.light2);

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
                    this.inst_geom_wireframe.create_geom(pos, new THREE.Color("white"), new THREE.Vector3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE), null, 0.25);
                    this.inst_geom_fill.create_geom(pos, new THREE.Color("white"), new THREE.Vector3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE));
                }
            }
        }

        this.beat_clock = new BeatClock(this);

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.camera.rotation.x = isom_angle;
        this.elapsed_time = 0;

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }
    
    anim_frame(dt) {
        const adjusted_elapsed = (this.beat_clock.running && this.beat_clock.getElapsedBeats() < 0.5 ? 4 : 1) * dt;
        // Spin with the shared view yaw at a quarter of its pace (0.05 rad/s
        // at 1x).
        this.cube_group.rotation.y = this.view_yaw(0.25);
        this.elapsed_time += adjusted_elapsed;

        // Scratch, reused for every cube (the setters copy the values).
        const scale = this.cell_scale;
        const color = this.cell_color;
        if (this.cur_state_idx == 1) {
            place_metaballs(this.elapsed_time);
        }
        for (let i = 0; i < CUBES_PER_SIDE; i++) {
            for (let j = 0; j < CUBES_PER_SIDE; j++) {
                for (let k = 0; k < CUBES_PER_SIDE; k++) {
                    const idx = i * CUBES_PER_SIDE ** 2 + j * CUBES_PER_SIDE + k;
                    const cell_val = this.cell_val_func(this.elapsed_time, i, j, k);
                    this.cell_values[i][j][k] = cell_val;
                    this.inst_geom_fill.set_scale(idx, scale.setScalar(cell_val));
                    if (this.cur_state_idx == 1) {
                        palette(1 / 8 * this.elapsed_time + 0.1 * j, color);
                    } else if (this.cur_state_idx == 0) {
                        color.copy(WHITE);
                    } else {
                        color.setRGB(0, 0, 0);
                    }
                    this.inst_geom_fill.set_color(idx, color);
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
            return Math.min(1.0, 2 * Math.tanh(metaballs(x, y, z)) ** 4);
        }
    }


    handle_beat(t, channel) {
        if (channel == 1) {
            // On the (latency-compensated) beat, not as the message lands.
            setTimeout(() => this.beat_clock.start(), this.get_beat_delay() * 1000);
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
