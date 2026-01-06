import * as THREE from 'three';
import { Component } from '../components/component.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ShaderLoader } from '../util.js';


// Animation constants
const BEATER_REST_OFFSET = 0.5;    // Distance from drum when at rest
const BEATER_RETURN_TIME = 0.5;    // Time in seconds to return to rest position
const HAT_OPEN_OFFSET = 0.25;      // Distance hat top rises when open
const HAT_OPEN_TIME = 0.15;        // Time in seconds to open the hat


// Base class for all drum pieces
class DrumPiece extends THREE.Object3D {
    constructor(material) {
        super();
        this.material = material;
        this.hit_time = null;
        this.beater_axis = 'y';  // Override to 'z' for kick drum
    }

    hit() {
        this.hit_time = 0;
    }

    // Call after adding beater to store its rest position
    initBeaterRestPosition() {
        if (this.beater) {
            this.beater_rest_position = this.beater.position.clone();
            // Set initial offset from drum
            this.beater.position[this.beater_axis] += BEATER_REST_OFFSET;
        }
    }

    anim_frame(dt) {
        if (this.hit_time === null || !this.beater) return;

        if (this.hit_time === 0) {
            // First frame after hit: instantly move to contact position
            this.beater.position[this.beater_axis] = this.beater_rest_position[this.beater_axis];
            this.hit_time += dt;
        } else {
            // Return phase: cubic ease-out from contact to rest
            const t = Math.min(this.hit_time / BEATER_RETURN_TIME, 1);
            const ease = 1 - Math.pow(1 - t, 3);  // Cubic ease-out: fast start, slow finish
            const offset = ease * BEATER_REST_OFFSET;
            this.beater.position[this.beater_axis] = this.beater_rest_position[this.beater_axis] + offset;

            if (t >= 1) {
                this.hit_time = null;
            } else {
                this.hit_time += dt;
            }
        }
    }

    // Helper to create a mesh from geometry and add it as a named part
    addPart(name, geometry) {
        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this[name] = mesh;
        this.add(mesh);
        return mesh;
    }
}


class SnareDrum extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['snare-drum']);
        this.addPart('stand', geometries['snare-drum-stand']);
        this.addPart('beater', geometries['snare-drum-beater']);
        this.initBeaterRestPosition();
    }
}


class BassDrum extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.beater_axis = 'z';  // Kick beater moves in Z axis
        this.addPart('drum', geometries['bass-drum']);
        this.addPart('beater', geometries['bass-drum-beater']);
        this.initBeaterRestPosition();
    }
}


class FloorTom extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['floor-tom']);
        this.addPart('stand', geometries['floor-tom-stand']);
        this.addPart('beater', geometries['floor-tom-beater']);
        this.initBeaterRestPosition();
    }
}


class LowTom extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['low-tom']);
        this.addPart('beater', geometries['low-tom-beater']);
        this.initBeaterRestPosition();
    }
}


class MidTom extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['mid-tom']);
        this.addPart('beater', geometries['mid-tom-beater']);
        this.initBeaterRestPosition();
    }
}


class HiHat extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('top', geometries['hat-top']);
        this.addPart('bottom', geometries['hat-bottom']);
        this.addPart('stand', geometries['hat-stand']);
        this.addPart('beater', geometries['hat-beater']);
        this.initBeaterRestPosition();

        // Hi-hat specific state
        this.top_rest_position = this.top.position.clone();
        this.hat_open_amount = 0;      // Current open offset (0 = closed, HAT_OPEN_OFFSET = fully open)
        this.opening = false;          // Whether hat is currently opening
        this.open_time = null;         // Time tracking for opening animation
    }

    hit_open() {
        // Start opening the hat, then hit
        this.opening = true;
        this.open_time = 0;
        this.hit();
    }

    hit_closed() {
        // Instantly close the hat, then hit
        this.opening = false;
        this.open_time = null;
        this.hat_open_amount = 0;
        this.top.position.y = this.top_rest_position.y;
        this.hit();
    }

    anim_frame(dt) {
        // Handle hat top opening animation
        if (this.opening && this.open_time !== null) {
            this.open_time += dt;
            const t = Math.min(this.open_time / HAT_OPEN_TIME, 1);
            this.hat_open_amount = t * HAT_OPEN_OFFSET;
            this.top.position.y = this.top_rest_position.y + this.hat_open_amount;

            if (t >= 1) {
                this.open_time = null;  // Done opening
            }
        }

        // Handle beater animation with adjusted contact position
        if (this.hit_time === null || !this.beater) return;

        if (this.hit_time === 0) {
            // First frame after hit: move to contact position (adjusted for hat open amount)
            this.beater.position[this.beater_axis] = this.beater_rest_position[this.beater_axis] + this.hat_open_amount;
            this.hit_time += dt;
        } else {
            // Return phase: cubic ease-out from contact to rest
            const t = Math.min(this.hit_time / BEATER_RETURN_TIME, 1);
            const ease = 1 - Math.pow(1 - t, 3);
            // Interpolate from contact position (with hat offset) to rest position
            const contact_pos = this.beater_rest_position[this.beater_axis] + this.hat_open_amount;
            const rest_pos = this.beater_rest_position[this.beater_axis] + BEATER_REST_OFFSET;
            this.beater.position[this.beater_axis] = contact_pos + ease * (rest_pos - contact_pos);

            if (t >= 1) {
                this.hit_time = null;
            } else {
                this.hit_time += dt;
            }
        }
    }
}


class Crash extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('cymbal', geometries['crash-top']);
        this.addPart('stand', geometries['crash-stand']);
        this.addPart('beater', geometries['crash-beater']);
        this.initBeaterRestPosition();
    }
}


export class DrumKit extends Component {
    constructor() {
        super();

        const stl_loader = new STLLoader();

        // List of all STL files to load
        const stl_files = [
            'snare-drum', 'snare-drum-stand', 'snare-drum-beater',
            'bass-drum', 'bass-drum-beater',
            'floor-tom', 'floor-tom-stand', 'floor-tom-beater',
            'low-tom', 'low-tom-beater',
            'mid-tom', 'mid-tom-beater',
            'hat-top', 'hat-bottom', 'hat-stand', 'hat-beater',
            'crash-top', 'crash-stand', 'crash-beater'
        ];

        // Create promises for all STL loads
        const stl_promises = stl_files.map(name =>
            stl_loader.loadAsync(`stl/drums/${name}.stl`).then(geometry => ({ name, geometry }))
        );

        const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = shader_loader.load();

        this.light = new THREE.DirectionalLight("blue", 3.0);
        this.light.position.set(0, 100, -100);
        this.light.castShadow = true;
        this.light.shadowCameraVisible = true;
        this.add(this.light);

        this.light2 = new THREE.PointLight("lightyellow", 20, 10, 1.5);
        this.light2.position.set(0, 2, 4);
        this.light2.castShadow = true;
        this.light2.shadowCameraVisible = true;
        this.add(this.light2);

        this.drum_color = new THREE.Color("purple");

        const makeCheckerTexture = (tiles = 8, pxPerTile = 64) => {
          const size = tiles * pxPerTile;

          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext("2d");

          for (let y = 0; y < tiles; y++) {
            for (let x = 0; x < tiles; x++) {
              ctx.fillStyle = (x + y) % 2 === 0 ? "#000" : "#fff";
              ctx.fillRect(x * pxPerTile, y * pxPerTile, pxPerTile, pxPerTile);
            }
          }

          const tex = new THREE.CanvasTexture(canvas);
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.anisotropy = 8;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          return tex;
        };

        Promise.all([Promise.all(stl_promises), shader_load_promise]).then(
            (results) => {
                const stl_results = results[0];
                const dither_pars = results[1][0];
                const dither = results[1][1];

                // Build geometry lookup object
                const geometries = {};
                for (const { name, geometry } of stl_results) {
                    geometries[name] = geometry;
                }

                this.fill_mat = new THREE.MeshPhysicalMaterial({
                    color: this.drum_color,
                    metalness: 0.5,
                    reflectivity: 0.4,
                    clearcoat: 0.2,
                    clearcoatRoughness: 0.4,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 1
                });
                this.fill_mat.flatShading = true;
                this.fill_mat.fog = true;

                const checkerTex = makeCheckerTexture(8, 64);
                this.checkerMat = new THREE.MeshStandardMaterial(
                    { map: checkerTex, roughness: 1, metalness: 0 }
                );

                for (const mat of [this.fill_mat, this.checkerMat]) {
                    mat.onBeforeCompile = (shader) => {
                        shader.fragmentShader =
                            shader.fragmentShader.replace(
                                '#include <dithering_pars_fragment>',
                                dither_pars
                            ).replace(
                                '#include <dithering_fragment>',
                                dither
                            );
                    };
                }

                // Create drum pieces
                this.snare = new SnareDrum(this.fill_mat, geometries);
                this.add(this.snare);

                this.bass = new BassDrum(this.fill_mat, geometries);
                this.add(this.bass);

                this.floor_tom = new FloorTom(this.fill_mat, geometries);
                this.add(this.floor_tom);

                this.low_tom = new LowTom(this.fill_mat, geometries);
                this.add(this.low_tom);

                this.mid_tom = new MidTom(this.fill_mat, geometries);
                this.add(this.mid_tom);

                this.hihat = new HiHat(this.fill_mat, geometries);
                this.add(this.hihat);

                this.crash = new Crash(this.fill_mat, geometries);
                this.add(this.crash);

                // Point light target at snare (central drum)
                this.light.target = this.snare;

                // Add checkered rug
                {
                    const plane = new THREE.Mesh(
                      new THREE.PlaneGeometry(8, 8),
                        this.checkerMat
                    );

                    plane.rotation.x = -Math.PI / 2;
                    plane.receiveShadow = true;
                    this.add(plane);
                }
        });
    }

    anim_frame(dt) {
        super.anim_frame(dt);
    }

    handle_beat(latency, channel) {
        super.handle_beat(latency, channel);

        // Channel to drum mapping
        // 1->kick, 2->nothing, 3->rim (not implemented), 4->snare,
        // 5->floor tom, 6->floor tom, 7->low tom, 8->mid tom,
        // 9->hihat (closed), 10->hihat (open), 11->crash, 12->cowbell (not implemented)

        // Handle hi-hat specially for open/closed
        if (channel === 9 && this.hihat) {
            this.hihat.hit_closed();
            return;
        }
        if (channel === 10 && this.hihat) {
            this.hihat.hit_open();
            return;
        }

        const channel_map = {
            1: this.bass,
            4: this.snare,
            5: this.floor_tom,
            6: this.floor_tom,
            7: this.low_tom,
            8: this.mid_tom,
            11: this.crash,
        };

        const drum = channel_map[channel];
        if (drum) {
            drum.hit();
        }
    }

    handle_sync(latency, sync_rate_hz, sync_idx) {
        super.handle_sync(latency, sync_rate_hz, sync_idx);
    }
}
