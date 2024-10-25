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
    ResourceLoader,
    create_instanced_cube,
} from './util.js';

const ROT_DIV = 1024;

class CubeAssembly extends THREE.Group {
    constructor(parent_scene, start_exploded, template_obj, min_spacing, max_spacing, depth) {
        super();
        this.depth = depth;
        this.parent_scene = parent_scene;
        this.max_spacing = max_spacing;
        this.min_spacing = min_spacing;
        let spacing = min_spacing;
        if (start_exploded) {
            this.spacing_direction = 1;
            spacing = max_spacing;
        } else {
            this.spacing_direction = -1;
            spacing = min_spacing;
        }
        this.cur_rotation = 0;
        this.explode_clock = new THREE.Clock(false);
        this.axes = [[], [], []];
        this.orbit = [];
        this.axis_group = new THREE.Group();
        this.orbit_group = new THREE.Group();

        for (let axis = 0; axis < 3; axis++) {
            for (let i = 0; i < (axis == 1 ? 3 : 2); i++) {
                const obj = template_obj.clone()
                this.axes[axis].push(obj);
                if (axis == 1) {
                    //this.add(cube_mesh);
                    this.axis_group.add(obj);
                } else {
                    //this.add(cube_mesh);
                    this.orbit_group.add(obj);
                }
            }
        }
        this.update_cube_positions(spacing, this.cur_rotation);
        //this.parent_scene.scene.add(this.axis_group);
        this.add(this.axis_group);
        //
        //this.axis_group.rotation.x = 2 * Math.asin(1 / Math.sqrt(3));
        //this.orbit_group.rotation.x = -2 * Math.asin(1 / Math.sqrt(3));
        this.axis_group.rotation.x = (this.depth == 1 ? 1 : 0) * Math.asin(1 / Math.sqrt(3));
        this.orbit_group.rotation.x = (this.depth == 1 ? 1 : 0) * Math.asin(1 / Math.sqrt(3));
        this.add(this.orbit_group);
    }

    clone() {
        return new CubeAssembly(this.parent_scene, this.spacing_direction == 1, this.axes[0][0], this.min_spacing, this.max_spacing, this.depth);
    }

    update_cube_positions(spacing, rotation) {
        for (let axis = 0; axis < 3; axis++) {
            for (let i = 0; i < (axis == 1 ? 3 : 2); i++) {
                const pos = new THREE.Vector3(0, 0, 0);
                if (axis != 1) {
                    pos.setComponent(axis, spacing * (2 * i - 1));
                    this.axes[axis][i].position.copy(pos);
                    if (this.depth == 1 && axis == 0) {
                        const world_offset = new THREE.Vector3(0, 0, 100 *
                            Math.sign(rotation / ROT_DIV - 0.5) * 
                            -Math.sign(2 * i - 1));
                        console.log(world_offset);
                        const world_quat = new THREE.Quaternion();
                        this.axes[axis][i].getWorldQuaternion(world_quat);
                        world_quat.invert();
                        world_offset.applyQuaternion(world_quat);
                        this.axes[axis][i].position.add(world_offset);
                    }
                } else {
                    pos.setComponent(axis, spacing * (i - 1));
                    this.axes[axis][i].position.copy(pos);
                    if (this.depth == 0) {
                        //pos.setComponent(0, spacing * (i - 1));
                    }
                    //pos.setComponent(axis, spacing * (i - 1));
                }
            }
        }
    }

    handle_beat(t, channel, recurse=false, start_depth=0, cur_depth=0) {
        this.explode_movement_seconds = Math.min(
            this.parent_scene.get_beat_delay(t),
            (this.max_spacing - this.min_spacing > 3 ? 0.25 : 0.1));
        if (cur_depth >= start_depth || !recurse) {
            this.spacing_direction *= -1;
            this.explode_clock.start();
            console.log("reversing");
        }
        if (recurse) {
            this.axes.forEach((cubes) => {
                cubes.forEach((cube) => {
                    if (typeof cube.handle_beat === 'function') {
                        cube.handle_beat(t, channel, recurse, start_depth, cur_depth + 1);
                    }
                });
            });
        }
    }

    anim_frame(dt, beats_per_sec) {
        this.cur_rotation = (this.cur_rotation + 2) % ROT_DIV;
        if (this.depth == 1) {
            this.axis_group.rotation.y = 2 * Math.PI * (1 / ROT_DIV * this.cur_rotation);
            this.orbit_group.rotation.y = 2 * Math.PI * (1 / ROT_DIV * this.cur_rotation);
            for (const axis of [0, 2]) {
                this.axes[axis].forEach(cube => {
                    //cube.rotation.y = 2 * Math.PI / 1024 * this.cur_rotation;
                });
            }
        }
        let explode_frac = 1.0;
        if (this.explode_clock.running) {
            explode_frac = clamp(
                this.explode_clock.getElapsedTime() / this.explode_movement_seconds,
                0, 1);
        }
        let spacing = 0;
        if (this.spacing_direction == 1) {
            spacing = lerp_scalar(this.min_spacing, this.max_spacing, explode_frac);
        } else {
            spacing = lerp_scalar(this.max_spacing, this.min_spacing, explode_frac);
        }

        this.update_cube_positions(spacing, this.cur_rotation);

        /*for (let axis = 0; axis < 3; axis++) {
            this.get_cube_positions(axis, spacing, this.cur_rotation).forEach((pos, i) => {
                this.axes[axis][i].position.copy(pos);
            });
        }*/

        this.axes.forEach(cubes => {
            cubes.forEach((cube, i) => {
                if (typeof cube.anim_frame === 'function') {
                    cube.anim_frame(dt, beats_per_sec);
                }
            });
        });
    }
}

export class HexagonScene extends VisScene {
    constructor() {
        super();

        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);


        this.shader_loader = new ResourceLoader(['glsl/hex_shader.vert', 'glsl/hex_shader.frag']);
        Promise.all([this.shader_loader.load(), load_texture('img/romaO.png')]).then(
            ([[vertex_shader, fragment_shader], texture]) => {
            this.uniforms = {
                time: { type: 'f', value: 0.0 },
                resolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                pixel_ratio: { type: 'f', value: window.devicePixelRatio },
                palette: { type: 't', value: texture },
            };
            this.background_material = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: vertex_shader,
                fragmentShader: fragment_shader,
                transparent: true,
            });
            //material = new THREE.MeshBasicMaterial({ color: "red" });
            this.plane = this.create_plane(this.cam_orth, this.background_material);
            this.plane.position.z = -900;
            this.scene.add(this.plane);
        });

        this.base_group = new THREE.Group();
        this.asm_group = new THREE.Group();

        this.assemblies = [];
        this.assembly_spacing = 9;
        this.num_assemblies_per_side = 6;

        {
            const cube_template = create_instanced_cube(Array(3).fill(2), "white", true, "black", 0.9);
            const assembly = new CubeAssembly(this, false, cube_template, 1.0, 3.0, false, 1);
            const asm2 = new CubeAssembly(this, false, assembly, 0, this.assembly_spacing, true, 0);
            this.assemblies.push(asm2);
            this.base_group.add(asm2);
        }

        //this.base_group.rotation.x = Math.asin(1 / Math.sqrt(3));
        this.camera.rotation.y = Math.PI / 4;

        this.scene.add(this.base_group);
        this.camera = this.cam_orth;

        //this.base_group.rotation.x = -Math.asin(1 / Math.sqrt(3));
        this.rotation_dir = 1;

        this.elapsed_beats = 0.0;
    }

    create_plane(camera, material) {
        const geometry = new THREE.PlaneGeometry(camera.right - camera.left,
            camera.top - camera.bottom);
        const plane = new THREE.Mesh(geometry, material);
        plane.position.z = -100;   // position in front of other objects
        return plane;
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        //console.log(this.rotation_dir);

        for (const asm of this.assemblies) {
            //asm.rotation.y += 0.005;
            //asm.rotation.x += 0.01;
            asm.anim_frame(dt, beats_per_sec);
        }
        const clock_dt = this.clock.getDelta();
        this.elapsed_beats += clock_dt * beats_per_sec;
        if (this.uniforms != null) {
            this.uniforms.time.value = this.elapsed_beats / 16;
        }
        //this.plane.position.z -= 0.02;
        //this.plane.rotation.y += 0.01;
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
        if (channel == 2) {
            for (const asm of this.assemblies) {
                asm.handle_beat(t, channel);
            }
        } else if (channel == 1) {
            for (const asm of this.assemblies) {
                asm.handle_beat(t, channel, true, 1); // start at children of assembly
            }
        }
    }

    handle_resize(width, height) {
        super.handle_resize(width, height);
        if (this.uniforms != null) {
            this.uniforms.resolution.value.set(width, height);
            this.uniforms.pixel_ratio.value = window.devicePixelRatio;
        }
        if (this.plane != null) {
            this.scene.remove(this.plane);
            this.plane = this.create_plane(this.cam_orth, this.background_material);
            this.scene.add(this.plane);
        }
    }
}
