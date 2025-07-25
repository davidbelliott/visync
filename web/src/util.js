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

export function make_wireframe_cone(r, h, segments, color, depth_test=true, fill=true, fill_color=new THREE.Color("black"), fill_opacity=1.0) {
    let geometry = new THREE.ConeGeometry(r, h, segments);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 1 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);

    if (fill) {
        const fill_mat = new THREE.MeshBasicMaterial({
            color: fill_color,
            polygonOffset: true,
            polygonOffsetFactor: 1, // positive value pushes polygon further away
            polygonOffsetUnits: 1,
            depthTest: depth_test,
            transparent: true,
            opacity: fill_opacity,
        });
        const inner_geom = new THREE.ConeGeometry(r, h, segments);
        mesh.add(new THREE.Mesh(inner_geom, fill_mat));
    }

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


export function make_point_cloud() {
    const geometry = new THREE.TorusGeometry(10, 3, 16, 100);
    const material = new THREE.PointsMaterial({
        size: 2.0,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: 1.0});

    return new THREE.Points( geometry, material );
}


export function make_wireframe_special(color) {
    const geometry = new THREE.TorusKnotGeometry(3, 1, 100, 16);
    //const edges_geom = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity: 1.0,
        color: new THREE.Color(color),
        linewidth: 1.0} );
    wireframe_mat.depthTest = false;
    wireframe_mat.depthWrite = false;
    const ls = new THREE.LineSegments(geometry, wireframe_mat);
    return ls
}


export function make_wireframe_cube(dims, color) {
    let geometry = new THREE.BoxGeometry(...dims);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 1 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);
    return mesh;
}


export function create_instanced_cube(dims, color, add_fill=true, fill_color="black", fill_opacity=0.0) {
    let geometry = new THREE.BoxGeometry(...dims);
    let wireframe = new THREE.EdgesGeometry(geometry);
    const wireframe_mat = new THREE.LineBasicMaterial( { color: color, linewidth: 2 } );
    const mesh = new THREE.LineSegments(wireframe, wireframe_mat);

    if (add_fill) {
        const fill_mat = new THREE.MeshBasicMaterial({
            color: fill_color,
            polygonOffset: true,
            polygonOffsetFactor: 1, // positive value pushes polygon further away
            polygonOffsetUnits: 1,
            transparent: (fill_opacity < 1.0),
            opacity: fill_opacity,
        });
        const inner_geom = new THREE.BoxGeometry(...dims);
        mesh.add(new THREE.Mesh(inner_geom, fill_mat));
    }

    return mesh;
}

export function create_instanced_cube_templates(width=1, height=1, depth=1) {
    // Create template for wireframe geometry
    const template_wireframe = new THREE.BufferGeometry();
    {
        // create a simple cube shape, using line segments
        const square_vertices = [
            [-0.5 * width, -0.5 * height],
            [0.5 * width, -0.5 * height],
            [0.5 * width, 0.5 * height],
            [-0.5 * width, 0.5 * height],
        ];
        const vert_buf = [];
        // Create the front and back faces of the cube
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 4; j++) {
                // Add a line between the current vertex and the next vertex
                vert_buf.push(...square_vertices[j]);
                vert_buf.push(depth * (i - 0.5));
                vert_buf.push(...square_vertices[(j + 1) % 4]);
                vert_buf.push(depth * (i - 0.5));
            }
        }
        // Create the lines between the front and back faces
        for (let j = 0; j < 4; j++) {
            // Add a line between the current vertex and the next vertex
            for (let i = 0; i < 2; i++) {
                vert_buf.push(...square_vertices[j]);
                vert_buf.push(depth * (i - 0.5));
            }
        }

        const vertices = new Float32Array(vert_buf);

        // itemSize = 3 because there are 3 values (components) per vertex
        template_wireframe.setAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
        template_wireframe.instanceCount = 1;
    }

    // Create template for fill cube
    const template_fill = new THREE.BoxGeometry(width, height, depth);

    return [template_wireframe, template_fill];
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
    constructor(size, color, axes, flicker=true, always_in_front=false, is_cross=false, billboard=true) {
        super();
        this.material = new THREE.LineBasicMaterial( { color: color } );
        var lines = [
                [-1, -1, 1, 1],
                [-1, 1, 1, -1],
                [-1.25, 0, 1.25, 0]];

        if (is_cross) {
            lines = [
                [-1, 0, 1, 0],
                [0, -1, 0, 1]];
        }
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
            if (always_in_front) {
                l.renderOrder = 999;
                this.material.depthTest = false;
                this.material.depthWrite = false;
            }
            this.add(l);
        }
        this.velocity = new THREE.Vector3();
        this.acceleration = new THREE.Vector3();
        this.flicker_frames = 3;
        this.cur_frame = 0;
        this.active = true;
        this.flicker = flicker;
        this.billboard = billboard;
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
            if (this.flicker) {
                this.visible = (this.cur_frame % (2 * this.flicker_frames) < this.flicker_frames);
            }
            if (this.billboard) {
                this.quaternion.copy(camera.quaternion);
                if (this.parent != null) {
                    const group_quat = new THREE.Quaternion();
                    this.parent.getWorldQuaternion(group_quat);
                    group_quat.conjugate();
                    this.quaternion.premultiply(group_quat);
                }
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
    constructor(parent_scene) {
        super(false);
        this.parent_scene = parent_scene;
        this.elapsed_beats = 0;
        this.bpm = 0;
    }

    start() {
        super.start();
        this.bpm = this.parent_scene.get_local_bpm();
        this.elapsed_beats = 0;
    }

    updateBPM(new_bpm) {
        this.elapsed_beats += this.getDelta() * this.bpm / 60;
        this.bpm = new_bpm;
    }

    getElapsedBeats() {
        const bpm = this.parent_scene.get_local_bpm();
        this.updateBPM(bpm);
        return this.elapsed_beats;
    }
}
