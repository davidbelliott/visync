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
