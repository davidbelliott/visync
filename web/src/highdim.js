import * as THREE from '/static/js/three.js/build/three.module.min.js';

export class Tesseract {
    constructor(parent_obj, size) {
        this.rot_xw = 0.0;
        this.vertices = [];
        this.edges = [];
        for (let x = 0; x < 2; x++) {
            for (let y = 0; y < 2; y++) {
                for (let z = 0; z < 2; z++) {
                    for (let w = 0; w < 2; w++) {
                        let v = new THREE.Vector4(size * (2 * x - 1),
                            size * (2 * y - 1),
                            size * (2 * z - 1),
                            size * (2 * w - 1));
                        for (let i in this.vertices) {
                            let d = this.vertices[i].clone();
                            d.sub(v);
                            if (d.lengthSq() <= 4.1 * size * size) {
                                this.edges.push([i, this.vertices.length]);
                            }
                        }
                        this.vertices.push(v);
                    }
                }
            }
        }

        const points = [];
        for (let i in this.edges) {
            for (let j in this.edges[i]) {
                const point = this.vertices[this.edges[i][j]];
                points.push(project_3d(point));
            }
        }
        const wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );
        this.geom = new THREE.BufferGeometry().setFromPoints(points);
        //this.geom = new THREE.BoxGeometry(1, 1, 1);
        const line = new THREE.LineSegments(this.geom, wireframe_mat);
        parent_obj.add(line);
    }
    update_geom() {
        const points = this.geom.attributes.position.array;
        let points_idx = 0;
        for (let i in this.edges) {
            for (let j in this.edges[i]) {
                const this_vert = this.vertices[this.edges[i][j]];
                const vert_rotated = apply_rotation(this_vert, [1, 3], this.rot_xw);
                const v = project_3d(vert_rotated);
                points[points_idx++] = v.x;
                points[points_idx++] = v.y;
                points[points_idx++] = v.z;
            }
        }
        //this.geom.setAttribute('position', new THREE.BufferAttribute(points_arr_typed, 3));
        this.geom.attributes.position.needsUpdate = true;
    }
}

function apply_translation(vec4, trans) {
    const v = vec4.clone();
    v.add(trans);
    return v;
}

function apply_rotation(vec4, plane, angle) {
    let rot_array = [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ];

    let idx = plane[0] * 4;
    rot_array[plane[0] * 4 + plane[0]] = Math.cos(angle);
    rot_array[plane[0] * 4 + plane[1]] = -Math.sin(angle);
    rot_array[plane[1] * 4 + plane[0]] = Math.sin(angle);
    rot_array[plane[1] * 4 + plane[1]] = Math.cos(angle);

    const rot = new THREE.Matrix4();
    rot.fromArray(rot_array, 0);
    const v = vec4.clone();
    v.applyMatrix4(rot);
    return v;
}

function project_3d(vec4) {
    //let d = new THREE.Vector4(camera.position.x, camera.position.y, camera.position.z, 0);
    const dist = 12;
    const w = 1.0 / (dist - vec4.w);
    const proj = new THREE.Matrix4();
    proj.set(w, 0, 0, 0,
        0, w, 0, 0,
        0, 0, w, 0,
        0, 0, 0, 0);
    const v = vec4.clone();
    v.applyMatrix4(proj);
    return new THREE.Vector3(v.x, v.y, v.z);
}
