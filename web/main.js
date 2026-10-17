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
import { Scene } from './src/scenes/scene.js';
import { GantryScene } from './src/scenes/gantry_scene.js';
import { CubeFractalScene } from './src/scenes/cubefractal_scene.js';
import { SpectrumScene } from './src/scenes/spectrum_scene.js';
import { TesseractScene } from './src/scenes/tesseract_scene.js';
import { IceCreamScene } from './src/scenes/ice_cream_scene.js';
import { CubemanScene } from './src/scenes/cubeman_scene.js';
import { GlyphWalkScene } from './src/scenes/glyph_walk_scene.js';
import { TessellateScene } from './src/scenes/tessellate_scene.js';
import { CubeTubesScene } from './src/scenes/cubetubes_scene.js';
import { YellowRobotScene } from './src/scenes/yellow_robot_scene.js';
import { SpinningRobotsScene } from './src/scenes/spinning_robots_scene.js';
import { DrumboxScene } from './src/scenes/drumbox_scene.js';
import { TracersScene } from './src/scenes/tracers_scene.js';
import { DDRScene } from './src/scenes/ddr_scene.js';
import { CubeBounceScene } from './src/scenes/cube_bounce_scene.js';
import { SurfacesScene } from './src/scenes/surfaces_scene.js';
import { ParamSurfaceScene } from './src/scenes/param_surface_scene.js';
import { HelixScene } from './src/scenes/helix_scene.js';
import { RollingCubeScene } from './src/scenes/rolling_cube_scene.js';
import { SphereGridScene } from './src/scenes/sphere_grid_scene.js';
import { CellularAutomataScene } from './src/scenes/cellular_automata_scene.js';
import { ShaderScene } from './src/scenes/shader_scene.js';
import { MIDI_SYNCS_PER_BEAT } from './src/scenes/scene.js';
import { BrainMazeScene } from './src/scenes/brain_maze_scene.js';
import { BuildingScene } from './src/scenes/building_scene.js';
import { VectorFieldScene } from './src/scenes/vector_field_scene.js';
import { DrumKitScene } from './src/scenes/drum_kit_scene.js';
import { DebugScene } from './src/scenes/debug_scene.js';
import { PoseScene } from './src/scenes/pose_scene.js';
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
import { CH_SHADER_A, CH_SHADER_B } from './src/controller_map.js';
import { BoxDef } from './src/geom_def.js';
import { ViewTransform } from './src/view_transform.js';
import { SteppedView, UPRIGHT_PITCHES } from './src/stepped_rotation.js';
import { WebsocketController, create_knobs, apply_control_change }
    from './src/controller.js';

import "./src/normalize.css";
import "./src/style.css";


// Whether each layered scene starts with a fresh depth buffer. true: every
// layer draws fully over the ones below (stacking order always wins). false:
// depth carries over, so a lower scene's geometry nearer the camera can show
// through (and black-fill) parts of the scenes above; the scenes' cameras
// differ, so where that happens is incidental, but it can interleave layers
// in a way that looks good.
const CLEAR_DEPTH_BETWEEN_SCENES = true;

const MSG_TYPE_SYNC = 0;
const MSG_TYPE_BEAT = 1;
const MSG_TYPE_GOTO_SCENE = 2;
const MSG_TYPE_ADVANCE_SCENE_STATE = 3;
const MSG_TYPE_PROMOTION = 4;
const MSG_TYPE_PROMOTION_GRANT = 5;
const MSG_TYPE_PITCH_BEND = 7;
const MSG_TYPE_CONTROL_CHANGE = 8;
const MSG_TYPE_AUDIO_INFO = 10;
// Name of the act currently playing (see adapter/message.py's MsgPerformer).
const MSG_TYPE_PERFORMER = 11;
// Our own timestamp, echoed back by the adapter so we can time the round trip
// (see connect()).
const MSG_TYPE_PING = 12;
// Whether beats arrive early for us to delay (see adapter/message.py's
// MsgBeatMode); sent by the adapter as we connect.
const MSG_TYPE_BEAT_MODE = 13;

// Widths the header's fixed fields are padded to, so the '|' separators hold
// still as values change (#header is white-space: pre). The scene list sits
// last in the header and is the only field left unpadded, since the number of
// slots in play has no useful bound.
// The connection indicator is one character wide in either state: every glyph
// below is a single Block Elements codepoint, which the header's monospace
// stack renders in one cell.
//
// Connected: shade blocks stepping solid -> sparse across each quarter note, so
// the indicator reads as a pulse locked to the kick. Index 0 lands on the beat.
const HUD_BEAT_GLYPHS = ['\u2588', '\u2593', '\u2592', '\u2591'];
// Connecting: quadrant blocks in corner order, which reads as one block
// rotating clockwise.
const HUD_SPIN_GLYPHS = ['\u2598', '\u259D', '\u2597', '\u2596'];
// Spinner steps per second. Fast enough to read as motion, slow enough that the
// corners are distinguishable.
const HUD_SPIN_HZ = 6;
// Beat length assumed before any sync has set a tempo, in seconds (120 bpm).
const HUD_FALLBACK_BEAT_S = 0.5;
// How often the header's fps and latency fields refresh, in seconds: fps
// counts the frames in each window, and slower refreshes keep both readable.
const HUD_STATS_INTERVAL_S = 0.5;

const SKEW_SMOOTHING = 0.99;
const LATENCY_SMOOTHING = 0.9;
const STALE_THRESHOLD = 0.1;
// How often to ping the adapter to measure our latency to it, in ms.
const PING_INTERVAL_MS = 250;
// Latency beyond the network's that we can't measure - display pipeline,
// audio output - in seconds, calibrated by hand. Added to the measured
// latency to get expected_latency().
//const EXTRA_LATENCY = 0.220;
const EXTRA_LATENCY = 0.0;

const ENABLE_GLOBAL_TRACERS = false;
const BG_COLOR = 'black';

const SCENES_PER_BANK = 10;
const NUM_SLOTS = 10;
// A crossfaded scene change (see set_slot) fades within its slot over this
// many beats (four bars), so swaps land musically and scale with tempo.
const CROSSFADE_BEATS = 16;
// While a slot crossfades, its header entry shows the incoming scene
// (highlighted) for this fraction of each beat, in step with the
// connection indicator's pulse (see hud_beat_phase), and the outgoing one
// for the rest: the incoming name lights with the solid glyph on the beat.
const HUD_BLINK_ON_FRACTION = 0.5;

// Longest frame delta (seconds) passed to scene animation. rAF stops while
// the tab/window is hidden, so an unclamped delta can span minutes and blow
// up the scenes' Euler-integrated spring physics; ~3 frames of slack absorbs
// ordinary hitches without visibly slowing motion.
const MAX_FRAME_DT = 0.1;

const MIN_SWIPE_LENGTH = 50;
// Two taps this close together in time (ms) and space (px) are a double-tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 40;
// sessionStorage key for the slots' scenes and the active slot, so they
// survive the page being reloaded (see save_slots).
const SLOTS_STORAGE_KEY = 'visync.slots';

var context = null;
var stats = new Stats();

window.addEventListener("load", init);


// URL of the relay that carries all top-level messages (sync, beat, scene
// changes, control changes, ...). Controllers can connect to this same relay.
// When the page is served on an explicit port (e.g. the vite dev server, from
// this machine or another on the LAN) we talk to the adapter directly on the
// same host; otherwise we're behind nginx, which proxies /ws/ to the adapter.
function relay_url() {
    const protocol = (location.protocol === 'https:' ? 'wss' : 'ws');
    const hostname = window.location.hostname;
    const direct = window.location.port !== "" || hostname === "localhost";
    const path = direct ? `${hostname}:8765` : `${hostname}/ws/`;
    return `${protocol}://${path}`;
}


function connect() {
    const socket = new WebSocket(relay_url());
    let ping_timer = null;
    socket.addEventListener('open', function() {
        context.set_connected(true);
        ping_timer = setInterval(() => {
            socket.send(JSON.stringify(
                {msg_type: MSG_TYPE_PING, t: performance.now() / 1000}));
        }, PING_INTERVAL_MS);
    });
    socket.addEventListener('message', function(e) {
	const msg = JSON.parse(e.data);
        const type = msg.msg_type;

        // Our own ping, echoed back: half its round trip is our one-way
        // latency to the adapter. Its t is on our clock, not the adapter's,
        // so it stays out of the skew estimate below.
        if (type == MSG_TYPE_PING) {
            const latency = (performance.now() / 1000 - msg.t) / 2;
            context.est_avg_latency = context.est_avg_latency === undefined ? latency :
                context.est_avg_latency * LATENCY_SMOOTHING + latency * (1 - LATENCY_SMOOTHING);
            return;
        }

        // Knob values are continuous state, not events scheduled against the
        // beat: they want no latency compensation, no ack, and none of the
        // overlay churn below - with FAKE_KNOB_MOVEMENT they arrive in the
        // high hundreds per second. Apply and return before all of that.
        if (type == MSG_TYPE_CONTROL_CHANGE) {
            apply_control_change(context.knobs, msg.wheel_idx, msg.value);
            return;
        }

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

        const est_tot_latency = context.expected_latency();

        //console.log(`Skew: ${skew} | ${context.est_avg_skew}`);
        //console.log(`Latency: ${context.est_avg_latency}`);

        if (type == MSG_TYPE_SYNC) {
            context.handle_sync(est_tot_latency, msg.sync_rate_hz, msg.sync_idx);
        } else if (type == MSG_TYPE_BEAT) {
            context.handle_beat(est_tot_latency, msg.channel);
        } else if (type == MSG_TYPE_ADVANCE_SCENE_STATE) {
            context.advance_state(msg.steps);
        } else if (type == MSG_TYPE_GOTO_SCENE) {
            context.change_scene(msg.scene, msg.bg, msg.crossfade ?? false);
        } else if (type == MSG_TYPE_AUDIO_INFO) {
            context.handle_audio_info(msg.avg, msg.peak, msg.spectrum,
                msg.spectrum_smoothed, msg.samplerate);
        } else if (type == MSG_TYPE_PERFORMER) {
            context.set_performer(msg.name);
        } else if (type == MSG_TYPE_BEAT_MODE) {
            context.set_beat_mode(msg.delayed);
        }
    });

    socket.addEventListener('close', function(e) {
        context.set_connected(false);
        clearInterval(ping_timer);
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

const ongoingTouches = [];
let last_tap = null;    // {t, x, y} of the last tap, for double-tap detection

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
    }
}

// Swipe right/left to shift every slot's contents one slot forward/back (see
// shift_slots), and down/up to step the active slot's scene forward/back.
// Tap the left/right quarter of the screen to move the active slot (the one
// highlighted in the header) back/forward, and double-tap the middle half to
// clear it.
function handle_end(evt) {
    evt.preventDefault();
    const touches = evt.changedTouches;

    for (let i = 0; i < touches.length; i++) {
        let idx = ongoingTouchIndexById(touches[i].identifier);
        if (idx >= 0) {
            const dx = touches[i].pageX - ongoingTouches[idx].pageX;
            const dy = touches[i].pageY - ongoingTouches[idx].pageY;

            if (Math.hypot(dx, dy) > MIN_SWIPE_LENGTH) {
                if (Math.abs(dx) > Math.abs(dy)) {
                    context.shift_slots(dx > 0 ? 1 : -1);
                } else {
                    context.step_active_scene(dy > 0 ? 1 : -1);
                }
            } else {
                const t = performance.now();
                const { pageX: x, pageY: y } = touches[i];
                if (x < window.innerWidth / 4) {
                    context.set_active_slot(context.active_slot - 1);
                } else if (x > window.innerWidth * 3 / 4) {
                    context.set_active_slot(context.active_slot + 1);
                } else if (last_tap && t - last_tap.t < DOUBLE_TAP_MS &&
                        Math.hypot(x - last_tap.x, y - last_tap.y) < DOUBLE_TAP_DIST) {
                    context.set_slot(context.active_slot, 0);
                    last_tap = null;
                } else {
                    last_tap = { t, x, y };
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
    // Frame-time graph, shown by clicking the header's fps field, just below
    // the header.
    stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
    stats.dom.style.visibility = 'hidden';
    document.body.appendChild( stats.dom );
    document.getElementById('fps-toggle').addEventListener('click', () => {
        const hidden = stats.dom.style.visibility == 'hidden';
        stats.dom.style.top = `${document.getElementById('header').offsetHeight}px`;
        stats.dom.style.visibility = hidden ? 'visible' : 'hidden';
    });
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

        // Header connection indicator (see update_conn_indicator).
        this.connected = false;
        this.last_quarter = null;      // last quarter note seen, in sync_idx/24
        this.last_quarter_t = null;    // when it arrived, seconds
        this.beat_period_s = HUD_FALLBACK_BEAT_S;

        // Header fps/latency fields (see update_stats_hud).
        this.hud_frames = 0;
        this.hud_window_start = performance.now() / 1000;
        // Clickable header fields (see index.html). Scene list entries are
        // rebuilt on every change, so their clicks are caught on the list.
        document.getElementById('scenes').addEventListener('click', (e) => {
            const entry = e.target.closest('[data-slot]');
            if (entry) {
                this.set_active_slot(Number(entry.dataset.slot));
            }
        });

        // Set up DOM and renderer
        this.container = document.createElement( 'div' );
        document.body.appendChild(this.container);
        this.renderer = new THREE.WebGLRenderer({
            antialias: false,
            depth: true,
            stencil: false,
            format: THREE.RGBAFormat,
        });
        this.renderer.shadowMap.enabled = true;
        this.renderer.autoClearColor = false;
        this.renderer.autoClearDepth = false;
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.container.appendChild(this.renderer.domElement);

        // The knobs scenes bind to. Values reach them from two places - a
        // controller adapter on its own port (apc40_control.py,
        // debug_control.py, kinect_control.py) via the controller below, and
        // the relay, which carries the control changes adapter.py forwards
        // from MIDI hardware and generates for FAKE_KNOB_MOVEMENT (handled in
        // connect(), on the socket already open for sync/beat). Which one a
        // value came in on says nothing about what it means, so the knobs live
        // here and both are just transports into them.
        // Created before scenes so scenes can bind to them.
        this.knobs = create_knobs();
        //this.controller = new WebsocketController(this, "ws://localhost:8766", this.knobs);
        // The shared rotation and zoom every scene reads (knobs 8, 9, 10).
        this.view = new ViewTransform(this.knobs);
        this.stepped_view = new SteppedView();

        // Create scenes
        this.scenes = new Map([
            [1, new GantryScene(this)], // more interactive
            [2, new CubeFractalScene(this)],    // more interactive
            [3, new SpinningRobotsScene(this)],  // overlap unaesthetic
            [4, new CubeTubesScene(this)],    // more interactive
            [5, new IceCreamScene(this)],   // more interactive, models too static
            [6, new DDRScene(this)],    // more interactive, basically no interactivity
            [7, new DrumboxScene(this)],    // more interactive, basically no interactivity
            [8, new YellowRobotScene(this)],    // interactivity needs work, better dance
            [9, new GlyphWalkScene(this)],    // more interactive, ideally draw random walks live
            [10, new SurfacesScene(this)],  // boring
            [11, new ParamSurfaceScene(this)],    // boring
            [12, new SpectrumScene(this)],  // more interactive, get rid of separate 2d and 3d states and have a knob continuously morph
            [13, new CubemanScene(this)],  // boring, needs more interactivity
            [14, new TessellateScene(this)],
            [15, new CubeBounceScene(this)],
            [16, new TesseractScene(this)],
            [17, new TracersScene(this)],
            [18, new HelixScene(this)], // boring, should react to spectrum instead and have knobs control stuff more
            [19, new RollingCubeScene(this)],
            [20, new SphereGridScene(this)],
            [21, new VectorFieldScene(this)],
            [22, new CellularAutomataScene(this)],
            [23, new DrumKitScene(this)],
            [24, new DebugScene(this)],
            [25, new PoseScene(this)],
            // The cube fractal scene's old background: knob A sizes the hexes
            // (render-buffer px between centres, 15..100, at 40 until moved),
            // knob B the swirl (0..1, at the original 0.5 until moved).
            [26, new ShaderScene(this, 'glsl/hex_background.frag', {
                shortname: 'hexbg',
                textures: { palette: 'img/romaO.png' },
                knobs: [
                    { channel: CH_SHADER_A, uniform: 'hex_size', initial: 40,
                        transform: (v) => lerp_scalar(15, 100, v) },
                    { channel: CH_SHADER_B, uniform: 'warp_amount', initial: 0.5,
                        transform: (v) => v },
                ],
            })],
            [27, new BrainMazeScene(this)],

            //[22, new ShaderScene(this, "glsl/chunks/texture1.frag")],
        ]);

        // Scene selection is driven by knobs 14 (foreground) and 15
        // (background). Each knob's normalized [0, 1] value maps across the
        // available scenes, applied whenever the knob changes (see bind_to).
        {
            const to_scene_idx = (norm) => Math.min(this.scenes.size - 1,
                Math.floor(norm * this.scenes.size));
            this.knobs.get(14).bind_to(
                (idx) => this.change_scene(idx, false), to_scene_idx);
            this.knobs.get(15).bind_to(
                (idx) => this.change_scene(idx, true), to_scene_idx);
        }

        // Fixed NUM_SLOTS render layers, rendered in descending slot order,
        // so lower slots draw on top: slot 0 is the front (foreground), slot
        // 1 behind it (background; see change_scene/set_slot), and slots 2-9,
        // only reachable from the keyboard (see keydown), draw behind both.
        // Each slot holds `scene`, the registry index of its scene (undefined
        // if empty), and while a change crossfades in, `outgoing`, the scene
        // it replaces: `fade` runs 0..1 over CROSSFADE_BEATS, drawing scene
        // at opacity fade and outgoing at 1 - fade, and outgoing is cleared
        // at 1. Every scene drawn is in here, and in the header.
        this.slots = Array.from({ length: NUM_SLOTS },
            () => ({ scene: undefined, outgoing: undefined, fade: 1 }));
        this.hud_blink_on = false;  // which side of a crossfade the header shows

        // Fading scenes render alone into fade_buffer (see render_faded),
        // which this quad then blends over the screen at their opacity. Its
        // vertices are already in clip space; the image is already in the
        // screen's encoding (see recreate_buffers) and premultiplied (scenes
        // render over transparent black), so it passes through as is.
        this.fade_buffer = null;    // sized in recreate_buffers
        this.fade_material = new THREE.ShaderMaterial({
            uniforms: { image: { value: null }, opacity: { value: 1 } },
            vertexShader: [
                'varying vec2 v_uv;',
                'void main() {',
                '    v_uv = uv;',
                '    gl_Position = vec4(position.xy, 0.0, 1.0);',
                '}',
            ].join('\n'),
            fragmentShader: [
                'uniform sampler2D image;',
                'uniform float opacity;',
                'varying vec2 v_uv;',
                'void main() {',
                '    gl_FragColor = texture2D(image, v_uv) * opacity;',
                '}',
            ].join('\n'),
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            depthTest: false,
            depthWrite: false,
        });
        this.fade_scene = new THREE.Scene();
        const fade_quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fade_material);
        fade_quad.frustumCulled = false;
        this.fade_scene.add(fade_quad);
        this.fade_camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.prev_clear_color = new THREE.Color();

        // Which slot plain number-key presses target; shift+<numkey>
        // changes this instead of changing a scene (see keydown).
        this.active_slot = 0;

        // Show a blank screen at startup. The scene-selection bindings above
        // used to run every frame and did this implicitly from the knobs'
        // default value; now that bindings only fire on a knob change, do it
        // explicitly.
        this.change_scene(0);
        // Then put back whatever was showing before a reload - e.g. mobile
        // Safari dropping the page while it was in the background.
        this.load_slots();
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

        // Until the adapter says otherwise (see set_beat_mode).
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

    // The scenes on screen as {idx, opacity}, back to front, each once. A
    // scene can sit in several slots, or be both incoming and outgoing, but
    // it is one object with one state: it draws once, at the front-most
    // place it appears and at the highest opacity it has anywhere.
    visible_layers() {
        const layers = [];      // front to back while building
        for (let slot = 0; slot < NUM_SLOTS; slot++) {
            const { scene, outgoing, fade } = this.slots[slot];
            for (const [idx, opacity] of [[scene, fade], [outgoing, 1 - fade]]) {
                if (idx === undefined) {
                    continue;
                }
                const seen = layers.find((layer) => layer.idx === idx);
                if (seen) {
                    seen.opacity = Math.max(seen.opacity, opacity);
                } else {
                    layers.push({ idx, opacity });
                }
            }
        }
        return layers.reverse();
    }

    // Call fn(scene) once for each scene on screen, front to back: each
    // animates and takes events once (see visible_layers).
    for_each_shown_scene(fn) {
        const layers = this.visible_layers();
        for (let i = layers.length - 1; i >= 0; i--) {
            fn(this.scenes.get(layers[i].idx));
        }
    }

    // The pitches the shared stepped view may rest on: those every stepped
    // scene on screen allows (all upright stops when none is showing). If
    // they had none in common, the front-most stepped scene's would win;
    // the current scenes all allow the isometric tilt, so they always share
    // it.
    stepped_pitch_stops() {
        let stops = null;
        let front = null;
        this.for_each_shown_scene((scene) => {
            if (scene.stepped_pitches === null) {
                return;
            }
            front = front ?? scene.stepped_pitches;
            stops = stops === null ? scene.stepped_pitches :
                stops.filter((pitch) => scene.stepped_pitches.includes(pitch));
        });
        if (stops === null) {
            return UPRIGHT_PITCHES;
        }
        return stops.length > 0 ? stops : front;
    }

    // Advance every slot's crossfade by dt seconds, finishing those that
    // reach the end, and blink the header's entries for those still going.
    update_crossfades(dt) {
        let hud_changed = false;
        let crossfading = false;
        for (const slot of this.slots) {
            if (slot.fade >= 1) {
                continue;
            }
            slot.fade += dt / this.beat_period_s / CROSSFADE_BEATS;
            if (slot.fade >= 1) {
                slot.fade = 1;
                slot.outgoing = undefined;
                hud_changed = true;
            } else {
                crossfading = true;
            }
        }
        const blink_on = crossfading && this.hud_beat_phase() < HUD_BLINK_ON_FRACTION;
        if (blink_on != this.hud_blink_on) {
            this.hud_blink_on = blink_on;
            hud_changed = true;
        }
        if (hud_changed) {
            this.update_scene_hud();
        }
    }

    anim_frame() {
        const dt = Math.min(this.clock.getDelta(), MAX_FRAME_DT);
        this.update_conn_indicator();
        this.update_stats_hud();
        this.update_crossfades(dt);
        this.view.update(dt);
        this.stepped_view.update(dt, this.view, this.stepped_pitch_stops());
        this.for_each_shown_scene((scene) => {
            scene.anim_frame(dt);
            scene.update_zoom();
        });
    }

    // Every HUD_STATS_INTERVAL_S, write the frame rate over that window and
    // the relay's smoothed one-way latency (half the ack round trip the
    // adapter measures, see connect()) into the header.
    update_stats_hud() {
        this.hud_frames++;
        const now = performance.now() / 1000;
        const elapsed = now - this.hud_window_start;
        if (elapsed < HUD_STATS_INTERVAL_S) {
            return;
        }
        document.getElementById('fps').innerHTML = (this.hud_frames / elapsed).toFixed(0);
        document.getElementById('latency').innerHTML = this.est_avg_latency === undefined ?
            '-' : (this.est_avg_latency * 1000).toFixed(1);
        this.hud_frames = 0;
        this.hud_window_start = now;
    }

    recreate_buffers(width, height) {
        // Free the old targets' GPU memory: resizes (on mobile, whenever the
        // address bar shows or hides) would otherwise leak a set each time.
        this.buffers?.forEach((b) => b.dispose());
        this.buffers = [];
        for (let i = 0; i < 2; i++) {
            this.buffers.push(new THREE.WebGLRenderTarget(width, height, {
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat,
                depthBuffer: true,
                stencilBuffer: false
            }));
        }
        this.cur_buffer_idx = 0;
        // At the canvas's real resolution (main.js renders below
        // devicePixelRatio), like the screen the scenes normally draw to.
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        this.fade_buffer?.dispose();
        this.fade_buffer = new THREE.WebGLRenderTarget(size.x, size.y, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            depthBuffer: true,
            stencilBuffer: false
        });
        // Scenes must render into it exactly as they would to the screen:
        // three writes linear colour into ordinary render targets, which
        // would change anything working on the final colour (the house
        // dither runs after the output conversion, so it came out dimmer
        // until the fade finished). It only writes the target's own colour
        // space into ones flagged as XR targets, and the flag changes nothing
        // else here (it also allows tone mapping, which is off). Stored as
        // plain RGBA8, so nothing decodes it on the way out either.
        this.fade_buffer.texture.colorSpace = THREE.SRGBColorSpace;
        this.fade_buffer.texture.internalFormat = 'RGBA8';
        this.fade_buffer.isXRRenderTarget = true;
    }

    render() {
            // Render slots back to front (descending), so slot 0 draws on top.

            // Clear buffer 0 (background)
            this.renderer.setRenderTarget(this.buffers[0]);
            this.renderer.clear();

            this.renderer.setRenderTarget(null);
            this.renderer.clear();

            for (const { idx, opacity } of this.visible_layers()) {
                if (opacity <= 0) {
                    continue;
                }
                if (CLEAR_DEPTH_BETWEEN_SCENES) {
                    this.renderer.setRenderTarget(null);
                    this.renderer.clearDepth();
                }
                const scene = this.scenes.get(idx);
                if (opacity >= 1) {
                    scene.render(this.renderer, this.buffers[0]);
                } else {
                    this.render_faded(scene, opacity);
                }
                const vector = new THREE.Vector2(0, 0);
                this.renderer.copyFramebufferToTexture(vector, this.buffers[0].texture);
            }
    }

    // Draw scene over the screen at opacity (0..1): render it alone into
    // fade_buffer, cleared to transparent, then blend that image over the
    // screen. Fading the finished image rather than each material works the
    // same for every scene (custom shaders, dither, lines, feedback) and
    // never shows a scene's insides through itself.
    render_faded(scene, opacity) {
        const renderer = this.renderer;
        renderer.getClearColor(this.prev_clear_color);
        const prev_clear_alpha = renderer.getClearAlpha();
        renderer.setRenderTarget(this.fade_buffer);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        scene.render(renderer, this.buffers[0]);
        renderer.setRenderTarget(null);
        renderer.setClearColor(this.prev_clear_color, prev_clear_alpha);
        this.fade_material.uniforms.image.value = this.fade_buffer.texture;
        this.fade_material.uniforms.opacity.value = opacity;
        renderer.render(this.fade_scene, this.fade_camera);
    }

    on_window_resize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.renderer.setSize(width, height);
        // Physical pixels per rendered pixel, along each axis: at least 2 on
        // hidpi displays (phones, retina laptops) for a chunkier look, and
        // more on very large windows to keep the render size down.
        const hidpi_ratio = window.devicePixelRatio >= 2 ? 2 : 1;
        const div_ratio = Math.max(hidpi_ratio, Math.ceil(Math.max(width, height) / 2000));
        this.renderer.setPixelRatio(window.devicePixelRatio / div_ratio);
        this.recreate_buffers(width, height);
        this.scenes.forEach((scene) => {
            scene.handle_resize(width, height);
        });
    }

    // Put scene_idx in the given slot, leaving every other slot untouched,
    // and update the HUD's scene list. The change is instant unless
    // `crossfade`, in which case it fades in over CROSSFADE_BEATS.
    set_slot(slot, scene_idx, crossfade = false) {
        if (scene_idx == 0) {
            scene_idx = undefined;
        } else if (!this.scenes.has(scene_idx)) {
            return;
        }
        const s = this.slots[slot];
        if (s.scene === scene_idx) {
            return;
        }
        if (!crossfade) {
            // Also cuts short any crossfade already running in this slot.
            s.outgoing = undefined;
            s.fade = 1;
        } else if (scene_idx !== undefined && s.outgoing === scene_idx) {
            // Changed back mid-crossfade: run it in reverse from where it is.
            s.outgoing = s.scene;
            s.fade = 1 - s.fade;
        } else {
            // Fade out whichever scene shows most; a third scene can't fit,
            // so the other side of an unfinished crossfade drops out.
            if (s.outgoing === undefined || s.fade >= 0.5) {
                s.outgoing = s.scene;
            }
            s.fade = 0;
        }
        s.scene = scene_idx;
        if (s.outgoing === undefined && s.scene === undefined) {
            s.fade = 1;
        }
        this.update_scene_hud();
        this.save_slots();
    }

    // Remember each slot's scene and the active slot for load_slots. Storage
    // can be unavailable (private browsing, blocked site data); then
    // there's just nothing to restore.
    save_slots() {
        const state = {
            scenes: this.slots.map(({ scene }) => scene ?? 0),
            active_slot: this.active_slot,
        };
        try {
            sessionStorage.setItem(SLOTS_STORAGE_KEY, JSON.stringify(state));
        } catch (e) {}
    }

    // Restore what save_slots stored, if anything, without crossfading.
    load_slots() {
        let state;
        try {
            state = JSON.parse(sessionStorage.getItem(SLOTS_STORAGE_KEY));
        } catch (e) {
            return;
        }
        if (!state) {
            return;
        }
        state.scenes?.forEach((scene_idx, slot) => {
            if (slot < NUM_SLOTS) {
                this.set_slot(slot, scene_idx);
            }
        });
        this.set_active_slot(state.active_slot ?? 0);
    }

    // Rewrite the HUD's scene list as <slot>:<shortname> for every occupied
    // slot, joined with '+'. Slot order is front to back (slot 0 draws on
    // top, higher slots behind it), so the list reads front layer first -
    // which also avoids the fg/bg labels the header used to carry. A slot
    // mid-crossfade blinks between its incoming scene, highlighted, and its
    // outgoing one (see update_crossfades).
    update_scene_hud() {
        // One clickable entry per slot (see the constructor), its index in
        // the primary colour when it's the active slot.
        const entry = (slot, name) => {
            const index_class = slot == this.active_slot ? ' class="emph"' : '';
            return `<span class="clickable" data-slot="${slot}"><span${index_class}>${slot}:</span>${name}</span>`;
        };
        const name_of = (idx) => idx === undefined ? '' : this.scenes.get(idx).shortname;
        const shown = [];
        let active_shown = false;
        this.slots.forEach(({ scene, outgoing, fade }, slot) => {
            if (slot > this.active_slot && !active_shown) {
                shown.push(entry(this.active_slot, ''));
                active_shown = true;
            }
            if (scene !== undefined || outgoing !== undefined) {
                let name = name_of(scene);
                if (fade < 1) {
                    name = this.hud_blink_on ?
                        `<span class="emph">${name}</span>` : name_of(outgoing);
                }
                shown.push(entry(slot, name));
                if (slot == this.active_slot) {
                    active_shown = true;
                }
            }
        });
        // An empty active slot behind every occupied one.
        if (!active_shown) {
            shown.push(entry(this.active_slot, ''));
        }
        document.getElementById('scenes').innerHTML = shown.join('+<wbr>');
    }

    // The act currently playing, from MsgPerformer.
    set_performer(name) {
        document.getElementById('performer').innerHTML = name;
    }

    // Relay connection state, from connect()'s socket events. Only the relay is
    // reported: the controller socket on 8766 has nothing listening whenever no
    // controller adapter is running, which is most of the time, so showing its
    // state would leave the header permanently claiming a problem.
    set_connected(connected) {
        this.connected = connected;
        if (!connected) {
            // Nothing is clocking us any more, so don't let the pulse carry on
            // from a stale beat if the relay comes back.
            this.last_quarter = null;
            this.last_quarter_t = null;
        }
        this.update_conn_indicator();
    }

    // Redraw the header's one-character indicator. Called every frame, because
    // both states animate: a rotating quadrant while the relay is down, and a
    // solid-to-sparse pulse across each quarter note while it's up.
    update_conn_indicator() {
        const elem = document.getElementById('conn');
        const now = performance.now() / 1000;

        if (!this.connected) {
            // Stepped off the wall clock rather than accumulated per frame, so
            // it turns at the same rate whatever the frame rate is doing.
            const i = Math.floor(now * HUD_SPIN_HZ) % HUD_SPIN_GLYPHS.length;
            elem.innerHTML = HUD_SPIN_GLYPHS[i];
            elem.className = 'muted';
            return;
        }

        const last = HUD_BEAT_GLYPHS.length - 1;
        const i = Math.min(last, Math.floor(this.hud_beat_phase() * HUD_BEAT_GLYPHS.length));
        elem.innerHTML = HUD_BEAT_GLYPHS[i];
        elem.className = 'emph';
    }

    // How far through the current beat the header is, 0..1, from the last
    // quarter note's arrival: the connection indicator's pulse and the scene
    // list's crossfade blink both step off this, so they stay in time. 1
    // (the end of the beat) until a beat has landed; clamped, so a stalled
    // clock holds there instead of wrapping round as if a beat had arrived.
    hud_beat_phase() {
        if (this.last_quarter_t === null) {
            return 1;
        }
        const now = performance.now() / 1000;
        return clamp((now - this.last_quarter_t) / this.beat_period_s, 0, 1);
    }

    // Scene-change messages (MIDI/network MsgGotoScene, and the APC knobs 14
    // / 15 bound above) always target the fixed foreground (slot 0, drawn in
    // front) / background (slot 1, behind it) slots, regardless of which
    // slot the keyboard currently has active (see keydown).
    change_scene(scene_idx, bg = false, crossfade = false) {
        this.set_slot(bg ? 1 : 0, scene_idx, crossfade);
    }

    // Make `slot` the one number keys and vertical swipes act on.
    set_active_slot(slot) {
        this.active_slot = clamp(slot, 0, NUM_SLOTS - 1);
        this.update_scene_hud();
        this.save_slots();
    }

    // Move every slot's contents (scene and any crossfade in progress) one
    // slot forward (dir 1) or back (dir -1), leaving the slot vacated at the
    // other end empty. Does nothing if that would push a non-empty slot off
    // the end. The active slot stays where it is.
    shift_slots(dir) {
        const edge = this.slots[dir > 0 ? NUM_SLOTS - 1 : 0];
        if (edge.scene !== undefined || edge.outgoing !== undefined) {
            return;
        }
        const empty = { scene: undefined, outgoing: undefined, fade: 1 };
        if (dir > 0) {
            this.slots.pop();
            this.slots.unshift(empty);
        } else {
            this.slots.shift();
            this.slots.push(empty);
        }
        this.update_scene_hud();
        this.save_slots();
    }

    // Move the active slot `steps` scenes through the registry, wrapping
    // round through blank (0) at the ends. Used by vertical swipes.
    step_active_scene(steps) {
        const order = [0, ...[...this.scenes.keys()].sort((a, b) => a - b)];
        const cur = order.indexOf(this.slots[this.active_slot].scene ?? 0);
        const next = ((cur + steps) % order.length + order.length) % order.length;
        this.set_slot(this.active_slot, order[next]);
    }

    advance_state(steps) {
        console.log(`advance ${steps} steps`);
        this.for_each_shown_scene((scene) => scene.advance_state(steps));
    }

    // Physical left-to-right key order for both the digit->bank-position and
    // digit->render-slot mappings below: keys 1-9 give 0-8, 0 gives 9.
    key_digit_to_slot(digit) {
        return digit;//(digit + 9) % 10;
    }

    keydown(e) {
        const num = parseInt(e.key);
        const shift_chars = ')!@#$%^&*(';
        console.log(e.key);
        if (!isNaN(num)) {
            // Plain digit: show the corresponding scene from the current
            // bank in whichever slot is currently active.
            const scene_idx = this.cur_scene_bank * SCENES_PER_BANK +
                this.key_digit_to_slot(num % 10);
            this.set_slot(this.active_slot, scene_idx);
        } else if (shift_chars.includes(e.key)) {
            // Shift+digit: switch which slot subsequent digit presses
            // target, without changing any scene.
            this.set_active_slot(this.key_digit_to_slot(shift_chars.indexOf(e.key)));
        } else if (e.shiftKey && e.key == "ArrowLeft") {
            this.shift_slots(-1);
        } else if (e.shiftKey && e.key == "ArrowRight") {
            this.shift_slots(1);
        } else if (e.key == "ArrowLeft") {
            this.advance_state(-1);
        } else if (e.key == "ArrowRight") {
            this.advance_state(1);
        } else if (e.key == "ArrowUp") {
            this.cur_scene_bank = Math.min(this.cur_scene_bank + 1, this.num_scene_banks - 1);
        } else if (e.key == "ArrowDown") {
            this.cur_scene_bank = Math.max(this.cur_scene_bank - 1, 0);
        } else if (e.key == "Delete" || e.key == "Backspace") {
            // Clear the active slot, as a double-tap does (a Mac's delete
            // key is Backspace).
            this.set_slot(this.active_slot, 0);
        } else {
            this.for_each_shown_scene((scene) => scene.handle_key(e.key));
        }
    }

    // How long after the adapter sends something it's seen and heard here,
    // in seconds: our measured one-way network latency plus EXTRA_LATENCY.
    expected_latency() {
        return (this.est_avg_latency ?? 0) + EXTRA_LATENCY;
    }

    // `sync_idx` counts MIDI clocks, MIDI_SYNCS_PER_BEAT per quarter note -
    // not beats, despite what this parameter used to be called.
    handle_sync(latency, sync_rate_hz, sync_idx) {
        // Clock sync_idx sounded `latency` ago. Deliver the clock N ahead of
        // it, for the fewest N that cover the latency, at the moment that
        // one sounds, so scenes stay on the audible grid in either beat mode.
        const period = 1 / sync_rate_hz;
        const n = Math.max(0, Math.ceil(latency / period));
        const delay = n * period - latency;
        setTimeout(() => {
            this.scenes.forEach((scene) => {
                scene.handle_sync_raw(sync_rate_hz, sync_idx + n);
            });
        }, delay * 1000);
        // Update overlay with sync rate hz (convert to bpm)
        const bpm = sync_rate_hz * 60 / MIDI_SYNCS_PER_BEAT;
        document.getElementById("bpm").innerHTML = bpm.toFixed(0);

        // Timestamp each quarter note for the header's pulse indicator. Taken
        // as the sync arrives rather than when the delayed beat is delivered:
        // the indicator reports the clock on the wire, which is what you want
        // when you're checking whether the adapter is still with you.
        const quarter = Math.floor(sync_idx / MIDI_SYNCS_PER_BEAT);
        if (quarter !== this.last_quarter) {
            this.last_quarter = quarter;
            this.last_quarter_t = performance.now() / 1000;
            this.beat_period_s = 60 / bpm;
        }
    }

    // Immediate vs delayed (latency-compensated) beats, as set by the
    // adapter's input mode and --immediate flag.
    set_beat_mode(delayed) {
        this.immediate_mode = !delayed;
        this.update_mode_hud();
    }

    update_mode_hud() {
        const mode = this.immediate_mode ? 'imm' : 'del';
        const mode_elem = document.getElementById('mode');
        mode_elem.innerHTML = mode;
    }

    handle_beat(latency, channel) {
        // Beats only go to on-screen scenes. Hidden scenes never damp their
        // physics (anim_frame doesn't run for them), so delivering hits
        // would wind their springs up unboundedly until re-shown.
        this.for_each_shown_scene((scene) => scene.handle_beat(latency, channel));
    }

    handle_pose(skeletons) {
        // Same reasoning as handle_beat: only on-screen scenes need it.
        this.for_each_shown_scene((scene) => scene.handle_pose(skeletons));
    }

    // All levels are dBFS, converted adapter-side (see adapter/audio_info.py).
    // avg/peak: mean and peak input level since the last message. spectrum: FFT
    // magnitude bins, linearly spaced in frequency; smoothed: the same,
    // time-averaged. samplerate (Hz) fixes the frequency axis (bin k is at
    // k * samplerate / FFT_SIZE Hz). Sent by adapter.py's -a/--audio mode.
    handle_audio_info(avg, peak, spectrum, smoothed, samplerate) {
        // Same reasoning as handle_beat: only on-screen scenes need it.
        this.for_each_shown_scene((scene) => scene.handle_audio_info(
            avg, peak, spectrum, smoothed, samplerate));
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
