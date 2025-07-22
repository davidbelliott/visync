import * as THREE from 'three';
import { Component } from '../components/component.js';
import { rand_int } from '../util.js';

/* ───────────────── CONFIG ───────────────── */
const GRID_N  = 12;        // number of sample points per axis → GRID_N³ vectors
const SPACING = 1.5;       // distance between sample points
const SCALE   = 0.60;      // length multiplier for each vector
const VECTOR_COUNT = GRID_N*GRID_N*GRID_N;
const TRACER_INTERVAL  = 0.01;   // s between drops
const TRACER_LIFETIME  = 0.30;   // s until fully transparent
const TRACER_MAX_COUNT = Math.ceil(TRACER_LIFETIME / TRACER_INTERVAL) + 2; // safe head‑room
const TRACER_EDGE_COUNT = 12;   // EdgesGeometry → 12 line segments
const TRACER_INSTANCES  = TRACER_MAX_COUNT * TRACER_EDGE_COUNT;

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
            linewidth: 1,
        });

        this.base_group = new THREE.Group();
        this.add(this.base_group);

        const lines = new THREE.LineSegments(this.instGeom, material);
        lines.renderOrder = 0;
        this.base_group.add(lines);


        // generate field
        this.update_field_pointers();

        // Edge-only cube (each vertex is editable via geometry.attributes.position)
        //const cube_geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)); // 12 straight edges
        const cube_geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)); // 12 straight edges
        const cube_material = new THREE.LineBasicMaterial({
            color: 0xffffff,
            depthTest: false,
        });
        this.cube = new THREE.LineSegments(cube_geometry, cube_material);
        this.cube.renderOrder = 2;
        this.base_group.add(this.cube)
        const p = cube_geometry.getAttribute('position');
        this.default_pos = p.array.slice();
        this.reset_cube();

        this.elapsedTime      = 0;        // global clock (s)
        this.tracerTimer      = 0;        // time since last drop (s)
        this.nextTracer       = 0;        // ring‑buffer index [0, TRACER_MAX_COUNT)
        this.tracerBirth      = new Float32Array(TRACER_MAX_COUNT);

        /* ---------- build instanced geometry for tracers ---------- */
        this.tracerStarts     = new Float32Array(TRACER_INSTANCES * 3);
        this.tracerEnds       = new Float32Array(TRACER_INSTANCES * 3);
        this.tracerOpacities  = new Float32Array(TRACER_INSTANCES);

        this.tracerGeom = new THREE.InstancedBufferGeometry();
        this.tracerGeom.index      = this.base.index;       // reuse 1‑unit line index
        this.tracerGeom.attributes = this.base.attributes;  // reuse positions
        this.tracerGeom.instanceCount = TRACER_INSTANCES;
        this.tracerGeom.setAttribute('tracerStart',
              new THREE.InstancedBufferAttribute(this.tracerStarts, 3));
        this.tracerGeom.setAttribute('tracerEnd',
              new THREE.InstancedBufferAttribute(this.tracerEnds, 3));
        this.tracerGeom.setAttribute('tracerOpacity',
              new THREE.InstancedBufferAttribute(this.tracerOpacities, 1));

        const tracerMat = new THREE.RawShaderMaterial({
          vertexShader: `
             precision mediump float;
             attribute vec3 position;
             attribute vec3 tracerStart;
             attribute vec3 tracerEnd;
             attribute float tracerOpacity;
             uniform mat4 modelViewMatrix;
             uniform mat4 projectionMatrix;
             varying float vOpacity;
             void main(){
               vec3 worldPos = mix(tracerStart, tracerEnd, position.x);
               gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos,1.0);
               vOpacity = tracerOpacity;
             }`,
          fragmentShader: `
             precision mediump float;
             varying float vOpacity;
             void main(){ gl_FragColor = vec4(vec3(1.0), vOpacity); }`,
          transparent: true,
          depthTest: false,
          linewidth: 1,
          renderOrder: 98
        });

        this.tracerLines = new THREE.LineSegments(this.tracerGeom, tracerMat);
        this.tracerLines.renderOrder = 1;
        this.add(this.tracerLines);          // NOT inside base_group → stays static
    }

createTracer() {
    /* ── make sure matrices are current ── */
    this.base_group.updateMatrixWorld(true);  // includes its latest rotation
    this.updateMatrixWorld(true);             // in case the component moved

    const posAttr   = this.cube.geometry.getAttribute('position');
    const toWorld   = this.cube.matrixWorld;                    // cube → world
    const toLocal   = new THREE.Matrix4().copy(this.matrixWorld).invert(); // world → component‑local

    const tIdx = this.nextTracer;
    const base = tIdx * TRACER_EDGE_COUNT;

    for (let e = 0; e < TRACER_EDGE_COUNT; ++e){
        const i0 = e*2, i1 = i0+1;

        /* cube‑local → world → component‑local  (one clone per vertex) */
        const start = new THREE.Vector3(
            posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0))
            .applyMatrix4(toWorld)
            .applyMatrix4(toLocal);

        const end = new THREE.Vector3(
            posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1))
            .applyMatrix4(toWorld)
            .applyMatrix4(toLocal);

        this.tracerStarts.set([start.x, start.y, start.z], (base+e)*3);
        this.tracerEnds  .set([end.x,   end.y,   end.z  ], (base+e)*3);
        this.tracerOpacities[base + e] = 1.0;
    }

    /* flag for upload */
    this.tracerGeom.attributes.tracerStart.needsUpdate   = true;
    this.tracerGeom.attributes.tracerEnd.needsUpdate     = true;
    this.tracerGeom.attributes.tracerOpacity.needsUpdate = true;

    /* ring‑buffer bookkeeping */
    this.tracerBirth[tIdx] = this.elapsedTime;
    this.nextTracer = (this.nextTracer + 1) % TRACER_MAX_COUNT;
}

    updateTracers(dt){
        /* fade everything in one tight loop */
        for (let t = 0; t < TRACER_MAX_COUNT; ++t){
            const age   = this.elapsedTime - this.tracerBirth[t];
            const alpha = THREE.MathUtils.clamp(1.0 - age/TRACER_LIFETIME, 0, 1);
            const base  = t * TRACER_EDGE_COUNT;
            for (let e = 0; e < TRACER_EDGE_COUNT; ++e){
                this.tracerOpacities[base + e] = alpha;
            }
        }
        this.tracerGeom.attributes.tracerOpacity.needsUpdate = true;
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

        /* --- tracer bookkeeping --- */
        this.elapsedTime += dt;
        this.tracerTimer += dt;

        if (this.tracerTimer >= TRACER_INTERVAL){
            this.createTracer();
            this.tracerTimer -= TRACER_INTERVAL;
        }
        this.updateTracers(dt);
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
