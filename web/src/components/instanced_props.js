import * as THREE from 'three';
import { InstancedGeometryCollection } from '../instanced_geom.js';
import { ResourceLoader } from '../util.js';

// A batch of one prop shape (a ramp, an archway, a cone...) drawn in two
// calls however many there are: a lit fill shaded through the house dither,
// outlined along its edges in the same colour. Each instance is posed by a
// matrix and has its own opacity (e.g. fog of war times a level's fade): the
// fill dissolves through the dither (so it stays opaque, needing no
// sorting), the edges blend. Fill and edges both draw once the dither
// chunks load; add_instance() before then is ignored.
//
// Per frame: begin(), add_instance() each visible instance, end().
export class InstancedProps extends THREE.Group {
    // geometry: the prop's shape. color: THREE.Color of fill and edges.
    // max: instances at once. edge_angle: deg; neighbouring faces meeting
    // at more than this get an edge (EdgesGeometry).
    constructor(geometry, { color, max, edge_angle = 30 }) {
        super();
        this.max = max;
        this.count = 0;
        this.fill = null;
        this.edges = null;          // once the shaders load
        // The edges' line batch writes its colour to the screen as-is, with
        // none of three's linear -> sRGB output conversion, so it is given the
        // colour already in sRGB, matching the fill.
        this.color = color.clone();
        this.edge_color = color.clone().convertLinearToSRGB();
        // Scratch for decomposing instance matrices (the Group's own
        // position / quaternion / scale are taken).
        this.tmp_pos = new THREE.Vector3();
        this.tmp_quat = new THREE.Quaternion();
        this.tmp_scale = new THREE.Vector3();

        new ResourceLoader(['glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag']).load().then(
            ([dither_pars, dither]) => {
                const fill_geom = geometry.clone();
                this.alphas = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
                this.alphas.setUsage(THREE.DynamicDrawUsage);
                fill_geom.setAttribute('instance_alpha', this.alphas);
                // Pushed back so the edges, on its surface, draw.
                const mat = new THREE.MeshLambertMaterial({
                    color: this.color,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 1,
                });
                mat.onBeforeCompile = (shader) => {
                    shader.vertexShader = shader.vertexShader.replace(
                        '#include <common>',
                        'attribute float instance_alpha;\nvarying float v_alpha;\n#include <common>'
                    ).replace(
                        '#include <begin_vertex>',
                        '#include <begin_vertex>\nv_alpha = instance_alpha;'
                    );
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <dithering_pars_fragment>',
                        dither_pars + '\nvarying float v_alpha;'
                    ).replace(
                        '#include <dithering_fragment>',
                        dither
                    ).replace(
                        '#include <clipping_planes_fragment>',
                        '#include <clipping_planes_fragment>\n' +
                        'if (dither4x4(gl_FragCoord.xy, v_alpha) < 0.5) discard;'
                    );
                };
                this.fill = new THREE.InstancedMesh(fill_geom, mat, max);
                this.fill.count = 0;
                this.fill.frustumCulled = false;
                this.add(this.fill);

                this.edges = new InstancedGeometryCollection(this,
                    new THREE.EdgesGeometry(geometry, edge_angle), 'Lines', max);
                for (let k = 0; k < max; k++) {
                    this.edges.create_geom(new THREE.Vector3(), this.edge_color,
                        new THREE.Vector3(1, 1, 1), null, 0);
                }
                this.edges.set_num_instances(0);
            });
    }

    // Recolour fill and edges (THREE.Color).
    set_color(color) {
        this.color.copy(color);
        this.edge_color.copy(color).convertLinearToSRGB();
        this.fill?.material.color.copy(color);
    }

    begin() {
        this.count = 0;
    }

    // Draw an instance posed by matrix (THREE.Matrix4: translation,
    // rotation and scale, no shear) at alpha (0..1; 0 skips it).
    add_instance(matrix, alpha) {
        if (this.fill === null || alpha <= 0 || this.count >= this.max) {
            return;
        }
        const k = this.count++;
        this.fill.setMatrixAt(k, matrix);
        this.alphas.setX(k, alpha);
        matrix.decompose(this.tmp_pos, this.tmp_quat, this.tmp_scale);
        this.edges.set_pos(k, this.tmp_pos);
        this.edges.set_quaternion(k, this.tmp_quat);
        this.edges.set_scale(k, this.tmp_scale);
        this.edges.set_color(k, this.edge_color, alpha);
    }

    end() {
        if (this.fill === null) {
            return;
        }
        this.fill.count = this.count;
        this.fill.instanceMatrix.needsUpdate = true;
        this.alphas.needsUpdate = true;
        this.edges.set_num_instances(this.count);
    }
}
