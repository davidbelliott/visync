import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    arr_eq,
    ShaderLoader
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

        this.shader_loader = new ShaderLoader('glsl/hex_shader.vert', 'glsl/hex_shader.frag');
        this.shader_loader.load().then(([vertex_shader, fragment_shader]) => {
            console.log(fragment_shader);
            this.uniforms = {
                time: { type: 'f', value: 0.0 },
                resolution: { type: 'v2', value: new THREE.Vector2(width, height) },
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

        const cube_mesh = create_instanced_cube(Array(3).fill(2), "white");
        this.base_group.add(cube_mesh);

        this.scene.add(this.base_group);
        this.camera = this.cam_orth;
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60;
        // Y rotation
        this.base_group.rotation.y += 0.01;
        this.base_group.rotation.x += 0.02;
        const elapsed_time = this.clock.getElapsedTime();
        if (this.uniforms != null) {
            this.uniforms.time.value = elapsed_time * beats_per_sec / 16;
        }
        //this.plane.position.z -= 0.02;
        //this.plane.rotation.y += 0.01;
    }

    handle_sync(t, bpm, beat) {
    }

    handle_beat(t, channel) {
    }
}
