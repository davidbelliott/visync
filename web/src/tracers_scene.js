import * as THREE from 'three';
import { VisScene } from './vis_scene.js';
import {
    clamp,
    lerp_scalar,
    update_persp_camera_aspect,
    create_instanced_cube,
    BeatClock
} from './util.js';
import { LightningStrike } from './lightning_strike.js';

const GRID_COLOR = 'white';
const LINE_WIDTH = 1;

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

export class TracersScene extends VisScene {
    constructor(context) {
        super(context, 'tracers', 3);

        this.vbo_scene = new THREE.Scene();
        this.vbo_camera = new THREE.PerspectiveCamera(45, window.innerHeight / window.innerWidth, 0.1, 4000);
        this.vbo_camera.position.set(0, 0, 5);
        //this.vbo_camera = new THREE.OrthographicCamera(-8, 8, -8, 8);
        this.cam_vel = new THREE.Vector3();
        this.num_traces = 6;
        this.trace_spacing = 2;

        this.beat_idx = 0;
        this.sync_clock = new BeatClock(this);
        this.state_change_clock = new BeatClock(this);

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

        this.base_scale = 0.75;
        this.curr_scale = this.base_scale;

        this.cubes = [];
        this.ray_params = [];
        this.lightning_strikes = [];
        this.lightning_strike_meshes = [];
        this.cubes_group = new THREE.Group();
        for (const pos of this.cube_positions) {
            const ls = create_instanced_cube([1, 1, 1], "cyan");
            ls.position.copy(pos);
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
        //

        const rayDirection = new THREE.Vector3( 0, - 1, 0 );
        let rayLength = 0;
        const vec1 = new THREE.Vector3();
        const vec2 = new THREE.Vector3();

        

        //this.vbo_scene.add(this.lightning_strike_mesh );

        this.start_cube_bounce_ampl = 0;
        this.curr_cube_bounce_ampl = 0;
        this.target_cube_bounce_ampl = 0;
        this.max_cube_bounce_ampl = 0.5;


        this.expand_period_beats = 8;


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
                        'varying vec2 vUv;',
                        'void main() {',
                        '	vec4 texel1 = texture2D( t1, vUv );',
                        '	vec4 texel2 = texture2D( t2, vUv );',
                        '	gl_FragColor = max(texel1, ratio * texel2);',
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
        let beat_time = this.sync_clock.getElapsedBeats();
        // Update bounce amplitude
        const bounce_change_beats = 8;
        const state_change_frac = clamp(this.state_change_clock.getElapsedBeats() / bounce_change_beats, 0, 1);
        this.curr_cube_bounce_ampl = lerp_scalar(this.start_cube_bounce_ampl, this.target_cube_bounce_ampl, state_change_frac);


        const scale_frac = beat_time / this.expand_period_beats;
        return this.base_scale + Math.cos(scale_frac * 2 * Math.PI) * this.curr_cube_bounce_ampl;
    }

    handle_sync(t, bpm, beat) {
        this.sync_clock.updateBPM(bpm);
        this.state_change_clock.updateBPM(bpm);
        if (beat % this.expand_period_beats == 0) {
            this.sync_clock.start(bpm);
        }
    }

    handle_resize(width, height) {
        const aspect = width / height;
        update_persp_camera_aspect(this.vbo_camera, aspect);
        this.recreate_buffers(width, height);
    }

    anim_frame(dt) {
        for (const cube of this.cubes) {
            cube.rotation.x += 0.5 * dt;
            cube.rotation.y += 0.5 * dt;
            cube.scale.setScalar(this.get_cube_scale());
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
            this.target_cube_bounce_ampl = this.max_cube_bounce_ampl;
            this.start_cube_bounce_ampl = this.curr_cube_bounce_ampl;
        } else {
            this.target_cube_bounce_ampl = 0;
            this.start_cube_bounce_ampl = this.curr_cube_bounce_ampl;
        }
        this.state_change_clock.start(this.get_local_bpm());
    }


    render(renderer) {
        const old_autoclear = renderer.autoClearColor;
        const old_render_target = renderer.getRenderTarget();
        //renderer.autoClearColor = false;
        //super.render(renderer);
        //
        //
        // Last render is stored in buffers[1]
        // Render new frame to buffers[0]
        renderer.render(this.vbo_scene, this.vbo_camera);


        /*let tex_values = [];
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

        renderer.setRenderTarget(old_render_target);
        renderer.clear();
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);*/
        //renderer.autoClearColor = old_autoclear;
        //this.cur_buffer_idx = (this.cur_buffer_idx + 1) % this.buffers.length;
    }
}
