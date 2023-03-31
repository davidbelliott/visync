import * as THREE from 'three';

import { LightningStrike } from 'three/examples/jsm/geometries/LightningStrike.js';
import { LightningStorm } from 'three/examples/jsm/objects/LightningStorm.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';

window.addEventListener("load", init);

var router = null;
const SCALE_LERP_RATE = 5;

var clock = null;

var scenes = null;
var cur_scene_idx = 0;

class Queue {
    constructor() {
        this.elements = {};
        this.head = 0;
        this.tail = 0;
    }
    enqueue(element) {
        this.elements[this.tail] = element;
        this.tail++;
    }
    dequeue() {
        const item = this.elements[this.head];
        delete this.elements[this.head];
        this.head++;
        return item;
    }
    peek() {
        return this.elements[this.head];
    }
    get length() {
        return this.tail - this.head;
    }
    get is_empty() {
        return this.length === 0;
    }
}


function createOutline( scene, camera, objectsArray, visibleColor ) {

				const outlinePass = new OutlinePass( new THREE.Vector2( window.innerWidth, window.innerHeight ), scene, camera, objectsArray );
				outlinePass.edgeStrength = 2.5;
				outlinePass.edgeGlow = 0.7;
				outlinePass.edgeThickness = 2.8;
				outlinePass.visibleEdgeColor = visibleColor;
				outlinePass.hiddenEdgeColor.set( 0 );
				composer.addPass( outlinePass );

				return outlinePass;

			}

function change_scene(scene_idx) {
    scenes[cur_scene_idx].deactivate();
    cur_scene_idx = scene_idx;
    scenes[cur_scene_idx].activate();
}

function keydown(e) {
    console.log(e.key);
    const num = parseInt(e.key);
    if (!isNaN(num) && scenes != null) {
        const scene_idx = Math.min(num % 10, scenes.length - 1);
        change_scene(scene_idx);
    } else {
        scenes[cur_scene_idx].handle_key(e.key);
    }
}

function init() {
    init_gfx();
    scenes = [
        new VisOpening("Kazakh Player Mode Presents", "Vain Oblations", "", 0),
        new Tracers(),
        new HomeBackground()];
    document.addEventListener('keydown', keydown);
    change_scene(1);
    animate();
    const socket = new WebSocket(`ws://${window.location.hostname}:8080`);
    socket.addEventListener('message', function(event) {
        console.log("recv msg");
        console.log(event.data);
        const tokens = event.data.split(":");
        const t = parseFloat(tokens[0]);
        const action = tokens[1];
        const data = tokens[2];

        if (action == "beat") {
            //bg.cubes_group.rotation.y += 0.1;
            scenes[cur_scene_idx].handle_beat();
            const time_now = Date.now() / 1000;
            const latency = time_now - t;
            console.log(latency);
            socket.send(tokens[0]);
        }
    });
    console.log("initialized");
}

const ASPECT_RATIO = 1.5;
const BG_COLOR = 'black';
const LINE_WIDTH = 1;
const POINT_SIZE = 2.0
const GRID_COLOR = 'white';

var canvas = null;
var renderer = null;
var composer = null;

function make_wireframe_cube() {
    const geometry = new THREE.BoxGeometry( 1, 1, 1 );
    const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: new THREE.Color(GRID_COLOR),
        linewidth: LINE_WIDTH} );

    const ls = new THREE.LineSegments(edges_geom, wireframe_mat);

    const frac = 0.99;
    const fill_geometry = new THREE.BoxGeometry(frac, frac, frac);
    const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color('black')});
    const mesh = new THREE.Mesh(fill_geometry, mat);
    ls.add(mesh);
    return ls
}

function make_wireframe_special() {
    const geometry = new THREE.TorusKnotGeometry(3, 1, 100, 16);
    //const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: new THREE.Color(GRID_COLOR),
        linewidth: LINE_WIDTH} );
    wireframe_mat.depthTest = false;
    wireframe_mat.depthWrite = false;
    const material = new THREE.PointsMaterial({
        size: POINT_SIZE,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: 1.0});
    const ls = new THREE.LineSegments(geometry, wireframe_mat);
    return ls
}

function make_point_cloud() {
    const geometry = new THREE.TorusGeometry(10, 3, 16, 100);
    const material = new THREE.PointsMaterial({
        size: POINT_SIZE,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: 1.0});

    return new THREE.Points( geometry, material );
}

function update_camera_aspect(camera, aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
}

function rand_int(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min); //The maximum is exclusive and the minimum is inclusive
}

class VisScene {
    constructor() {
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, ASPECT_RATIO, 0.1, 4000);
        this.yscale = 1.0;
    }

    activate() {
    }

    deactivate() {
    }

    anim_frame(dt) {
    }

    render(renderer) {
        renderer.render(this.scene, this.camera);
    }

    handle_key(key) {

    }

    handle_beat() {

    }
}

class VisOpening extends VisScene {
    constructor(pretitle, title, subtitle, start_stage) {
        super();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, ASPECT_RATIO, 0.1, 4000);
        this.start_stage = start_stage;
        this.stage = 0;
        this.html_elements = [];
        this.html_values = [];
        this.all_html_elements = ["pretitle", "songtitle", "subtitle"];
        for (const [i, v] of [pretitle, title, subtitle].entries()) {
            if (v != "") {
                this.html_elements.push(this.all_html_elements[i]);
                this.html_values.push(v);
            }
        }
    }

    activate() {
        console.log("activating");
        const overlay = document.getElementById("overlay");
        overlay.style.display = 'none';
        for (const [i, id] of this.all_html_elements.entries()) {
            const elem = document.getElementById(id);
            elem.style.visibility = 'hidden';
        }
        for (const [i, v] of this.html_values.entries()) {
            const elem = document.getElementById(this.html_elements[i]);
            elem.innerHTML = v;
        }
        this.set_stage(this.start_stage);
        overlay.style.display = 'block';
    }

    deactivate() {
        const overlay = document.getElementById("overlay");
        overlay.style.display = 'none';
    }

    anim_frame(dt) {
    }

    render(renderer) {
        renderer.render(this.scene, this.camera);
    }

    set_stage(stage) {
        stage = Math.max(0, Math.min(this.html_values.length, stage));
        for (const i in this.html_values) {
            const elem = document.getElementById(this.html_elements[i]);
            if (i < stage) {
                elem.style.visibility = 'visible';
            } else {
                elem.style.visibility = 'hidden';
            }
        }
        this.stage = stage;
    }

    handle_key(key) {
        if (key == "ArrowLeft") {
            let new_stage = this.stage - 1;
            if (new_stage < 0) {
                new_stage = this.html_values.length;
            }
            this.set_stage(new_stage);
        } else if (key == "ArrowRight") {
            this.set_stage((this.stage + 1) % (this.html_values.length + 1));
        }
    }
}


function Transition( sceneA, sceneB ) {
}

class Tracers extends VisScene {
    constructor() {
        super();

        this.vbo_scene = new THREE.Scene();
        this.vbo_camera = new THREE.PerspectiveCamera(45, ASPECT_RATIO, 0.1, 4000);
        this.vbo_camera.position.set(0, 0, 5);
        //this.vbo_camera = new THREE.OrthographicCamera(-8, 8, -8, 8);
        this.cam_vel = new THREE.Vector3();
        this.num_traces = 6;
        this.trace_spacing = 2;
        this.buffers = [];

        this.min_base_scale = 1.0;
        this.max_base_scale = 1.5;
        this.base_scale = this.min_base_scale;



        for (let i = 0; i < this.num_traces * this.trace_spacing; i++) {
            this.buffers.push(new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {}));
        }
        this.cur_buffer_idx = 0;
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


        this.ray_params_base = {
            sourceOffset: new THREE.Vector3(),
            destOffset: new THREE.Vector3(),
            radius0: 0.02,
            radius1: 0.01,
            minRadius: 0.01,
            maxIterations: 7,
            isEternal: true,

            timeScale: 0.7,

            propagationTimeFactor: 0.05,
            vanishingTimeFactor: 0.95,
            subrayPeriod: 3.5,
            subrayDutyCycle: 0.6,
            maxSubrayRecursion: 3,
            ramification: 7,
            recursionProbability: 0.6,

            roughness: 0.85,
            straightness: 0.6
        };

        this.ray_dest_offset_scale = 5.0;
        this.ray_dest_movement_rate = 0.1;

        this.lightningColor = new THREE.Color( 0xB0FFFF );
        //this.lightningColor = new THREE.Color('cyan');

        this.lightningMaterial = new THREE.MeshBasicMaterial( { color: this.lightningColor } );


        this.cubes = [];
        this.ray_params = [];
        this.lightning_strikes = [];
        this.lightning_strike_meshes = [];
        this.cubes_group = new THREE.Group();
        for (const pos of this.cube_positions) {
            const ls = make_wireframe_cube();
            ls.position.copy(pos);
            ls.material.color.copy(new THREE.Color("cyan"));
            this.cubes_group.add(ls);
            this.cubes.push(ls);
            let ray_params = Object.assign({}, this.ray_params_base);

            const dest_offset = new THREE.Vector3(Math.random() - 0.5,
                Math.random() - 0.5,
                Math.random() - 0.5);
            dest_offset.normalize();
            dest_offset.multiplyScalar(this.ray_dest_offset_scale);
            ray_params.destOffset = dest_offset;
            this.ray_params.push(ray_params);

            const lightning_strike = new LightningStrike(ray_params);
            this.lightning_strikes.push(lightning_strike);

            const lightning_strike_mesh = new THREE.Mesh(lightning_strike, this.lightningMaterial );
            this.lightning_strike_meshes.push(lightning_strike_mesh);

            ls.add(lightning_strike_mesh);
        }
        this.vbo_scene.add(this.cubes_group);

        this.ls = make_wireframe_special();
        this.ls.material.color.copy(new THREE.Color("gray"));
        this.ls.renderOrder = -1;
        //this.vbo_scene.add(this.ls);
        this.pc = make_point_cloud();
        this.pc.position.copy(this.camera.position);
        //this.vbo_scene.add(this.pc);
        //

        const rayDirection = new THREE.Vector3( 0, - 1, 0 );
        let rayLength = 0;
        const vec1 = new THREE.Vector3();
        const vec2 = new THREE.Vector3();

        

        //this.vbo_scene.add(this.lightning_strike_mesh );




        this.elapsed_time = 0.0;
        this.time_since_update = 0.0;
        this.time_scaling_key = 0.0;
        this.time_ellipses = 0.0;

        this.cur_selected = 0;
        this.has_started = false;

        const aspect = window.innerWidth / window.innerHeight;
        update_camera_aspect(this.vbo_camera, aspect);

        {
            this.scene = new THREE.Scene();
            const width = window.innerWidth;
            const height = window.innerHeight;
            this.camera = new THREE.OrthographicCamera( width / - 2, width / 2, height / 2, height / - 2, - 10, 10 );
            this.blend_material = new THREE.ShaderMaterial( {
                    uniforms: {
                            t1: { value: null },
                            t2: { value: null },
                            t3: { value: null },
                            t4: { value: null },
                            t5: { value: null },
                            t6: { value: null },
                            ratio: {
                                    value: 0.0
                            },
                    },
                    vertexShader: [
                        'varying vec2 vUv;',
                        'void main() {',
                        'vUv = vec2( uv.x, uv.y );',
                        'gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
                        '}'
                    ].join( '\n' ),
                    fragmentShader: [
                        'uniform float ratio;',
                        'uniform sampler2D t1;',
                        'uniform sampler2D t2;',
                        'uniform sampler2D t3;',
                        'uniform sampler2D t4;',
                        'uniform sampler2D t5;',
                        'uniform sampler2D t6;',
                        'varying vec2 vUv;',
                        'void main() {',
                        '	vec4 texel1 = texture2D( t1, vUv );',
                        '	vec4 texel2 = texture2D( t2, vUv );',
                        '	vec4 texel3 = texture2D( t3, vUv );',
                        '	vec4 texel4 = texture2D( t4, vUv );',
                        '	vec4 texel5 = texture2D( t5, vUv );',
                        '	vec4 texel6 = texture2D( t6, vUv );',
                        '	gl_FragColor = max(texel1, ratio * max(texel2, ratio * max(texel3, ratio * max(texel4, ratio * max(texel5, ratio * texel6)))));',
                        '}'
                    ].join( '\n' )
            } );
            const geometry = new THREE.PlaneGeometry( window.innerWidth, window.innerHeight );
            const mesh = new THREE.Mesh( geometry, this.blend_material );
            this.scene.add( mesh );
        }
    }

    handle_beat() {
        this.base_scale = this.max_base_scale;
    }

    anim_frame(dt) {
        for (const cube of this.cubes) {
            cube.rotation.x += 0.5 * dt;
            cube.rotation.y += 0.5 * dt;
            cube.scale.setScalar(this.base_scale);
        }

        for (const rp of this.ray_params) {
            const movement = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() - 0.5,
                Math.random() - 0.5);
            movement.multiplyScalar(this.ray_dest_movement_rate);
            rp.destOffset.add(movement);
            rp.destOffset.normalize();
            rp.destOffset.multiplyScalar(this.ray_dest_offset_scale);
        }

        //this.cubes_group.scale.setScalar(this.base_scale);


        this.cubes_group.rotation.x += 0.1 * dt;
        this.cubes_group.rotation.y += 0.4 * dt;

        this.ls.rotation.x += 0.2 * dt;
        this.ls.rotation.y += 0.1 * dt;

        this.time_since_update += dt;
        this.time_scaling_key += dt;
        this.elapsed_time += dt;

        for (const ls of this.lightning_strikes) {
            ls.update(this.elapsed_time);
        }
        this.base_scale += (this.min_base_scale - this.base_scale) * SCALE_LERP_RATE * dt;
    }

    render(renderer) {
        renderer.autoClearColor = false;
        super.render(renderer);
        renderer.setRenderTarget(this.buffers[this.cur_buffer_idx]);
        renderer.clear();
        renderer.render(this.vbo_scene, this.vbo_camera);
        let tex_values = [];
        let idx = this.cur_buffer_idx;
        for (let i = 0; i < this.buffers.length; i++) {
            if (i % this.trace_spacing == 0) {
                tex_values.push(this.buffers[idx].texture);
            }
            idx--;
            if (idx < 0) {
                idx = this.buffers.length - 1;
            }
        }
        this.blend_material.uniforms.t1.value = tex_values[0];
        this.blend_material.uniforms.t2.value = tex_values[1];
        this.blend_material.uniforms.t3.value = tex_values[2];
        this.blend_material.uniforms.t4.value = tex_values[3];
        this.blend_material.uniforms.t5.value = tex_values[4];
        this.blend_material.uniforms.t6.value = tex_values[5];
        this.blend_material.uniforms.ratio.value = 0.8;//transitionParams.transition;

        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClearColor = true;
        this.cur_buffer_idx = (this.cur_buffer_idx + 1) % this.buffers.length;
    }
}

class HomeBackground extends VisScene {
    constructor() {
        super();
        this.min_base_scale = 2.0;
        this.max_base_scale = 3.0;
        this.base_scale = this.min_base_scale;


        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, ASPECT_RATIO, 0.1, 4000);
        this.camera.position.set(0, 0, 10);
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
            const ls = make_wireframe_cube();
            ls.position.copy(pos);
            ls.material.color.copy(new THREE.Color("cyan"));
            this.cubes_group.add(ls);
            this.cubes.push(ls);
        }
        this.ls = make_wireframe_special();
        this.ls.material.color.copy(new THREE.Color("gray"));
        this.ls.renderOrder = -1;
        this.scene.add(this.ls);
        this.pc = make_point_cloud();
        this.pc.position.copy(this.camera.position);
        this.scene.add(this.pc);
        this.scene.add(this.cubes_group);

        this.time_since_update = 0.0;
        this.time_scaling_key = 0.0;
        this.time_ellipses = 0.0;

        this.cur_selected = 0;
        this.has_started = false;

        const aspect = window.innerWidth / window.innerHeight;
        update_camera_aspect(this.camera, aspect);
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

    handle_beat() {
        this.base_scale = this.max_base_scale;
    }
}

function on_window_resize() {
	const aspect = window.innerWidth / window.innerHeight;
	if (scenes != null) {
            update_camera_aspect(scenes[cur_scene_idx].camera, aspect);
            console.log(aspect);
	}
	renderer.setSize(window.innerWidth, window.innerHeight);
}

function init_gfx() {
        clock = new THREE.Clock(true);
	canvas = document.getElementById('canvas');
	renderer = new THREE.WebGLRenderer({ "canvas": canvas, "antialias": false });
	renderer.setClearColor(BG_COLOR);
	renderer.setPixelRatio(window.devicePixelRatio);
        composer = new EffectComposer( renderer );
	on_window_resize();
        window.addEventListener('resize', on_window_resize);
}


function animate() {
    let dt = clock.getDelta();
    if (scenes != null) {
        for (const scene of scenes) {
            scene.anim_frame(dt);
        }
        scenes[cur_scene_idx].render(renderer);
    }
    window.requestAnimationFrame(animate);
}
