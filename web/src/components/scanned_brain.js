import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ContourScan } from './contour_scan.js';
import { lerp_scalar, ease, clamp, ShaderLoader } from '../util.js';

// The brain drawn as a scan: cyan contour lines (ContourScan) scrolling up
// over a lit, dithered fill cut into alternating bands, and a scan contour
// that sweeps up on demand (start_scan, e.g. each kick), and a white flash on
// demand (flash). Its underside sits
// on the group's origin; `height` (world units) is set once the model loads,
// and nothing draws until then.
//
// Contour spacing, model units: the brain is ~160 tall, so ~18 slices. They
// scroll up this many slices per beat. A scan sweeps up over SCAN_BEATS,
// lighting the contours below it over SCAN_TRAIL model units. Contours on
// faces turned away from the viewer are BACK_GAIN as bright (with the fill
// in front, only visible at the silhouette).
const SLICE_SPACING = 9;
const SLICE_SCROLL_PER_BEAT = 0.25;
const SCAN_BEATS = 1;
const SCAN_TRAIL = 30;
const BACK_GAIN = 0.35;
const LINE_COLOR = new THREE.Color('cyan');
const SCAN_COLOR = new THREE.Color('white');
// The fill under the contours: lit and dithered, dark enough that the
// contours stay the brightest thing on it.
const FILL_COLOR = new THREE.Color(0.0, 0.25, 0.25);
// flash() turns contours and fill this colour, fading back over FLASH_BEATS.
const FLASH_COLOR = new THREE.Color('white');
const FLASH_BEATS = 0.5;

export class ScannedBrain extends THREE.Group {
    // scale: world units per model unit.
    constructor(scale) {
        super();
        this.contours = null;       // ContourScan, once loaded
        this.height = 0;            // world units, once loaded
        // Model units the contours have scrolled up, wrapping every two
        // bands so the solid/empty bands never swap at the wrap.
        this.slice_offset = 0;
        this.fill_uniforms = {
            slice_offset: { value: 0 },
            slice_spacing: { value: SLICE_SPACING },
        };
        this.scan_frac = 1;         // through the running scan, 0..1; 1 = none
        this.scan_height = 0;       // model units
        this.flash_amount = 0;      // 1 at a flash, fading to 0
        // The live colours, lerped towards FLASH_COLOR by flash_amount.
        this.line_color = LINE_COLOR.clone();
        this.fill_mat = null;       // once loaded

        Promise.all([
            new ShaderLoader('glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag').load(),
            new STLLoader().loadAsync('stl/brain.stl'),
        ]).then(([[dither_pars, dither], geom]) => {
            // Fill behind the contours, hiding the far side's, in every other
            // band between them: a stack of open rings, its inside showing
            // (double-sided) through the gaps, shaded through the house
            // dither. Pushed back so the near contours, which lie exactly on
            // its surface, pass the depth test.
            const fill_mat = this.fill_mat = new THREE.MeshLambertMaterial({
                color: FILL_COLOR,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: 1,
                polygonOffsetUnits: 1,
            });
            fill_mat.onBeforeCompile = (shader) => {
                Object.assign(shader.uniforms, this.fill_uniforms);
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'varying float v_height;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nv_height = position.y;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                ).replace(
                    'void main() {',
                    'uniform float slice_offset;\nuniform float slice_spacing;\n' +
                    'varying float v_height;\nvoid main() {\n' +
                    'if (mod(floor((v_height - slice_offset) / slice_spacing), 2.0) > 0.5) discard;'
                );
            };
            const fill = new THREE.Mesh(geom, fill_mat);

            this.contours = new ContourScan(geom, {
                spacing: SLICE_SPACING,
                line_color: this.line_color,
                scan_color: SCAN_COLOR,
                back_gain: BACK_GAIN,
                trail: SCAN_TRAIL,
            });
            for (const obj of [fill, this.contours]) {
                obj.scale.setScalar(scale);
                obj.position.y = -this.contours.min_y * scale;
                this.add(obj);
            }
            this.height = (this.contours.max_y - this.contours.min_y) * scale;
        });
    }

    // Sweep a scan contour up the brain, restarting any still running.
    start_scan() {
        this.scan_frac = 0;
    }

    // Turn the whole brain white, fading back over FLASH_BEATS.
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
        }
        this.slice_offset = (this.slice_offset
            + d_beats * SLICE_SCROLL_PER_BEAT * SLICE_SPACING) % (2 * SLICE_SPACING);
        this.fill_uniforms.slice_offset.value = this.slice_offset;
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
