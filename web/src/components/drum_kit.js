import * as THREE from 'three';
import { Component } from '../components/component.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ShaderLoader } from '../util.js';


// Base class for all drum pieces
class DrumPiece extends THREE.Object3D {
    constructor(material) {
        super();
        this.material = material;
        this.hit_time = null;
    }

    hit() {
        this.hit_time = 0;
    }

    anim_frame(dt) {
        if (this.hit_time === null) return;
        // Animation logic will be implemented later
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
    }
}


class BassDrum extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['bass-drum']);
        this.addPart('beater', geometries['bass-drum-beater']);
    }
}


class FloorTom extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['floor-tom']);
        this.addPart('stand', geometries['floor-tom-stand']);
        this.addPart('beater', geometries['floor-tom-beater']);
    }
}


class LowTom extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['low-tom']);
        this.addPart('beater', geometries['low-tom-beater']);
    }
}


class MidTom extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('drum', geometries['mid-tom']);
        this.addPart('beater', geometries['mid-tom-beater']);
    }
}


class HiHat extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('top', geometries['hat-top']);
        this.addPart('bottom', geometries['hat-bottom']);
        this.addPart('stand', geometries['hat-stand']);
        this.addPart('beater', geometries['hat-beater']);
    }
}


class Crash extends DrumPiece {
    constructor(material, geometries) {
        super(material);
        this.addPart('cymbal', geometries['crash-top']);
        this.addPart('stand', geometries['crash-stand']);
        this.addPart('beater', geometries['crash-beater']);
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
    }

    handle_sync(latency, sync_rate_hz, sync_idx) {
        super.handle_sync(latency, sync_rate_hz, sync_idx);
    }
}
