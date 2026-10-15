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
// Contour spacing, model units: the head is ~28 tall, so ~12 slices,
// sparser than the brain's ~18. They scroll up this many slices per beat. A
// scan sweeps up over SCAN_BEATS, lighting the contours below it over
// SCAN_TRAIL model units. Contours on faces turned away from the viewer are
// BACK_GAIN as bright (with the fill in front, only visible at the
// silhouette). Recutting the contours costs a pass over the head's ~15k
// triangles per frame.
const SLICE_SPACING = 2.3;
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
// A key light on the face alone, in the shader rather than the scene, so it
// lights nothing else (no hot spots on nearby walls): from FACE_LIGHT_DIR in
// the model's frame (in front of the face and ~30 deg above), so it turns
// with the head, adding up to FACE_LIGHT_GAIN of the fill colour (Lambert,
// unshadowed) on top of the scene's lights.
const FACE_LIGHT_DIR = new THREE.Vector3(0, 0.6, 1).normalize();
const FACE_LIGHT_GAIN = 0.25;
// A faint ambient on the head alone (likewise in the shader), adding
// AMBIENT_GAIN of the fill colour everywhere so its back, away from the
// lights, isn't pitch black.
const AMBIENT_GAIN = 0.01;
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
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'uniform vec3 face_light_dir;\nvarying vec3 v_face_light_dir;\n' +
                    'varying float v_height;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nv_face_light_dir = normalMatrix * face_light_dir;\n' +
                    'v_height = position.y;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    'void main() {',
                    'uniform float face_light_gain;\nuniform float ambient_gain;\n' +
                    'varying vec3 v_face_light_dir;\n' +
                    'uniform float slice_offset;\nuniform float slice_spacing;\n' +
                    'varying float v_height;\nvoid main() {\n' +
                    'if (mod(floor((v_height - slice_offset) / slice_spacing), 2.0) > 0.5) discard;'
                ).replace(
                    '#include <opaque_fragment>',
                    'outgoingLight += diffuseColor.rgb * face_light_gain\n' +
                    '    * max(dot(normal, normalize(v_face_light_dir)), 0.0);\n' +
                    'outgoingLight += diffuseColor.rgb * ambient_gain;\n' +
                    '#include <opaque_fragment>'
                ).replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            const fill = new THREE.Mesh(geom, fill_mat);
            fill.castShadow = fill.receiveShadow = shadows;

            this.contours = new ContourScan(geom, {
                spacing: SLICE_SPACING,
                line_color: this.line_color,
                scan_color: SCAN_COLOR,
                back_gain: BACK_GAIN,
                trail: SCAN_TRAIL,
            });
            for (const obj of [fill, this.contours]) {
                obj.scale.setScalar(scale);
                this.add(obj);
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
