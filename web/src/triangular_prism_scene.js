import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    ease, BeatClock, lerp_scalar, clamp, make_wireframe_cube
} from './util.js';
import { InstancedGeometryCollection } from './instanced_geom.js';

export class TriangularPrismScene extends VisScene {
    constructor(context) {
        super(context, 'rollingcube', 2, 180);

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
        this.tri_group = new THREE.Group();
        this.scene.add(this.tri_group);

        this.projectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

        this.wave_color_clock = new BeatClock(this);
        this.wave_color_clock.start();
        this.wave_scale_clock = new BeatClock(this);
        this.wave_scale_clock.start();
        this.sync_clock = new BeatClock(this);
        this.camera_rot_clock = new BeatClock(this);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
        directionalLight.position.set(1, 1, 1);
        this.scene.add(directionalLight);

        this.scrollSpeed = 1;
        this.scrollPosition = 0;

        this.prismSize = 1;
        this.prism_base_geom = this.create_prism_geometry();
        this.prism_collection = new InstancedGeometryCollection(this.tri_group, this.prism_base_geom);
        this.createPrismInstances();

        this.cube_side_len = this.prismSize * 3 / Math.sqrt(2);

        const isom_angle = Math.asin(1 / Math.sqrt(3));
        this.cube_group = new THREE.Group();
        this.cube = make_wireframe_cube([this.cube_side_len, this.cube_side_len, this.cube_side_len], "white", false);
        this.cube_group_1 = new THREE.Group();
        this.cube_group_1.rotation.x = isom_angle;
        this.cube_group_1.rotation.y = Math.PI / 4;
        this.cube_group_1.add(this.cube);
        this.cube_group.add(this.cube_group_1);
        this.cube_group.rotation.z = Math.PI / 6;
        this.cube_group.position.z = this.prismSize * 3;
        this.scene.add(this.cube_group);
        this.cube_group.visible = false;

        // Create the projected cube
        this.cube_projection = this.createProjectedCube();
        this.scene.add(this.cube_projection);

        this.rolls_per_sync = 1;
        this.camera_movement_syncs = 8;
        this.cube_rot = [0, 0];
        this.roll_dir = 2;
    }

    createProjectedCube() {
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({ color: 'white', depthTest: false });

        // Initialize with placeholder vertices
        const vertices = new Float32Array(24 * 3); // 12 edges, 2 points per edge, 3 coordinates per point
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

        return new THREE.LineSegments(geometry, material);
    }

    updateProjectedCube() {
        // Get the original vertices from the cube
        const originalPositions = this.cube.geometry.getAttribute('position');
        const projectedPositions = this.cube_projection.geometry.getAttribute('position');

        // Get the world matrix of the cube
        this.cube.updateMatrixWorld(true);
        const worldMatrix = this.cube.matrixWorld.clone();

        const vertex = new THREE.Vector3();
        const projectedVertex = new THREE.Vector3();

        // Project each vertex
        for (let i = 0; i < originalPositions.count; i++) {
            vertex.fromBufferAttribute(originalPositions, i);
            vertex.applyMatrix4(worldMatrix);
            this.projectionPlane.projectPoint(vertex, projectedVertex);
            projectedPositions.setXYZ(i, projectedVertex.x, projectedVertex.y, 0);
        }

        projectedPositions.needsUpdate = true;
    }

    create_prism_geometry() {
        const height = 0.5;
        const radius = this.prismSize;//2 / Math.sqrt(3);

        const tri_verts = [
            [0, radius],
            [-radius * Math.sqrt(3) / 2, -radius / 2],
            [radius * Math.sqrt(3) / 2, -radius / 2]
        ];

        const points = [];
        for (let i = 0; i < 3; i++) {
            // top line to next triangle point
            points.push(new THREE.Vector3(...tri_verts[i], height));
            points.push(new THREE.Vector3(...tri_verts[(i + 1) % 3], height));
            // bot line to next triangle point
            points.push(new THREE.Vector3(...tri_verts[i], 0));
            points.push(new THREE.Vector3(...tri_verts[(i + 1) % 3], 0));
            // line connecting top tri to bot tri
            points.push(new THREE.Vector3(...tri_verts[i], height));
            points.push(new THREE.Vector3(...tri_verts[i], 0));
        }
        return new THREE.BufferGeometry().setFromPoints(points);
    }

    createPrismInstances() {
        this.gridSize = 10;
        this.prismInstances = [];

        for (let x = -2 * this.gridSize; x < 2 * this.gridSize; x++) {
            for (let y = -this.gridSize; y < this.gridSize; y++) {
                const pos = new THREE.Vector3(
                    x * this.prismSize * Math.sqrt(3) / 2,
                    y * this.prismSize * 3 / 2 - this.prismSize,
                    0);
                const color = new THREE.Color("white");
                const scale = new THREE.Vector3(0.9, 0.9, 1);
                let rotation = 0;
                if (y % 2 != 0) {
                    pos.x += this.prismSize * Math.sqrt(3) / 2;
                }
                if (x % 2 != 0) {
                    pos.y += this.prismSize / 2;
                    rotation = Math.PI;
                }
                const prism = this.prism_collection.create_geom(pos, color, scale, rotation);
            }
        }
    }

    anim_frame(dt) {
        // Cube roll on 16th notes
        const sync_clock_beats = clamp(this.sync_clock.getElapsedBeats(), 0, 1);
        const camera_rot_beats = this.camera_rot_clock.getElapsedBeats();
        const cube_roll_frac = (sync_clock_beats * this.rolls_per_sync) % 1;
        //const num_rots = this.cube_rot[1];
        const num_rots = 0;
        this.camera.rotation.x = Math.PI / 4 * ease(clamp(1 / 0.6 *
            (Math.abs(2 * (camera_rot_beats / this.camera_movement_syncs) - 1) - 0.2),
            0, 1));
        //this.camera.rotation.x = 0;
        //this.camera.rotation.z += 0.05 * dt;
        //this.tri_group.rotation.z += 0.05 * dt;
        //this.camera.position.x += this.scrollSpeed * dt;

        const axis_arr = [0, 0, 0];
        const sign = [1, -1, 1];
        axis_arr[this.roll_dir] = 1;
        const theta = sign[this.roll_dir] * cube_roll_frac * Math.PI / 2;
        const quat = new THREE.Quaternion();
        quat.setFromAxisAngle(new THREE.Vector3().fromArray(axis_arr), theta);
        this.cube.setRotationFromQuaternion(quat);
        if (this.roll_dir == 0) {
            this.cube.position.y = 
                (3 * this.prismSize / 2) * Math.sin(theta + Math.PI / 4) - 1/2 * this.cube_side_len;
            this.cube.position.z = 
                -(3 * this.prismSize / 2) * Math.cos(theta + Math.PI / 4) - 1/2 * this.cube_side_len;
        } else if (this.roll_dir == 1) {
            this.cube.position.x = 
                -(3 * this.prismSize / 2) * Math.sin(theta + Math.PI / 4) - 1/2 * this.cube_side_len;
            this.cube.position.z = 
                -(3 * this.prismSize / 2) * Math.cos(theta + Math.PI / 4) - 1/2 * this.cube_side_len;
        } else if (this.roll_dir == 2) {
            this.cube.position.y = 
                -(3 * this.prismSize / 2) * Math.sin(theta + Math.PI / 4) - 1/2 * this.cube_side_len;
            this.cube.position.x = 
                -(3 * this.prismSize / 2) * Math.cos(theta + Math.PI / 4) - 1/2 * this.cube_side_len;
        }
        //let num_rots = Math.trunc(this.cube.rotation.z / (Math.PI / 2));
        //num_rots = 0;
        //this.cube.position.x = 0;
        /*this.cube.position.y = (num_rots - 1/2) * this.cube_side_len -
            (3 * this.prismSize / 2) * Math.cos(theta + Math.PI / 4);*/

        // Camera tracks cube, without the "bounce" orthogonal to plane
        const cube_world_pos = new THREE.Vector3(0, 0, 0);
        this.cube.localToWorld(cube_world_pos);

        this.camera.position.y = cube_world_pos.y;
        this.camera.position.x = cube_world_pos.x;


        this.updateProjectedCube();


        const tri_camera_offset = this.tri_group.position.clone();
        tri_camera_offset.sub(this.camera.position);
        if (tri_camera_offset.y > 2 * this.prismSize * 1.5) {
            this.tri_group.position.y -= 2 * this.prismSize * 1.5;
        }
        if (tri_camera_offset.y < -2 * this.prismSize * 1.5) {
            this.tri_group.position.y += 2 * this.prismSize * 1.5;
        }
        if (tri_camera_offset.x > this.prismSize * Math.sqrt(3)) {
            this.tri_group.position.x -= this.prismSize * Math.sqrt(3);
        }
        if (tri_camera_offset.x < -this.prismSize * Math.sqrt(3)) {
            this.tri_group.position.x += this.prismSize * Math.sqrt(3);
        }

        const elapsed_scale_beats = this.wave_scale_clock.getElapsedBeats();
        const elapsed_color_beats = this.wave_color_clock.getElapsedBeats();
        for (let i = 0; i < this.prism_collection.instancedGeometry.instanceCount; i++) {
            const from_camera = this.prism_collection.get_pos(i).clone();
            this.tri_group.localToWorld(from_camera);
            from_camera.sub(this.camera.position);
            let scale = 1;
            if (this.cur_state_idx > 0) {
                scale = clamp(0.9 + 0.3 * Math.sin(-2 * Math.PI * elapsed_scale_beats + from_camera.length()), 0, 1);
            }
            //const scale = clamp(0.7 + 0.05 * from_camera.length() * Math.sin(2 * 2 * Math.PI * elapsed_time), 0, 1) ** 2;
            const scale_vec = new THREE.Vector3(scale, scale, 1);
            this.prism_collection.set_scale(i, scale_vec);

            const saturation = 1.0;
            const lightness = 0.5;
            
            const color = new THREE.Color();
            color.setHSL(Math.sin(1 / 8 * elapsed_color_beats + 0.1 * from_camera.length()), saturation, lightness);
            this.prism_collection.set_color(i, color);
            /*if (from_camera.y > (this.gridSize - 1) * this.prismSize * 1.5) {
                pos.y -= (this.gridSize * 2) * this.prismSize * 1.5;
                this.prism_collection.set_pos(i, pos);
            }
            if (from_camera.y < -this.gridSize * this.prismSize * 1.5) {
                pos.y += (this.gridSize * 2) * this.prismSize * 1.5;
                this.prism_collection.set_pos(i, pos);
            }*/
        }
    }

    handle_beat(t, channel) {
        if (channel == 1) {
        }
    }

    handle_sync(t, bpm, beat) {
        const beat_to_start_clock_on = Math.ceil(1.0 / this.rolls_per_sync);
        if (beat % beat_to_start_clock_on == 0) {
            this.sync_clock.start();
            // Snap cube rotation to closest 90 degree angle
            for (const i in this.cube_rot) {
                this.cube_rot[i] += 1;
            }
            this.roll_dir = Math.floor(Math.random() * 3);
        }
        if (beat % this.camera_movement_syncs == 0) {
            this.camera_rot_clock.start();
            this.wave_scale_clock.start();
        }
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
