import * as THREE from 'three';
import { Component } from '../components/component.js';
import { rand_int } from '../util.js';

/* ───────────────── CONFIG ───────────────── */
const GRID_N  = 12;
const SPACING = 1.5;
const SCALE   = 0.60;
const VECTOR_COUNT = GRID_N*GRID_N*GRID_N;
const POINTER_SMOOTH_TIME = 2.00; // seconds; feel free to tweak

const MAX_CUBES = 32;
const CUBE_EDGE_COUNT = 12;
const CUBE_VERT_COUNT = 24; // EdgesGeometry emits 2 vertices per edge
const CUBE_LIFETIME = 4.0;

const TRACER_INTERVAL  = 0.010;
const TRACER_LIFETIME  = 0.08;
const TRACER_MAX_COUNT = Math.ceil(TRACER_LIFETIME / TRACER_INTERVAL) + 2;
const TRACER_EDGE_COUNT = 12;   // cube has 12 edges
// ONE tracer "drop" per active cube per tick.
// Total tracer DROPS kept in the ring:
const TOTAL_TRACERS = TRACER_MAX_COUNT * MAX_CUBES;
// Total instanced LINE SEGMENTS (12 edges per tracer "drop"):
const TRACER_INSTANCES = TOTAL_TRACERS * TRACER_EDGE_COUNT;

const ACCEL_PER_UNIT_FIELD = 0.25;


function createField() {
  const waves = rand_int(1, 1);
  const kx = [], ky = [], kz = [], phaseX = [], phaseY = [], phaseZ = [];
  for (let i = 0; i < waves; i++) {
    const randFreq = () => (Math.random() * 0.25) * Math.PI * 2;
    kx.push(randFreq()); ky.push(randFreq()); kz.push(randFreq());
    phaseX.push(Math.random() * Math.PI * 2);
    phaseY.push(Math.random() * Math.PI * 2);
    phaseZ.push(Math.random() * Math.PI * 2);
  }
  return function field(pos) {
    let vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < waves; i++) {
      vx += Math.sin(kx[i] * pos.x + phaseX[i]);
      vy += Math.sin(ky[i] * pos.y + phaseY[i]);
      vz += Math.sin(kz[i] * pos.z + phaseZ[i]);
    }
    const v = new THREE.Vector3(vx, vy, vz);
    const maxLen = waves * Math.sqrt(3);
    v.multiplyScalar(1 / maxLen);
    return v;
  };
}

export class VectorFieldComponent extends Component {
  constructor() {
    super();

    this.field = createField();

    // Base geometry (unit line 0->1 on X) used by all instanced line renderers
    this.base = new THREE.BufferGeometry();
    this.base.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0], 3));

    /* ───────────────── VECTOR FIELD LINES (unchanged) ───────────────── */
    this.opacities= new Float32Array(VECTOR_COUNT);

    // Displayed endpoints (attributes use these)
    this.starts = new Float32Array(VECTOR_COUNT * 3);
    this.ends   = new Float32Array(VECTOR_COUNT * 3);

    // Tween buffers (we don't expose these to the GPU directly)
    this._ptrSrc = new Float32Array(VECTOR_COUNT * 3);
    this._ptrDst = new Float32Array(VECTOR_COUNT * 3);
    this._ptrLerpT   = 1.0;                 // 1 = not lerping
    this._ptrLerpDur = POINTER_SMOOTH_TIME; // configurable
    this._ptrInit    = false;               // first fill snaps in

    this.instGeom = new THREE.InstancedBufferGeometry();
    this.instGeom.index         = this.base.index;
    this.instGeom.attributes    = this.base.attributes;
    this.instGeom.instanceCount = VECTOR_COUNT;
    this.instGeom.setAttribute('instanceStart',   new THREE.InstancedBufferAttribute(this.starts,3));
    this.instGeom.setAttribute('instanceEnd',     new THREE.InstancedBufferAttribute(this.ends,3));
    this.instGeom.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(this.opacities,1));

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
           // (kept for posterity; overwritten below)
           vColor = vec3(1.0-position.x, 0.0, position.x); // red→green (ignored)
           // original end-cap look: white on one end, blue on the other
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

    this.update_field_pointers();

    /* ───────────────── TEMPLATE CUBE GEOMETRY (hidden) ─────────────────
       Used only to get the default vertex positions (EdgesGeometry layout). */
    const cube_geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)); // 12 edges -> 24 verts
    const cube_material = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
    this.cube = new THREE.LineSegments(cube_geometry, cube_material);
    this.cube.visible = false; // hide template
    this.base_group.add(this.cube);

    const p = cube_geometry.getAttribute('position');
    this.default_pos = p.array.slice(); // 24 * 3 floats snapshot

    /* ───── NEW: cube pool state (positions/velocities per cube) ───── */
    this.cubeActive = Array(MAX_CUBES).fill(false);
    this.cubeBirth  = new Float32Array(MAX_CUBES);
    this.cubePos    = new Float32Array(MAX_CUBES * CUBE_VERT_COUNT * 3);
    this.cubeVel    = new Float32Array(MAX_CUBES * CUBE_VERT_COUNT * 3);
    this.nextCube   = 0;
    this.lastSpawned = -1;

    /* ───── NEW: instanced renderer for all cube edges ─────
       Each instance = one edge segment of one cube. */
    this.cubeStarts    = new Float32Array(MAX_CUBES * CUBE_EDGE_COUNT * 3);
    this.cubeEnds      = new Float32Array(MAX_CUBES * CUBE_EDGE_COUNT * 3);
    this.cubeOpacities = new Float32Array(MAX_CUBES * CUBE_EDGE_COUNT).fill(1.0);

    this.cubeGeom = new THREE.InstancedBufferGeometry();
    this.cubeGeom.index      = this.base.index;
    this.cubeGeom.attributes = this.base.attributes;
    this.cubeGeom.instanceCount = MAX_CUBES * CUBE_EDGE_COUNT;
    this.cubeGeom.setAttribute('cubeStart',
      new THREE.InstancedBufferAttribute(this.cubeStarts, 3));
    this.cubeGeom.setAttribute('cubeEnd',
      new THREE.InstancedBufferAttribute(this.cubeEnds, 3));
    this.cubeGeom.setAttribute('cubeOpacity',
      new THREE.InstancedBufferAttribute(this.cubeOpacities, 1));

    const cubeMat = new THREE.RawShaderMaterial({
      vertexShader: `
        precision mediump float;
        attribute vec3 position;
        attribute vec3 cubeStart;
        attribute vec3 cubeEnd;
        attribute float cubeOpacity;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        varying float vOpacity;
        void main(){
          vec3 worldPos = mix(cubeStart, cubeEnd, position.x);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos,1.0);
          vOpacity = cubeOpacity;
        }`,
      fragmentShader: `
        precision mediump float;
        varying float vOpacity;
        void main(){ gl_FragColor = vec4(1.0,1.0,1.0,vOpacity); }`,
      transparent: true,
      depthTest: false,
      linewidth: 1
    });

    this.cubeLines = new THREE.LineSegments(this.cubeGeom, cubeMat);
    this.cubeLines.renderOrder = 2; // above field lines
    this.base_group.add(this.cubeLines);

    /* ───────────────── TRACERS (unchanged draw, slight source tweak) ───────────────── */
    this.elapsedTime      = 0;
    this.tracerTimer      = 0;
    this.nextTracer       = 0;
    this.tracerBirth      = new Float32Array(TRACER_MAX_COUNT);

// ── TRACERS ──
this.tracerStarts     = new Float32Array(TRACER_INSTANCES * 3);
this.tracerEnds       = new Float32Array(TRACER_INSTANCES * 3);
this.tracerOpacities  = new Float32Array(TRACER_INSTANCES);
// NEW: one birth time per tracer DROP (not per edge)
this.tracerBirth      = new Float32Array(TOTAL_TRACERS);
// NEW: base opacity captured at spawn (per tracer DROP)
this.tracerBaseOpacity= new Float32Array(TOTAL_TRACERS);

// Initialize so “unused” slots are safely invisible
for (let i = 0; i < TOTAL_TRACERS; i++) {
  this.tracerBirth[i] = -1.0;         // sentinel = never spawned
  this.tracerBaseOpacity[i] = 0.0;    // starts invisible
}

this.tracerGeom = new THREE.InstancedBufferGeometry();
this.tracerGeom.index      = this.base.index;
this.tracerGeom.attributes = this.base.attributes;
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
    this.base_group.add(this.tracerLines);  // ← attach to base_group so it rotates with cubes
  }

  /* ──────────────── POOL HELPERS ──────────────── */
  _cubeOffset(cubeIdx) { return cubeIdx * CUBE_VERT_COUNT * 3; }
  _edgeOffset(cubeIdx) { return cubeIdx * CUBE_EDGE_COUNT * 3; }

  _spawnCubeFromTemplate(slot) {
    // copy default positions into cubePos, zero velocities
    const dstPosOff = this._cubeOffset(slot);
    this.cubePos.set(this.default_pos, dstPosOff);
    this.cubeVel.fill(0, dstPosOff, dstPosOff + CUBE_VERT_COUNT * 3);

    this.cubeActive[slot] = true;
    this.cubeBirth[slot]  = this.elapsedTime;
    this.lastSpawned = slot;
  }


  /* Update cube edge start/end attributes from current per-vertex positions */
    _refreshCubeInstances() {
      for (let c = 0; c < MAX_CUBES; c++) {
        const basePos  = this._cubeOffset(c);
        const baseEdge = this._edgeOffset(c);

        // compute cube alpha from age (and deactivate when done)
        let alpha = 0.0;
        if (this.cubeActive[c]) {
          const age = this.elapsedTime - this.cubeBirth[c];
          alpha = Math.max(0, 1.0 - age / CUBE_LIFETIME);
          if (alpha <= 0) {
            this.cubeActive[c] = false;
          }
        }

        for (let e = 0; e < CUBE_EDGE_COUNT; e++) {
          const i0 = 2*e, i1 = i0+1;
          const p0 = basePos + i0*3;
          const p1 = basePos + i1*3;
          const dst = baseEdge + e*3;

          this.cubeStarts[dst+0] = this.cubePos[p0+0];
          this.cubeStarts[dst+1] = this.cubePos[p0+1];
          this.cubeStarts[dst+2] = this.cubePos[p0+2];

          this.cubeEnds[dst+0] = this.cubePos[p1+0];
          this.cubeEnds[dst+1] = this.cubePos[p1+1];
          this.cubeEnds[dst+2] = this.cubePos[p1+2];

          this.cubeOpacities[(c*CUBE_EDGE_COUNT)+e] = alpha;
        }
      }

      this.cubeGeom.attributes.cubeStart.needsUpdate   = true;
      this.cubeGeom.attributes.cubeEnd.needsUpdate     = true;
      this.cubeGeom.attributes.cubeOpacity.needsUpdate = true;
    }

  /* ──────────────── TRACERS ──────────────── */
createTracersForActiveCubes() {
  for (let c = 0; c < MAX_CUBES; c++) {
    if (!this.cubeActive[c]) continue;

    const basePos = this._cubeOffset(c);

    // One tracer DROP for this cube
    const tIdx = this.nextTracer; // ring across TOTAL_TRACERS
    const edgeBase = tIdx * TRACER_EDGE_COUNT;

    // Cube alpha at spawn time (matches cube fade model)
    const age = this.elapsedTime - this.cubeBirth[c];
    const cubeAlpha = Math.max(0, 1.0 - age / CUBE_LIFETIME);

    for (let e = 0; e < TRACER_EDGE_COUNT; ++e){
      const i0 = 2*e, i1 = i0+1;
      const p0 = basePos + i0*3;
      const p1 = basePos + i1*3;

      this.tracerStarts.set([
        this.cubePos[p0+0], this.cubePos[p0+1], this.cubePos[p0+2]
      ], (edgeBase+e)*3);

      this.tracerEnds.set([
        this.cubePos[p1+0], this.cubePos[p1+1], this.cubePos[p1+2]
      ], (edgeBase+e)*3);

      // Initialize per-edge opacity to the cube’s current alpha;
      // per-frame fade is applied in updateTracers().
      this.tracerOpacities[edgeBase + e] = cubeAlpha;
    }

    // Record this tracer DROP’s birth + base alpha
    this.tracerBirth[tIdx] = this.elapsedTime;
    this.tracerBaseOpacity[tIdx] = cubeAlpha;

    // Advance ring index across TOTAL_TRACERS
    this.nextTracer = (this.nextTracer + 1) % TOTAL_TRACERS;
  }

  // Upload
  this.tracerGeom.attributes.tracerStart.needsUpdate   = true;
  this.tracerGeom.attributes.tracerEnd.needsUpdate     = true;
  this.tracerGeom.attributes.tracerOpacity.needsUpdate = true;
}

updateTracers(dt){
  for (let t = 0; t < TOTAL_TRACERS; ++t){
    const birth = this.tracerBirth[t];
    let alpha = 0.0;

    if (birth >= 0.0) {
      const age  = this.elapsedTime - birth;
      const fade = THREE.MathUtils.clamp(1.0 - age / TRACER_LIFETIME, 0, 1);
      alpha = this.tracerBaseOpacity[t] * fade;
    }
    const base = t * TRACER_EDGE_COUNT;
    for (let e = 0; e < TRACER_EDGE_COUNT; ++e){
      this.tracerOpacities[base + e] = alpha;
    }
  }
  this.tracerGeom.attributes.tracerOpacity.needsUpdate = true;
}

  /* ──────────────── ORIGINAL UTILS ──────────────── */
  reset_cube() {
    // Keep: used as the template for spawns
    const p = this.cube.geometry.getAttribute('position');
    this.cube.geometry.setAttribute('velocity',
      new THREE.BufferAttribute(new Float32Array(p.count * 3).fill(0), 3));
    p.copyArray(this.default_pos);
  }

update_field_pointers() {
  let idx = 0;
  const half = (GRID_N - 1) / 2;
  let maxMag = 0;

  // We’ll fill _ptrDst and a temp mag array to compute opacities
  const dstStart = this._ptrDst;                  // alias for clarity
  const dstEnd   = new Float32Array(VECTOR_COUNT * 3);
  const mags     = new Float32Array(VECTOR_COUNT);

  for (let i = 0; i < GRID_N; ++i) {
    for (let j = 0; j < GRID_N; ++j) {
      for (let k = 0; k < GRID_N; ++k) {
        const x = (i - half) * SPACING;
        const y = (j - half) * SPACING;
        const z = (k - half) * SPACING;

        const v = this.field(new THREE.Vector3(x, y, z));
        const mag = v.length();
        mags[idx] = mag;
        maxMag = Math.max(maxMag, mag);

        const midpoint = new THREE.Vector3(x, y, z);
        const dir = v.clone().normalize();
        const start = midpoint.clone().addScaledVector(dir, -SCALE / 2);
        const end   = midpoint.clone().addScaledVector(dir,  SCALE / 2);

        // write targets
        dstStart[idx*3 + 0] = start.x;
        dstStart[idx*3 + 1] = start.y;
        dstStart[idx*3 + 2] = start.z;

        dstEnd[idx*3 + 0] = end.x;
        dstEnd[idx*3 + 1] = end.y;
        dstEnd[idx*3 + 2] = end.z;

        idx++;
      }
    }
  }

  // Normalize opacities (unchanged behavior)
  for (let i = 0; i < VECTOR_COUNT; ++i) {
    this.opacities[i] = THREE.MathUtils.clamp(mags[i] / (maxMag || 1), 0.05, 1);
  }
  this.instGeom.getAttribute('instanceOpacity').needsUpdate = true;

  // On first run: snap directly with no tween
  if (!this._ptrInit) {
    this.starts.set(dstStart);
    this.ends.set(dstEnd);
    this._ptrInit  = true;
    this._ptrLerpT = 1.0;
    this.instGeom.getAttribute('instanceStart').needsUpdate = true;
    this.instGeom.getAttribute('instanceEnd').needsUpdate   = true;
    return;
  }

  // Subsequent runs: start a tween from current displayed -> new targets
  this._ptrSrc.set(this.starts);   // current displayed becomes source
  this._ptrDst.set(dstStart);      // start targets already in _ptrDst
  this._ptrDstEnd = dstEnd;        // stash end targets separately
  this._ptrSrcEnd = new Float32Array(this.ends); // source ends

  this._ptrLerpT = 0.0; // begin interpolation
}

  /* ──────────────── ANIMATION ──────────────── */
  anim_frame(dt) {
    super.anim_frame();
    this.base_group.rotation.z += 0.05 * dt;

    // Integrate each ACTIVE cube’s per-vertex positions using the field
    for (let c = 0; c < MAX_CUBES; c++) {
      if (!this.cubeActive[c]) continue;

      const basePos = this._cubeOffset(c);
      for (let i = 0; i < CUBE_VERT_COUNT; i++) {
        const pIdx = basePos + i*3;

        const pos = new THREE.Vector3(
          this.cubePos[pIdx+0],
          this.cubePos[pIdx+1],
          this.cubePos[pIdx+2]
        );
        const v = new THREE.Vector3(
          this.cubeVel[pIdx+0],
          this.cubeVel[pIdx+1],
          this.cubeVel[pIdx+2]
        );

        const accel = this.field(pos).multiplyScalar(dt * ACCEL_PER_UNIT_FIELD);
        v.add(accel);              // v ← v + a*dt (a already scaled by dt)
        pos.add(v);                // x ← x + v

        this.cubeVel[pIdx+0] = v.x; this.cubeVel[pIdx+1] = v.y; this.cubeVel[pIdx+2] = v.z;
        this.cubePos[pIdx+0] = pos.x; this.cubePos[pIdx+1] = pos.y; this.cubePos[pIdx+2] = pos.z;
      }

    }

    // Push cube edge endpoints into instanced attributes (keeps instanceCount fixed)
    this._refreshCubeInstances();

    /* --- tracer bookkeeping --- */
    this.elapsedTime += dt;
    this.tracerTimer += dt;

    if (this.tracerTimer >= TRACER_INTERVAL){
      this.createTracersForActiveCubes();
      this.tracerTimer -= TRACER_INTERVAL;
    }
    this.updateTracers(dt);

// --- pointer tween (smooth angle change for vector indicators) ---
if (this._ptrLerpT < 1.0) {
  this._ptrLerpT = Math.min(1.0, this._ptrLerpT + (this._ptrLerpDur > 0 ? dt / this._ptrLerpDur : 1.0));
  const t = this._ptrLerpT;
  const it = 1.0 - t;

  // Lerp start and end arrays
  for (let i = 0; i < VECTOR_COUNT * 3; ++i) {
    this.starts[i] = this._ptrSrc[i]    * it + this._ptrDst[i]    * t;
    this.ends[i]   = this._ptrSrcEnd[i] * it + this._ptrDstEnd[i] * t;
  }

  this.instGeom.getAttribute('instanceStart').needsUpdate = true;
  this.instGeom.getAttribute('instanceEnd').needsUpdate   = true;

  // After finishing, collapse sources to final to avoid drift
  if (this._ptrLerpT === 1.0) {
    this.starts.set(this._ptrDst);
    this.ends.set(this._ptrDstEnd);
  }
}
  }

  /* ──────────────── BEAT / SYNC ──────────────── */
  handle_beat(latency, channel) {
    const delay = this.parent ? this.parent.get_beat_delay(latency) : 0;
    setTimeout(() => {
      if (channel == 1) {
        // Spawn a fresh cube from the pool (round-robin)
        //this.reset_cube(); // refresh template’s default_pos (no-op for pool)
        const slot = this.nextCube;
        this._spawnCubeFromTemplate(slot);
        this.nextCube = (this.nextCube + 1) % MAX_CUBES;
      } else if (channel == 2 || channel == 4) {
        // Reserve for future behaviors (color pulse, explode, etc.)
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
