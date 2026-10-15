import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ease, ShaderLoader } from '../util.js';

// David's head (a scan, stl/david_head.stl: Y up, face towards +z, ~28 units
// tall; cleaned and decimated from models/david_head.stl by
// scripts/clean_head_mesh.py), drawn as a plain lit, dithered fill that
// flashes white on demand (flash). Its underside sits on the group's origin,
// centred over it; `height` (world units) is set once the model loads, and
// nothing draws until then.
//
// The scan's face is turned ~5.5 deg off +z; this yaw (rad, about Y) squares
// it up, found as the rotation making the face most mirror-symmetric.
const MODEL_YAW = THREE.MathUtils.degToRad(-5.5);
// The fill: lit and dithered, cyan, mid-bright so its shading reads.
const FILL_COLOR = new THREE.Color(0.0, 0.6, 0.6);
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
            // Face it squarely down +z, centred over the origin, underside on it.
            geom.rotateY(MODEL_YAW);
            geom.computeBoundingBox();
            const box = geom.boundingBox;
            this.height = (box.max.y - box.min.y) * scale;
            geom.translate(-(box.min.x + box.max.x) / 2, -box.min.y,
                -(box.min.z + box.max.z) / 2);
            const fill_mat = this.fill_mat = new THREE.MeshLambertMaterial({
                color: FILL_COLOR,
            });
            fill_mat.onBeforeCompile = (shader) => {
                shader.uniforms.face_light_dir = { value: FACE_LIGHT_DIR };
                shader.uniforms.face_light_gain = { value: FACE_LIGHT_GAIN };
                shader.uniforms.ambient_gain = { value: AMBIENT_GAIN };
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'uniform vec3 face_light_dir;\nvarying vec3 v_face_light_dir;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nv_face_light_dir = normalMatrix * face_light_dir;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    'void main() {',
                    'uniform float face_light_gain;\nuniform float ambient_gain;\n' +
                    'varying vec3 v_face_light_dir;\nvoid main() {'
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
