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

function create_instanced_cube(dims, color) {
    let geometry = new THREE.BoxGeometry(...dims);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 1 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);

    const fill_mat = new THREE.MeshBasicMaterial({
        color: "black",
        polygonOffset: true,
        polygonOffsetFactor: 1, // positive value pushes polygon further away
        polygonOffsetUnits: 1
    });
    const inner_geom = new THREE.BoxGeometry(...dims);
    mesh.add(new THREE.Mesh(inner_geom, fill_mat));

    return mesh;
}

class CubeAssembly extends THREE.Group {
    constructor(start_exploded, template_obj, min_spacing=1.0, max_spacing=3.0) {
        super();
        this.max_spacing = max_spacing;
        this.min_spacing = min_spacing;
        if (start_exploded) {
            this.spacing = this.max_spacing;
            this.spacing_direction = 1;
        } else {
            this.spacing = this.min_spacing;
            this.spacing_direction = -1;
        }
        this.cubes = [];
        const cube_positions = this.get_cube_positions(this.spacing);
        this.explode_clock = new THREE.Clock(false);

        for (const pos of cube_positions) {
            const cube_mesh = template_obj.clone();
            cube_mesh.position.copy(pos);
            this.cubes.push(cube_mesh);
            this.add(cube_mesh);
        }
    }

    clone() {
        return new CubeAssembly(this.spacing_direction == 1, this.cubes[0], this.min_spacing, this.max_spacing);
    }

    get_cube_positions(spacing) {
        const cube_positions = [];
        for (let axis = 0; axis < 3; axis++) {
            for (let i = 0; i < 3; i++) {
                if (axis == 0 || i != 1) {
                    const pos = new THREE.Vector3();
                    pos.setComponent(axis, spacing * (i - 1));
                    cube_positions.push(pos);
                }
            }
        }
        return cube_positions;
    }

    handle_beat(t, channel, recurse=false, start_depth=0, cur_depth=0) {
        if (cur_depth >= start_depth || !recurse) {
            this.spacing_direction *= -1;
            this.explode_clock.start();
        }
        if (recurse) {
            this.cubes.forEach((cube, i) => {
                if (typeof cube.handle_beat === 'function') {
                    cube.handle_beat(t, channel, recurse, start_depth, cur_depth + 1);
                }
            });
        }
    }

    anim_frame(dt, beats_per_sec) {
        const explode_movement_beats = (this.max_spacing - this.min_spacing > 3 ? 0.5 : 0.25);
        let explode_frac = 1.0;
        if (this.explode_clock.running) {
            explode_frac = clamp(
                this.explode_clock.getElapsedTime() * beats_per_sec / explode_movement_beats,
                0, 1);
        }
        if (this.spacing_direction == 1) {
            this.spacing = lerp_scalar(this.min_spacing, this.max_spacing, explode_frac);
        } else {
            this.spacing = lerp_scalar(this.max_spacing, this.min_spacing, explode_frac);
        }

        this.get_cube_positions(this.spacing).forEach((pos, i) => {
            this.cubes[i].position.copy(pos);
        });

        this.cubes.forEach((cube, i) => {
            if (typeof cube.anim_frame === 'function') {
                cube.anim_frame(dt, beats_per_sec);
            }
        });
    }
}

export class HexagonScene extends VisScene {
    constructor(env) {
        super(env);

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

        this.cur_rotation = 0;

        this.shader_loader = new ResourceLoader(['glsl/hex_shader.vert', 'glsl/hex_shader.frag']);
        Promise.all([this.shader_loader.load(), load_texture('img/romaO.png')]).then(
            ([[vertex_shader, fragment_shader], texture]) => {
            this.uniforms = {
                time: { type: 'f', value: 0.0 },
                resolution: { type: 'v2', value: new THREE.Vector2(width, height) },
                palette: { type: 't', value: texture },
            };
            let material = new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: vertex_shader,
                fragmentShader: fragment_shader,
                transparent: true,
            });
            //material = new THREE.MeshBasicMaterial({ color: "red" });
            let geometry = new THREE.PlaneGeometry(this.cam_orth.right - this.cam_orth.left,
                this.cam_orth.top - this.cam_orth.bottom);
            this.plane = new THREE.Mesh(geometry, material);
            this.plane.position.z = -100;   // position in front of other objects
            this.scene.add(this.plane);
        });

        this.base_group = new THREE.Group();
        this.asm_group = new THREE.Group();

        this.assemblies = [];
        this.assembly_spacing = 9;
        this.num_assemblies_per_side = 6;

        {
            const cube_template = create_instanced_cube(Array(3).fill(2), "white");
            const assembly = new CubeAssembly(false, cube_template);
            const asm2 = new CubeAssembly(false, assembly, 0, this.assembly_spacing);
            this.assemblies.push(asm2);
            this.base_group.add(asm2);
        }

        this.base_group.rotation.x = Math.asin(1 / Math.sqrt(3));     // isometric angle
        this.base_group.rotation.y = Math.PI / 4;

        this.scene.add(this.base_group);
        this.camera = this.cam_orth;

        this.elapsed_beats = 0.0;
    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        this.cur_rotation += 1;
        this.base_group.rotation.y = this.cur_rotation * Math.PI / 1024;

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
        console.log("beat");
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
}
