"""Clean up a photogrammetry bust (web/models/david_head.stl) for the frontend.

Removes floating fragments and small holes, then smooths only where the
surface is rough at a fine scale (hair, speckle, spikes), leaving the face's
features and the flat cut planes (bottom, shoulders) and their edges intact,
and decimates to an even density.

Run with Blender (no tkinter/venv deps; Blender bundles numpy):
    /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/clean_head_mesh.py -- \
        web/models/david_head.stl web/stl/david_head.stl [--debug-ply weights.ply]

--debug-ply also writes the cleaned, undecimated mesh with the smoothing
weight as vertex colour (white = smoothed fully), for checking the mask.
"""
import sys

import bmesh
import bpy
import numpy as np

# Model units are ~cm (the bust is ~28 tall); median edge ~0.09.
# Loose parts with fewer verts than this are scan debris.
MIN_PART_VERTS = 1000
# Holes with at most this many boundary edges are filled.
MAX_HOLE_EDGES = 64
# Roughness: the normal offset of each vertex from its ROUGH_SCALE_ITERS-times
# umbrella-smoothed position (features a few edges across), RMS-averaged over
# ROUGH_SPREAD_ITERS rings so coherent features (one crease line) score lower
# than an area of noise (hair). Smoothing weight ramps from 0 at ROUGH_LO to
# 1 at ROUGH_HI (model units).
ROUGH_SCALE_ITERS = 4
ROUGH_SPREAD_ITERS = 15
ROUGH_LO = 0.012
ROUGH_HI = 0.03
# The weight is then blurred over WEIGHT_BLUR_ITERS rings and scaled by
# WEIGHT_GAIN (clamped to 1), so the hair is smoothed evenly rather than in
# patches pinned by the less rough islands within it.
WEIGHT_BLUR_ITERS = 10
WEIGHT_GAIN = 1.6
# Vertices on faces this many times the median face area, below CAP_MAX_Y
# (model units relative to the bounding box's centre: under the neck),
# belong to the flat cut planes (filled with large triangles); they and
# LOCK_RINGS rings around them are never moved, so the cut edges stay sharp.
# (Large triangles higher up are the scanner's hole patches in the hair.)
CAP_AREA_FACTOR = 50
CAP_MAX_Y = -6.0
LOCK_RINGS = 2
# Regions never smoothed, whose features (eyelids, lips, nostrils, ear
# rims) score as rough as hair: boxes (min, max per axis, model units
# relative to the bounding box's centre; Y up, face +z) with soft edges
# PROTECT_SOFT wide. The face from chin to brows, and both ears (|x|).
PROTECT_FACE = ((-5.5, 5.5), (-6.5, 5.5), (3.0, 99.0))
PROTECT_EARS = ((5.0, 8.5), (-1.5, 4.5), (-2.5, 1.5))
PROTECT_SOFT = 0.8
# Only the head is smoothed: above SMOOTH_MIN_Y (relative, as above; the
# hair ends at the nape ~-2.4), keeping the shirt and its collar's ridge.
SMOOTH_MIN_Y = -4.0
# Laplacian smoothing: passes and step. Plain (not shrink-free Taubin),
# which barely touched the hair's lumps (~0.3-0.5 across); the hair sinks
# ~0.1 instead, reading as a slightly closer crop.
SMOOTH_PASSES = 70
SMOOTH_LAMBDA = 0.5
# Final triangle count after decimation.
TARGET_FACES = 15000


def neighbour_mean(x, e, deg):
    """Mean of x over each vertex's edge neighbours (x: (N,) or (N, k))."""
    a, b = e[:, 0], e[:, 1]
    cols = x.reshape(len(deg), -1)
    out = np.empty_like(cols)
    for c in range(cols.shape[1]):
        s = np.bincount(a, cols[b, c], len(deg)) + np.bincount(b, cols[a, c], len(deg))
        out[:, c] = s / np.maximum(deg, 1)
    return out.reshape(x.shape)


def in_box(p, box):
    """Soft membership (0..1) of points p in box, ramping over PROTECT_SOFT."""
    m = np.ones(len(p))
    for axis, (lo, hi) in enumerate(box):
        x = p[:, axis]
        m *= np.clip((x - lo) / PROTECT_SOFT + 0.5, 0, 1) * np.clip((hi - x) / PROTECT_SOFT + 0.5, 0, 1)
    return m


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    src, dst = argv[0], argv[1]
    debug_ply = argv[argv.index('--debug-ply') + 1] if '--debug-ply' in argv else None

    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Default axes: coordinates come in (and go out) unchanged.
    bpy.ops.wm.stl_import(filepath=src)
    ob = bpy.context.selected_objects[0]
    me = ob.data

    # Weld, drop debris, fill small holes.
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.verts.ensure_lookup_table()
    seen = set()
    debris = []
    for v in bm.verts:
        if v in seen:
            continue
        part, stack = [v], [v]
        seen.add(v)
        while stack:
            x = stack.pop()
            for ed in x.link_edges:
                o = ed.other_vert(x)
                if o not in seen:
                    seen.add(o)
                    part.append(o)
                    stack.append(o)
        if len(part) < MIN_PART_VERTS:
            debris.extend(part)
    bmesh.ops.delete(bm, geom=debris, context='VERTS')
    boundary = [ed for ed in bm.edges if ed.is_boundary]
    filled = bmesh.ops.holes_fill(bm, edges=boundary, sides=MAX_HOLE_EDGES)
    bmesh.ops.triangulate(bm, faces=filled['faces'])
    # Keep the scan's own winding (outward): recalc_face_normals flips this
    # holey, non-manifold mesh inward, wholly or in patches, which the
    # frontend's single-sided material shows as black and see-through.
    if bm.calc_volume(signed=True) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    print(f'removed {len(debris)} debris verts, filled {len(filled["faces"])} hole faces, '
          f'{sum(ed.is_boundary for ed in bm.edges)} boundary edges left')
    bm.to_mesh(me)
    bm.free()
    me.update()

    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(n, 3)
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', e)
    e = e.reshape(-1, 2)
    deg = np.bincount(e.ravel(), minlength=n).astype(float)
    nor = np.empty(n * 3)
    me.vertex_normals.foreach_get('vector', nor)
    nor = nor.reshape(n, 3)

    # Roughness.
    s = co.copy()
    for _ in range(ROUGH_SCALE_ITERS):
        s = neighbour_mean(s, e, deg)
    r = (((co - s) * nor).sum(1)) ** 2
    for _ in range(ROUGH_SPREAD_ITERS):
        r = 0.5 * r + 0.5 * neighbour_mean(r, e, deg)
    r = np.sqrt(r)
    print('roughness pct 10/50/90/99:', np.percentile(r, [10, 50, 90, 99]).round(4))
    t = np.clip((r - ROUGH_LO) / (ROUGH_HI - ROUGH_LO), 0, 1)
    w = t * t * (3 - 2 * t)
    for _ in range(WEIGHT_BLUR_ITERS):
        w = 0.5 * w + 0.5 * neighbour_mean(w, e, deg)
    w = np.minimum(1, w * WEIGHT_GAIN)

    # Lock the cut planes and a margin around them.
    area = np.empty(len(me.polygons))
    me.polygons.foreach_get('area', area)
    lock = np.zeros(n, dtype=bool)
    rel = co - (co.min(0) + co.max(0)) / 2
    for p in np.nonzero(area > CAP_AREA_FACTOR * np.median(area))[0]:
        vs = list(me.polygons[p].vertices)
        if rel[vs, 1].max() < CAP_MAX_Y:
            lock[vs] = True
    for _ in range(LOCK_RINGS):
        lock |= neighbour_mean(lock.astype(float), e, deg) > 0
    w[lock] = 0
    w *= np.clip((rel[:, 1] - SMOOTH_MIN_Y) / PROTECT_SOFT + 0.5, 0, 1)
    ears = rel.copy()
    ears[:, 0] = np.abs(ears[:, 0])
    w *= (1 - in_box(rel, PROTECT_FACE)) * (1 - in_box(ears, PROTECT_EARS))
    print(f'locked {lock.sum()} cap verts; mean weight {w.mean():.3f}')

    co0 = co.copy()
    # Weighted Laplacian smoothing.
    for _ in range(SMOOTH_PASSES):
        co += (SMOOTH_LAMBDA * w)[:, None] * (neighbour_mean(co, e, deg) - co)
    moved = np.linalg.norm(co - co0, axis=1)
    print('moved pct 50/90/99 (w>0.9):', np.percentile(moved[w > 0.9], [50, 90, 99]).round(3))
    me.vertices.foreach_set('co', co.ravel())
    me.update()

    if debug_ply:
        attr = me.color_attributes.new('weight', 'FLOAT_COLOR', 'POINT')
        rgba = np.repeat(w[:, None], 4, 1)
        rgba[:, 3] = 1
        attr.data.foreach_set('color', rgba.ravel())
        bpy.ops.wm.ply_export(filepath=debug_ply, export_colors='LINEAR', ascii_format=False)
        me.color_attributes.remove(attr)

    mod = ob.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = TARGET_FACES / len(me.polygons)
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)
    print(f'decimated to {len(me.polygons)} faces')
    bpy.ops.wm.stl_export(filepath=dst, ascii_format=False)


main()
