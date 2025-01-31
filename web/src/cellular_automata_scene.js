import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    ease, BeatClock, lerp_scalar, clamp, make_wireframe_cube
} from './util.js';
import { InstancedGeometryCollection } from './instanced_geom.js';

const CUBES_PER_SIDE = 2;
const CUBE_SIZE = 1;

export class CellularAutomataScene extends VisScene {
    constructor() {
        super(2, 180);

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

        const geometry = new THREE.BufferGeometry();

        // create a simple cube shape, using line segments
        const square_vertices = [
            [-1.0, -1.0],
            [1.0, -1.0],
            [1.0, 1.0],
            [-1.0, 1.0],
        ];
        const vert_buf = [];
        // Create the front and back faces of the cube
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 4; j++) {
                // Add a line between the current vertex and the next vertex
                vert_buf.push(...square_vertices[j]);
                vert_buf.push(i * 2 - 1);
                vert_buf.push(...square_vertices[(j + 1) % 4]);
                vert_buf.push(i * 2 - 1);
            }
        }
        // Create the lines between the front and back faces
        for (let j = 0; j < 4; j++) {
            // Add a line between the current vertex and the next vertex
            for (let i = 0; i < 2; i++) {
                vert_buf.push(...square_vertices[j]);
                vert_buf.push(i * 2 - 1);
            }
        }

        const vertices = new Float32Array(vert_buf);

        // itemSize = 3 because there are 3 values (components) per vertex
        geometry.setAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
        geometry.instanceCount = 1;


        this.inst_geom = new InstancedGeometryCollection(this.cube_group, geometry, true);

        const total_side_length = CUBES_PER_SIDE * CUBE_SIZE;
        for (let i = 0; i < CUBES_PER_SIDE; i++) {
            for (let j = 0; j < CUBES_PER_SIDE; j++) {
                for (let k = 0; k < CUBES_PER_SIDE; k++) {
                    const pos = new THREE.Vector3(i * CUBE_SIZE - total_side_length / 2,
                        j * CUBE_SIZE - total_side_length / 2,
                        k * CUBE_SIZE - total_side_length / 2);
                    this.inst_geom.create_geom(pos, new THREE.Color("white"), new THREE.Vector3(1, 1, 1));
                }
            }
        }


        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.camera.rotation.x = isom_angle;
    }
    

    anim_frame(dt) {
        this.cube_group.rotation.y += 0.002;
    }

    handle_beat(t, channel) {
        if (channel == 1) {
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
