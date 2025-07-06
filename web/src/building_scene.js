import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    create_instanced_cube_templates,
    create_instanced_cube,
    make_wireframe_cone,
    rand_int,
    arr_eq,
    Spark,
    BeatClock
} from './util.js';
import { InstancedGeometryCollection } from './instanced_geom.js';

const CUBE_WAVE_SPEED = 1.5;
const NUM_CUBES_PER_SIDE = 10;

class Excitation extends THREE.Object3D {
    constructor(init_time) {
        super();
        this.init_time = init_time;
    }
}

const State = {
    PLACED: "placed",
    LIFTING: "lifting",
    FALLING: "falling"
};

const MAX_NUM_INST = 40000;

class Cube {
    constructor(wireframe_collection, solid_collection, wireframe_color,
            solid_color, opacity, position, scale, state=State.PLACED) {
        this.wireframe_collection = wireframe_collection;
        this.solid_collection = solid_collection;
        this.wireframe_color = wireframe_color;
        this.solid_color = solid_color;
        this.opacity = opacity;
        this.position = position;
        this.scale = scale;
        this.state = state;

        this.wireframe_geom_idx = wireframe_collection.create_geom(position, wireframe_color, scale, 0, 1);
        this.solid_geom_idx = solid_collection.create_geom(position, solid_color, scale, 0, 0.5);
    }

    update(dt) {
        this.wireframe_collection.set_pos(this.wireframe_geom_idx, this.position);
        this.wireframe_collection.set_scale(this.wireframe_geom_idx, this.scale);
        this.wireframe_collection.set_color(this.wireframe_geom_idx, this.wireframe_color);

        this.solid_collection.set_pos(this.solid_geom_idx, this.position);
        this.solid_collection.set_scale(this.solid_geom_idx, this.scale);
        this.solid_collection.set_color(this.solid_geom_idx, this.solid_color);
    }
}

class Kicker {
    constructor(wireframe_collection, solid_collection, wireframe_color,
            solid_color, opacity, position, scale) {
        this.wireframe_collection = wireframe_collection;
        this.solid_collection = solid_collection;
        this.wireframe_color = wireframe_color;
        this.solid_color = solid_color;
        this.opacity = opacity;
        this.position = position;
        this.scale = scale;

        this.wireframe_geom_idx = wireframe_collection.create_geom(position, wireframe_color, scale, 0, 1);
        this.solid_geom_idx = solid_collection.create_geom(position, solid_color, scale, 0, 0.5);
    }

    update(dt) {
        this.wireframe_collection.set_pos(this.wireframe_geom_idx, this.position);
        this.wireframe_collection.set_scale(this.wireframe_geom_idx, this.scale);
        this.wireframe_collection.set_color(this.wireframe_geom_idx, this.wireframe_color);

        this.solid_collection.set_pos(this.solid_geom_idx, this.position);
        this.solid_collection.set_scale(this.solid_geom_idx, this.scale);
        this.solid_collection.set_color(this.solid_geom_idx, this.solid_color);
    }
}

class Gantry {
    constructor(parent_scene, parent_obj, cubes_inst, width, start_xz) {
        const start_pos = new THREE.Vector3(start_xz.x,
            10 + 5.929,  // sqrt(2) * 5 * tan(pi / 8) + 1.5 + 0.5 + 1
            start_xz.z);
        this.base_y = start_pos.y;
        this.paddle_base_y = -1.0;
        this.paddle_start_y = this.paddle_base_y;
        this.paddle_end_y = (1.5 + 0.5) - this.base_y;

        this.parent_obj = parent_obj;
        this.clock = new THREE.Clock(false);
        this.move_clock = new BeatClock(parent_scene);
        this.pound_clock = new THREE.Clock(false);
        this.start_sweep_time = null;
        this.end_sweep_time = null;
        this.start_sweep_pos = new THREE.Vector3();
        this.start_sweep_pos.copy(start_pos);
        this.end_sweep_pos = new THREE.Vector3();
        this.end_sweep_pos.copy(start_pos);
        this.segments = [];
        this.time_waypoints = [];
        // Paddle part
        this.mover = new THREE.Group();
        this.paddle = create_instanced_cube([3, 1, 3], "white", true, "black", 0.5);
        this.paddle.position.y = this.paddle_base_y;
        this.mover.add(this.paddle);

        this.cube_top = create_instanced_cube([1, 1, 1], "white", true, "black", 0.5);
        this.mover.add(this.cube_top);

        this.cube_intersection = create_instanced_cube([1.01, 0.5, 0.5], "white", true, "black", 0.5);
        this.cube_intersection.add(create_instanced_cube([0.5, 1.01, 0.5], "white", true, "black", 0.5));
        this.cube_top.add(this.cube_intersection);

        this.vertical_beam = create_instanced_cube([0.5, 6.0, 0.5], "white", true, "black", 0.5);
        this.vertical_beam.position.y = 3.5;
        this.paddle.add(this.vertical_beam);

        this.mover.position.copy(start_pos);
        parent_obj.add(this.mover);
        this.parent_scene = parent_scene;

        this.x_beam = create_instanced_cube([width, 0.5, 0.5], "white", true, "black", 0.5);
        this.x_beam.position.copy(start_pos);
        this.x_beam.position.x = 0;
        parent_obj.add(this.x_beam);

        this.cubes_inst = cubes_inst;

        this.clock.start();
        this.max_pound_s = 0.15;
        this.pound_movement_secs = this.max_pound_s;
    }

    anim_frame(dt) {
        const sweep_beats = 2;

        // Sweeping
        {
            let frac = ease(Math.min(1, this.move_clock.getElapsedBeats() / sweep_beats));

            let cur_seg = 0;
            let frac_seg = frac;
            let start_offset = new THREE.Vector3(0, 0, 0);
            let end_offset = start_offset.clone();
            this.time_waypoints.every((t, i) => {
                if (t >= frac || i == this.time_waypoints.length - 1) {
                    cur_seg = i;
                    if (t > 0.01) {
                        frac_seg = frac / t;
                    }
                    end_offset.copy(start_offset);
                    end_offset.add(this.segments[i]);
                    return false;
                }
                start_offset.add(this.segments[i]);
                frac -= t;
                return true;
            });
            start_offset.lerp(end_offset, frac_seg);
            start_offset.add(this.start_sweep_pos);
            this.set_cube_xz(start_offset);
        }

        // Pounding
        {
            const t = this.pound_clock.getElapsedTime() / this.pound_movement_secs;
            let start_y = this.paddle_start_y;
            let end_y = this.paddle_end_y;
            const frac = (1 - Math.abs(Math.min(2, Math.max(0, t)) - 1)) ** 2;
            this.paddle.position.y = lerp_scalar(start_y, end_y, frac);
        }
    }

    set_cube_target_idx(i, j) {
        const pos = this.cubes_inst.get_pos(i * NUM_CUBES_PER_SIDE + j);
        this.target_indices = [i, j];
        this.end_sweep_pos.copy(pos);
        this.end_sweep_pos.y = this.base_y;
        this.start_sweep_pos.copy(this.mover.position);

        this.segments = this.segmentize_path_45deg(
            this.end_sweep_pos.clone().sub(this.start_sweep_pos));

        this.time_waypoints = [];
        let total_length = 0;
        for (const seg of this.segments) {
            total_length += seg.length();
        }
        for (const seg of this.segments) {
            let this_seg = seg.length() / total_length;
            if (isNaN(this_seg)) {
                this_seg = 0;
            }
            this.time_waypoints.push(this_seg);
        }
    }

    set_cube_xz(pos) {
        this.mover.position.x = pos.x;
        this.mover.position.z = pos.z;
        this.x_beam.position.z = pos.z;
    }

    move_system(offset) {
        this.mover.position.add(offset);
        this.x_beam.position.add(offset);
        this.start_sweep_pos.add(offset);
        this.end_sweep_pos.add(offset);
    }

    segmentize_path_45deg(offset) {
        const smallest_component = Math.min(Math.abs(offset.x), Math.abs(offset.z));
        const segments = [];
        segments.push(new THREE.Vector3(
            Math.sign(offset.x) * smallest_component,
            0,
            Math.sign(offset.z) * smallest_component));
        segments.push(offset.clone().sub(segments[0]));
        return segments;
    }

    start_pound(latency, sparks) {
        /*if (this.pound_clock.getElapsedTime() * beats_per_sec < 2 * this.pound_movement_beats) {
            // has not fully returned to top position
            this.paddle_start_y = this.paddle.position.y;
        } else {
            this.paddle_start_y = this.paddle_base_y;
        }*/
        this.pound_movement_secs = Math.min(this.max_pound_s,
            this.parent_scene.get_beat_delay(latency));
        this.pound_clock.start();
        setTimeout(() => {
            if (sparks) {
                const sparks_origin = this.mover.position.clone();
                sparks_origin.y = 1.5;
                this.parent_scene.create_sparks(sparks_origin, 5, 25, "white");
            }
            this.parent_scene.add_excitation(new THREE.Vector3(
                this.mover.position.x, 0, this.mover.position.z));
        }, 1000 * this.pound_movement_secs);
    }
}


export class BuildingScene extends VisScene {
    constructor(context) {
        super(context, 'building');

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 40;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.rot_clock = new BeatClock(this);
        this.zoom_clock = new BeatClock(this);
        this.beat_idx = 0;

        this.base_group = new THREE.Group();
        this.cubes_group = new THREE.Group();
        this.cubes = [];
        this.sparks = [];
        this.max_num_sparks = 64;
        this.cur_spark_idx = 0;
        for (let i = 0; i < this.max_num_sparks; i++) {
            const s = new Spark(0.3, "white", [0, 1]);
            s.active = false;
            this.cubes_group.add(s);
            this.sparks.push(s);
        }

        this.cube_base_size = 3;
        this.cube_base_height = 3;
        this.cube_base_spacing = 0.5;
        this.drift_vel = 0.0;

        this.start_zoom = 1;
        this.target_zoom = 1;
        this.zoom_movement_beats = 1;

        this.target_rot_y = 0;      // integer multiples of PI / 16
        this.start_rot_y = 0;       // integer multiples of PI / 16
        this.rotation_movement_beats = 8;

        const width = NUM_CUBES_PER_SIDE * this.cube_base_size + 
            (NUM_CUBES_PER_SIDE - 1) * this.cube_base_spacing;
        const center_offset = -(width - this.cube_base_size) / 2;

        const [cube_wire_geom, cube_solid_geom] = create_instanced_cube_templates(this.cube_base_size, this.cube_base_height, this.cube_base_size);
        this.wireframe_cubes = new InstancedGeometryCollection(this.cubes_group, cube_wire_geom, "Lines", MAX_NUM_INST);
        this.solid_cubes = new InstancedGeometryCollection(this.cubes_group, cube_solid_geom, "Triangles", MAX_NUM_INST);
        this.spheres = [];

        for (let i = 0; i < NUM_CUBES_PER_SIDE; i++) {
            for (let j = 0; j < NUM_CUBES_PER_SIDE; j++) {
                const depth = rand_int(12, 18);
                for (let k = 0; k < depth; k++) {
                    let position = new THREE.Vector3(
                        j * (this.cube_base_size + this.cube_base_spacing) + center_offset,
                        k * (this.cube_base_size + this.cube_base_spacing),
                        i * (this.cube_base_size + this.cube_base_spacing) + center_offset);
                    //const cube_mesh = create_instanced_cube(, "magenta", true, "black", 0.5);
                    const cube = new Cube(
                        this.wireframe_cubes,
                        this.solid_cubes,
                        new THREE.Color("magenta"),
                        new THREE.Color("purple"),
                        0.5,
                        position,
                        new THREE.Vector3(1, 1, 1));
                    this.cubes.push(cube);
                }
                if (rand_int(0, 20) == 0) {
                    let position = new THREE.Vector3(
                        j * (this.cube_base_size + this.cube_base_spacing) + center_offset,
                        depth * this.cube_base_size + (depth) * this.cube_base_spacing - 0.00 * this.cube_base_size,
                        i * (this.cube_base_size + this.cube_base_spacing) + center_offset);
                    /*const cone = new Cube(
                        this.wireframe_cubes,
                        this.solid_cubes,
                        new THREE.Color("white"),
                        new THREE.Color("purple"),
                        0.5,
                        position,
                        new THREE.Vector3(1, 0.5, 1));
                    this.cubes.push(cube);*/
                    /*const cone = make_wireframe_cone(this.cube_base_size / 2,
                        this.cube_base_size,
                        4,
                        new THREE.Color("purple"),
                        true,
                    );
                    cone.rotation.y = Math.PI / 4;
                    cone.position.copy(position);
                    this.cubes_group.add(cone);*/
                    const sphereGeometry = new THREE.SphereGeometry(this.cube_base_size / 2, 32, 32);
                    const lambertMaterial = new THREE.MeshLambertMaterial({ 
                        color: "purple",
                        transparent: true,
                        opacity: 1.0
                    });
                    const sphere = new THREE.Mesh(sphereGeometry, lambertMaterial);
                    sphere.castShadow = true;
                    sphere.receiveShadow = true;
                    sphere.position.copy(position);
                    this.cubes_group.add(sphere);
                    this.spheres.push(sphere);

                    const light = new THREE.PointLight("white", 5, 0, 1.0);
                    sphere.add(light);
                }
            }
        }

        //this.light = new THREE.PointLight("white", 20, 0, 1.0);
        //this.light.position.set(1, 20, 20);
        //this.base_group.add(this.light);
        
        /*this.gantries = [];
        for (let i = 0; i < 2; i++) {
            this.gantries.push(
                new Gantry(this, this.cubes_group, this.wireframe_cubes, width,
                    new THREE.Vector3(2, 0, 2)));
        }
        this.moving_gantry_idx = 0;
        this.pounding_gantry_idx = 1;*/

        const isom_angle = Math.asin(1 / Math.sqrt(3));


        this.base_group.rotation.x = isom_angle;//Math.PI / 8.0;
        this.base_group.rotation.y = Math.PI / 4.0;

        this.base_group.add(this.cubes_group);
        this.scene.add(this.base_group);

        this.camera = this.cam_orth;
        this.camera.position.y = this.cube_base_size * (12 + 18) / 2;


        this.marker_cube = new THREE.Object3D();//create_instanced_cube(Array(3).fill(1), "yellow");
        this.marker_cube.position.set(0, 6, 0);
        this.cubes_group.add(this.marker_cube);

    }

    anim_frame(dt) {
        const cube_moves_per_beat = 4;

        for (const cube of this.cubes) {
            cube.update(dt);
        }

        for (const sphere of this.spheres) {
            sphere.position.x += 0.5 * dt;
        }


        // Y rotation
        const rot_frac = ease(Math.min(1, this.rot_clock.getElapsedBeats() / this.rotation_movement_beats));
        this.base_group.rotation.y = Math.PI * (1 / 4 + lerp_scalar(this.start_rot_y, this.target_rot_y, rot_frac) / 2);
        const start_color = new THREE.Color((this.start_rot_y % 2 == 0 ? "magenta" : "blue"));
        const end_color = new THREE.Color((this.target_rot_y % 2 == 0 ? "magenta" : "blue"));
        const cur_color = new THREE.Color();
        cur_color.lerpColors(start_color, end_color, rot_frac);

        this.cubes_group.position.y -= this.drift_vel * dt;

        // Zoom
        const zoom_frac = ease(Math.min(1, this.zoom_clock.getElapsedBeats() / this.zoom_movement_beats));
        const new_zoom = lerp_scalar(this.start_zoom, this.target_zoom, zoom_frac);
        if (new_zoom != this.cam_orth.zoom) {
            this.cam_orth.zoom = new_zoom;
            this.cam_orth.updateProjectionMatrix();
        }

        const elapsed_time = this.clock.getElapsedTime();
        /*for (const g of this.gantries) {
            g.anim_frame(dt);
        }*/

        /*for (const s of this.sparks) {
            s.anim_frame(dt, this.cam_orth);
        }*/
    }

    handle_sync(t, bpm, beat) {
        console.log('sync');
        if (beat % 4 == 0) {
            if (rand_int(0, 2) == 0 && (
                    (!this.rot_clock.running) ||
                    (this.rot_clock.getElapsedBeats() > this.rotation_movement_beats))) {
                console.log('start rot');

                this.start_rot_y = this.target_rot_y;
                this.target_rot_y++;
                this.rot_clock.start();
            }
            if (rand_int(0, 8) == 0) {
                this.start_zoom = this.target_zoom;
                if (this.target_zoom == 1) {
                    this.target_zoom = 0.7;
                } else {
                    this.target_zoom = 1;
                }
                this.zoom_clock.start();
            }
        }
    }

    handle_beat(t, channel) {
    }

    create_sparks(pos, num, avg_vel, color) {
        for (let i = 0; i < 16; i++) {
            /*const vel = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() * 0.5,
                Math.random() - 0.5);*/
            //vel.normalize();
            const vel = new THREE.Vector3(1, 0.5, 0);

            vel.applyEuler(new THREE.Euler(0, Math.PI / 8 * i, 0));
            vel.multiplyScalar(avg_vel);
            this.sparks[this.cur_spark_idx].active = true;
            this.sparks[this.cur_spark_idx].position.copy(pos);
            this.sparks[this.cur_spark_idx].velocity = vel;
            this.sparks[this.cur_spark_idx].acceleration.set(0, -40, 0);
            this.sparks[this.cur_spark_idx].material.color.set(color);

            this.cur_spark_idx = (this.cur_spark_idx + 1) % this.max_num_sparks;
        }
    }
}
