import * as THREE from 'three';

// A mesh drawn as its horizontal contour lines (in the mesh's own frame, y
// up), like stacked scan slices, plus a scan contour that lights up the
// contours below it. The contours are real line segments, recut from the
// triangles every frame, so WebGL draws them exactly 1 px wide and unsmoothed
// at any slope; a contour drawn in a fragment shader takes its width from
// each facet's slope, so it varies across a faceted mesh. Blended additively
// with no depth writes, so the see-through contours never need sorting.
//
// Cost: one pass over the triangles per update (a few ops each, ~7k
// triangles for the brain) and re-uploading the segments drawn.
export class ContourScan extends THREE.LineSegments {
    // geometry: non-indexed triangles, as STLLoader gives.
    // spacing: model units between contours.
    // line_color / scan_color: THREE.Color of the contours / scan contour.
    // back_gain: brightness of contours on faces turned away from the
    //   viewer, relative to those facing it, so the far side reads as further.
    // trail: model units below the scan over which its glow fades.
    constructor(geometry, { spacing, line_color, scan_color, back_gain, trail }) {
        const tris = geometry.getAttribute('position').array;
        const num_tris = tris.length / 9;

        // Face normals from the winding (STL files' stored normals are
        // sometimes zero), and the most segments any update can draw: each
        // triangle crosses at most floor(height / spacing) + 1 contours at any
        // scroll offset, plus the scan contour.
        const face_normals = new Float32Array(num_tris * 3);
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        let max_segments = 0;
        for (let t = 0; t < num_tris; t++) {
            a.fromArray(tris, 9 * t);
            b.fromArray(tris, 9 * t + 3);
            c.fromArray(tris, 9 * t + 6);
            c.sub(b);
            b.sub(a);
            b.cross(c).normalize().toArray(face_normals, 3 * t);
            const ys = [tris[9 * t + 1], tris[9 * t + 4], tris[9 * t + 7]];
            max_segments += Math.floor((Math.max(...ys) - Math.min(...ys)) / spacing) + 2;
        }

        const line_geom = new THREE.BufferGeometry();
        const positions = new THREE.BufferAttribute(new Float32Array(max_segments * 6), 3);
        const colors = new THREE.BufferAttribute(new Float32Array(max_segments * 6), 3);
        positions.setUsage(THREE.DynamicDrawUsage);
        colors.setUsage(THREE.DynamicDrawUsage);
        line_geom.setAttribute('position', positions);
        line_geom.setAttribute('color', colors);
        line_geom.setDrawRange(0, 0);
        super(line_geom, new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        // The segments change every frame; skip bounds upkeep and culling.
        this.frustumCulled = false;

        this.tris = tris;
        this.face_normals = face_normals;
        this.num_tris = num_tris;
        this.spacing = spacing;
        this.line_color = line_color;
        this.scan_color = scan_color;
        this.back_gain = back_gain;
        this.trail = trail;
        geometry.computeBoundingBox();
        this.min_y = geometry.boundingBox.min.y;
        this.max_y = geometry.boundingBox.max.y;
        this.view_dir = new THREE.Vector3();
        this.world_quat = new THREE.Quaternion();
    }

    // Recut the contours: at heights offset + k * spacing (model units), plus
    // the scan contour at scan_height when scan_strength (0..1) > 0.
    update(offset, scan_height, scan_strength) {
        // Towards the (orthographic) camera, in the mesh's frame.
        this.getWorldQuaternion(this.world_quat).invert();
        const view = this.view_dir.set(0, 0, 1).applyQuaternion(this.world_quat);

        const tris = this.tris;
        const s = this.spacing;
        let n = 0;
        for (let t = 0; t < this.num_tris; t++) {
            const o = 9 * t;
            const y0 = tris[o + 1], y1 = tris[o + 4], y2 = tris[o + 7];
            const lo = Math.min(y0, y1, y2);
            const hi = Math.max(y0, y1, y2);
            const fn = 3 * t;
            const facing = this.face_normals[fn] * view.x + this.face_normals[fn + 1] * view.y +
                this.face_normals[fn + 2] * view.z >= 0 ? 1 : this.back_gain;
            for (let h = offset + Math.ceil((lo - offset) / s) * s; h <= hi; h += s) {
                // Contours below the scan light up, fading with distance.
                const below = scan_height - h;
                const gain = facing * (below > 0 ?
                    1 + 2 * scan_strength * Math.exp(-below / this.trail) : 1);
                n = this.add_segment(n, o, h, this.line_color, gain);
            }
            if (scan_strength > 0 && lo <= scan_height && scan_height <= hi) {
                n = this.add_segment(n, o, scan_height, this.scan_color, facing * scan_strength);
            }
        }
        this.geometry.setDrawRange(0, 2 * n);
        this.geometry.getAttribute('position').needsUpdate = true;
        this.geometry.getAttribute('color').needsUpdate = true;
    }

    // Write segment n: where height h cuts the triangle at tris[o], coloured
    // color * gain. Vertices exactly at h count as above it, so neighbouring
    // triangles agree on shared edges and the contours close up without
    // gaps. Returns the next segment index.
    add_segment(n, o, h, color, gain) {
        const tris = this.tris;
        const pos = this.geometry.getAttribute('position').array;
        const col = this.geometry.getAttribute('color').array;
        let p = 6 * n;
        for (let e = 0; e < 3; e++) {
            const ia = o + 3 * e;
            const ib = o + 3 * ((e + 1) % 3);
            const ya = tris[ia + 1], yb = tris[ib + 1];
            if ((ya >= h) != (yb >= h)) {
                const f = (h - ya) / (yb - ya);
                pos[p] = tris[ia] + f * (tris[ib] - tris[ia]);
                pos[p + 1] = h;
                pos[p + 2] = tris[ia + 2] + f * (tris[ib + 2] - tris[ia + 2]);
                col[p] = color.r * gain;
                col[p + 1] = color.g * gain;
                col[p + 2] = color.b * gain;
                p += 3;
            }
        }
        // A triangle the height only touches at a corner crosses no edge
        // (or the counts are uneven at a degenerate one): draw nothing.
        return p == 6 * n + 6 ? n + 1 : n;
    }
}
