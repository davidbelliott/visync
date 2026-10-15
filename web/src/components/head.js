import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ease, ShaderLoader } from '../util.js';

// David's head (a scan, stl/david_head.stl: Y up, face towards +z, ~28 units
// tall), drawn as a plain lit, dithered fill that flashes white on demand
// (flash). Its underside sits on the group's origin, centred over it;
// `height` (world units) is set once the model loads, and nothing draws
// until then.
//
// The fill: lit and dithered, cyan, mid-bright so its shading reads.
const FILL_COLOR = new THREE.Color(0.0, 0.6, 0.6);
// flash() turns the fill this colour, fading back over FLASH_BEATS.
const FLASH_COLOR = new THREE.Color('white');
const FLASH_BEATS = 0.5;

export class Head extends THREE.Group {
    // scale: world units per model unit. shadows: whether it casts and
    // receives shadows.
    constructor(scale, { shadows = false } = {}) {
        super();
        this.height = 0;            // world units, once loaded
        this.flash_amount = 0;      // 1 at a flash, fading to 0
        this.fill_mat = null;       // once loaded

        Promise.all([
            new ShaderLoader('glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag').load(),
            new STLLoader().loadAsync('stl/david_head.stl'),
        ]).then(([[dither_pars, dither], geom]) => {
            // Centre it over the origin, underside on it.
            geom.computeBoundingBox();
            const box = geom.boundingBox;
            this.height = (box.max.y - box.min.y) * scale;
            geom.translate(-(box.min.x + box.max.x) / 2, -box.min.y,
                -(box.min.z + box.max.z) / 2);
            const fill_mat = this.fill_mat = new THREE.MeshLambertMaterial({
                color: FILL_COLOR,
            });
            fill_mat.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            const fill = new THREE.Mesh(geom, fill_mat);
            fill.castShadow = fill.receiveShadow = shadows;
            fill.scale.setScalar(scale);
            this.add(fill);
        });
    }

    // Turn the whole head white, fading back over FLASH_BEATS.
    flash() {
        this.flash_amount = 1;
    }

    // Advance by d_beats: fade any flash.
    update(d_beats) {
        if (this.flash_amount > 0) {
            this.flash_amount = Math.max(0, this.flash_amount - d_beats / FLASH_BEATS);
            this.fill_mat?.color.lerpColors(FILL_COLOR, FLASH_COLOR, ease(this.flash_amount));
        }
    }
}
