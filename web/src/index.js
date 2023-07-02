"use strict";

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LightningStrike } from 'three/examples/jsm/geometries/LightningStrike.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { Tesseract } from './highdim.js';
import { VisScene } from './vis_scene.js';
import { GantryScene } from './gantry_scene.js';
import { HexagonScene } from './hexagon_scene.js';
import { SpectrumScene } from './spectrum_scene.js';
import { IntroScene } from './intro_scene.js';

import {
    lerp_scalar,
    ease,
    update_persp_camera_aspect,
    update_orth_camera_aspect,
    rand_int,
    arr_eq
} from './util.js';

import css_normalize from "./normalize.css";
import css_style from "./style.css";


const SCALE_LERP_RATE = 5;
const MSG_TYPE_SYNC = 0;
const MSG_TYPE_BEAT = 1;

var context = null;

const env = {
    bpm: 120,
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
    context.change_scene(1);
    animate();
}

function connect() {
    //const socket = new WebSocket(`ws://192.168.1.235:8080`);
    const socket = new WebSocket(`ws://visuals:8080`);
    socket.addEventListener('message', function(e) {
        const msg = JSON.parse(e.data);
        const type = msg.msg_type;

        if (type == MSG_TYPE_SYNC) {
            //bg.cubes_group.rotation.y += 0.1;
            context.handle_sync(msg.t, msg.bpm, msg.beat);
            env.bpm = msg.bpm;
        } else if (type == MSG_TYPE_BEAT) {
            context.handle_beat(msg.t, msg.channel);
        }
        const time_now = Date.now() / 1000;
        const latency = time_now - msg.t;
        socket.send(latency);
    });

    socket.addEventListener('close', function(e) {
        // Try to reconnect after 1 second
        console.log('Socket is closed. Reconnect will be attempted in 1 second.', e.reason);
        setTimeout(function() {
            connect();
        }, 1000);
    });

    socket.addEventListener('error', function(e) {
        console.log('Socket encountered error: ', e.message, 'Closing socket');
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
    constructor(env) {
        super(env);

        this.vbo_scene = new THREE.Scene();
        this.vbo_camera = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.vbo_camera.position.set(0, 0, 5);
        //this.vbo_camera = new THREE.OrthographicCamera(-8, 8, -8, 8);
        this.cam_vel = new THREE.Vector3();
        this.num_traces = 6;
        this.trace_spacing = 2;

        this.beat_idx = 0;
        this.beat_clock = new THREE.Clock(false);


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

        return 4 * (t - 0.5) ** 2 * (max_base_scale - min_base_scale) + 
            min_base_scale;
    }

    handle_sync(t, bpm, beat) {
        this.beat_idx++;
        if (this.beat_idx % 2 == 0) {
            this.beat_clock.start();
        }
    }

    handle_resize(width, height) {
        const aspect = width / height;
        update_persp_camera_aspect(this.vbo_camera, aspect);
        this.recreate_buffers(width, height);
    }

    anim_frame(dt) {
        const beats_per_sec = this.env.bpm / 60 / 2;
        let beat_time = this.beat_clock.getElapsedTime() * beats_per_sec;
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
        this.camera = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
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
        this.base_scale = this.max_base_scale;
    }
}

class GeomDef {
    constructor(coords, children=new Map()) {
        this.coords = coords;
        this.children = children;
        this.mesh = null;
    }

    create() {
        const group = new THREE.Group();
        for (const [i, c] of this.children) {
            group.add(c.create());
        }
        this.mesh = group;
        this.mesh.position.set(...this.coords);
        return this.mesh;
    }
}

class BoxDef extends GeomDef {
    constructor(coords, dims, children=new Map()) {
        super(coords, children);
        this.dims = dims;
    }
    create() {
        super.create();
        let geometry = new THREE.BoxGeometry(...this.dims);
        let wireframe = new THREE.EdgesGeometry(geometry);
        const wireframe_mat = new THREE.LineBasicMaterial( { color: "yellow", linewidth: 1 } );
        this.mesh.add(new THREE.LineSegments(wireframe, wireframe_mat));

        const inner_dims = [...this.dims];
        for (const i in inner_dims) {
            inner_dims[i] *= 0.97;
        }
        const fill_mat = new THREE.MeshBasicMaterial( { color: "black" } );
        const inner_geom = new THREE.BoxGeometry(...inner_dims);
        this.mesh.add(new THREE.Mesh(inner_geom, fill_mat));

        return this.mesh;
    }
}


class LineDef extends GeomDef {
    constructor(coords, children=new Map()) {
        super(coords, children);
        this.coords = coords;
    }
    create() {
        super.create();
        const line_mat = new THREE.LineBasicMaterial({color: "yellow"});
        const points = [];
        for (const i in this.coords) {
            points.push(new THREE.Vector3(...(this.coords[i])));
        }
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geom, line_mat);
        this.mesh.add(line);
        return this.mesh;
    }
}


const RobotParts = {
    TORSO: 0,
    LEGS: [1, 2],
    HEAD: 3,
    HANDS: [4, 5],
    FEET: [6, 7],
    ARMS: [8, 9],
    EYES: 10,
    MAX: 11
}


class Robot {
    constructor(parent_obj, position) {
        this.obj = new THREE.Group();
        this.meshes = Array(RobotParts.MAX);

        this.cube_defs = new Map();
        for (const side of [0, 1]) {
            const sign = (2 * side - 1);
            this.cube_defs[RobotParts.HANDS[side]] = new BoxDef([sign * -0.5, 0, 1], [0.5, 1, 1]);
            const arm_children = new Map([
                [RobotParts.HANDS[side], this.cube_defs[RobotParts.HANDS[side]]]
            ]);
            this.cube_defs[RobotParts.ARMS[side]] = new BoxDef([sign * 1.75, 0.5, 1.75], [0.5, 0.5, 2.0],
                arm_children);
        }

        this.cube_defs[RobotParts.LEGS[0]] = new BoxDef([-0.75, -2, 0],
            [0.5, 1.5, 1.0]);
        this.cube_defs[RobotParts.LEGS[1]] = new BoxDef([0.75, -2, 0],
            [0.5, 1.5, 1.0]);
        this.cube_defs[RobotParts.EYES] = new BoxDef([0, 0, 1.125], [1.5, 0.25, 0.25]);


        this.cube_defs[RobotParts.LEGS[0]] = new BoxDef([-0.75, -2, 0],
            [0.5, 1.5, 1.0]);
        this.cube_defs[RobotParts.LEGS[1]] = new BoxDef([0.75, -2, 0],
            [0.5, 1.5, 1.0]);
        this.cube_defs[RobotParts.EYES] = new BoxDef([0, 0, 1.125], [1.5, 0.25, 0.25]);

        const head_children = new Map([
            [RobotParts.EYES, this.cube_defs[RobotParts.EYES]]]);

        this.cube_defs[RobotParts.HEAD] = new BoxDef([0, 1.75, 0], [2.0, 1.0, 2.0],
            head_children);

        const torso_children = new Map([
            [RobotParts.HEAD, this.cube_defs[RobotParts.HEAD]],
            [RobotParts.ARMS[0], this.cube_defs[RobotParts.ARMS[0]]],
            [RobotParts.ARMS[1], this.cube_defs[RobotParts.ARMS[1]]],
            [RobotParts.LEGS[0], this.cube_defs[RobotParts.LEGS[0]]],
            [RobotParts.LEGS[1], this.cube_defs[RobotParts.LEGS[1]]]]);

        this.cube_defs[RobotParts.TORSO] = new BoxDef([0, 1, 0], [3, 2, 1], torso_children);

        this.cube_defs[RobotParts.FEET[0]] = new BoxDef([-0.75, -2, 0], [1.5, 0.5, 2.0]);
        this.cube_defs[RobotParts.FEET[1]] = new BoxDef([0.75, -2, 0], [1.5, 0.5, 2.0]);

        const offset = [0, -1, 0];
        for (const i of [RobotParts.TORSO, RobotParts.FEET[0], RobotParts.FEET[1]]) {
            for (const j in offset) {
                this.cube_defs[i].coords[j] += offset[j];
            }
        }


        for (const i of [RobotParts.TORSO, RobotParts.FEET[0], RobotParts.FEET[1]]) {
            let mesh = this.cube_defs[i].create();
            this.obj.add(mesh);
            this.meshes[i] = mesh;
        }
        this.obj.position.copy(position);
        parent_obj.add(this.obj);
    }
}


class HyperRobot extends VisScene {
    constructor(env) {
        super(env);

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 16;
        this.cam_persp = new THREE.PerspectiveCamera( 75, 1, 0.1, 10000 );
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -8, 1000);
        this.scene = new THREE.Scene();
        this.move_clock = new THREE.Clock(false);
        this.half_beat_clock = new THREE.Clock(false);
        this.beat_clock = new THREE.Clock(false);

        this.beat_idx = 0;

        this.start_rot = [0, 0];
        this.target_rot = [0, 0];
        this.rot = [0, 512 / 2];

        this.robots = [];
        this.circles = [];

        this.all_group = new THREE.Group();
        this.robot_group = new THREE.Group();
        this.circle_group = new THREE.Group();
        this.anaman_group = new THREE.Group();
        this.tesseract_group = new THREE.Group();

        this.tesseract = new Tesseract(this.tesseract_group, 4);
        this.tesseract_group.position.set(0, 0.5, 2.75);
        //this.all_group.add(this.tesseract_group);

        this.curr_spacing = 3;

        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                let position = new THREE.Vector3((i - 1) * this.curr_spacing, 0,
                    (j - 1) * this.curr_spacing);
                this.robots.push(new Robot(this.robot_group, position));

                const circle = make_wireframe_circle(6, 32, new THREE.Color("cyan"));
                circle.position.copy(position);
                //circle.position.z += 1.2;   // foot forward offset
                circle.rotation.x = Math.PI / 2.0;
                this.circles.push(circle);
                this.circle_group.add(circle);

            }
        }
        // position circle group right below feet
        this.circle_group.position.y = -3.26;

        this.all_group.add(this.circle_group);
        this.all_group.add(this.robot_group);


        this.circle_scale_base = 0.1;
        this.circle_scale_max = 1.0;

        this.scene.add(this.all_group);

        /*let loader = new GLTFLoader();
        loader.load( 'static/obj/anaman.glb', function ( gltf ) {
            const wireframe_mat = new THREE.LineBasicMaterial( { color: "cyan", linewidth: 1 } );
            for (var i in gltf.scene.children) {
                let edges = new THREE.EdgesGeometry(gltf.scene.children[i].geometry, 30);
                let mesh = new THREE.LineSegments(edges, wireframe_mat);
                this.anaman_group.add(mesh);
                this.anaman_group.position.set(0, 2.15, -0.2);
                this.anaman_group.scale.set(2.0, 2.0, 2.0);
                this.anaman_group.rotation.set(Math.PI / 2.0, 0, 0);
            }
            this.all_group.add(this.anaman_group);
        }, undefined, function ( error ) {
                console.error( error );
        } );*/

        this.cam_persp.position.set(0, 0, 8);
        this.cam_orth.position.set(0, 0, 8);

        this.camera = this.cam_orth;
        //this.camera = this.cam_persp;

        update_orth_camera_aspect(this.cam_orth, aspect, this.frustum_size);
        update_persp_camera_aspect(this.cam_persp, aspect);
    }

    is_foot_forward(side_idx, t) {
        const t_period = 1.0 / 4.0;
        const pos_idx = (Math.floor(t / t_period) + 2 * side_idx) % 4;
        return (pos_idx == 1 || pos_idx == 2);
    }

    get_foot_shuffle_offset(side_idx, t) {
        // get shuffle offset for this side as an array [x, y, z]
        // side_idx: 0 for left, 1 for right
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            [0, ease(Math.min(1, dt / t_mov)), ease(Math.min(0, -1 + dt / t_mov))],
            [0, ease(Math.max(0, 1 - dt / t_mov)), ease(Math.min(1, dt / t_mov))],
            [0, 0, ease(Math.max(0, 1 - dt / t_mov))],
            [0, 0, ease(Math.max(-1, -dt / t_mov))]];
        /*const pos_idx = (Math.floor(t / t_period) +
            ((side_idx + beat_idx) % 2) * 2) % position_options.length;*/
        const pos_idx = (Math.floor(t / t_period) + 2 * side_idx) % position_options.length;
        return position_options[pos_idx];
    }

    get_body_shuffle_offset(t) {
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            ease(Math.min(1, dt / t_mov)),
            ease(Math.max(0, 1 - dt / t_mov))];
        /*const pos_idx = (Math.floor(t / t_period) +
            ((side_idx + beat_idx) % 2) * 2) % position_options.length;*/
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.8;
    }

    get_arms_pump_offset(t) {
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = t_period * 0.8;
        const dt = Math.max(0, (t % t_period) - (t_period - t_mov));
        const position_options = [
            ease(Math.min(1, dt / t_mov)),
            ease(Math.max(0, 1 - dt / t_mov))];
        /*const pos_idx = (Math.floor(t / t_period) +
            ((side_idx + beat_idx) % 2) * 2) % position_options.length;*/
        const pos_idx = Math.floor(t / t_period) % position_options.length;
        return position_options[pos_idx] * 0.6;
    }

    handle_sync(t, bpm, beat) {
        this.beat_clock.start();
        if (this.beat_idx % 2 == 0) {
            // half-note beat
            this.half_beat_clock.start();
            console.log(`HALF BEAT: ${t}`);
            this.circle_group.position.x = 0.75;
        } else {
            this.circle_group.position.x = -0.75;
        }
        this.beat_idx++;
        const snap_mult = 64;
        if (rand_int(0, 4) == 0) {//(song_beat != song_beat_prev && song_beat % 2 == 0 || paused) {// && rand_int(0, 2) == 0) {
            // if close enough, can clear the existing movement to start a new one
            if (this.go_to_target) {
                const manhattan_dist = Math.abs(this.target_rot[0] - this.rot[0]) +
                    Math.abs(this.target_rot[1] - this.rot[1]);
                if (manhattan_dist <= 8) {
                    this.go_to_target = false;
                }
            }
            // if done moving to target, start a new movement
            if (!this.go_to_target) {
                for (var i = 0; i < 2; i++) {
                    this.start_rot[i] = Math.round(this.rot[i] / snap_mult) * snap_mult;
                }
                let motion_idx = rand_int(0, 8);   // -1, 0, 1 about 2 axes, but no 0, 0
                if (motion_idx > 3) {
                    motion_idx += 1;            // make it 0-8 (9 options) for ease
                }
                let rot_dirs = [motion_idx % 3 - 1, Math.floor(motion_idx / 3) - 1];
                this.target_rot = [(Math.round(this.start_rot[0] / snap_mult) + rot_dirs[0]) * snap_mult,
                    (Math.round(this.start_rot[1] / snap_mult) + rot_dirs[1]) * snap_mult];
                this.go_to_target = true;
                this.move_clock.start();
                //console.log(`go to target: ${this.target_rot} from ${this.start_rot}`);
            }
        }
    }


    anim_frame(dt) {
        const div = 512;    // # of divisions per pi radians
        const float_rate = 1;
        const track_rate = 2;
        const beats_per_sec = this.env.bpm / 60;

        this.tesseract.rot_xw -= 0.05;
        this.tesseract.update_geom();


        if (this.go_to_target) {
            const num_beats_to_lerp = 1.0;
            let elapsed = this.move_clock.getElapsedTime();
            for (var i = 0; i < 2; i++) {
                const full_time = 1.0 / beats_per_sec * num_beats_to_lerp;
                const ang_vel = (this.target_rot[i] - this.start_rot[i]) * 1.0 / full_time;
                const sign_before = Math.sign(this.target_rot[i] - this.rot[i]);
                this.rot[i] = this.start_rot[i] + ang_vel * elapsed;
                const sign_after = Math.sign(this.target_rot[i] - this.rot[i]);
                if (sign_after != sign_before) {
                    this.rot[i] = this.target_rot[i];
                }
            }
            if (arr_eq(this.rot, this.target_rot)) {
                /*for (var i = 0; i < 2; i++) {
                    rot[i] = target_rot[i];
                }*/
                this.go_to_target = false;
            }
        }


        let half_beat_time = this.half_beat_clock.getElapsedTime() * beats_per_sec / 2.0;
        let furthest_forward_z_touching_ground = null;
        for (let side = 0; side < 2; side++) {
            const shuffle_offset = this.get_foot_shuffle_offset(side, half_beat_time);
            const body_offset = this.get_body_shuffle_offset(half_beat_time);
            const arms_offset = this.get_arms_pump_offset(half_beat_time);
            this.robots.forEach((robot, i) => {
                const leg = robot.cube_defs[RobotParts.TORSO].children.get(
                    RobotParts.LEGS[side]).mesh;

                const foot_base_y = robot.cube_defs[RobotParts.FEET[side]].coords[1];
                const foot_base_z = robot.cube_defs[RobotParts.FEET[side]].coords[2];
                const leg_base_y = robot.cube_defs[RobotParts.LEGS[side]].coords[1];
                const leg_base_z = robot.cube_defs[RobotParts.LEGS[side]].coords[2];
                const leg_base_height = robot.cube_defs[RobotParts.LEGS[side]].dims[1];

                const leg_scale_y = 1 + (body_offset - shuffle_offset[1]) / leg_base_height;
                const leg_offset_y = (1 - leg_scale_y) * leg_base_height / 2;//shuffle_offset[1] - body_offset;
                robot.meshes[RobotParts.FEET[side]].position.y = foot_base_y + shuffle_offset[1];
                robot.meshes[RobotParts.FEET[side]].position.z = foot_base_z + shuffle_offset[2];
                leg.position.y = leg_base_y + leg_offset_y;
                leg.position.z = leg_base_z + shuffle_offset[2];
                leg.scale.y = leg_scale_y;

                const torso_base_y = robot.cube_defs[RobotParts.TORSO].coords[1];
                robot.meshes[RobotParts.TORSO].position.y = torso_base_y + body_offset;

                const arm_base_y = robot.cube_defs[RobotParts.ARMS[side]].coords[1];
                const arm = robot.cube_defs[RobotParts.TORSO].children.get(
                    RobotParts.ARMS[side]).mesh;
                arm.position.y = arm_base_y + arms_offset;
            });
            if (shuffle_offset[1] == 0 && 
                (shuffle_offset[2] > furthest_forward_z_touching_ground || 
                furthest_forward_z_touching_ground === null)) {
                // if this is the furthest-forward side touching the ground,
                // track it with the circles
                furthest_forward_z_touching_ground = shuffle_offset[2];
            }
        }
        this.circle_group.position.z = furthest_forward_z_touching_ground;

        let beat_time = this.beat_clock.getElapsedTime() * beats_per_sec;
        this.circle_scale = lerp_scalar(this.circle_scale_base, this.circle_scale_max, beat_time);
        for (const circle of this.circles) {
            circle.scale.setScalar(this.circle_scale);
            circle.material.opacity = 1.0 - beat_time;
        }

        this.all_group.rotation.x = this.rot[0] * Math.PI / div;
        this.all_group.rotation.y = this.rot[1] * Math.PI / div;

    }
}


class GraphicsContext {
    constructor() {
        this.tracers = false;
        this.clock = new THREE.Clock(true);
        this.scenes = [
            new VisOpening(env, "Kazakh Player Mode Presents", "Vain Oblations", "", 0),
            new IntroScene(env),
            new SpectrumScene(env),
            new HexagonScene(env),
            new GantryScene(env),
            new Tracers(env),
            new HomeBackground(env),
            new HyperRobot(env)
        ];
        this.cur_scene_idx = 0;

	this.canvas = document.getElementById('canvas');
	this.renderer = new THREE.WebGLRenderer({ "canvas": this.canvas, "antialias": false });
	this.renderer.setClearColor(BG_COLOR);
	this.renderer.setPixelRatio(window.devicePixelRatio);
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
        let dt = this.clock.getDelta();
        this.scenes[this.cur_scene_idx].anim_frame(dt);
    }

    recreate_buffers(width, height) {
        this.buffers = [];
        for (let i = 0; i < this.num_traces * this.trace_spacing; i++) {
            this.buffers.push(new THREE.WebGLRenderTarget(width, height, {}));
        }
        this.cur_buffer_idx = 0;
    }

    render() {
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
        this.scenes[this.cur_scene_idx].deactivate();
        this.cur_scene_idx = scene_idx;
        this.scenes[this.cur_scene_idx].activate();
    }

    keydown(e) {
        const num = parseInt(e.key);
        if (!isNaN(num)) {
            const scene_idx = Math.min(num % 10, this.scenes.length - 1);
            this.change_scene(scene_idx);
        } else if (e.key == 't') {
            if (this.num_traces == 1) {
                this.set_tracer_params(8, 4, 0.7);
            } else {
                this.set_tracer_params(1, 1, 1);
            }
        } else {
            this.scenes[this.cur_scene_idx].handle_key(e.key);
        }
    }

    handle_sync(t, bpm, beat) {
        this.scenes[this.cur_scene_idx].handle_sync(t, bpm, beat);
    }

    handle_beat(t, channel) {
        this.scenes[this.cur_scene_idx].handle_beat(t, channel);
    }
}


function animate() {
    context.anim_frame();
    context.render();
    window.requestAnimationFrame(animate);
}
