"use strict";
import * as THREE from 'three';
import {
    ShaderLoader
} from './util.js';


function create_wireframe_mat() {
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

    return mat;
}


function create_fill_mat() {
    var vertexShaderPars = [
        "attribute vec3 instanceOffset;",
        "attribute vec4 instanceColor;",
        "attribute vec3 instanceScale;",
        "attribute float instanceRotation;",
        "#define USE_INSTANCING_COLOR 1",
    ].join("\n");

    var vertexShaderProject = [
        "vec4 mvPosition = vec4( transformed, 1.0 );",
        "mat4 worldPosTrans = mat4( ",
            "vec4( instanceScale.x * cos(instanceRotation), instanceScale.x * -sin(instanceRotation), 0.0,     0.0), ",
            "vec4( instanceScale.y * sin(instanceRotation), instanceScale.y *  cos(instanceRotation), 0.0,     0.0),",
            "vec4( 0.0,                    0.0,                     instanceScale.z, 0.0),",
            "vec4( instanceOffset.xyz,                                          1.0)",
        ");",
        "mvPosition = modelViewMatrix * worldPosTrans * vec4( position, 1.0 );",
        "	gl_Position = projectionMatrix * mvPosition;",
    ].join("\n");

    const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
        'glsl/chunks/dither.frag');
    const shader_load_promise = shader_loader.load();

    return shader_load_promise.then(([dither_pars, dither]) => {
        const fill_mat = new THREE.MeshLambertMaterial({
            color: 'white',
            polygonOffset: true,
            polygonOffsetFactor: 1, // positive value pushes polygon further away
            polygonOffsetUnits: 1
        });
        fill_mat.flatShading = false;

        fill_mat.onBeforeCompile = (shader) => {
            shader.fragmentShader =
                shader.fragmentShader.replace(
                    '#include <dithering_pars_fragment>',
                    dither_pars
                ).replace(
                    '#include <dithering_fragment>',
                    dither
                );
            shader.vertexShader =
                shader.vertexShader.replace(
                    '#include <common>',
                    vertexShaderPars + '\n' +
                    '#include <common>'
                ).replace(
                    '#include <project_vertex>',
                    vertexShaderProject
                );
            debugger;
        };

        return fill_mat;
    });
}


// Valid types: Lines, LineStrip, Triangles
export class InstancedGeometryCollection {
    constructor(scene, templateGeometry, draw_type='Lines', maxInstances=1024) {
        this.scene = scene;
        this.maxInstances = maxInstances;
        this.draw_type = draw_type;

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

        if (this.draw_type == 'Lines') {
            this.mat = create_wireframe_mat();
            this.mesh = new THREE.LineSegments(this.instancedGeometry, this.mat);
            this.mesh.frustumCulled = false;
            this.scene.add(this.mesh);
        } else if (this.draw_type == 'LineStrip') {
            this.mat = create_wireframe_mat();
            this.mesh = new THREE.Line(this.instancedGeometry, this.mat);
            this.mesh.frustumCulled = false;
            this.scene.add(this.mesh);
        } else if (this.draw_type == 'Triangles') {
            create_fill_mat().then((mat) => {
                this.mat = mat;
                this.mesh = new THREE.Mesh(this.instancedGeometry, this.mat);
                this.mesh.frustumCulled = false;
                this.scene.add(this.mesh);
            });
        } else {
            console.error(`Unrecognized draw type: ${this.draw_type}`);
            debugger;
            return;
        }
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
