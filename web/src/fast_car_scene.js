import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { VisScene } from './vis_scene.js';
import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    clamp,
    arr_eq,
    create_instanced_cube,
    make_wireframe_rectangle,
    make_wireframe_cone,
    make_wireframe_circle,
    make_line,
    ShaderLoader,
    Spark
} from './util.js';

class TunnelMovementBackground {
    constructor(env) {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(20, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.squares = [];
        this.squares_group = new THREE.Group();
        this.num_squares = 80;
        this.square_sep = 4;
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(true);
        this.wave_ampl = 2;
        this.start_square_offset = 0;
        this.env = env;
        this.start_rot = 0;
        this.end_rot = 0;
        for (let i = 0; i < this.num_squares; i++) {
                const sq = make_wireframe_rectangle(2.0, 2.0, "white");
                sq.position.setZ(this.start_square_offset -this.square_sep * i);
                //sq.position.setX(Math.sin(i / this.num_squares * 2 * Math.PI) * this.wave_ampl);
                //sq.position.setY(Math.cos(i / this.num_squares * 2 * Math.PI) * this.wave_ampl);
                sq.visible = false;
                this.squares.push(sq);
                this.squares_group.add(sq);
        }
        this.scene.add(this.squares_group);
    }

    get_square_xy(i, offset) {

    }

    anim_frame(dt) {
        const beats_per_sec = this.get_local_bpm() / 60;
        const elapsed = this.clock.getElapsedTime();
        const speed = 20.0;
        this.squares_group.position.z = -speed * elapsed;

        /*this.squares.forEach((s, i) => {
                s.material.opacity = Math.max(0.0, 1.0 - (this.camera.position.z - (s.position.z + this.squares_group.position.z)) / (10 * this.square_sep));
                s.material.needsUpdate = true;
        });*/
        const max_offset = this.square_sep;
        this.squares_group.position.z -= speed * dt;
        //while (this.squares_group.position.z < -max_offset) {
            //this.squares_group.position.z += max_offset;
        //}
        const pos_frac = -this.squares_group.position.z / max_offset;
        //this.camera.position.setX(Math.sin(pos_frac * 2 * Math.PI) * this.wave_ampl);
        //this.camera.position.setY(Math.cos(pos_frac * 2 * Math.PI) * this.wave_ampl);
        const beats_per_lerp = 0.5;
        const frac = clamp(this.sync_clock.getElapsedTime() * beats_per_sec / beats_per_lerp, 0, 1);
        this.squares_group.rotation.z = Math.PI / 4 * (this.start_rot +
            lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot));

    }

    render(renderer, target) {
        renderer.setRenderTarget(target);
        renderer.render(this.scene, this.camera);
    }

    add_square(color) {
        const sq = this.squares.pop();
        sq.material.color.set(color);
        sq.material.needsUpdate = true;
        sq.position.z = this.start_square_offset - this.squares_group.position.z;
        sq.visible = true;
        this.squares.unshift(sq);
    }

    handle_sync(t, bpm, beat) {
        if (beat % 2 == 0) {
            this.sync_clock.start();
            this.start_rot = this.end_rot;
            this.end_rot = this.start_rot + 1;
        }
    }
}

export class FastCarScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;

        this.frustum_size = 40;
        this.camera = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        update_orth_camera_aspect(this.camera, aspect);

        this.cam_vbo = this.camera.clone();

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.vbo_scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(true);
        this.half_beat_clock = new THREE.Clock(true);
        this.full_beat_clock = new THREE.Clock(true);

        this.base_group = new THREE.Group();
        this.bg = new TunnelMovementBackground(env);

        this.base_group.rotation.x = 0;

        this.start_rot = 0;
        this.end_rot = 0;
        this.rot_dir = 1;
        this.base_group.rotation.y = this.start_rot * Math.PI / 8;

        this.buffer = new THREE.WebGLRenderTarget(width, height, {});

        const ambientLight = new THREE.AmbientLight("blue");
        this.vbo_scene.add( ambientLight );

        const pointLight = new THREE.PointLight( 0xffffff, 15 );
        this.camera.add( pointLight );
        this.light = new THREE.DirectionalLight("white", 2);
        this.vbo_scene.add(this.light);


// manager
        this.object = null;
        this.object_color = new THREE.Color("black");

        function loadModel(self) {
            self.object_mat = new THREE.MeshLambertMaterial({
                color: self.object_color,
                polygonOffset: true,
                polygonOffsetFactor: 1, // positive value pushes polygon further away
                polygonOffsetUnits: 1
            });
            const wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1, transparent: true } );
            self.object.traverse( function ( child ) {
                if ( child.isMesh ) {
                    let edges = new THREE.EdgesGeometry(child.geometry, 20);
                    let wireframe = new THREE.LineSegments(edges, wireframe_mat);
                    // add to child so we get same orientation
                    child.add(wireframe);
                    // to parent of child. Using attach keeps our orietation
                    child.parent.attach(wireframe);
                    // remove child (we don't want child)
                    //child.parent.remove(child);
                    child.material = self.object_mat;
                }

            } );

            self.object.scale.setScalar( 0.10 );
            self.object.position.set(0, -1, 0);
            self.base_group.add(self.object );
        }

        const manager = new THREE.LoadingManager(() => { loadModel(this); });

        // texture

        //const textureLoader = new THREE.TextureLoader( manager );
        //const texture = textureLoader.load( 'textures/uv_grid_opengl.jpg', render );
        //texture.colorSpace = THREE.SRGBColorSpace;

        // model

        function onProgress( xhr ) {

                if ( xhr.lengthComputable ) {

                        const percentComplete = xhr.loaded / xhr.total * 100;
                        //console.log( 'model ' + Math.round( percentComplete, 2 ) + '% downloaded' );

                }

        }

        function onError() {}

        const loader = new OBJLoader( manager );
        loader.load('stl/sedan-09.obj', (obj) => {
            this.object = obj;
        }, onProgress, onError );


        this.shader_loader = new ShaderLoader('glsl/default.vert', 'glsl/dither.frag');
        this.shader_loader.load().then(([vertex_shader, fragment_shader]) => {
            this.vbo_material = new THREE.ShaderMaterial({
                uniforms: {
                    uTexture: { value: null }
                },
                vertexShader: vertex_shader,
                fragmentShader: fragment_shader
            });
            let geometry = new THREE.PlaneGeometry(this.camera.right - this.camera.left,
                this.camera.top - this.camera.bottom);
            this.plane = new THREE.Mesh(geometry, this.vbo_material);
            this.plane.position.z = -100;
            this.scene.add(this.plane);
        });

        this.vbo_scene.add(this.base_group);
    }

    anim_frame(dt) {
        this.bg.anim_frame(dt);

        const beats_per_sec = this.get_local_bpm() / 60;
        const beats_per_lerp = 1.0;
        const t = this.sync_clock.getElapsedTime() * beats_per_sec;
        const frac = clamp((t - (1 - beats_per_lerp)) / beats_per_lerp, 0, 1);
        //this.base_group.rotation.y = Math.PI / 8 * (this.start_rot +
            //lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot));
        this.base_group.rotation.y += 0.005;
    }

    handle_sync(t, bpm, beat) {
        this.bg.handle_sync(t, bpm, beat);
        if (Math.abs(this.end_rot) == 4) {
            this.rot_dir *= -1;
        }
        this.start_rot = this.end_rot;
        this.end_rot = this.start_rot + this.rot_dir;
        this.sync_clock.start();
        if (beat % 2 == 0) {
            this.half_beat_clock.start();
        }
        if (beat % 4 == 0) {
            this.full_beat_clock.start();
        }
    }

    handle_beat(t, channel) {
        if (channel == 2) {
            this.bg.add_square("white");
        } else if (channel == 1 || channel == 3) {
            this.bg.add_square("red");
        }
    }

    render(renderer) {
        if (this.vbo_material == null) {
            return;
        }
        renderer.autoClearColor = false;
        super.render(renderer);
        renderer.setRenderTarget(this.buffer);
        renderer.clear();
        renderer.render(this.vbo_scene, this.cam_vbo);
        this.vbo_material.uniforms.uTexture.value = this.buffer.texture;
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClearColor = true;
    }
}
