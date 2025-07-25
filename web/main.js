"use strict";

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
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
import { DrumboxScene } from './src/drumboxes_scene.js';
import { TracersScene } from './src/tracers_scene.js';
import { DDRScene } from './src/ddr_scene.js';
import { HomeBackgroundScene } from './src/home_background_scene.js';
import { SurfacesScene } from './src/surfaces_scene.js';
import { BackgroundSurfacesScene } from './src/bg_surfaces_scene.js';
import { HelixScene } from './src/helix_scene.js';
import { TriangularPrismScene } from './src/triangular_prism_scene.js';
import { CelticKnotScene } from './src/celtic_knot_scene.js';
import { CellularAutomataScene } from './src/cellular_automata_scene.js';
import { TextScene } from './src/text_scene.js';
import { ShaderScene } from './src/shader_scene.js';
import { BuildingScene } from './src/building_scene.js';
import { VectorFieldScene } from './src/scenes/vector_field.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';

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


const MSG_TYPE_SYNC = 0;
const MSG_TYPE_BEAT = 1;
const MSG_TYPE_GOTO_SCENE = 2;
const MSG_TYPE_ADVANCE_SCENE_STATE = 3;
const MSG_TYPE_PROMOTION = 4;
const MSG_TYPE_PROMOTION_GRANT = 5;
const MSG_TYPE_ACK = 6;
const MSG_TYPE_PITCH_BEND = 7;
const MSG_TYPE_CONTROL_CHANGE = 8;

const SKEW_SMOOTHING = 0.99;
const LATENCY_SMOOTHING = 0.9;
const STALE_THRESHOLD = 0.1;
//const EXTRA_LATENCY = 0.220;
const EXTRA_LATENCY = 0.0;

const ENABLE_GLOBAL_TRACERS = false;
const BG_COLOR = 'black';

const SCENES_PER_BANK = 10;

const MIN_SWIPE_LENGTH = 50;

var context = null;
var stats = new Stats();

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


function msg_to_disp_string(msg) {
    let msg_txt = '';
    const str_len = 12;
    if (msg.msg_type == MSG_TYPE_SYNC) {
        msg_txt = `SYNC ${msg.sync_idx}`;
    } else if (msg.msg_type == MSG_TYPE_BEAT) {
        msg_txt = `BEAT ${msg.channel}`;
    } else if (msg.msg_type == MSG_TYPE_GOTO_SCENE) {
        msg_txt = `GOTO ${msg.scene} ${msg.bg}`;
    } else if (msg.msg_type == MSG_TYPE_ADVANCE_SCENE_STATE) {
        msg_txt = `ADV ${msg.steps}`;
    }
    return msg_txt.substring(0, str_len).padEnd(str_len);
}


function connect() {
    //const socket = new WebSocket(`ws://192.168.1.235:8080`);
    let pathname = window.location.pathname;
    pathname = pathname.substring(0, pathname.lastIndexOf('/') + 1);
    const protocol = (location.protocol === 'https:' ? 'wss' : 'ws');
    //const relay_url = `${window.location.hostname}:8765`;
    //const relay_url = 'raspberrypi/ws/';
    const relay_url = '192.168.5.1/ws/';
    const socket = new WebSocket(`${protocol}://${relay_url}`);
    socket.addEventListener('message', function(e) {
	const msg = JSON.parse(e.data);
        const type = msg.msg_type;

        // Estimate clock skew
        const t_now = Date.now() / 1000;
        const skew = t_now - msg.t;
        context.est_avg_skew = context.est_avg_skew ? 
            context.est_avg_skew * SKEW_SMOOTHING + skew * (1 - SKEW_SMOOTHING) :
            skew;

        // Discard stale messages
        if (skew - context.est_avg_skew > STALE_THRESHOLD) {
            return;
        }

        // Update average latency with the one-way latency seen last
        context.est_avg_latency = context.est_avg_latency ?
            context.est_avg_latency * LATENCY_SMOOTHING + msg.latency * (1 - LATENCY_SMOOTHING) :
            msg.latency;

        /*const est_tot_latency = skew - context.est_avg_skew // extra latency of just this message
            + context.est_avg_latency   // average latency
            + EXTRA_LATENCY;            // extra latency (manual calibration)*/
        const est_tot_latency = /*msg.latency +*/ EXTRA_LATENCY;

        //console.log(`Skew: ${skew} | ${context.est_avg_skew}`);
        //console.log(`Latency: ${context.est_avg_latency}`);

        // Update the overlay with latency
        const latency_elem = document.getElementById('latency');
        const latency_str = `${(est_tot_latency * 1000).toFixed(1)}`.substring(0, 4).padEnd(4);
        latency_elem.innerHTML = latency_str;

        if (type == MSG_TYPE_SYNC) {
            context.handle_sync(est_tot_latency, msg.sync_rate_hz, msg.sync_idx);
        } else if (type == MSG_TYPE_BEAT) {
            context.handle_beat(est_tot_latency, msg.channel);
        } else if (type == MSG_TYPE_ADVANCE_SCENE_STATE) {
            context.advance_state(msg.steps);
        } else if (type == MSG_TYPE_CONTROL_CHANGE) {
            console.log("control change");
            console.log(msg);
            if (msg.wheel_idx == 1) {
                // Foreground scene
                context.change_scene(Math.floor(msg.value / 5), false);
            } else if (msg.wheel_idx == 2) {
                // Background scene
                context.change_scene(Math.floor(msg.value / 5), true);
            }
        } else if (type == MSG_TYPE_GOTO_SCENE) {
            context.change_scene(msg.scene, msg.bg);
        }
        const resp = {msg_type: MSG_TYPE_ACK, t: msg.t};
        socket.send(JSON.stringify(resp));

        // Update the overlay with last msg contents
        if (type != MSG_TYPE_SYNC) {
            const last_msg_elem = document.getElementById('lastmsg');
            last_msg_elem.innerHTML = msg_to_disp_string(msg);
        }
    });

    socket.addEventListener('close', function(e) {
        // Try to reconnect after 1 second
        //console.log('Socket is closed. Reconnect will be attempted in 1 second.', e.reason);
        setTimeout(function() {
            connect();
        }, 1000);
    });

    socket.addEventListener('error', function(e) {
        console.log('Socket encountered error: ', e, 'Closing socket');
        socket.close();
    });

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

const ongoingTouches = [];

function ongoingTouchIndexById(idToFind) {
    for (let i = 0; i < ongoingTouches.length; i++) {
        const id = ongoingTouches[i].identifier;

        if (id === idToFind) {
        return i;
        }
    }
    return -1; // not found
}

function copyTouch({ identifier, pageX, pageY }) {
    return { identifier, pageX, pageY };
}

function handle_start(evt) {
    evt.preventDefault();
    const touches = evt.changedTouches;

    for (let i = 0; i < touches.length; i++) {
        ongoingTouches.push(copyTouch(touches[i]));
        /*if (touches[i].pageX < window.innerWidth / 2) {
            context.change_scene(clamp(0, context.cur_scene_idx - 1, context.scenes.length - 1));
        } else {
            context.change_scene(clamp(0, context.cur_scene_idx + 1, context.scenes.length - 1));
        }*/
    }
}

function handle_end(evt) {
    evt.preventDefault();
    const touches = evt.changedTouches;

    for (let i = 0; i < touches.length; i++) {
        let idx = ongoingTouchIndexById(touches[i].identifier);
        if (idx >= 0) {
            const start_pos = new THREE.Vector2(ongoingTouches[idx].pageX, ongoingTouches[idx].pageY);
            const end_pos = new THREE.Vector2(touches[i].pageX, touches[i].pageY);
            const delta = end_pos.clone();
            delta.sub(start_pos);

            if (delta.length() > MIN_SWIPE_LENGTH) {
                // This is a swipe
                if (Math.abs(delta.x) > Math.abs(delta.y)) {
                    // Horizontal swipe
                    if (delta.x > 0) {
                        context.change_scene(clamp(0, context.cur_scene_idx - 1, context.scenes.length - 1));
                    } else {
                        context.change_scene(clamp(0, context.cur_scene_idx + 1, context.scenes.length - 1));
                    }
                } else {
                    // Vertical swipe
                    if (delta.y > 0) {
                        context.change_scene(clamp(0, context.cur_bg_scene_idx + 1, context.scenes.length - 1), true);
                    } else {
                        context.change_scene(clamp(0, context.cur_bg_scene_idx - 1, context.scenes.length - 1), true);
                    }
                }
            } else {
                // This is a tap
                if (touches[i].pageX < window.innerWidth / 4) {
                    context.scenes.get(context.cur_scene_idx).advance_state(-1);
                } else if (touches[i].pageX > window.innerWidth * 3 / 4) {
                    context.scenes.get(context.cur_scene_idx).advance_state(1);
                }
            }
            ongoingTouches.splice(idx, 1);
        }
    }
}

function handle_cancel(evt) {

}

function handle_move(evt) {

}


function init() {
    stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
    stats.dom.style.visibility = 'hidden';
    document.body.appendChild( stats.dom );
    context = new GraphicsContext();
    document.addEventListener('keydown', (e) => { context.keydown(e); });
    connect();
    animate();
}


class GraphicsContext {
    constructor() {
        this.tracers = false;
        this.clock = new THREE.Clock(true);
        this.cur_beat = 0;
        this.cur_sync_error = 0;
        this.bpm = 120;
        this.last_scheduled_sync_time = null;
        this.next_scheduled_sync_time = null;

        // Set up DOM and renderer
        this.debug_overlay = document.getElementById("debug-overlay");
        this.overlay_indicators = [];
        for (let i = 1; i <= 16; i++) {
            const elem = document.createElement("div");
            this.debug_overlay.appendChild(elem);
            this.overlay_indicators.push(elem);
        }
        this.debug_overlay.style.visibility = "hidden";
        this.container = document.createElement( 'div' );
        document.body.appendChild(this.container);
        this.renderer = new THREE.WebGLRenderer({
            antialias: false,
            depth: true,
            stencil: false,
            format: THREE.RGBAFormat,
        });
        this.renderer.autoClearColor = false;
        this.renderer.autoClearDepth = true;
	this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.container.appendChild(this.renderer.domElement);

        // Create scenes
        this.scenes = new Map([
            [0, new VisScene(this)],
            [1, new GantryScene(this)],
            [2, new HexagonScene(this)],
            [3, new SpinningRobotsScene(this)],
            [4, new CubeLockingScene(this)],
            [5, new IceCreamScene(this)],
            [6, new DDRScene(this)],
            [7, new DrumboxScene(this)],
            [8, new YellowRobotScene(this)],
            [9, new ChineseScene(this)],
            [10, new SurfacesScene(this)],
            [11, new BackgroundSurfacesScene(this)],
            [12, new SpectrumScene(this)],
            [13, new FastCubeScene(this)],
            [14, new TessellateScene(this)],
            [15, new HomeBackgroundScene(this)],
            [16, new IntroScene(this)],
            [17, new TracersScene(this)],
            [18, new HelixScene(this)],
            [19, new TriangularPrismScene(this)],
            [20, new CellularAutomataScene(this)],
            [21, new VectorFieldScene(this)],
            //[20, new SlideScene(["img/jungle-background.jpg"])],
            //[21, new TextScene()],
            //[21, new ShaderScene("glsl/chunks/octagrams.frag")],
            //[20, new CelticKnotScene()],
        ]);
        this.change_scene(21);
        this.change_scene(0, true);
        this.cur_scene_bank = 0;
        this.num_scene_banks = Math.ceil((Math.max(...this.scenes.keys()) + 1)
            / SCENES_PER_BANK);

        // Handle touches
        {
            const el = this.renderer.domElement;
            el.addEventListener("touchstart", handle_start);
            el.addEventListener("touchend", handle_end);
            el.addEventListener("touchcancel", handle_cancel);
            el.addEventListener("touchmove", handle_move);
        }


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

        this.immediate_mode = true;

        this.on_window_resize();
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
        this.scenes.get(this.cur_scene_idx).anim_frame(dt);
        if (this.cur_bg_scene_idx != this.cur_scene_idx) {
            this.scenes.get(this.cur_bg_scene_idx).anim_frame(dt);
        }
    }

    indicator_on(i, color) {
        this.overlay_indicators[i].style.backgroundColor = color;
    }

    indicator_off(i) {
        this.overlay_indicators[i].style.backgroundColor = 'transparent';
    }

    indicator_toggle(i, color) {
        if (this.overlay_indicators[i].style.backgroundColor == 'transparent') {
            this.overlay_indicators[i].style.backgroundColor = color;
        } else {
            this.overlay_indicators[i].style.backgroundColor = 'transparent';
        }
    }

    recreate_buffers(width, height) {
        this.buffers = [];
        for (let i = 0; i < Math.max(2, this.num_traces * this.trace_spacing); i++) {
            this.buffers.push(new THREE.WebGLRenderTarget(width, height, {
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat,
                depthBuffer: true,
                stencilBuffer: false
            }));
        }
        this.cur_buffer_idx = 0;
    }

render() {
    if (true) {
        // Use direct rendering to screen in scene bg -> fg order
        this.renderer.clear();

        // Render background scene
        if (this.cur_bg_scene_idx !== null && this.cur_bg_scene_idx != this.cur_scene_idx) {
            this.scenes.get(this.cur_bg_scene_idx).render(this.renderer);
            const vector = new THREE.Vector2(0, 0);
            this.renderer.copyFramebufferToTexture(vector, this.buffers[0].texture);
        } else {
            this.renderer.clear();
        }

        // Render foreground scene
        this.scenes.get(this.cur_scene_idx).render(this.renderer, this.buffers[0]);
    } else {
        // Do overlay render by rendering bg and fg to buffers and blending

        const originalClearColor = this.renderer.getClearColor(new THREE.Color());
        const originalClearAlpha = this.renderer.getClearAlpha();
        
        // Create blend shader if it doesn't exist
        if (!this.blendMaterial) {
            this.blendMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    bgTexture: { value: null },
                    fgTexture: { value: null }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    varying vec2 vUv;
                    uniform sampler2D bgTexture;
                    uniform sampler2D fgTexture;
                    void main() {
                        vec4 bgColor = texture2D(bgTexture, vUv);
                        vec4 fgColor = texture2D(fgTexture, vUv);
                        
                        // Alpha blending
                        gl_FragColor = vec4(
                            mix(bgColor.rgb, fgColor.rgb, fgColor.a),
                            max(bgColor.a, fgColor.a)
                        );
                    }
                `,
                transparent: true,
                depthTest: false
            });
            
            this.displayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMaterial);
            this.displayQuad.frustumCulled = false;
            this.displayScene = new THREE.Scene();
            this.displayScene.add(this.displayQuad);
            this.displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
        }
        
        // Render background scene to buffer 0
        if (this.cur_bg_scene_idx !== null && this.cur_bg_scene_idx != this.cur_scene_idx) {
            this.renderer.setRenderTarget(this.buffers[0]);
            this.renderer.setClearColor(0x000000, 0); // Clear with transparent black
            this.renderer.clear();
            this.scenes.get(this.cur_bg_scene_idx).render(this.renderer);
        } else {
            // If no background, clear buffer with transparent black
            this.renderer.setRenderTarget(this.buffers[0]);
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.clear();
        }
        
        // Render foreground scene to buffer 1
        this.renderer.setRenderTarget(this.buffers[1]);
        this.renderer.setClearColor(0x000000, 0); // Clear with transparent black
        this.renderer.clear();
        this.scenes.get(this.cur_scene_idx).render(this.renderer, this.buffers[0]);
        
        // Blend both buffers and render to screen
        this.renderer.setRenderTarget(null);
        this.renderer.setClearColor(BG_COLOR, 1);
        this.renderer.clear();
        
        this.blendMaterial.uniforms.bgTexture.value = this.buffers[0].texture;
        this.blendMaterial.uniforms.fgTexture.value = this.buffers[1].texture;
        this.renderer.render(this.displayScene, this.displayCamera);
        
        // Restore original clear color
        this.renderer.setClearColor(originalClearColor, originalClearAlpha);
    }
}

    on_window_resize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.renderer.setSize(width, height);
        const div_ratio = Math.max(Math.ceil(Math.max(width, height) / 1000), 2);
        //const div_ratio = window.devicePixelRatio;
        this.renderer.setPixelRatio(window.devicePixelRatio / div_ratio);
        this.recreate_buffers(width, height);
        this.scenes.forEach((scene) => {
            scene.handle_resize(width, height);
        });
    }

    change_scene(new_scene_idx, bg=false) {
        if (this.scenes.has(new_scene_idx)) {
            const cur_idx = bg ? this.cur_bg_scene_idx : this.cur_scene_idx;
            const other_idx = bg ? this.cur_scene_idx : this.cur_bg_scene_idx;
            if (cur_idx !== undefined && cur_idx != other_idx) {
                this.scenes.get(cur_idx).deactivate();
            }
            if (bg) {
                this.cur_bg_scene_idx = new_scene_idx;
            } else {
                this.cur_scene_idx = new_scene_idx;
            }
            if (new_scene_idx != other_idx) {
                this.scenes.get(new_scene_idx).activate();
            }

            // Update relevant element in the HTML overlay
            const str_len = 10;
            const hud_div = document.getElementById(bg ? 'bg-name' : 'fg-name');
            const scene_name_pad = this.scenes.get(new_scene_idx).shortname
                .substring(0, str_len).padEnd(str_len);
            console.log(scene_name_pad);
            hud_div.innerHTML = scene_name_pad;
        }
    }

    advance_state(steps) {
        this.scenes.get(this.cur_scene_idx).advance_state(steps);
        if (this.cur_bg_scene_idx !== null && this.cur_bg_scene_idx != this.cur_scene_idx) {
            this.scenes.get(this.cur_bg_scene_idx).advance_state(steps);
        }
    }

    keydown(e) {
        const num = parseInt(e.key);
        const shift_chars = ')!@#$%^&*(';
        console.log(e.key);
        if (!isNaN(num)) {
            const scene_idx = Math.trunc(this.cur_scene_bank * SCENES_PER_BANK + 
                (num % 10));
            this.change_scene(scene_idx);
        } else if (shift_chars.includes(e.key)) {
            const scene_idx = Math.trunc(this.cur_scene_bank * SCENES_PER_BANK + 
                shift_chars.indexOf(e.key));
            this.change_scene(scene_idx, true);
        } else if (e.key == 't') {
            if (this.num_traces == 1) {
                this.set_tracer_params(10, 4, 0.8);
                //this.set_tracer_params(8, 1, 0.7);
            } else {
                this.set_tracer_params(1, 1, 1);
            }
        } else if (e.code == "Space") {
            this.immediate_mode = !this.immediate_mode;
            this.update_mode_hud();
        } else if (e.code == "KeyD") {
            if (this.debug_overlay.style.visibility == 'hidden') {
                this.debug_overlay.style.visibility = 'visible';
                stats.dom.style.visibility = 'visible';
            } else {
                this.debug_overlay.style.visibility = 'hidden';
                stats.dom.style.visibility = 'hidden';
            }
        } else if (e.key == "ArrowLeft") {
            this.advance_state(-1);
        } else if (e.key == "ArrowRight") {
            this.advance_state(1);
        } else if (e.key == "ArrowUp") {
            this.cur_scene_bank = Math.min(this.cur_scene_bank + 1, this.num_scene_banks - 1);
        } else if (e.key == "ArrowDown") {
            this.cur_scene_bank = Math.max(this.cur_scene_bank - 1, 0);
        } else {
            this.scenes.get(this.cur_scene_idx).handle_key(e.key);
        }
    }

    handle_sync(latency, sync_rate_hz, beat) {
        const syncs_to_skip = 24;
        const delay = this.immediate_mode ? 0 : syncs_to_skip / sync_rate_hz - latency;

        // Wait until the next beat to deliver the sync message
        setTimeout(() => {
            this.scenes.forEach((scene) => {
                scene.handle_sync_raw(sync_rate_hz, beat + 1);
            });
        }, delay * 1000);

        /*this.scenes.forEach((scene) => {
            scene.handle_sync_raw(sync_rate_hz, beat);
        });*/
        // Update overlay with sync rate hz (convert to bpm)
        const bpm = Math.round(sync_rate_hz * 60 / 24);
        const bpm_elem = document.getElementById("bpm");
        bpm_elem.innerHTML = String(bpm).padEnd(3);
    }

    update_mode_hud() {
        const mode = this.immediate_mode ? 'imm' : 'del';
        const mode_elem = document.getElementById('mode');
        mode_elem.innerHTML = mode;
    }

    handle_beat(latency, channel) {
        this.scenes.forEach((scene) => {
            scene.handle_beat(latency, channel);
        });
    }

    get_avg_skew() {
        return this.est_avg_skew;
    }
}


function animate() {
    context.renderer.setAnimationLoop(() => {
        stats.begin();
        context.anim_frame();
        context.render();
        stats.end();
    });
}
