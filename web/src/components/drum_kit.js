import * as THREE from 'three';
import { Component } from '../components/component.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ShaderLoader } from '../util.js';


export class DrumKit extends Component {
    constructor() {
        super();

        const stl_loader = new STLLoader();
        const stl_load_promise = stl_loader.loadAsync('stl/drums.stl');
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
          tex.colorSpace = THREE.SRGBColorSpace; // r152+ (safe to keep)
          tex.needsUpdate = true;
          return tex;
        };

        Promise.all([stl_load_promise, shader_load_promise]).then(
            (results) => {
                const geometry = results[0];
                const dither_pars = results[1][0];
                const dither = results[1][1];

                this.fill_mat = new THREE.MeshPhysicalMaterial({
                    color: this.drum_color,
                    metalness: 0.5,
                    reflectivity: 0.4,
                    clearcoat: 0.2,
                    clearcoatRoughness: 0.4,
                    polygonOffset: true,
                    polygonOffsetFactor: 1, // positive value pushes polygon further away
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

                // Add drum assembly
                {
                    const mesh_inner = new THREE.Mesh(geometry, this.fill_mat)
                    mesh_inner.castShadow = true;
                    mesh_inner.receiveShadow = true;
                    this.add(mesh_inner);
                    this.drums = mesh_inner;
                    this.light.target = this.drums;
                }

                // Add checkered rug
                {
                // --- plane with repeating checker pattern ---
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
