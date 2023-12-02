"use strict";
import * as THREE from 'three';




export class InstancedGeometryCollection {
    constructor(scene, templateGeometry, linesegments=true, maxInstances=1024) {
        this.scene = scene;
        this.maxInstances = maxInstances;

        // Creating an instanced geometry based on the template
        this.instancedGeometry = new THREE.InstancedBufferGeometry().copy(templateGeometry);
        this.instancedGeometry.instanceCount = 0;


        // Pre-allocating position, color, and scale attributes
        this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 3), 3);
        this.rotations = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 1), 1);
        this.colors = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 4), 4);
        this.scales = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 3), 3);

        this.instancedGeometry.setAttribute('instanceOffset', this.offsets);
        this.instancedGeometry.setAttribute('instanceColor', this.colors);
        this.instancedGeometry.setAttribute('instanceScale', this.scales);
        this.instancedGeometry.setAttribute('instanceRotation', this.rotations);


        /*const shader_transform = function(shader) {
            shader.vertexShader = `
                #define USE_INSTANCING_COLOR
                attribute vec4 instanceColor;
                attribute vec3 instanceOffset;
                attribute vec3 instanceScale;
                ${shader.vertexShader}
            `.replace(
                `#include <begin_vertex>`,
                `#include <begin_vertex>
                transformed *= instanceScale;
                transformed += instanceOffset;`)
            .replace(
                `#include <color_pars_vertex>`,
                `varying vec4 vColor;`)
            .replace(
                `#include <color_vertex>`,
                `vColor = vec4( 1.0 );
                //vColor.rgba *= instanceColor.rgba;`);
            /*shader.fragmentShader = `
                        #define USE_COLOR_ALPHA
                        varying vec4 instanceColor;
                        ${shader.fragmentShader}
                    `.replace(
                        `#include <dithering_fragment>`,
                        `if (instanceColor.a == 0.0) discard;
                        #include <dithering_fragment>`
                    );*/
            /*shader.fragmentShader = `
            #define USE_COLOR_ALPHA
            ${shader.fragmentShader}`
        };*/

        /*if (wireframe) {
            this.mat = new THREE.LineBasicMaterial({
                color: "#ffffff",
                onBeforeCompile: shader_transform});
        } else {
            this.mat = new THREE.MeshBasicMaterial({
                color: "#ffffff",
                transparent: true,
                onBeforeCompile: shader_transform});
        }*/

        //this.mat = new THREE.LineBasicMaterial({color: "white"});

        var vertexShader = [
        "precision highp float;",
        "",
        "uniform mat4 modelViewMatrix;",
        "uniform mat4 projectionMatrix;",
        "",
        "attribute vec3 position;",
        "attribute vec3 instanceOffset;",
        "attribute vec4 instanceColor;",
        "attribute vec3 instanceScale;",
        "attribute float instanceRotation;",
        "",
        "varying vec4 vColor;",
        "",
        "void main() {",
        "",
           "",
        "mat4 worldPosTrans = mat4( ",
            "vec4( instanceScale.x * cos(instanceRotation), instanceScale.x * -sin(instanceRotation), 0.0,     0.0), ",
            "vec4( instanceScale.y * sin(instanceRotation), instanceScale.y *  cos(instanceRotation), 0.0,     0.0),",
            "vec4( 0.0,                    0.0,                     instanceScale.z, 0.0),",
            "vec4( instanceOffset.xyz,                                          1.0)",
        ");",
        "	gl_Position = projectionMatrix * modelViewMatrix * worldPosTrans * vec4( position, 1.0 );",
        "       vColor = instanceColor;",
        "",
        "}"
        ].join("\n");
        var fragmentShader = [
        "precision highp float;",
        "",
        "varying vec4 vColor;",
        "",
        "void main() {",
        "",
        "	gl_FragColor = vColor;",
        "",
        "}"
        ].join("\n");

        var mat = new THREE.RawShaderMaterial({
            uniforms: {},
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            side: THREE.DoubleSide,
            transparent: false
        });

        if (linesegments) {
            this.mesh = new THREE.LineSegments(this.instancedGeometry, mat);
        } else {
            this.mesh = new THREE.Line(this.instancedGeometry, mat);
        }
        this.mesh.frustumCulled = false;
        this.scene.add(this.mesh);
    }

    create_geom(pos, color, scale, rotation=0) {
        if (this.instancedGeometry.instanceCount >= this.maxInstances) {
            console.error('Max instances reached');
            return -1;
        }

        this.set_pos(this.instancedGeometry.instanceCount, pos);
        this.set_color(this.instancedGeometry.instanceCount, color);
        this.set_scale(this.instancedGeometry.instanceCount, scale);
        this.set_rotation(this.instancedGeometry.instanceCount, rotation);

        return this.instancedGeometry.instanceCount++;
    }

    get_pos(idx) {
        const arr = [];
        for (let i = 0; i < 3; i++) {
            arr.push(this.offsets.getComponent(idx, i));
        }
        return new THREE.Vector3(...arr);
    }

    set_pos(idx, pos) {
        this.offsets.setXYZ(idx, pos.x, pos.y, pos.z);
        this.offsets.needsUpdate = true;
    }

    set_color(idx, color) {
        this.colors.setXYZW(idx, color.r, color.g, color.b, color.a);
        this.colors.needsUpdate = true;
    }

    set_scale(idx, scale) {
        this.scales.setXYZ(idx, scale.x, scale.y, scale.z);
        this.scales.needsUpdate = true;
    }

    set_rotation(idx, rotation) {
        this.rotations.setComponent(idx, 0, rotation);
        this.rotations.needsUpdate = true;
    }
}
