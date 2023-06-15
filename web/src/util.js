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
