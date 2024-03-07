import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
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
    constructor(env, parent_scene) {
        this.parent_scene = parent_scene;
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
        const beats_per_sec = this.parent_scene.get_local_bpm() / 60;
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

export class FastCubeScene extends VisScene {
    constructor(env) {
        super(env);

        const width = window.innerWidth;
        const height = window.innerHeight;


        const aspect = width / height;
        this.frustum_size = 20;
        this.cam_fg = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);

        this.camera = this.cam_fg;

        const isom_angle = Math.asin(1 / Math.sqrt(3));     // isometric angle

        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock(true);
        this.sync_clock = new THREE.Clock(true);
        this.half_beat_clock = new THREE.Clock(true);
        this.full_beat_clock = new THREE.Clock(true);

        this.base_group = new THREE.Group();
        this.bg = new TunnelMovementBackground(env, this);

        this.vibe_ampl = 0;

        this.cube = create_instanced_cube([6, 6, 6], "white");
        this.front_speaker = make_wireframe_circle(2, 32, "white");
        this.front_speaker.add(make_wireframe_circle(0.7, 32, "white"));
        this.front_speaker.position.z = 3;
        this.cube.add(this.front_speaker);
        this.base_group.add(this.cube);
        this.feet = [
            create_instanced_cube([3, 1.5, 6], "white"),
            create_instanced_cube([3, 1.5, 6], "white")];
        this.feet_base_pos = [
            new THREE.Vector3(-1.5, -6, 0),
            new THREE.Vector3(1.5, -6, 0)];
        this.feet.forEach((f, i) => {
            for (let i = 0; i < 2; i++) {
                for (let j = 0; j < 4; j++) {
                    const spike = make_wireframe_cone(Math.sqrt(2) * 3/4, 3/4, 4, "white");
                    spike.rotation.set(0, Math.PI / 4, Math.PI);
                    spike.position.set(i * 3/2 - (3/2 * (2/2 - 1/2)),
                        -1.5 / 2 - 3/8,
                        j * 3/2 - (3/2 * (4/2 - 1/2)));
                    f.add(spike);
                }
            }
            f.position.copy(this.feet_base_pos[i]);
            this.base_group.add(f);
        });

        this.lasers = [];
        this.laser_on_times = [];
        this.cur_frame = 0;
        this.hands = [
            create_instanced_cube([3, 3, 1.5], "white"),
            create_instanced_cube([3, 3, 1.5], "white")];
        this.hands_base_pos = [
            new THREE.Vector3(-5, 0, 0),
            new THREE.Vector3(5, 0, 0)];
        this.hands.forEach((h, i) => {
            for (let i = 0; i < 4; i++) {
                const height = (i == 0 || i == 3) ? 2.25 : 3;
                const finger = create_instanced_cube([3/4, height, 1.0], "white");
                finger.position.set(3/4 * i + (-3/4 * 2 + 3/8), height / 2 + 3 / 2, 0);
                h.add(finger);
            }
            const eye = make_wireframe_circle(0.5, 32, "cyan");
            eye.position.z = 0.75;
            h.add(eye);
            const laser = make_line([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, 100)], "cyan");
            this.lasers.push(laser);
            h.add(laser);
            h.position.copy(this.hands_base_pos[i]);
            this.base_group.add(h);
        });
        this.flicker_frames = 3;

        this.sparks = [];
        this.max_num_sparks = 64;
        this.cur_spark_idx = 0;
        for (let i = 0; i < this.max_num_sparks; i++) {
            const s = new Spark(0.3, "white", [0, 1]);
            s.active = false;
            this.base_group.add(s);
            this.sparks.push(s);
        }

        this.buffer = new THREE.WebGLRenderTarget(width, height, {});
        this.base_group.rotation.x = -isom_angle;

        this.start_rot = 0;
        this.end_rot = 0;
        this.rot_dir = 1;
        this.base_group.rotation.y = this.start_rot * Math.PI / 8;


        this.shader_loader = new ShaderLoader('glsl/default.vert', 'glsl/texture.frag');
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

        this.scene.add(this.base_group);
    }

    get_foot_shuffle_offset(side_idx, t) {
        // get shuffle offset for this side as an array [x, y, z]
        // side_idx: 0 for left, 1 for right
        // t: normalized time since half-note beat (0 - 1)
        const t_period = 1.0 / 4.0;
        const t_mov = 0.4;
        const dt = (t / t_period) % 1;
        const this_side_x = 0;
        const position_options = [
            [this_side_x, 0, clamp(1 - (dt - (1 - t_mov)) / t_mov, 0, 1)],
            [this_side_x, 0, clamp(-(dt - (1 - t_mov)) / t_mov, -1, 0)],
            [this_side_x * clamp(1 - (dt - (1 - t_mov)) / t_mov, 0, 1), clamp((dt - (1 - t_mov)) / t_mov, 0, 1), clamp(-1 + (dt - (1 - t_mov)) / t_mov, -1, 0)],
            [this_side_x * clamp((dt - (1 - t_mov)) / t_mov, 0, 1), clamp(1 - (dt - (1 - t_mov)) / t_mov, 0, 1), clamp((dt - (1 - t_mov)) / t_mov, 0, 1)]];
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

    anim_frame(dt) {
        this.cur_frame++;
        const beats_per_sec = this.get_local_bpm() / 60;
        const beats_per_lerp = 1.0;
        const t = this.sync_clock.getElapsedTime() * beats_per_sec;
        const frac = clamp((t - (1 - beats_per_lerp)) / beats_per_lerp, 0, 1);
        this.base_group.rotation.y = Math.PI / 8 * (this.start_rot +
            lerp_scalar(0, 1, frac) * (this.end_rot - this.start_rot));


        let half_beat_time = this.half_beat_clock.getElapsedTime() * beats_per_sec / 2.0;
        let full_beat_time = this.full_beat_clock.getElapsedTime() * beats_per_sec / 4.0;
        for (let side = 0; side < 2; side++) {
            const shuffle_offset = this.get_foot_shuffle_offset(side, half_beat_time);
            this.feet[side].position.x = this.feet_base_pos[side].x + shuffle_offset[0];
            this.feet[side].position.y = this.feet_base_pos[side].y + 1.5 * shuffle_offset[1];
            this.feet[side].position.z = this.feet_base_pos[side].z + shuffle_offset[2];

            this.hands[side].position.y = this.hands_base_pos[side].y + 2 * Math.sin(2 * Math.PI * (full_beat_time + 0.5 * side));
        }

        this.front_speaker.position.z = 3 + Math.random() * this.vibe_ampl;
        this.vibe_ampl *= 0.96;

        // Lasers
        const t_now = this.clock.getElapsedTime();
        const keep_ranges = [];
        let is_active = false;
        for (const t_range of this.laser_on_times) {
            if (t_range[0] <= t_now && t_range[1] > t_now) {
                is_active = true;
            }
            if (t_range[1] > t_now) {
                keep_ranges.push(t_range);
            }
        }
        this.laser_on_times = keep_ranges;

        for (const l of this.lasers) {
            l.visible = is_active && (this.cur_frame % (2 * this.flicker_frames) < this.flicker_frames);
        }

        // Sparks
        for (const s of this.sparks) {
            s.anim_frame(dt, this.camera);
        }

        this.bg.anim_frame(dt);

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

        if (channel == 1) {
            const thirtysecond_note_dur = 60 / this.get_local_bpm() / 8;
            const start_t = this.clock.getElapsedTime() + 4 * thirtysecond_note_dur
                - this.env.total_latency;
            this.laser_on_times.push([
                start_t,
                start_t + 8 * thirtysecond_note_dur
            ]);
            setTimeout(() => {
                const sparks_origin = this.cube.position.clone();
                sparks_origin.z = 3;
                this.create_sparks(sparks_origin, 5, 10, "white");
                this.vibe_ampl = 0.5;
            }, 4 * thirtysecond_note_dur - this.env.total_latency);
        }
    }

    render(renderer) {
        if (this.vbo_material == null) {
            return;
        }
        const renderTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(this.buffer);
        renderer.clear();
        renderer.render(this.bg.scene, this.bg.camera);
        this.vbo_material.uniforms.uTexture.value = this.buffer.texture;
        renderer.setRenderTarget(renderTarget);
        renderer.render(this.scene, this.camera);
        //renderer.render(this.scene, this.camera);
    }

    create_sparks(pos, num, avg_vel, color) {
        for (let i = 0; i < 16; i++) {
            /*const vel = new THREE.Vector3(
                Math.random() - 0.5,
                Math.random() * 0.5,
                Math.random() - 0.5);*/
            //vel.normalize();
            const vel = new THREE.Vector3(0, 1, 1);

            vel.applyEuler(new THREE.Euler(0, 0, Math.PI / 8 * i));
            vel.multiplyScalar(avg_vel);
            this.sparks[this.cur_spark_idx].active = true;
            this.sparks[this.cur_spark_idx].position.copy(pos);
            this.sparks[this.cur_spark_idx].velocity = vel;
            this.sparks[this.cur_spark_idx].acceleration.set(0, 0, 0);
            this.sparks[this.cur_spark_idx].material.color.set(color);

            this.cur_spark_idx = (this.cur_spark_idx + 1) % this.max_num_sparks;
        }
    }
}
