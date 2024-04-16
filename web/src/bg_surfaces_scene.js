import { VisScene } from "./vis_scene.js";
import * as THREE from "three";
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import {
    create_instanced_cube,
    make_wireframe_special,
    make_point_cloud,
    ShaderLoader
} from "./util.js";

function radial_wave(u, v, target, t) {
    const r = 50;
    
    const x = r * (u - 0.5);//Math.sin(u) * r;
    const z = r * (v - 0.5);//Math.sin(v / 2) * 2 * r;
    const y = (Math.sin(u * 4 * Math.PI - 0.1 * t) + Math.cos(v * 3 * Math.PI - 0.05 * t)) * 2.8;
    
    target.set(x, y, z);
}


export class BackgroundSurfacesScene extends VisScene {
    constructor() {
        super();
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
        this.cam_persp.position.set(0, 0, 200);
        this.camera = this.cam_persp;
        this.base_group = new THREE.Group();
        this.geoms = [];

        const radialWave = function(u, v, target) {
            radial_wave(u, v, target, 0);
        };

        const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
            'glsl/chunks/dither.frag');
        const shader_load_promise = shader_loader.load();

        shader_load_promise.then(([dither_pars, dither]) => {
            const meshMaterial = new THREE.MeshPhongMaterial({
                color: "white",
                shininess: 20,
                specular: 0xffffff,
                flatShading: false,
            });
            meshMaterial.side = THREE.DoubleSide;

            meshMaterial.onBeforeCompile = (shader) => {
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            };
            this.geom = new ParametricGeometry(radialWave, 120, 120);

            for (let i = 0; i < 3; i++) {
                const mesh = new THREE.Mesh(this.geom, meshMaterial);
                mesh.position.set(Math.random() * 100 - 50, Math.random() * 100 - 50, Math.random() * 100 - 50);
                mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
                mesh.scale.set(Math.random() * 2 + 1, Math.random() * 2 + 1, Math.random() * 2 + 1);
                this.base_group.add(mesh);
            }

            this.sphere_geom = new THREE.SphereGeometry(10, 32, 32);
            for (let i = 0; i < 5; i++) {
                const mesh = new THREE.Mesh(this.sphere_geom, meshMaterial);
                mesh.position.set(Math.random() * 100 - 50, Math.random() * 100 - 50, Math.random() * 100 - 50);
                mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
                mesh.scale.setScalar(Math.random() * 2 + 1);
                this.base_group.add(mesh);
            }

        });

        this.base_group.rotation.x = Math.PI / 4;

        this.amblight = new THREE.AmbientLight("blue", 0.7);
        this.scene.add(this.amblight);

        this.dir_light = new THREE.DirectionalLight("white", 0.2);
        this.dir_light.position.set(1, 1, 0);
        this.scene.add(this.dir_light);

        this.light = new THREE.PointLight("white", 10, 0, 1);
        //this.light.castShadow = true;
        this.scene.add(this.light);

        this.scene.add(this.base_group);
    }

    anim_frame(dt) {
        this.base_group.rotation.y += 0.2 * dt;
        //this.base_group.rotation.x += 0.04 * dt;
        //this.base_group.rotation.z += 1.0 * dt;
        // Get the current time
        var time = Date.now() * 0.01;

        if (this.geom) {
            const positionAttribute = this.geom.getAttribute( 'position' );

            let x = 0, y = 0, z = 0;

            const pos = new THREE.Vector3();
            for ( let i = 0; i < positionAttribute.count; i ++ ) {
                const u = positionAttribute.getX(i) / 50 + 0.5;
                const v = positionAttribute.getZ(i) / 50 + 0.5;
                radial_wave(u, v, pos, time);
                positionAttribute.setXYZ( i, pos.x, pos.y, pos.z );
            }

            positionAttribute.needsUpdate = true;
            this.geom.computeVertexNormals();
            this.geom.computeBoundingBox();
            this.geom.computeBoundingSphere();
        }
    }

    handle_beat(t, channel) {
    }

    render(renderer) {
        const is_shadow_enabled = renderer.shadowMap.enabled;
        renderer.shadowMap.enabled = true;
        renderer.render(this.scene, this.camera);
        renderer.shadowMap.enabled = is_shadow_enabled;
    }
}
