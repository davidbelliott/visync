import * as THREE from 'three';
import { Component } from '../components/component.js';
import { rand_int } from '../util.js';

/* ───────────────── CONFIG ───────────────── */
const GRID_N  = 12;        // number of sample points per axis → GRID_N³ vectors
const SPACING = 1.5;       // distance between sample points
const SCALE   = 0.60;      // length multiplier for each vector
const VECTOR_COUNT = GRID_N*GRID_N*GRID_N;

function field1(pos) {
   const vx = -pos.x;
   const vy =  -pos.y;
   const vz =  Math.sin(pos.x*2.0);
   return new THREE.Vector3(vx, vy, vz);
}

// Returns a function f(pos: THREE.Vector3) → THREE.Vector3
// Each call to createField() produces a different field
function createField() {
    const waves = rand_int(1, 1);
  // Random wave‑vectors (k) and phases for each component
  const kx = [], ky = [], kz = [], phaseX = [], phaseY = [], phaseZ = [];
  for (let i = 0; i < waves; i++) {
    // Frequency range: 0.5 · 2π  →  2 · 2π  radians per world‑unit
    const randFreq = () => (Math.random() * 0.25) * Math.PI * 2;
    kx.push(randFreq());
    ky.push(randFreq());
    kz.push(randFreq());

    phaseX.push(Math.random() * Math.PI * 2);
    phaseY.push(Math.random() * Math.PI * 2);
    phaseZ.push(Math.random() * Math.PI * 2);
  }

  /** -------- the field function -------- */
  return function field(pos) {
    // Raw (unnormalised) vector components in [‑waves, waves]
    let vx = 0, vy = 0, vz = 0;

    for (let i = 0; i < waves; i++) {
      vx += Math.sin(kx[i] * pos.x + phaseX[i]);
      vy += Math.sin(ky[i] * pos.y + phaseY[i]);
      vz += Math.sin(kz[i] * pos.z + phaseZ[i]);
    }

    // Combine into a THREE.Vector3
    const v = new THREE.Vector3(vx, vy, vz);

    // ---------- Normalise magnitude to ≤ 1 ----------
    //   Max possible |v| is waves * sqrt(3)
    const maxLen = waves * Math.sqrt(3);
    v.multiplyScalar(1 / maxLen);  // now |v| ≤ 1

    // Optional extra modulation to vary magnitudes inside [0,1]
    // (uncomment if you want more activity near the origin)
    // const amp = 0.5 * (Math.sin(pos.length() * 1.5) + 1); // 0‑1
    // v.multiplyScalar(amp);

    return v; // components may be ±, but |v| ∈ [0,1]
  };
}

export class VectorFieldComponent extends Component {

    constructor() {
        super();
        // Current field
        this.field = createField();

        // Base geometry (unit line)
        this.base = new THREE.BufferGeometry();
        this.base.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0], 3));

        // Instance buffers
        this.starts   = new Float32Array(VECTOR_COUNT*3);
        this.ends     = new Float32Array(VECTOR_COUNT*3);
        this.opacities= new Float32Array(VECTOR_COUNT);

        /* ───────────────── BUILD INSTANCED GEOMETRY ───────────────── */
        this.instGeom = new THREE.InstancedBufferGeometry();
        this.instGeom.index         = this.base.index;
        this.instGeom.attributes    = this.base.attributes; // copy position
        this.instGeom.instanceCount = VECTOR_COUNT;
        this.instGeom.setAttribute('instanceStart',   new THREE.InstancedBufferAttribute(this.starts,3));
        this.instGeom.setAttribute('instanceEnd',     new THREE.InstancedBufferAttribute(this.ends,3));
        this.instGeom.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(this.opacities,1));

        /* ───────────────── CUSTOM SHADER MATERIAL ───────────────── */
        const material = new THREE.RawShaderMaterial({
            vertexShader:`
               precision mediump float;
               attribute vec3 position;
               attribute vec3 instanceStart;
               attribute vec3 instanceEnd;
               attribute float instanceOpacity;
               uniform mat4 modelViewMatrix;
               uniform mat4 projectionMatrix;
               varying vec3 vColor;
               varying float vOpacity;
               void main(){
                 vec3 worldPos = mix(instanceStart, instanceEnd, position.x);
                 gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos,1.0);
                 vColor = vec3(1.0-position.x, 0.0, position.x); // red→green
                 vColor = vec3(position.x > 0.5 ? 1.0 : 0.0, position.x > 0.5 ? 1.0 : 0.0, 1.0);
                 vOpacity = instanceOpacity;
               }
            `,
            fragmentShader:`
               precision mediump float;
               varying vec3 vColor;
               varying float vOpacity;
               void main(){
                 gl_FragColor = vec4(vColor, vOpacity);
               }
            `,
            transparent: true,
            depthWrite: false,
            linewidth: 1
        });

        this.base_group = new THREE.Group();
        this.add(this.base_group);

        const lines = new THREE.LineSegments(this.instGeom, material);
        this.base_group.add(lines);


        // generate field
        this.update_field_pointers();

        // Edge-only cube (each vertex is editable via geometry.attributes.position)
        //const cube_geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)); // 12 straight edges
        const cube_geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)); // 12 straight edges
        const cube_material = new THREE.LineBasicMaterial({ color: 0xffffff });
        this.cube = new THREE.LineSegments(cube_geometry, cube_material);
        this.base_group.add(this.cube)
        const p = cube_geometry.getAttribute('position');
        this.default_pos = p.array.slice();
        this.reset_cube();
    }

    reset_cube() {
        const p = this.cube.geometry.getAttribute('position');
        this.cube.geometry.setAttribute('velocity', new THREE.BufferAttribute(new Float32Array(p.count * 3).fill(0), 3));
        p.copyArray(this.default_pos);
    }

    update_field_pointers() {
        let idx=0;
        const half = (GRID_N-1)/2;
        let maxMag = 0;
        for(let i=0; i < GRID_N;++i) {
            for(let j=0; j < GRID_N;++j) {
                for(let k=0;k < GRID_N;++k) {
                    const x = (i-half)*SPACING;
                    const y = (j-half)*SPACING;
                    const z = (k-half)*SPACING;

                   // ---- VECTOR FIELD DEFINITION ----
                   // Example: simple curl‑like field

                    const v = this.field(new THREE.Vector3(x, y, z));
                    const mag = v.length();
                    maxMag = Math.max(maxMag, mag);
                    const midpoint = new THREE.Vector3(x,y,z);

                    const start = midpoint.clone().addScaledVector(v.normalize(), -SCALE / 2);
                    const end   = midpoint.clone().addScaledVector(v.normalize(), SCALE / 2);

                    this.starts.set([start.x,start.y,start.z], idx*3);
                    this.ends.set([end.x,end.y,end.z],       idx*3);
                    this.opacities[idx] = mag;  // store raw for now, normalise later
                    idx++;
                }
            }
        }

        // normalise opacities 0→1
        for(let i=0;i<VECTOR_COUNT;++i){
            this.opacities[i] = THREE.MathUtils.clamp(this.opacities[i]/maxMag, 0.05, 1);
        }

        this.instGeom.getAttribute('instanceStart').needsUpdate = true;
        this.instGeom.getAttribute('instanceEnd').needsUpdate = true;
        this.instGeom.getAttribute('instanceOpacity').needsUpdate = true;

    }

    anim_frame(dt) {
        this.base_group.rotation.z += 0.05 * dt;
        let g = this.cube.geometry;
        let p = g.getAttribute('position');
        let v = g.getAttribute('velocity');
        for (let i = 0; i<p.count; i++) { 
            let pos = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
            let vel = new THREE.Vector3(v.getX(i), v.getY(i), v.getZ(i));
            let accel = this.field(pos).multiplyScalar(dt);
            vel.add(accel);
            pos.add(vel);
            v.setXYZ(i, vel.x, vel.y, vel.z);
            p.setXYZ(i, pos.x, pos.y, pos.z);
        }
        p.needsUpdate = true;
    }

    handle_beat(latency, channel) {
        const delay = this.parent ? this.parent.get_beat_delay(latency) : 0;
        setTimeout(() => {
            if (channel == 1) {
                this.reset_cube();
            } else if (channel == 2 || channel == 4) {
                // TODO
            }
        }, delay * 1000);
    }

    handle_sync(latency, sync_rate_hz, sync_idx) {
        if (sync_idx % 16 == 0) {
                this.field = createField();
                this.update_field_pointers();
        }
    }
}
