import * as THREE from 'three';

// 4D rotation planes, applied in this order: [field, axis a, axis b].
const PLANES = [['rot_xy', 0, 1], ['rot_xz', 0, 2], ['rot_xw', 0, 3],
    ['rot_yz', 1, 2], ['rot_yw', 1, 3], ['rot_zw', 2, 3]];

// A tesseract wireframe, re-projected to 3D by update_geom from its 4D
// rotation (rot_*, rad), per-axis scale and projection.
export class Tesseract extends THREE.Object3D {
    constructor(size) {
        super();
        this.size = size;
        for (const [name] of PLANES) {
            this[name] = 0;
        }
        this.scale_vec = new THREE.Vector4(1, 1, 1, 1);
        // Projection: null drops w; a distance d (along w from the centre)
        // projects in perspective, scaling points by (d - size/2) / (d - w),
        // so the near cube keeps its size and the far one draws inside it.
        this.w_dist = null;

        // Vertex i has x, y, z, w = +-size/2 by its bits 3, 2, 1, 0; edges
        // join vertices one bit apart.
        this.vertices = [];
        for (let i = 0; i < 16; i++) {
            this.vertices.push([3, 2, 1, 0].map((bit) => ((i >> bit) & 1 ? 0.5 : -0.5) * size));
        }
        this.edges = [];
        for (let i = 0; i < 16; i++) {
            for (const bit of [1, 2, 4, 8]) {
                if (!(i & bit)) {
                    this.edges.push([i, i | bit]);
                }
            }
        }
        this.projected = new Float32Array(16 * 3);
        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute('position',
            new THREE.BufferAttribute(new Float32Array(this.edges.length * 6), 3));
        this.add(new THREE.LineSegments(this.geom, new THREE.LineBasicMaterial({ color: "white" })));
        this.update_geom();
    }

    update_geom() {
        const rots = PLANES.map(([name, a, b]) => [a, b, Math.cos(this[name]), Math.sin(this[name])]);
        const v = [0, 0, 0, 0];
        for (let i = 0; i < 16; i++) {
            for (let k = 0; k < 4; k++) {
                v[k] = this.vertices[i][k] * this.scale_vec.getComponent(k);
            }
            for (const [a, b, c, s] of rots) {
                const va = v[a], vb = v[b];
                v[a] = c * va + s * vb;
                v[b] = c * vb - s * va;
            }
            const k = this.w_dist === null ? 1 : (this.w_dist - this.size / 2) / (this.w_dist - v[3]);
            this.projected[3 * i] = k * v[0];
            this.projected[3 * i + 1] = k * v[1];
            this.projected[3 * i + 2] = k * v[2];
        }
        const points = this.geom.attributes.position.array;
        this.edges.forEach(([i, j], e) => {
            points.set(this.projected.subarray(3 * i, 3 * i + 3), 6 * e);
            points.set(this.projected.subarray(3 * j, 3 * j + 3), 6 * e + 3);
        });
        this.geom.attributes.position.needsUpdate = true;
    }
}
