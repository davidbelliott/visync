"use strict";
import * as THREE from 'three';
import {
    ShaderLoader
} from './util.js';

// Rotates v by unit quaternion q, using the same (counter-clockwise) sign
// convention as THREE.Quaternion. A zeroed q (a freshly allocated buffer)
// also acts as the identity, so uninitialized instances are safe.
const QUAT_ROTATE_GLSL = [
    "vec3 quat_rotate(vec4 q, vec3 v) {",
    "    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);",
    "}"
].join("\n");


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
    "attribute vec4 instanceQuaternion;",
    "",
    "varying vec4 vColor;",
    "",
    QUAT_ROTATE_GLSL,
    "",
    "void main() {",
    "    vec3 transformed = quat_rotate(instanceQuaternion, position * instanceScale) + instanceOffset;",
    "    gl_Position = projectionMatrix * modelViewMatrix * vec4( transformed, 1.0 );",
    "    vColor = instanceColor;",
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
        transparent: true,
        depthWrite: false,
        depthTest: true
    });

    return mat;
}


function create_fill_mat(transparent=false) {

    var vertexShaderPars = [
        "attribute vec3 instanceOffset;",
        "attribute vec4 instanceColor;",
        "attribute vec3 instanceScale;",
        "attribute vec4 instanceQuaternion;",
        "varying vec4 vInstanceColor;",
        QUAT_ROTATE_GLSL,
    ].join("\n");

    // The instance rotation must also spin the lighting normals. The scale
    // is deliberately not folded in: a non-uniform scale would need an
    // inverse-transpose, and skipping it keeps zero scales (used by scenes
    // to hide instances) from producing NaN normals.
    var vertexShaderNormal = [
        "#include <beginnormal_vertex>",
        "objectNormal = quat_rotate(instanceQuaternion, objectNormal);",
    ].join("\n");

    var vertexShaderProject = [
        "vec3 inst_transformed = quat_rotate(instanceQuaternion, transformed * instanceScale) + instanceOffset;",
        "vec4 mvPosition = modelViewMatrix * vec4( inst_transformed, 1.0 );",
        "gl_Position = projectionMatrix * mvPosition;",
        "vInstanceColor = instanceColor;",
    ].join("\n");

    const shader_loader = new ShaderLoader('glsl/chunks/dither_pars.frag',
        'glsl/chunks/dither.frag');
    const shader_load_promise = shader_loader.load();

    return shader_load_promise.then(([dither_pars, dither]) => {
        const fill_mat = new THREE.MeshLambertMaterial({
            vertexColors: true,
            color: 'white',
            polygonOffset: true,
            polygonOffsetFactor: 1, // positive value pushes polygon further away
            polygonOffsetUnits: 1,
            transparent: transparent
        });
        fill_mat.flatShading = false;

        fill_mat.onBeforeCompile = (shader) => {
            shader.fragmentShader =
                shader.fragmentShader.replace(
                    '#include <color_pars_fragment>',
                    '#include <color_pars_fragment>\nvarying vec4 vInstanceColor;'
                ).replace(
                    '#include <color_fragment>',
                    'diffuseColor *= vInstanceColor;'
                ).replace(
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
                    '#include <beginnormal_vertex>',
                    vertexShaderNormal
                ).replace(
                    '#include <project_vertex>',
                    vertexShaderProject
                );
        };

        return fill_mat;
    });
}


// A batch of identical geometries drawn in a single call, with per-instance
// position, scale, rotation (a quaternion), and RGBA color. Alpha only
// blends for the line draw types and, when transparent_fill is set, for
// Triangles; an opaque (default) triangle fill ignores instance alpha.
// Valid types: Lines, LineStrip, Triangles
export class InstancedGeometryCollection {
    constructor(scene, templateGeometry, draw_type='Lines', maxInstances=1024,
                transparent_fill=false) {
        this.scene = scene;
        this.maxInstances = maxInstances;
        this.draw_type = draw_type;

        // Creating an instanced geometry based on the template
        this.instancedGeometry = new THREE.InstancedBufferGeometry().copy(templateGeometry);
        this.instancedGeometry.instanceCount = 0;

        // An auto-computed bounding sphere would cover only the template, not
        // the instance offsets (hence frustumCulled = false below), and its
        // template-dependent center feeds the renderer's transparent z-sort —
        // sibling collections would swap draw order as the camera moves. Pin
        // it to the origin so collections under one parent sort as equal and
        // draw in creation order.
        this.instancedGeometry.boundingSphere =
            new THREE.Sphere(new THREE.Vector3(0, 0, 0), Infinity);


        // Pre-allocating position, color, scale, and rotation attributes
        this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 3), 3);
        this.quaternions = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 4), 4);
        this.colors = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 4), 4);
        this.scales = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 3), 3);

        this.instancedGeometry.setAttribute('instanceOffset', this.offsets);
        this.instancedGeometry.setAttribute('instanceColor', this.colors);
        this.instancedGeometry.setAttribute('instanceScale', this.scales);
        this.instancedGeometry.setAttribute('instanceQuaternion', this.quaternions);

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
            create_fill_mat(transparent_fill).then((mat) => {
                this.mat = mat;
                this.mesh = new THREE.Mesh(this.instancedGeometry, this.mat);
                this.mesh.frustumCulled = false;
                this.scene.add(this.mesh);
            });
        } else {
            console.error(`Unrecognized draw type: ${this.draw_type}`);
            return;
        }
    }

    // quat is a THREE.Quaternion, or null for the identity orientation.
    create_geom(pos, color, scale, quat=null, alpha=1) {
        if (this.instancedGeometry.instanceCount >= this.maxInstances) {
            console.error('Max instances reached');
            return -1;
        }

        this.set_pos(this.instancedGeometry.instanceCount, pos);
        this.set_color(this.instancedGeometry.instanceCount, color, alpha);
        this.set_scale(this.instancedGeometry.instanceCount, scale);
        this.set_quaternion(this.instancedGeometry.instanceCount, quat);

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

    set_color(idx, color, alpha=1.0) {
        this.colors.setXYZW(idx, color.r, color.g, color.b, alpha);
        this.colors.needsUpdate = true;
    }

    set_scale(idx, scale) {
        this.scales.setXYZ(idx, scale.x, scale.y, scale.z);
        this.scales.needsUpdate = true;
    }

    set_quaternion(idx, quat) {
        if (quat == null) {
            this.quaternions.setXYZW(idx, 0, 0, 0, 1);
        } else {
            this.quaternions.setXYZW(idx, quat.x, quat.y, quat.z, quat.w);
        }
        this.quaternions.needsUpdate = true;
    }

    // Convenience for planar scenes: counter-clockwise rotation about +Z,
    // written straight into the buffer so hot loops need no Quaternion.
    set_rotation_z(idx, angle) {
        this.quaternions.setXYZW(idx, 0, 0, Math.sin(angle / 2), Math.cos(angle / 2));
        this.quaternions.needsUpdate = true;
    }

    // For callers that rebuild the whole batch every update instead of
    // managing persistent instances: write attributes for indices
    // [0, count) with the set_* methods, then truncate the draw count here.
    set_num_instances(count) {
        this.instancedGeometry.instanceCount = count;
    }
}
