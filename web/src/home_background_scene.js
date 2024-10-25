import { VisScene } from "./vis_scene.js";
import * as THREE from "three";
import {
    create_instanced_cube,
    make_wireframe_special,
    make_point_cloud
} from "./util.js";


const SCALE_LERP_RATE = 5;


export class HomeBackgroundScene extends VisScene {
    constructor() {
        super();
        this.min_base_scale = 2.0;
        this.max_base_scale = 3.0;
        this.base_scale = this.min_base_scale;


        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
        this.cam_persp.position.set(0, 0, 10);
        this.camera = this.cam_persp;
        //this.camera = new THREE.OrthographicCamera(-8, 8, -8, 8);
        this.cam_vel = new THREE.Vector3();
        this.cube_positions = [];
        const BOUND = 1;
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                for (let k = 0; k < 2; k++) {
                    let pos = new THREE.Vector3(BOUND * (2 * i - 1), BOUND * (2 * j - 1), BOUND * (2 * k - 1));
                    this.cube_positions.push(pos);
                }
            }
        }
        this.cubes = [];
        this.cubes_group = new THREE.Group();
        for (const pos of this.cube_positions) {
            const ls = create_instanced_cube([1, 1, 1], "cyan");
            ls.position.copy(pos);
            this.cubes_group.add(ls);
            this.cubes.push(ls);
        }
        this.ls = make_wireframe_special("white");
        this.ls.material.color.copy(new THREE.Color("gray"));
        this.ls.renderOrder = -1;
        //this.scene.add(this.ls);
        this.pc = make_point_cloud();
        this.pc.position.copy(this.camera.position);
        this.scene.add(this.pc);
        this.scene.add(this.cubes_group);

        this.time_since_update = 0.0;
        this.time_scaling_key = 0.0;
        this.time_ellipses = 0.0;

        this.cur_selected = 0;
        this.has_started = false;
    }

    anim_frame(dt) {
        for (const cube of this.cubes) {
            cube.rotation.x += 0.5 * dt;
            cube.rotation.y += 0.5 * dt;
        }

        this.cubes_group.scale.setScalar(this.base_scale);


        this.cubes_group.rotation.x += 0.1 * dt;
        this.cubes_group.rotation.y += 0.4 * dt;
        this.ls.rotation.x += 0.2 * dt;
        this.ls.rotation.y += 0.1 * dt;
        //this.pc.rotation.y += 0.05 * dt;
        //this.camera.position.addScaledVector(this.cam_vel, dt);

        this.time_since_update += dt;
        this.time_scaling_key += dt;
        this.elapsed_time += dt;

        this.base_scale += (this.min_base_scale - this.base_scale) * SCALE_LERP_RATE * dt;
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay();
        if (channel == 1) {
            setTimeout(() => { this.base_scale = this.max_base_scale; }, delay * 1000);
        }
    }
}
