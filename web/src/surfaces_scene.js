import { VisScene } from "./vis_scene.js";
import * as THREE from "three";
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import {
    create_instanced_cube,
    make_wireframe_special,
    make_point_cloud
} from "./util.js";

function radial_wave(u, v, target, t) {
    const r = 50;
    
    const x = r * (u - 0.5);//Math.sin(u) * r;
    const z = r * (v - 0.5);//Math.sin(v / 2) * 2 * r;
    const y = (Math.sin(u * 4 * Math.PI - 0.1 * t) + Math.cos(v * 3 * Math.PI - 0.05 * t)) * 2.8;
    
    target.set(x, y, z);
}


export class SurfacesScene extends VisScene {
    constructor() {
        super();
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
        this.cam_persp.position.set(0, 0, 100);
        this.camera = this.cam_persp;
        this.base_group = new THREE.Group();

        const radialWave = function(u, v, target) {
            radial_wave(u, v, target, 0);
        };

        const meshMaterial = new THREE.MeshPhongMaterial({
            color: "magenta",
            shininess: 70,
            specular: 0xffffff,
            flatShading: true,
        });
        meshMaterial.side = THREE.DoubleSide;

        const cube = create_instanced_cube([1, 1, 1], "white");
        //this.base_group.add(cube);

        this.geom = new ParametricGeometry(radialWave, 32, 32);
        //const geom = new THREE.ParametricGeometry( THREE.ParametricGeometries.klein, 25, 25 );
        const mesh = new THREE.Mesh(this.geom, meshMaterial);
        console.log(mesh);
        this.base_group.add(mesh);
        this.base_group.rotation.x = Math.PI / 4;
        //this.scene.add(mesh);

        this.amblight = new THREE.AmbientLight("blue", 0.2);
        this.scene.add(this.amblight);

        this.light = new THREE.PointLight(0xffffff, 10, 0, 0.75);
        this.light.position.set(0, 20, 10);
        this.light.castShadow = true;
        this.scene.add(this.light);

        this.scene.add(this.base_group);
    }

    anim_frame(dt) {
        this.base_group.rotation.y += 0.2 * dt;
        //this.base_group.rotation.x += 0.04 * dt;
        //this.base_group.rotation.z += 1.0 * dt;
        // Get the current time
        var time = Date.now() * 0.05;

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

    handle_beat(t, channel) {
    }

    render(renderer) {
        const is_shadow_enabled = renderer.shadowMap.enabled;
        renderer.shadowMap.enabled = true;
        renderer.render(this.scene, this.camera);
        renderer.shadowMap.enabled = is_shadow_enabled;
    }
}
