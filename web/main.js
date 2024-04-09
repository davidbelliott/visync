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
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
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

const ENABLE_GLOBAL_TRACERS = false;
const BG_COLOR = 'black';

const SCENES_PER_BANK = 10;

var context = null;
var stats = new Stats();

class Environment {
    constructor() {
        this.bpm = 0;
        this.total_latency = 0.065;
        this.immediate_mode = false;
    }

    get_beat_delay() {
        const delay = this.immediate_mode ? 0 :
            Math.max(60 / this.bpm / 2 - this.total_latency, 0);
        return delay;
    }
}

const env = new Environment();

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


function init() {
    stats.showPanel(0); // 0: fps, 1: ms, 2: mb, 3+: custom
    stats.dom.style.visibility = 'hidden';
    document.body.appendChild( stats.dom );

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
    const relay_url = `${window.location.hostname}:8765`;
    const socket = new WebSocket(`${protocol}://${relay_url}`);
    //const socket = new WebSocket(`ws://192.168.1.2:8765`);
    socket.addEventListener('message', function(e) {
	const msg = JSON.parse(e.data);
        const type = msg.msg_type;

        if (type == MSG_TYPE_SYNC) {
            //bg.cubes_group.rotation.y += 0.1;
            //console.log(`Beat ${msg.beat}`);
            //
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


function Transition( sceneA, sceneB ) {
}


class GraphicsContext {
    constructor() {
        this.tracers = false;
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(true);
        this.scenes = [
            new CubeLockingScene(env),
            new BackgroundSurfacesScene(env),
            new TracersScene(env),
            new HexagonScene(env),
            new GantryScene(env),
            new YellowRobotScene(env),
            new SurfacesScene(env),
            new BackgroundSurfacesScene(env),
            new SpectrumScene(env),
            new FastCubeScene(env),
            new DDRScene(env),
            new DrumboxScene(env),
            new IceCreamScene(env),
            new SlideScene(env, ["img/cover.png", "img/santa-claus.jpg", "img/santa-claus-2.png"]),
            new IntroScene(env),
            new SpinningRobotsScene(env),
            new ChineseScene(env),
            new TessellateScene(env),
            //new FastCarScene(env),
            new HomeBackgroundScene(env),
        ];
        this.cur_scene_idx = 0;
        this.cur_bg_scene_idx = 1;
        this.cur_scene_bank = 0;
        this.num_scene_banks = Math.ceil(this.scenes.length / SCENES_PER_BANK);

        this.debug_overlay = document.getElementById("debug-overlay");
        this.overlay_indicators = [];
        this.indicator_on_time_range = [];
        for (let i = 1; i <= 16; i++) {
            const elem = document.createElement("div");
            this.debug_overlay.appendChild(elem);
            this.overlay_indicators.push(elem);
            this.indicator_on_time_range.push([]);
        }
        this.debug_overlay.style.visibility = "hidden";
        this.container = document.createElement( 'div' );
        document.body.appendChild(this.container);
	this.renderer = new THREE.WebGLRenderer({
            antialias: false,
        });
        this.renderer.autoClearColor = false;
        this.renderer.autoClearDepth = true;
	this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.container.appendChild(this.renderer.domElement);

        //document.body.appendChild( VRButton.createButton(this.renderer) );


        // Effect composers for overlaying two scenes
        {
            this.composer_bg = new EffectComposer(this.renderer);
            this.composer_fg = new EffectComposer(this.renderer);

            // Render pass for sceneB, rendering it off-screen
            this.render_pass_bg = new RenderPass(this.scenes[0].scene, this.scenes[0].camera);
            this.composer_bg.addPass(this.render_pass_bg);
            this.composer_bg.renderToScreen = false;

            // Render pass for sceneA
            this.render_pass_fg = new RenderPass(this.scenes[this.cur_scene_idx].scene, this.scenes[this.cur_scene_idx].camera);
            this.composer_fg.addPass(this.render_pass_fg);

            // Custom shader to blend sceneB into a portion of sceneA
            const blendShader = {
                uniforms: {
                    tDiffuse: { value: null }, // Texture from sceneA
                    tOverlay: { value: null }, // Texture from sceneB
                    overlayRect: { value: new THREE.Vector4(0.25, 0.25, 0.5, 0.5) } // x, y, width, height of overlay in normalized coordinates
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                        precision highp float;
                        float luma(vec3 color) {
                        return dot(color, vec3(0.299, 0.587, 0.114));
                        }

                        float luma(vec4 color) {
                        return dot(color.rgb, vec3(0.299, 0.587, 0.114));
                        }

                        float dither4x4(vec2 position, float brightness) {
                        int x = int(mod(position.x, 4.0));
                        int y = int(mod(position.y, 4.0));
                        int index = x + y * 4;
                        float limit = 0.0;

                        if (x < 8) {
                            if (index == 0) limit = 0.0625;
                            if (index == 1) limit = 0.5625;
                            if (index == 2) limit = 0.1875;
                            if (index == 3) limit = 0.6875;
                            if (index == 4) limit = 0.8125;
                            if (index == 5) limit = 0.3125;
                            if (index == 6) limit = 0.9375;
                            if (index == 7) limit = 0.4375;
                            if (index == 8) limit = 0.25;
                            if (index == 9) limit = 0.75;
                            if (index == 10) limit = 0.125;
                            if (index == 11) limit = 0.625;
                            if (index == 12) limit = 1.0;
                            if (index == 13) limit = 0.5;
                            if (index == 14) limit = 0.875;
                            if (index == 15) limit = 0.375;
                        }

                        return brightness < limit ? 0.0 : 1.0;
                        }

                        vec3 dither4x4(vec2 position, vec3 color) {
                        return color * dither4x4(position, luma(color));
                        }

                        vec4 dither4x4(vec2 position, vec4 color) {
                        return vec4(color.rgb * dither4x4(position, luma(color)), 1.0);
                        }




                    uniform sampler2D tDiffuse;
                    uniform sampler2D tOverlay;
                    uniform vec4 overlayRect;
                    varying vec2 vUv;
                    void main() {
                        vec4 fg_color = texture2D(tDiffuse, vUv);
                        if (fg_color.rgb == vec3(1, 1, 1) && vUv.x > overlayRect.x && vUv.x < overlayRect.x + overlayRect.z && vUv.y > overlayRect.y && vUv.y < overlayRect.y + overlayRect.w) {
                            vec4 bg_color = dither4x4(
                                gl_FragCoord.xy, texture2D(tOverlay, vUv)) * 2.0;
                            bg_color = texture2D(tOverlay, vUv);
                            float lum = luma(bg_color.rgb);
                            bg_color = vec4(lum, lum, lum, 1.0);
                            //fg_color = fg_color + bg_color;
                        }
                        gl_FragColor = fg_color;
                    }
                `
            };

            // Add shader pass to blend sceneB onto sceneA
            this.blendPass = new ShaderPass(CopyShader);
            //this.composer_fg.addPass(this.blendPass);
            this.outputPass = new OutputPass();
            //this.composer_fg.addPass(this.outputPass);
            //this.composer_fg.addPass(gamma_shader);
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
        //const dt = this.clock.getDelta();
        const dt = 1.0 / 60.0;
        const t_now = this.clock.getElapsedTime();
        this.scenes[this.cur_scene_idx].anim_frame(dt);
        if (this.cur_bg_scene_idx !== null) {
            this.scenes[this.cur_bg_scene_idx].anim_frame(dt);
        }

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
        if (ENABLE_GLOBAL_TRACERS) {



        }

        const ENABLE_OVERLAY = false;

        if (ENABLE_OVERLAY) {
            // Render sceneB to texture
            this.composer_bg.render();
            // Render sceneA with sceneB overlaid
            //this.blendPass.uniforms.tOverlay.value = this.composer_bg.readBuffer.texture;
            this.composer_fg.render();
        } else {
            this.renderer.clear();
            if (this.cur_bg_scene_idx !== null) {
                this.scenes[this.cur_bg_scene_idx].render(this.renderer);
            }
            this.scenes[this.cur_scene_idx].render(this.renderer);
        }



        return;






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
        this.renderer.setSize(width, height);
	this.renderer.setPixelRatio(window.devicePixelRatio);
        this.composer_bg.setSize(width, height);
        this.composer_fg.setSize(width, height);
        this.recreate_buffers(width, height);
        this.scenes.forEach((scene) => {
            scene.handle_resize(width, height);
        });
    }

    change_scene(scene_idx) {
        if (scene_idx >= 0 && scene_idx < this.scenes.length) {
            this.scenes[this.cur_scene_idx].deactivate();
            this.cur_scene_idx = scene_idx;
            this.render_pass_fg.scene = this.scenes[this.cur_scene_idx].scene;
            this.render_pass_fg.camera = this.scenes[this.cur_scene_idx].camera;
            this.scenes[this.cur_scene_idx].activate();
        }
    }

    advance_state(steps) {
        this.scenes[this.cur_scene_idx].advance_state(steps);
    }

    keydown(e) {
        const num = parseInt(e.key);
        if (!isNaN(num)) {
            const scene_idx = Math.trunc(clamp(this.cur_scene_bank * SCENES_PER_BANK + 
                num % 10, 0, this.scenes.length - 1));
            this.change_scene(scene_idx);
        } else if (e.key == 't') {
            if (this.num_traces == 1) {
                this.set_tracer_params(10, 4, 0.8);
                //this.set_tracer_params(8, 1, 0.7);
            } else {
                this.set_tracer_params(1, 1, 1);
            }
        } else if (e.code == "Tab") {
            console.log("tab");
            env.immediate_mode = !env.immediate_mode;
            if (this.debug_overlay.style.visibility == 'hidden') {
                this.debug_overlay.style.visibility = 'visible';
                stats.dom.style.visibility = 'visible';
            } else {
                this.debug_overlay.style.visibility = 'hidden';
                stats.dom.style.visibility = 'hidden';
            }
        } else if (e.key == "ArrowLeft") {
            this.scenes[this.cur_scene_idx].advance_state(-1);
        } else if (e.key == "ArrowRight") {
            this.scenes[this.cur_scene_idx].advance_state(1);
        } else if (e.key == "ArrowUp") {
            this.cur_scene_bank = Math.min(this.cur_scene_bank + 1, this.num_scene_banks - 1);
        } else if (e.key == "ArrowDown") {
            this.cur_scene_bank = Math.max(this.cur_scene_bank - 1, 0);
        } else {
            this.scenes[this.cur_scene_idx].handle_key(e.key);
        }
    }

    handle_sync(t, bpm, beat) {
        const thirtysecond_note_dur = 60 / env.bpm / 8;
        const delay = env.immediate_mode ? 0 :
            8 * thirtysecond_note_dur - env.total_latency;
        const start_t = this.clock.getElapsedTime() + delay;
        this.indicator_on_time_range[this.indicator_on_time_range.length - 1].push([
            start_t,
            start_t + thirtysecond_note_dur
        ]);

        const ms_since_last_sync = Math.round(1000 * this.sync_clock.getDelta());
        const expected_ms = 60000 / bpm;
        console.log(`Sync: ${ms_since_last_sync}`);
        console.log(`Error: ${ms_since_last_sync - expected_ms}`);

        env.bpm = bpm;

        setTimeout(() => {
            this.scenes.forEach((scene) => {
                scene._handle_sync_raw(t, bpm, beat + 1);
            });
        }, delay * 1000);
    }

    handle_beat(t, channel) {
        const thirtysecond_note_dur = 60 / env.bpm / 8;
        const delay = env.immediate_mode ? 0 :
            4 * thirtysecond_note_dur - env.total_latency;
        const start_t = this.clock.getElapsedTime() + delay;
        this.indicator_on_time_range[channel - 1].push([
            start_t,
            start_t + thirtysecond_note_dur
        ]);
        this.scenes.forEach((scene) => {
            scene.handle_beat(t, channel);
        });
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
