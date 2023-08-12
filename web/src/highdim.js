import * as THREE from 'three';

export class Tesseract extends THREE.Object3D {
    constructor(size, camera) {
        super();
        this.rot_xy = 0.0;
        this.rot_xz = 0.0;
        this.rot_xw = 0.0;
        this.rot_yz = 0.0;
        this.rot_yw = 0.0;
        this.rot_zw = 0.0;
        this.scale_vec = new THREE.Vector4(1, 1, 1, 1);
        this.vertices = [];
        this.edges = [];
        for (let x = 0; x < 2; x++) {
            for (let y = 0; y < 2; y++) {
                for (let z = 0; z < 2; z++) {
                    for (let w = 0; w < 2; w++) {
                        let v = new THREE.Vector4(size * (2 * x - 1) / 2,
                            size * (2 * y - 1) / 2,
                            size * (2 * z - 1) / 2,
                            size * (2 * w - 1) / 2);
                        for (let i in this.vertices) {
                            let d = this.vertices[i].clone();
                            d.sub(v);
                            if (d.lengthSq() <= 1.01 * size * size) {
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
                points.push(project_3d(point, camera));
            }
        }
        const wireframe_mat = new THREE.LineBasicMaterial( { color: "white", linewidth: 1 } );
        this.geom = new THREE.BufferGeometry().setFromPoints(points);
        //this.geom = new THREE.BoxGeometry(1, 1, 1);
        const line = new THREE.LineSegments(this.geom, wireframe_mat);
        this.add(line);
    }
    update_geom(camera) {
        const points = this.geom.attributes.position.array;
        let points_idx = 0;
        for (let i in this.edges) {
            for (let j in this.edges[i]) {
                const this_vert = this.vertices[this.edges[i][j]];
                let v = apply_scale(this_vert, this.scale_vec);

                v = apply_rotation(v, [0, 1], this.rot_xy);
                v = apply_rotation(v, [0, 2], this.rot_xz);
                v = apply_rotation(v, [0, 3], this.rot_xw);
                v = apply_rotation(v, [1, 2], this.rot_yz);
                v = apply_rotation(v, [1, 3], this.rot_yw);
                v = apply_rotation(v, [2, 3], this.rot_zw);

                v = project_3d(v, camera);
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

function apply_scale(vec4, scale) {
    const v = vec4.clone();
    v.multiply(scale);
    return v;
}

function project_3d(vec4, camera) {
    let d = new THREE.Vector4(camera.position.x, camera.position.y, camera.position.z, 0);
    d.sub(vec4);
    //const dist = 5;
    const w =  1.0;// / (dist + vec4.w);
    const proj = new THREE.Matrix4();
    proj.set(w, 0, 0, 0,
        0, w, 0, 0,
        0, 0, w, 0,
        0, 0, 0, 0);
    const v = vec4.clone();
    v.applyMatrix4(proj);
    return new THREE.Vector3(v.x, v.y, v.z);
}
