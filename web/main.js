"use strict";

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { LightningStrike } from './src/lightning_strike.js';
import { Tesseract } from './src/highdim.js';
import { VisScene } from './src/vis_scene.js';
import { GantryScene } from './src/gantry_scene.js';
import { HexagonScene } from './src/hexagon_scene.js';
import { SlideScene } from './src/slide_scene.js';
import { SpectrumScene } from './src/spectrum_scene.js';
import { IntroScene } from './src/intro_scene.js';
import { IceCreamScene } from './src/ice_cream_scene.js';
import { FastCubeScene } from './src/fast_cube_scene.js';
import { ChineseScene } from './src/chinese_scene.js';
import { TessellateScene } from './src/tessellate_scene.js';
import { FastCarScene } from './src/fast_car_scene.js';
import { CubeLockingScene } from './src/cube_locking_scene.js';
import { YellowRobotScene } from './src/yellow_robot_scene.js';
import { SpinningRobotsScene } from './src/spinning_robots_scene.js';


import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    create_instanced_cube,
    rand_int,
    arr_eq,
    clamp
} from './src/util.js';
import { BoxDef } from './src/geom_def.js';

import "./src/normalize.css";
import "./src/style.css";


const SCALE_LERP_RATE = 5;
const MSG_TYPE_SYNC = 0;
const MSG_TYPE_BEAT = 1;
const MSG_TYPE_GOTO_SCENE = 2;
const MSG_TYPE_ADVANCE_SCENE_STATE = 3;

const ENABLE_GLOBAL_TRACERS = false;

var context = null;

const env = {
    bpm: 120,
    total_latency: 0.065,
}

window.addEventListener("load", init);

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

function init() {
    context = new GraphicsContext();
    document.addEventListener('keydown', (e) => { context.keydown(e); });
    connect();
    context.change_scene(0);
    animate();
}

function connect() {
    //const socket = new WebSocket(`ws://192.168.1.235:8080`);
    let pathname = window.location.pathname;
    pathname = pathname.substring(0, pathname.lastIndexOf('/') + 1);
    const protocol = (location.protocol === 'https:' ? 'wss' : 'ws');
    //const socket = new WebSocket(`${protocol}://${window.location.hostname}${pathname}ws`);
    const socket = new WebSocket(`ws://192.168.1.2:8765`);
    socket.addEventListener('message', function(e) {
	const msg = JSON.parse(e.data);
        const type = msg.msg_type;

        if (type == MSG_TYPE_SYNC) {
            //bg.cubes_group.rotation.y += 0.1;
            //console.log(`Beat ${msg.beat}`);
            env.bpm = msg.bpm;
            context.handle_sync(msg.t, msg.bpm, msg.beat);
        } else if (type == MSG_TYPE_BEAT) {
            context.handle_beat(msg.t, msg.channel);
        } else if (type == MSG_TYPE_GOTO_SCENE) {
            context.change_scene(msg.scene);
        } else if (type == MSG_TYPE_ADVANCE_SCENE_STATE) {
            context.advance_state(msg.steps);
        }
        //socket.send(msg.t);	// TODO: re-add for latency estimation
    });

    socket.addEventListener('close', function(e) {
        // Try to reconnect after 1 second
        //console.log('Socket is closed. Reconnect will be attempted in 1 second.', e.reason);
        setTimeout(function() {
            connect();
        }, 1000);
    });

    socket.addEventListener('error', function(e) {
        //console.log('Socket encountered error: ', e.message, 'Closing socket');
        socket.close();
    });
}

const BG_COLOR = 'black';
const LINE_WIDTH = 1;
const POINT_SIZE = 2.0
const GRID_COLOR = 'white';


function make_wireframe_cube() {
    const geometry = new THREE.BoxGeometry( 1, 1, 1 );
    const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: new THREE.Color(GRID_COLOR),
        linewidth: LINE_WIDTH} );

    const ls = new THREE.LineSegments(edges_geom, wireframe_mat);

    const frac = 0.98;
    const fill_geometry = new THREE.BoxGeometry(frac, frac, frac);
    const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color('black')});
    const mesh = new THREE.Mesh(fill_geometry, mat);
    ls.add(mesh);
    return ls
}

function make_wireframe_circle(radius, segments, color) {
    // Make a wireframe circle using THREE.js and return it
    const geometry = new THREE.CircleGeometry(radius, segments);
    const edges_geom = new THREE.EdgesGeometry(geometry);

    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: color,
        linewidth: LINE_WIDTH});

    const circle = new THREE.LineSegments(edges_geom, wireframe_mat);
    //const circle = new THREE.Mesh(edges_geom, wireframe_mat);
    return circle;
}

function createWireframeCircle(radius, segments, color) {
  // Create a geometry for the circle
  const circleGeometry = new THREE.CircleGeometry(radius, segments);

  // Remove the face and fill materials from the geometry
  //circleGeometry.faces.splice(0, circleGeometry.faces.length);
  //circleGeometry.faceVertexUvs[0].splice(0, circleGeometry.faceVertexUvs[0].length);

  // Create a line segments geometry from the circle geometry
  const wireframeGeometry = new THREE.EdgesGeometry(circleGeometry);

  // Create a material for the wireframe
  const wireframeMaterial = new THREE.LineBasicMaterial({ color: color });

  // Create the wireframe mesh
  const wireframeMesh = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);

  // Return the wireframe mesh
  return wireframeMesh;
}

function make_wireframe_sphere(radius) {
    const geometry = new THREE.SphereGeometry(radius, 32, 32);
    const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: new THREE.Color(GRID_COLOR),
        linewidth: LINE_WIDTH} );

    const ls = new THREE.LineSegments(edges_geom, wireframe_mat);
    return ls
}

function make_wireframe_polyhedron(radius, detail) {
    const geometry = new THREE.IcosahedronGeometry(radius, detail);
    const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: new THREE.Color(GRID_COLOR),
        linewidth: LINE_WIDTH} );

    const ls = new THREE.LineSegments(edges_geom, wireframe_mat);
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

class VisOpening extends VisScene {
    constructor(env, pretitle, title, subtitle, start_stage) {
        super(env);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
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
        const overlay = document.getElementById("overlay");
        //overlay.style.display = 'none';
        for (const [i, id] of this.all_html_elements.entries()) {
            const elem = document.getElementById(id);
            elem.style.visibility = 'hidden';
        }
        for (const [i, v] of this.html_values.entries()) {
            const elem = document.getElementById(this.html_elements[i]);
            elem.innerHTML = v;
        }
        this.set_stage(this.start_stage);
        overlay.style.display = 'hidden';
    }

    deactivate() {
        const overlay = document.getElementById("overlay");
        //overlay.style.display = 'none';
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
    constructor(env) {
        super(env, 3);

        this.vbo_scene = new THREE.Scene();
        this.vbo_camera = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.vbo_camera.position.set(0, 0, 5);
        //this.vbo_camera = new THREE.OrthographicCamera(-8, 8, -8, 8);
        this.cam_vel = new THREE.Vector3();
        this.num_traces = 6;
        this.trace_spacing = 2;

        this.beat_idx = 0;
        this.sync_clock = new THREE.Clock(false);
        this.state_change_clock = new THREE.Clock(false);

        this.recreate_buffers(window.innerWidth, window.innerHeight);

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
            lightning_strike_mesh.visible = false;

            ls.add(lightning_strike_mesh);
        }
        this.vbo_scene.add(this.cubes_group);

        this.ls = make_wireframe_polyhedron(15, 3);
        this.ls.material.color.copy(new THREE.Color("gray"));
        this.ls.renderOrder = -1;
        this.vbo_scene.add(this.ls);
        this.pc = make_point_cloud();
        this.pc.position.copy(this.camera.position);
        //this.vbo_scene.add(this.pc);
        //

        const rayDirection = new THREE.Vector3( 0, - 1, 0 );
        let rayLength = 0;
        const vec1 = new THREE.Vector3();
        const vec2 = new THREE.Vector3();

        

        //this.vbo_scene.add(this.lightning_strike_mesh );

        this.start_cube_bounce_ampl = 0;
        this.curr_cube_bounce_ampl = 0;
        this.target_cube_bounce_ampl = 0;


        this.elapsed_time = 0.0;
        this.time_since_update = 0.0;
        this.time_scaling_key = 0.0;
        this.time_ellipses = 0.0;

        this.cur_selected = 0;
        this.has_started = false;

        const aspect = window.innerWidth / window.innerHeight;
        update_persp_camera_aspect(this.vbo_camera, aspect);

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

    recreate_buffers(width, height) {
        this.buffers = [];
        for (let i = 0; i < this.num_traces * this.trace_spacing; i++) {
            this.buffers.push(new THREE.WebGLRenderTarget(width, height, {}));
        }
        this.cur_buffer_idx = 0;
    }

    get_cube_scale(t) {
        const min_base_scale = 1;
        const max_base_scale = 1.5;

        return this.curr_cube_bounce_ampl * clamp((t - 0.5) ** 2, 0, 1) * (max_base_scale - min_base_scale) + 
            min_base_scale;
    }

    handle_sync(t, bpm, beat) {
        if (beat % 2 == 0) {
            this.sync_clock.start();
        }
    }

    handle_resize(width, height) {
        const aspect = width / height;
        update_persp_camera_aspect(this.vbo_camera, aspect);
        this.recreate_buffers(width, height);
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60 / 2;
        let beat_time = this.sync_clock.getElapsedTime() * beats_per_sec;
        for (const cube of this.cubes) {
            cube.rotation.x += 0.5 * dt;
            cube.rotation.y += 0.5 * dt;
            cube.scale.setScalar(this.get_cube_scale(beat_time));
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

        // Update bounce amplitude
        const bounce_change_beats = 8;
        const frac = clamp(this.state_change_clock.getElapsedTime() * beats_per_sec / bounce_change_beats, 0, 1);
        this.curr_cube_bounce_ampl = lerp_scalar(this.start_cube_bounce_ampl, this.target_cube_bounce_ampl, frac);


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
    }

    state_transition(old_state_idx, new_state_idx) {
        let lightning_visible = false;
        let cubes_bouncing = false;
        if (new_state_idx == 0) {
            lightning_visible = false;
            cubes_bouncing = false;
        } else if (new_state_idx == 1) {
            lightning_visible = false;
            cubes_bouncing = true;
        } else if (new_state_idx == 2) {
            lightning_visible = true;
            cubes_bouncing = true;
        }
        for (const ls of this.lightning_strike_meshes) {
            ls.visible = lightning_visible;
        }
        if (cubes_bouncing) {
            this.target_cube_bounce_ampl = 4;
            this.start_cube_bounce_ampl = this.curr_cube_bounce_ampl;
        } else {
            this.target_cube_bounce_ampl = 0;
            this.start_cube_bounce_ampl = this.curr_cube_bounce_ampl;
        }
        this.state_change_clock.start();
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
    constructor(env) {
        super(env);
        this.min_base_scale = 2.0;
        this.max_base_scale = 3.0;
        this.base_scale = this.min_base_scale;


        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
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
        update_persp_camera_aspect(this.camera, aspect);
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
        const delay = Math.max(60 / this.env.bpm / 2 - this.env.total_latency, 0);
        if (channel == 1) {
            setTimeout(() => { this.base_scale = this.max_base_scale; }, delay * 1000);
        }
    }
}


class GraphicsContext {
    constructor() {
        this.tracers = false;
        this.clock = new THREE.Clock(true);
        this.scenes = [
            new SlideScene(env, ["img/cover.png", "img/santa-claus.jpg", "img/santa-claus-2.png"]),
            new IntroScene(env),
            new SpinningRobotsScene(env),
            new ChineseScene(env),
            new TessellateScene(env),
            //new FastCarScene(env),
            new CubeLockingScene(env),
            new HomeBackground(env),
            new YellowRobotScene(env),
            new IceCreamScene(env),
            new Tracers(env),
            new HexagonScene(env),
            new GantryScene(env),
            new SpectrumScene(env),
            new FastCubeScene(env)
        ];
        this.cur_scene_idx = 0;

        this.debug_overlay = document.getElementById("debug-overlay");

        this.overlay_indicators = [];
        this.indicator_on_time_range = [];
        for (let i = 1; i <= 16; i++) {
            const elem = document.createElement("div");
            this.debug_overlay.appendChild(elem);
            this.overlay_indicators.push(elem);
            this.indicator_on_time_range.push([]);
        }
        this.debug_overlay.style.display = "none";
        this.container = document.createElement( 'div' );
        document.body.appendChild(this.container);
	this.renderer = new THREE.WebGLRenderer();
	this.renderer.setClearColor(BG_COLOR);
	this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.xr.enabled = true
        this.container.appendChild(this.renderer.domElement);

        //document.body.appendChild( VRButton.createButton(this.renderer) );

        this.composer = new EffectComposer(this.renderer);

        // Plane in orthographic view with custom shaders for tracers
        {
            this.num_traces = 1;
            this.trace_spacing = 1;
            this.trace_persistence = 0;

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

	this.on_window_resize();    // also creates buffers
        window.addEventListener('resize', () => { this.on_window_resize(); });
    }

    set_tracer_params(num_traces, spacing, persistence) {
        this.num_traces = num_traces;
        this.trace_spacing = spacing;
        this.trace_persistence = persistence;
        const width = window.innerWidth;
        const height = window.innerHeight;
        this.recreate_buffers(width, height);
    }

    anim_frame() {
        const dt = this.clock.getDelta();
        const t_now = this.clock.getElapsedTime();
        this.scenes[this.cur_scene_idx].anim_frame(dt);

        this.overlay_indicators.forEach((ind, i) => {
            const t_ranges = this.indicator_on_time_range[i];
            const keep_ranges = [];
            let is_active = false;
            for (const t_range of t_ranges) {
                if (t_range[0] <= t_now && t_range[1] > t_now) {
                    is_active = true;
                }
                if (t_range[1] > t_now) {
                    keep_ranges.push(t_range);
                }
            }
            this.indicator_on_time_range[i] = keep_ranges;
            if (is_active) {
                if (i == this.overlay_indicators.length - 1) {
                    ind.style.backgroundColor = 'red';
                } else {
                    ind.style.backgroundColor = 'white';
                }
            } else {
                ind.style.backgroundColor = 'transparent';
            }
        });
    }

    recreate_buffers(width, height) {
        this.buffers = [];
        for (let i = 0; i < this.num_traces * this.trace_spacing; i++) {
            this.buffers.push(new THREE.WebGLRenderTarget(width, height, {}));
        }
        this.cur_buffer_idx = 0;
    }

    render() {
        if (!ENABLE_GLOBAL_TRACERS) {
            this.scenes[this.cur_scene_idx].render(this.renderer);
            return;
        }






        this.renderer.autoClearColor = false;
        this.renderer.setRenderTarget(this.buffers[this.cur_buffer_idx]);
        this.renderer.clear();
        this.scenes[this.cur_scene_idx].render(this.renderer);

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
        this.blend_material.uniforms.ratio.value = this.trace_persistence;

        this.renderer.setRenderTarget(null);
        this.renderer.clear();
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        this.renderer.autoClearColor = true;
        this.cur_buffer_idx = (this.cur_buffer_idx + 1) % this.buffers.length;
    }

    on_window_resize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.recreate_buffers(width, height);
        this.scenes[this.cur_scene_idx].handle_resize(width, height);
        this.renderer.setSize(width, height);
    }

    change_scene(scene_idx) {
        if (scene_idx >= 0 && scene_idx < this.scenes.length) {
            this.scenes[this.cur_scene_idx].deactivate();
            this.cur_scene_idx = scene_idx;
            this.scenes[this.cur_scene_idx].activate();
        }
    }

    advance_state(steps) {
        this.scenes[this.cur_scene_idx].advance_state(steps);
    }

    keydown(e) {
        const num = parseInt(e.key);
        if (!isNaN(num)) {
            const scene_idx = Math.min(num % 10, this.scenes.length - 1);
            this.change_scene(scene_idx);
        } else if (e.key == 't') {
            if (this.num_traces == 1) {
                this.set_tracer_params(10, 4, 0.8);
                //this.set_tracer_params(8, 1, 0.7);
            } else {
                this.set_tracer_params(1, 1, 1);
            }
        } else if (e.code == "Tab") {
            if (this.debug_overlay.style.visibility == 'hidden') {
                this.debug_overlay.style.visibility = 'visible';
            } else {
                this.debug_overlay.style.display = 'hidden';
            }
        } else {
            this.scenes[this.cur_scene_idx].handle_key(e.key);
        }
    }

    handle_sync(t, bpm, beat) {
        const thirtysecond_note_dur = 60 / env.bpm / 8;
        const delay = 8 * thirtysecond_note_dur - env.total_latency;
        const start_t = this.clock.getElapsedTime() + delay;
        this.indicator_on_time_range[this.indicator_on_time_range.length - 1].push([
            start_t,
            start_t + thirtysecond_note_dur
        ]);

        setTimeout(() => {
            this.scenes[this.cur_scene_idx]._handle_sync_raw(t, bpm, beat + 1);
        }, delay * 1000);
    }

    handle_beat(t, channel) {
        const thirtysecond_note_dur = 60 / env.bpm / 8;
        const start_t = this.clock.getElapsedTime() + 4 * thirtysecond_note_dur
            - env.total_latency;
        this.indicator_on_time_range[channel - 1].push([
            start_t,
            start_t + thirtysecond_note_dur
        ]);
        this.scenes[this.cur_scene_idx].handle_beat(t, channel);
    }
}


function animate() {
    context.renderer.setAnimationLoop(() => {
        context.anim_frame();
        context.render();
    });
}
