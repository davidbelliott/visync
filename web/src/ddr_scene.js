import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    create_instanced_cube,
    ShaderLoader,
    BeatClock
} from './util.js';
import { InstancedGeometryCollection } from './instanced_geom.js';

const BODY_COLOR = new THREE.Color("red");
const ROT_BEATS = 3.75;

function mirror_mesh(mesh, axis_idx) {
    const new_mesh = mesh.clone();
    const scale = new_mesh.scale.toArray();
    const pos = new_mesh.position.toArray();
    scale[axis_idx] *= -1;
    pos[axis_idx] *= -1;
    new_mesh.scale.fromArray(scale);
    new_mesh.position.fromArray(pos);
    return new_mesh;
}

function mesh_from_gltf(gltf_mesh, fill_mat, wireframe_mat) {
    const gltf_geom = gltf_mesh.geometry;
    let edges = new THREE.EdgesGeometry(gltf_geom, 30);
    const mesh = new THREE.Object3D();
    const fill_mesh = new THREE.Mesh(gltf_geom, fill_mat);
    //mesh.add(fill_mesh);
    mesh.add(new THREE.LineSegments(edges, wireframe_mat));
    mesh.quaternion.copy(gltf_mesh.quaternion);
    mesh.position.copy(gltf_mesh.position);
    mesh.scale.copy(gltf_mesh.scale);
    return mesh;
}

class DDRRobot extends THREE.Object3D {
    constructor(gltf_scene, fill_mat, wireframe_mat) {
        super();
        for (const child_mesh of gltf_scene.scene.children) {
            //debugger;
            if (child_mesh.name == "body") {
                this.body = mesh_from_gltf(child_mesh, fill_mat, wireframe_mat);
                this.add(this.body);
            } else if (child_mesh.name == "leg") {
                this.legs = [mesh_from_gltf(child_mesh, fill_mat, wireframe_mat)];
                this.legs.push(mirror_mesh(this.legs[0], 2));
                for (const leg of this.legs) {
                    this.add(leg);
                }
            } else if (child_mesh.name == "hand") {
                this.hands = [mesh_from_gltf(child_mesh, fill_mat, wireframe_mat)];
                this.hands.push(mirror_mesh(this.hands[0], 2));
                for (const hand of this.hands) {
                    this.add(hand);
                }
            } else if (child_mesh.name == "foot") {
                this.feet = [mesh_from_gltf(child_mesh, fill_mat, wireframe_mat)];
                this.feet.push(mirror_mesh(this.feet[0], 2));
                for (const foot of this.feet) {
                    this.add(foot);
                }
            }
        }
    }
}

class DDRArrows extends InstancedGeometryCollection {
    constructor(template_geom) {
        super(template_geom);
        for (let i = 0; i < 3; i++) {
            this.create_geom(new THREE.Vector3(0, 0, 0), new THREE.Color("orange"), new THREE.Vector3(1, 1, 1), Math.PI / 2 * i);
        }
    }
}

export class DDRScene extends VisScene {
    constructor(env) {
        super(env, 1);
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.frustum_size = 10;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;

        this.clock = new THREE.Clock();
        this.base_group = new THREE.Group();
        this.scene = new THREE.Scene();

        const loader = new GLTFLoader();
        const stl_load_promise = loader.loadAsync('stl/ddr-robot.glb');
        this.shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = this.shader_loader.load();
        this.spacing = 8;
        this.num_per_side = 3;
        Promise.all([stl_load_promise, shader_load_promise]).then((results) => {
            const gltf_scene = results[0];
            const dither_pars = results[1][0];
            const dither = results[1][1];
            this.fill_mat = new THREE.MeshLambertMaterial({
                color: BODY_COLOR,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1
            });
            this.wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );

            this.fill_mat.onBeforeCompile = (shader) => {
                shader.fragmentShader =
                    shader.fragmentShader.replace(
                        '#include <dithering_pars_fragment>',
                        dither_pars
                    ).replace(
                        '#include <dithering_fragment>',
                        dither
                    );
            };


            // Robots
            {
                console.log(gltf_scene);
                const offset = new THREE.Vector3(-this.spacing * (this.num_per_side - 1) / 2, 0, -this.spacing * (this.num_per_side - 1) / 2);
                for (let i = 0; i < this.num_per_side; i++) {
                    for (let j = 0; j < this.num_per_side; j++) {
                        const robot = new DDRRobot(gltf_scene, this.fill_mat, this.wireframe_mat);
                        robot.position.set(i * this.spacing, 2, j * this.spacing);
                        robot.position.add(offset);
                        this.base_group.add(robot);
                    }
                }
            }

            // DDR arrows
            const edges_geom = new THREE.EdgesGeometry(gltf_scene.scene.getObjectByName("arrow").geometry, 30);
            this.arrows = new DDRArrows(edges_geom);
            this.arrows.position.set(0, -2, 0);
            this.base_group.add(this.arrows);

            // Light
            {
                this.light = new THREE.PointLight("white", 200);
                this.light.position.set(0, 0, 24);
                this.base_group.add(this.light);
            }

            this.initialized = true;
        });

        this.camera.rotation.x = -Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.scene.add(this.base_group);

        // Robot rotation, in 90 degree increments starting from 45 degrees
        this.start_robot_rot = 0;
        this.target_robot_rot = 0;
        this.robot_rot_clock = new BeatClock(this);
    }

    anim_frame(dt) {
        if (!this.initialized) {
            return;
        }
        const rot_frac = ease(clamp(this.robot_rot_clock.get_elapsed_beats() / ROT_BEATS, 0, 1));

        const robot_rot = lerp_scalar(this.start_robot_rot, this.target_robot_rot, rot_frac);
        this.base_group.rotation.y = Math.PI / 4 + Math.PI / 2 * robot_rot;
    }

    handle_beat(t, channel) {
    }

    handle_sync(t, bpm, beat) {
        if (beat % 4 == 0) {
            this.start_robot_rot = this.target_robot_rot;
            this.target_robot_rot++;
            this.robot_rot_clock.start();
        }
    }

    state_transition(old_state_idx, new_state_idx) {
    }
}
