"use strict";
import * as THREE from 'three';

export function lerp_scalar(start, target, frac) {
    return start + (target - start) * frac;
}

export function ease(x) {
    return (1 - Math.cos(Math.PI * x)) / 2 * Math.sign(x);
}

export function update_persp_camera_aspect(camera, aspect) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
}

export function update_orth_camera_aspect(camera, aspect, frustum_size) {
    camera.left = -frustum_size * aspect / 2;
    camera.right = frustum_size * aspect / 2;
    camera.top = frustum_size / 2;
    camera.bottom = -frustum_size / 2;
    camera.updateProjectionMatrix();
}

export function rand_int(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min); //The maximum is exclusive and the minimum is inclusive
}

export function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
}

export function arr_eq(a, b) {
    if (a.length != b.length) {
        return false;
    }
    for (const i in a) {
        if (a[i] != b[i]) {
            return false;
        }
    }
    return true;
}

export class ResourceLoader {
    constructor(urls) {
        this.urls = urls;
    }

    load() {
        return Promise.all(
            this.urls.map(url => fetch(url).then(resp => resp.text()))
        );
    }
}

export function load_texture(url) {
    return new Promise(resolve => {
        new THREE.TextureLoader().load(url, resolve);
    });
}

export class ShaderLoader {
    constructor(vertex_url, fragment_url) {
        this.vertex_url = vertex_url;
        this.fragment_url = fragment_url;
    }

    load() {
        return Promise.all([
        fetch(this.vertex_url).then(resp => resp.text()),
        fetch(this.fragment_url).then(resp => resp.text())
        ]);
    }
}

export function make_line(points, color) {
    const material = new THREE.LineBasicMaterial( { color: color } );
    const geometry = new THREE.BufferGeometry().setFromPoints( points );
    const l = new THREE.Line( geometry, material );
    return l;
}

export function make_wireframe_cone(r, h, segments, color) {
    let geometry = new THREE.ConeGeometry(r, h, segments);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 1 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);

    const fill_mat = new THREE.MeshBasicMaterial({
        color: "black",
        polygonOffset: true,
        polygonOffsetFactor: 1, // positive value pushes polygon further away
        polygonOffsetUnits: 1
    });
    const inner_geom = new THREE.ConeGeometry(r, h, segments);
    mesh.add(new THREE.Mesh(inner_geom, fill_mat));

    return mesh;
}

export function make_wireframe_cylinder(r_top, r_bottom, height, color) {
    // Makes a fake wireframe cylinder (outline); don't rotate about Z
    const ls = new THREE.Group();
    const c_top = make_wireframe_circle(r_top, 32, color);
    c_top.rotation.x = Math.PI / 2;
    c_top.position.y = height / 2;
    //ls.add(c_top);
    const c_bot = make_wireframe_circle(r_bottom, 32, color);
    c_bot.rotation.x = Math.PI / 2;
    c_bot.position.y = -height / 2;
    //ls.add(c_bot);
    const fill_geometry = new THREE.CylinderGeometry(r_top, r_bottom, height, 32);
    fill_geometry.scale(0.99, 0.99, 0.99);
    /*const fill_mat = new THREE.MeshBasicMaterial({
        color: "black",
        polygonOffset: true,
        polygonOffsetFactor: 1, // positive value pushes polygon further away
        polygonOffsetUnits: 1
    });*/
    const fill_mat = new THREE.MeshLambertMaterial({color: color});
    const mesh = new THREE.Mesh(fill_geometry, fill_mat);
    ls.add(mesh);

    const line_mat = new THREE.LineBasicMaterial({color: color});

    const line_1 = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-r_top, height / 2, 0),
        new THREE.Vector3(-r_bottom, -height / 2, 0)]);
    const line_2 = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(r_top, height / 2, 0),
        new THREE.Vector3(r_bottom, -height / 2, 0)]);
    //ls.add(new THREE.Line(line_1, line_mat));
    //ls.add(new THREE.Line(line_2, line_mat));

    return ls;
}


export function make_wireframe_cube(dims, color) {
    let geometry = new THREE.BoxGeometry(...dims);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 1 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);
    return mesh;
}


export function create_instanced_cube(dims, color) {
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


export function make_wireframe_circle(radius, segments, color) {
    // Make a wireframe circle using THREE.js and return it
    const geometry = new THREE.CircleGeometry(radius, segments);
    const edges_geom = new THREE.EdgesGeometry(geometry);

    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: color,
        linewidth: 1.0});

    const circle = new THREE.LineSegments(edges_geom, wireframe_mat);
    //const circle = new THREE.Mesh(edges_geom, wireframe_mat);
    return circle;
}

export function make_wireframe_rectangle(width, height, color) {
    const geometry = new THREE.PlaneGeometry(width, height);
    const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: color,
        linewidth: 1.0} );
    const ls = new THREE.LineSegments(edges_geom, wireframe_mat);
    return ls
}


export class Spark extends THREE.Object3D {
    constructor(size, color, axes) {
        super();
        this.material = new THREE.LineBasicMaterial( { color: color } );
        const lines = [
            [-1, -1, 1, 1],
            [-1, 1, 1, -1],
            [-1.25, 0, 1.25, 0]];
        for (const line of lines) {
            const points = [];
            for (let i = 0; i < 2; i++) {
                const point = [0, 0, 0];
                point[axes[0]] = line[i * 2] * size;
                point[axes[1]] = line[i * 2 + 1] * size;
                points.push(new THREE.Vector3().fromArray(point));
            }
            const geometry = new THREE.BufferGeometry().setFromPoints( points );
            const l = new THREE.Line( geometry, this.material );
            this.add(l);
        }
        this.velocity = new THREE.Vector3();
        this.acceleration = new THREE.Vector3();
        this.flicker_frames = 3;
        this.cur_frame = 0;
        this.active = true;
    }

    anim_frame(dt, camera) {
        if (this.active) {
            this.cur_frame++;
            const dv = this.acceleration.clone();
            dv.multiplyScalar(dt);
            this.velocity.add(dv);

            const dx = this.velocity.clone();
            dx.multiplyScalar(dt);
            this.position.add(dx);

            this.visible = true;
            this.visible = (this.cur_frame % (2 * this.flicker_frames) < this.flicker_frames);
            this.quaternion.copy(camera.quaternion);
            if (this.parent != null) {
                const group_quat = new THREE.Quaternion();
                this.parent.getWorldQuaternion(group_quat);
                group_quat.conjugate();
                this.quaternion.premultiply(group_quat);
            }
        } else {
            this.cur_frame = 0;
            this.visible = false;
        }
    }
}

export class ObjectPool extends THREE.Group {
    constructor(object_constr, max_num_objects) {
        super();
        this.pool_object_constr = object_constr;
        this.max_num_objects = max_num_objects;
        this.pool_objects = [];
        this.cur_idx = 0;
    }

    get_pool_object() {
        let obj = null;
        if (this.pool_objects.length < this.max_num_objects) {
            obj = this.pool_object_constr();
            this.pool_objects.push(obj);
            this.add(obj);
        } else {
            obj = this.pool_objects[this.cur_idx];
        }
        this.cur_idx = (this.cur_idx + 1) % this.max_num_objects;
        return obj;
    }

    foreach(fn) {
        this.pool_objects.forEach((obj) => {
            fn(obj);
        });
    }
}

export class BeatClock extends THREE.Clock {
    constructor(scene, autostart=true) {
        super(autostart);
        this.scene = scene;
        this.elapsed_beats = 0;
    }

    start() {
        super.start();
        this.elapsed_beats = 0;
    }

    get_elapsed_beats() {
        this.get_delta_beats();     // updates elapsed_beats
        return this.elapsed_beats;
    }

    get_delta_beats() {
        const delta_time = this.getDelta();
        const beats_per_second = this.scene.get_local_bpm() / 60;
        const beat_delta = delta_time * beats_per_second;
        this.elapsed_beats += beat_delta;
        return beat_delta;
    }
}
