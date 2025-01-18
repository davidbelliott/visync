import { VisScene } from "./vis_scene.js";
import * as THREE from "three";
import { BeatClock } from "./util.js";

class KnotSegment {
    constructor(geometry, material) {
        this.line = new THREE.Line(geometry, material);
        this.initialPoints = geometry.attributes.position.array.slice();
        this.baseZ = 0;
    }

    setBaseZ(z) {
        this.baseZ = z;
        const positions = this.line.geometry.attributes.position.array;
        for (let i = 0; i < positions.length; i += 3) {
            positions[i + 2] = z;
        }
        this.line.geometry.attributes.position.needsUpdate = true;
    }
}

export class CelticKnotScene extends VisScene {
    constructor() {
        super();
        this.scene = new THREE.Scene();
        
        const width = window.innerWidth;
        const height = window.innerHeight;
        const aspect = width / height;
        this.frustum_size = 20;
        this.camera = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2,
            -1000,
            1000
        );

        this.base_group = new THREE.Group();
        this.scene.add(this.base_group);
        
        this.knot_segments = [];
        this.createWovenBorder();
        
        this.beat_clock = new BeatClock(this);
        this.animation_intensity = 0;
        this.target_intensity = 0;
    }

    createWovenSegment(startPoint, endPoint, material, isOver) {
        const geometry = new THREE.BufferGeometry().setFromPoints([startPoint, endPoint]);
        const segment = new KnotSegment(geometry, material.clone());
        segment.setBaseZ(isOver ? 0.1 : -0.1);
        this.knot_segments.push(segment);
        this.base_group.add(segment.line);
        return segment;
    }

    createWovenBorder() {
        const size = this.frustum_size * 0.45;
        const stepSize = size * 0.1; // Size of each weave step
        
        const baseMaterial = new THREE.LineBasicMaterial({
            color: 0xffffff,
            linewidth: 2,
            transparent: true,
            opacity: 0.8
        });

        // Create the four sides of the border with weaving
        const sides = [
            // Bottom: left to right
            { start: [-size, -size], end: [size, -size], steps: Math.floor(2 * size / stepSize) },
            // Right: bottom to top
            { start: [size, -size], end: [size, size], steps: Math.floor(2 * size / stepSize) },
            // Top: right to left
            { start: [size, size], end: [-size, size], steps: Math.floor(2 * size / stepSize) },
            // Left: top to bottom
            { start: [-size, size], end: [-size, -size], steps: Math.floor(2 * size / stepSize) }
        ];

        sides.forEach((side, sideIndex) => {
            const dx = (side.end[0] - side.start[0]) / side.steps;
            const dy = (side.end[1] - side.start[1]) / side.steps;
            
            // Create main horizontal/vertical line
            const mainLine = this.createWovenSegment(
                new THREE.Vector3(side.start[0], side.start[1], 0),
                new THREE.Vector3(side.end[0], side.end[1], 0),
                baseMaterial,
                true
            );

            // Create weaving segments
            for (let i = 0; i < side.steps; i++) {
                const isOver = (i % 2 === 0);
                const startX = side.start[0] + dx * i;
                const startY = side.start[1] + dy * i;
                const endX = side.start[0] + dx * (i + 1);
                const endY = side.start[1] + dy * (i + 1);

                // Create diagonal weave lines
                if (sideIndex % 2 === 0) { // Horizontal sides
                    const weaveStart = new THREE.Vector3(startX, startY - stepSize/2, 0);
                    const weaveEnd = new THREE.Vector3(endX, endY + stepSize/2, 0);
                    this.createWovenSegment(weaveStart, weaveEnd, baseMaterial, !isOver);
                } else { // Vertical sides
                    const weaveStart = new THREE.Vector3(startX - stepSize/2, startY, 0);
                    const weaveEnd = new THREE.Vector3(endX + stepSize/2, endY, 0);
                    this.createWovenSegment(weaveStart, weaveEnd, baseMaterial, !isOver);
                }
            }
        });

        // Create inner border
        const innerSize = size - stepSize * 2;
        const innerPoints = [
            new THREE.Vector3(-innerSize, -innerSize, 0),
            new THREE.Vector3(innerSize, -innerSize, 0),
            new THREE.Vector3(innerSize, innerSize, 0),
            new THREE.Vector3(-innerSize, innerSize, 0),
            new THREE.Vector3(-innerSize, -innerSize, 0)
        ];

        const innerGeometry = new THREE.BufferGeometry().setFromPoints(innerPoints);
        const innerSegment = new KnotSegment(innerGeometry, baseMaterial.clone());
        innerSegment.setBaseZ(-0.2);
        this.knot_segments.push(innerSegment);
        this.base_group.add(innerSegment.line);
    }

    anim_frame(dt) {
        const intensity_lerp = 0.1;
        this.animation_intensity += (this.target_intensity - this.animation_intensity) * intensity_lerp;
        
        const t = this.beat_clock.getElapsedTime();
        
        // Very subtle rotation
        this.base_group.rotation.z = Math.sin(t * 0.5) * 0.01;
        
        // Animate segments - modify opacity for weaving effect
        this.knot_segments.forEach((segment, i) => {
            segment.line.material.opacity = 0.4 + 
                Math.sin(t * 2 + i * 0.2) * 0.2 * this.animation_intensity;
        });

        // Very subtle scale animation
        const scale = 1 + Math.sin(t) * 0.005 * this.animation_intensity;
        this.base_group.scale.set(scale, scale, 1);
    }

    handle_beat(t, channel) {
        const delay = this.get_beat_delay(t);
        setTimeout(() => {
            if (channel === 1 || channel === 3) {
                this.beat_clock.start();
                this.target_intensity = 1;
            }
        }, delay * 1000);

        setTimeout(() => {
            this.target_intensity = 0;
        }, delay * 1000 + 200);
    }

    handle_resize(width, height) {
        const aspect = width / height;
        this.camera.left = -this.frustum_size * aspect / 2;
        this.camera.right = this.frustum_size * aspect / 2;
        this.camera.top = this.frustum_size / 2;
        this.camera.bottom = -this.frustum_size / 2;
        this.camera.updateProjectionMatrix();
    }
}
