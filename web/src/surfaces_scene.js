import { VisScene } from "./vis_scene.js";
import * as THREE from "three";
import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import {
    create_instanced_cube,
    make_wireframe_special,
    make_point_cloud,
    clamp,
} from "./util.js";

function radial_wave(u, v, target, t) {
    const r = 50;
    
    const x = r * (u - 0.5);//Math.sin(u) * r;
    const z = r * (v - 0.5);//Math.sin(v / 2) * 2 * r;
    const y = (Math.sin(u * 4 * Math.PI - 0.1 * t) + Math.cos(v * 3 * Math.PI - 0.05 * t)) * 2.8;
    
    target.set(x, y, z);
}


export class SurfacesScene extends VisScene {
    constructor(context) {
        super(context, 'surfaces');
        this.scene = new THREE.Scene();
        this.cam_persp = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 4000);
        this.cam_persp.position.set(0, 0, 100);
        this.camera = this.cam_persp;
        this.base_group = new THREE.Group();
        this.beat_clock = new THREE.Clock();

        const radialWave = function(u, v, target) {
            radial_wave(u, v, target, 0);
        };


        const cube = create_instanced_cube([1, 1, 1], "white");
        //this.base_group.add(cube);

        this.geom = new ParametricGeometry(radialWave, 32, 32);
        //const geom = new THREE.ParametricGeometry( THREE.ParametricGeometries.klein, 25, 25 );
        this.meshes = [];
        for (let i = 0; i < 20; i++) {
            const meshMaterial = new THREE.MeshPhongMaterial({
                color: "magenta",
                shininess: 70,
                specular: 0xffffff,
                flatShading: true,
                transparent: true,
                opacity: (1 - i / 20) ** 2,
            });
            meshMaterial.side = THREE.DoubleSide;
            const mesh = new THREE.Mesh(this.geom, meshMaterial);
            mesh.position.y = 10 -i * 4;
            this.meshes.push(mesh);
            this.base_group.add(mesh);
        }
        this.base_group.rotation.x = Math.PI / 4;
        //this.scene.add(mesh);

        this.amblight = new THREE.AmbientLight("blue", 0.2);
        this.scene.add(this.amblight);

        this.light = new THREE.PointLight(0xffffff, 10, 0, 0.75);
        this.light.position.set(0, 40, 10);
        this.light.castShadow = true;
        this.scene.add(this.light);

        this.scene.add(this.base_group);

        this.rot_vec = new THREE.Vector3(0.01, 0.01, 0.01);
    }

    anim_frame(dt) {
        const rot_change = this.rot_vec.clone();
        rot_change.multiplyScalar(dt);
        this.base_group.rotation.x += rot_change.x;
        this.base_group.rotation.y += rot_change.y;
        this.base_group.rotation.z += rot_change.z;
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

        const beat_time = this.beat_clock.getElapsedTime() * 2;
        const num_meshes_visible = clamp((1 - beat_time) * 20, 1, 20);
        for (let i = 0; i < this.meshes.length; i++) {
            this.meshes[i].visible = i < num_meshes_visible;
        }
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay(t);
        setTimeout(() => {
            if (channel == 2) {
                this.beat_clock.start();
                this.rot_vec.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
                this.rot_vec.normalize();
            }
        }, delay * 1000);
    }

    render(renderer) {
        const is_shadow_enabled = renderer.shadowMap.enabled;
        renderer.shadowMap.enabled = true;
        renderer.render(this.scene, this.camera);
        renderer.shadowMap.enabled = is_shadow_enabled;
    }
}
