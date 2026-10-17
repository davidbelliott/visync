import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ContourScan } from './contour_scan.js';
import { lerp_scalar, ease, clamp, ShaderLoader } from '../util.js';

// David's head (a scan, stl/david_head.stl: Y up, face towards +z, ~28 units
// tall; cleaned and decimated from models/david_head.stl by
// scripts/clean_head_mesh.py), drawn as a scan like ScannedBrain: cyan
// contour lines (ContourScan) scrolling up over a lit, dithered fill cut into
// alternating bands, a scan contour that sweeps up on demand (start_scan,
// e.g. each kick), and a white flash on demand (flash). Its underside sits on
// the group's origin, centred over it; `height` (world units) is set once the
// model loads, and nothing draws until then.
//
// Contour spacing, model units: the head is ~28 tall, so ~8 slices, much
// sparser than the brain's ~18. They scroll up this many slices per beat. A
// scan sweeps up over SCAN_BEATS, lighting the contours below it over
// SCAN_TRAIL model units. Contours on faces turned away from the viewer are
// BACK_GAIN as bright (with the fill in front, only visible at the
// silhouette). Recutting the contours costs a pass over the head's ~15k
// triangles per frame.
const SLICE_SPACING = 3.5;
// true: the contours, over a fill cut into alternating bands between them
// (the "orange peel", the brain showing through the gaps), with the scan.
// false: none of that, just the solid dithered fill (hiding the brain).
const CONTOURS = false;
const SLICE_SCROLL_PER_BEAT = 0.25;
const SCAN_BEATS = 1;
const SCAN_TRAIL = 5.2;
const BACK_GAIN = 0.35;
const LINE_COLOR = new THREE.Color('cyan');
const SCAN_COLOR = new THREE.Color('white');
//
// The scan's face is turned ~5.5 deg off +z; this yaw (rad, about Y) squares
// it up, found as the rotation making the face most mirror-symmetric.
const MODEL_YAW = THREE.MathUtils.degToRad(-5.5);
// The fill under the contours: lit and dithered, dark enough that the
// contours stay the brightest thing on it (as the scanned brain's).
const FILL_COLOR = new THREE.Color(0.0, 0.25, 0.25);
// Lights on the head alone, in its shader rather than the scene, so they
// light nothing else (no hot spots on nearby walls), all in the model's
// frame so they turn with the head:
// - for contrast, the scene's lights (the maze's even overhead spotlight)
//   count SCENE_LIGHT_GAIN as much on the head, so its shadow side can go
//   dark;
// - a key light from FACE_LIGHT_DIR, adding up to FACE_LIGHT_GAIN of the
//   fill colour (unshadowed): from three quarters (to one side, in front
//   and above), so one side of the nose, cheeks and brow falls into shade
//   and models the face; lit from the front it flattened them. Its falloff
//   is Lambert sharpened to (n.l)^KEY_SHARPNESS, so it lights what faces it
//   brightly and drops away fast, rather than spreading evenly;
// - cavity shading: each vertex's concavity (how far its neighbours sit
//   above it, in edge lengths, see cavity_attribute) darkens creases (eye
//   sockets, nostrils, mouth, ears) and lifts ridges (brow, nose, cheekbones)
//   by CAVITY_STRENGTH per unit, within CAVITY_RANGE of the lighting;
//   against the dark maze without lighting the front.
const FACE_LIGHT_DIR = new THREE.Vector3(0.7, 0.55, 0.6).normalize();
const FACE_LIGHT_GAIN = 0.6;
const KEY_SHARPNESS = 1;
const SCENE_LIGHT_GAIN = 1.4;
const CAVITY_STRENGTH = 2;
const CAVITY_RANGE = [0.15, 1.0];
const CAVITY_SMOOTH_ITERS = 2;
// A faint ambient on the head alone (likewise in the shader), adding
// AMBIENT_GAIN of the fill colour everywhere so its back, away from the
// lights, isn't pitch black.
const AMBIENT_GAIN = 0.05;
// A solid brain inside, seen through the fill's gaps (stl/brain.stl: Y up,
// front +z, ~153 x 162 x 191 units): BRAIN_FIT head model units per brain
// unit, its bounding box centred at BRAIN_POS in the head's model frame (as
// placed here: centred over the origin, underside at 0), the largest fit
// inside the cranium, with a little clearance, found by ray-casting its
// vertices against the head in Blender. It receives no shadows, else the
// head's (cast whole, not banded) would black it out.
const BRAIN_FIT = 0.072;
const BRAIN_POS = new THREE.Vector3(0, 20.5, -1.5);
const BRAIN_COLOR = new THREE.Color('magenta');
// flash() turns contours, fill and brain this colour, fading back over FLASH_BEATS.
const FLASH_COLOR = new THREE.Color('white');
const FLASH_BEATS = 0.5;

// Per-vertex cavity factor (see CAVITY_STRENGTH) for a non-indexed triangle
// geometry, as a float attribute: its corners welded by position, normals
// averaged, each vertex's concavity the offset of its neighbours' mean along
// its normal, in mean edge lengths (smoothed over CAVITY_SMOOTH_ITERS rings).
function cavity_attribute(geom) {
    const pos = geom.getAttribute('position').array;
    const n_corners = pos.length / 3;
    const ids = new Map(), corner = new Int32Array(n_corners), uniq = [];
    for (let i = 0; i < n_corners; i++) {
        const key = `${Math.round(pos[3 * i] * 1e4)},${Math.round(pos[3 * i + 1] * 1e4)},${Math.round(pos[3 * i + 2] * 1e4)}`;
        let id = ids.get(key);
        if (id === undefined) {
            id = uniq.length / 3;
            ids.set(key, id);
            uniq.push(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
        }
        corner[i] = id;
    }
    const nv = uniq.length / 3;
    const nor = new Float32Array(3 * nv), nb = new Float32Array(3 * nv), deg = new Float32Array(nv);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let edge_sum = 0;
    for (let t = 0; t < n_corners; t += 3) {
        const v = [corner[t], corner[t + 1], corner[t + 2]];
        a.fromArray(uniq, 3 * v[0]); b.fromArray(uniq, 3 * v[1]); c.fromArray(uniq, 3 * v[2]);
        edge_sum += a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(a);
        const fn = c.clone().sub(b).cross(a.clone().sub(b));    // area-weighted, outward
        for (let k = 0; k < 3; k++) {
            for (let d = 0; d < 3; d++) {
                nor[3 * v[k] + d] -= fn.getComponent(d);
                // Both other corners are neighbours (each edge counted twice).
                nb[3 * v[k] + d] += uniq[3 * v[(k + 1) % 3] + d] + uniq[3 * v[(k + 2) % 3] + d];
            }
            deg[v[k]] += 2;
        }
    }
    const mean_edge = edge_sum / n_corners;
    let cav = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
        const nx = nor[3 * i], ny = nor[3 * i + 1], nz = nor[3 * i + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        let off = 0;
        for (let d = 0; d < 3; d++) {
            off += (nb[3 * i + d] / deg[i] - uniq[3 * i + d]) * nor[3 * i + d] / len;
        }
        cav[i] = off / mean_edge;
    }
    // Smooth over neighbouring vertices (via the triangles).
    for (let it = 0; it < CAVITY_SMOOTH_ITERS; it++) {
        const sum = new Float32Array(nv), cnt = new Float32Array(nv);
        for (let t = 0; t < n_corners; t += 3) {
            for (let k = 0; k < 3; k++) {
                const v = corner[t + k];
                for (let j = 0; j < 3; j++) {
                    sum[v] += cav[corner[t + j]];
                    cnt[v]++;
                }
            }
        }
        for (let i = 0; i < nv; i++) {
            cav[i] = sum[i] / cnt[i];
        }
    }
    const out = new Float32Array(n_corners);
    for (let i = 0; i < n_corners; i++) {
        out[i] = clamp(1 - CAVITY_STRENGTH * cav[corner[i]], CAVITY_RANGE[0], CAVITY_RANGE[1]);
    }
    return new THREE.BufferAttribute(out, 1);
}

export class Head extends THREE.Group {
    // scale: world units per model unit. shadows: whether it casts and
    // receives shadows.
    constructor(scale, { shadows = false } = {}) {
        super();
        this.contours = null;       // ContourScan, once loaded
        this.height = 0;            // world units, once loaded
        // Model units the contours have scrolled up, wrapping every two
        // bands so the solid/empty bands never swap at the wrap.
        this.slice_offset = 0;
        this.band_uniforms = {
            slice_offset: { value: 0 },
            slice_spacing: { value: SLICE_SPACING },
        };
        this.scan_frac = 1;         // through the running scan, 0..1; 1 = none
        this.scan_height = 0;       // model units
        this.flash_amount = 0;      // 1 at a flash, fading to 0
        // The live colours, lerped towards FLASH_COLOR by flash_amount.
        this.line_color = LINE_COLOR.clone();
        this.fill_mat = null;       // once loaded
        this.fill = null;           // the head's solid mesh, once loaded
        this.brain_mat = null;      // once loaded

        Promise.all([
            new ShaderLoader('glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag').load(),
            new STLLoader().loadAsync('stl/david_head.stl'),
            new STLLoader().loadAsync('stl/brain.stl'),
        ]).then(([[dither_pars, dither], geom, brain_geom]) => {
            // Face it squarely down +z, centred over the origin, underside on it.
            geom.rotateY(MODEL_YAW);
            geom.computeBoundingBox();
            const box = geom.boundingBox;
            this.height = (box.max.y - box.min.y) * scale;
            geom.translate(-(box.min.x + box.max.x) / 2, -box.min.y,
                -(box.min.z + box.max.z) / 2);
            // Fill behind the contours, hiding the far side's, in every other
            // band between them: a stack of open rings, its inside showing
            // (double-sided) through the gaps. Pushed back so the near
            // contours, which lie exactly on its surface, pass the depth test.
            const fill_mat = this.fill_mat = new THREE.MeshLambertMaterial({
                color: FILL_COLOR,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
            });
            fill_mat.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.band_uniforms);
                shader.uniforms.face_light_dir = { value: FACE_LIGHT_DIR };
                shader.uniforms.face_light_gain = { value: FACE_LIGHT_GAIN };
                shader.uniforms.ambient_gain = { value: AMBIENT_GAIN };
                shader.uniforms.key_sharpness = { value: KEY_SHARPNESS };
                shader.uniforms.scene_light_gain = { value: SCENE_LIGHT_GAIN };
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'uniform vec3 face_light_dir;\nvarying vec3 v_face_light_dir;\n' +
                    'attribute float cavity;\nvarying float v_cavity;\n' +
                    'varying float v_height;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nv_face_light_dir = normalMatrix * face_light_dir;\n' +
                    'v_cavity = cavity;\nv_height = position.y;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    'void main() {',
                    'uniform float face_light_gain;\nuniform float ambient_gain;\n' +
                    'varying vec3 v_face_light_dir;\n' +
                    'varying float v_cavity;\n' +
                    'uniform float key_sharpness;\nuniform float scene_light_gain;\n' +
                    'uniform float slice_offset;\nuniform float slice_spacing;\n' +
                    'varying float v_height;\nvoid main() {\n' +
                    (CONTOURS ?
                        'if (mod(floor((v_height - slice_offset) / slice_spacing), 2.0) > 0.5) discard;' : '')
                ).replace(
                    '#include <opaque_fragment>',
                    'outgoingLight *= scene_light_gain;\n' +
                    'outgoingLight += diffuseColor.rgb * face_light_gain\n' +
                    '    * pow(max(dot(normal, normalize(v_face_light_dir)), 0.0), key_sharpness);\n' +
                    'outgoingLight += diffuseColor.rgb * ambient_gain;\n' +
                    'outgoingLight *= v_cavity;\n' +
                    '#include <opaque_fragment>'
                ).replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            geom.setAttribute('cavity', cavity_attribute(geom));
            const fill = this.fill = new THREE.Mesh(geom, fill_mat);
            fill.castShadow = fill.receiveShadow = shadows;

            if (CONTOURS) {
                this.contours = new ContourScan(geom, {
                    spacing: SLICE_SPACING,
                    line_color: this.line_color,
                    scan_color: SCAN_COLOR,
                    back_gain: BACK_GAIN,
                    trail: SCAN_TRAIL,
                });
            }
            for (const obj of [fill, this.contours]) {
                if (obj !== null) {
                    obj.scale.setScalar(scale);
                    this.add(obj);
                }
            }

            brain_geom.computeBoundingBox();
            const brain_centre = brain_geom.boundingBox.getCenter(new THREE.Vector3());
            brain_geom.translate(-brain_centre.x, -brain_centre.y, -brain_centre.z);
            const brain_mat = this.brain_mat = new THREE.MeshLambertMaterial({
                color: BRAIN_COLOR,
            });
            brain_mat.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            const brain = new THREE.Mesh(brain_geom, brain_mat);
            brain.scale.setScalar(scale * BRAIN_FIT);
            brain.position.copy(BRAIN_POS).multiplyScalar(scale);
            this.add(brain);
        });
    }

    // Sweep a scan contour up the head, restarting any still running.
    start_scan() {
        this.scan_frac = 0;
    }

    // Turn the whole head white, fading back over FLASH_BEATS.
    flash() {
        this.flash_amount = 1;
    }

    // Advance by d_beats: scroll the contours, move any running scan, fade
    // any flash, and recut the contours.
    update(d_beats) {
        if (this.flash_amount > 0) {
            this.flash_amount = Math.max(0, this.flash_amount - d_beats / FLASH_BEATS);
            const f = ease(this.flash_amount);
            this.line_color.lerpColors(LINE_COLOR, FLASH_COLOR, f);
            this.fill_mat?.color.lerpColors(FILL_COLOR, FLASH_COLOR, f);
            this.brain_mat?.color.lerpColors(BRAIN_COLOR, FLASH_COLOR, f);
        }
        this.slice_offset = (this.slice_offset
            + d_beats * SLICE_SCROLL_PER_BEAT * SLICE_SPACING) % (2 * SLICE_SPACING);
        this.band_uniforms.slice_offset.value = this.slice_offset;
        if (this.contours === null) {
            return;
        }
        let strength = 0;
        if (this.scan_frac < 1) {
            this.scan_frac = Math.min(1, this.scan_frac + d_beats / SCAN_BEATS);
            // Rises with eased motion; fades over the last quarter so the
            // glow left at the top doesn't cut out.
            this.scan_height = lerp_scalar(this.contours.min_y, this.contours.max_y,
                ease(this.scan_frac));
            strength = clamp((1 - this.scan_frac) * 4, 0, 1);
        }
        this.contours.update(this.slice_offset, this.scan_height, strength);
    }
}
