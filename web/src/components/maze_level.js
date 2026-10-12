import * as THREE from 'three';
import { ResourceLoader } from '../util.js';
import { InstancedProps } from './instanced_props.js';
import { LEVEL_COLORS } from '../maze_levels.js';

// One level of a MazeLevels maze, drawn around a centre cell in that cell's
// frame (so coordinates stay small however far it is explored), all in the
// level's colour and faded as one by set_opacity (for crossfading levels):
//
// - Walls: one solid, a lit, dithered fill outlined only along its true
//   edges. Walls run between posts at the cells' corners, all axis-aligned
//   and the same height, so their union is one footprint extruded upwards:
//   build() lays it out on a grid alternating post widths and wall spans,
//   and emits only the union's top faces, its side faces where solid meets
//   empty, outline edges along the same boundaries top and bottom, and
//   vertical edges where the outline turns a corner. Some walls have a
//   window through them (rectangular, of the wall's aspect, or round):
//   their side faces are cut round the hole, and the hole lined and
//   outlined.
// - Archways over some doorways: the doorway drawn as a wall span with an
//   arch-topped opening cut down to the floor (the same machinery as the
//   windows), so its top is flush with the walls and it joins them with no
//   extra edges.
// - Ramps up from the level and down from it: each a solid wedge filling
//   its cell wall to wall, from the floor at its bottom side to the wall tops
//   at its top side (see MazeLevels); the ramp down from a level shows as
//   that wedge sunk in a walled-in hole.
// - Carpets in the rooms: a single-hue rectangle, its brightness varying
//   with simplex noise, outlined in the same hue.
// - The floor: a dithered fill whose opacity follows simplex noise.
//
// Fog of war: edges fade with distance from a point (set_viewer), eased
// between fog_near and fog_far; the floor too. The rest is lit (e.g. by a
// light whose range ends at fog_far), so it darkens with distance.

// Window size, as a fraction of the wall span's length and height (the same
// aspect as the wall; a round window's diameter is the height's fraction).
const WINDOW_SCALE = 0.5;
const WINDOW_ROUND_SEGMENTS = 24;
// Archways: the opening is inset ARCH_MARGIN world units from the doorway's
// sides and its semicircular top as far below the wall's top.
const ARCH_MARGIN = 0.5;
const ARCH_SEGMENTS = 12;           // per half turn
// Carpets: inset from a room's walls (world units), height above the floor,
// and their brightness varying from CARPET_DARK to 1 with simplex noise in
// patches CARPET_NOISE_SIZE world units across.
const CARPET_INSET = 2;
const CARPET_Y = 0.02;
const CARPET_DARK = 0.55;
const CARPET_NOISE_SIZE = 4;
// The floor's opacity follows simplex noise: FLOOR_MIN where it is below
// FLOOR_NOISE_LO, FLOOR_MAX above FLOOR_NOISE_HI (noise in about [-1, 1]), in
// patches FLOOR_NOISE_SIZE world units across. FLOOR_SIZE: its extent.
const FLOOR_MIN = 0.1;
const FLOOR_MAX = 0.25;
const FLOOR_NOISE_LO = -0.3;
const FLOOR_NOISE_HI = 0.7;
const FLOOR_NOISE_SIZE = 25;
const FLOOR_SIZE = 400;

// Per window (archways count as windows here). ~30 windows and ~10 archways
// typical; past MAX_WINDOWS the rest are left out (beyond the fog anyway),
// which bounds the buffers.
const MAX_WINDOWS = 64;
const MAX_RAMPS = 16;
const MAX_CARPETS = 12;

// GLSL: the fog (from a point's footprint position, v_xz) and the level's
// opacity, shared by every material here.
const FOG_PARS = [
    'uniform vec2 fog_centre;',
    'uniform float fog_near;',
    'uniform float fog_far;',
    'uniform float opacity_all;',
    'varying vec2 v_xz;',
    'float fog_alpha() {',
    '    float f = clamp((fog_far - distance(v_xz, fog_centre)) / (fog_far - fog_near), 0.0, 1.0);',
    '    return 0.5 - 0.5 * cos(3.14159265 * f);',
    '}',
].join('\n');

export class MazeLevel extends THREE.Group {
    // levels: MazeLevels. cell: grid pitch; thickness / height: the walls'
    // (world units); level_height: between levels' floors. half: cells
    // drawn either side of the centre cell.
    constructor(levels, { cell, thickness, height, level_height, half, fog_near, fog_far }) {
        super();
        this.levels = levels;
        this.level = 0;
        this.cell = cell;
        this.thickness = thickness;
        this.height = height;
        this.level_height = level_height;
        this.half = half;
        this.color = new THREE.Color(levels.color(0));

        // The footprint grid: cells lo..hi, with the corners either side of
        // each, alternating corner (even index) and cell (odd) spans, so
        // `spans` spans per side and their spans + 1 boundaries' coordinates.
        this.lo = -half - 1;
        this.hi = half;
        this.spans = 2 * (this.hi - this.lo + 1) + 1;
        const m = this.spans;
        this.edges_at = new Float32Array(m + 1);
        this.solid = new Uint8Array(m * m);
        this.window_kind = new Uint8Array(m * m);      // per wall span: 0, 1 rect, 2 round, 3 arch
        // Walls and archways on each cell's east and north sides, for the
        // cells around the grid (one more each way, for the outermost posts).
        this.wall_side = this.hi - this.lo + 3;
        const w2 = this.wall_side * this.wall_side;
        this.east_wall = new Uint8Array(w2);
        this.north_wall = new Uint8Array(w2);
        this.east_arch = new Uint8Array(w2);
        this.north_arch = new Uint8Array(w2);

        this.uniforms = {
            fog_centre: { value: new THREE.Vector2() },
            fog_near: { value: fog_near },
            fog_far: { value: fog_far },
            opacity_all: { value: 1 },
            // Where this group's origin is in the maze (world units), so
            // noise patterns stay fixed to the maze as the window moves.
            maze_origin: { value: new THREE.Vector2() },
        };

        // Window panels: each kind's wall face (u along the wall, v up) cut
        // round its hole, triangulated, and the hole's outline.
        this.window_shapes = [null, this.window_shape(1), this.window_shape(2), this.arch_shape()];

        // Worst cases: every span's top, every boundary a side face (a window
        // panel at most a few dozen triangles more), edges along every
        // boundary top and bottom, verticals at every crossing, and window
        // outlines.
        const boundaries = 2 * m * (m + 1);
        // A window adds its two faces' cut-round panels and its lining.
        const panel_tris = 2 * this.window_shapes[2].tris.length + 2 * WINDOW_ROUND_SEGMENTS;
        const max_tris = 2 * (m * m + boundaries) + panel_tris * MAX_WINDOWS;
        this.fill_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'normal']) {
            const attr = new THREE.BufferAttribute(new Float32Array(max_tris * 9), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.fill_geom.setAttribute(name, attr);
        }
        const max_lines = 2 * boundaries + (m + 1) * (m + 1) + 2 * WINDOW_ROUND_SEGMENTS * MAX_WINDOWS +
            4 * MAX_CARPETS;
        this.line_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'line_color']) {
            const attr = new THREE.BufferAttribute(new Float32Array(max_lines * 6), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.line_geom.setAttribute(name, attr);
        }
        this.carpet_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'color']) {
            const attr = new THREE.BufferAttribute(new Float32Array(MAX_CARPETS * 18), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.carpet_geom.setAttribute(name, attr);
        }

        // Edges: blended, per-vertex colour (walls in the level's colour,
        // carpets in theirs), in front of the fills (which are pushed back).
        const line_mat = new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: [
                'attribute vec3 line_color;',
                'varying vec3 v_color;',
                'varying vec2 v_xz;',
                'void main() {',
                '    v_xz = position.xz;',
                '    v_color = line_color;',
                '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                '}',
            ].join('\n'),
            fragmentShader: [
                FOG_PARS,
                'varying vec3 v_color;',
                'void main() {',
                '    gl_FragColor = vec4(v_color, fog_alpha() * opacity_all);',
                '    #include <colorspace_fragment>',
                '}',
            ].join('\n'),
            transparent: true,
            depthWrite: false,
        });
        const lines = new THREE.LineSegments(this.line_geom, line_mat);
        lines.frustumCulled = false;
        this.add(lines);

        // Ramps: a unit wedge, posed and stretched per ramp.
        this.ramps = new InstancedProps(this.wedge_geometry(),
            { color: this.color, max: MAX_RAMPS });
        this.add(this.ramps);
        this.ramp_list = [];        // [Matrix4, x, z] per ramp in the window
        this.matrix_pool = [];
        this.dummy = new THREE.Object3D();
        this.dummy.rotation.order = 'YXZ';

        // The fills: walls, carpets and floor, lit and shaded through the
        // house dither, dissolving through it with the level's opacity.
        // Added once the shader chunks load.
        this.wall_mat = null;
        this.floor_mat = null;
        new ResourceLoader(['glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag',
            'glsl/chunks/simplex2d.glsl']).load().then(([dither_pars, dither, simplex2d]) => {
            // A lit, dithered fill. extra_frag runs first in the fragment
            // shader (with the fog, opacity and noise available); polygon_offset
            // pushes it back so edges on it draw.
            const fill_material = (params, polygon_offset, extra_frag) => {
                const mat = new THREE.MeshLambertMaterial({
                    ...params,
                    polygonOffset: true,
                    polygonOffsetFactor: polygon_offset,
                    polygonOffsetUnits: polygon_offset,
                });
                mat.onBeforeCompile = (shader) => {
                    Object.assign(shader.uniforms, this.uniforms);
                    shader.vertexShader = shader.vertexShader.replace(
                        '#include <common>',
                        'varying vec2 v_xz;\n#include <common>'
                    ).replace(
                        '#include <begin_vertex>',
                        // In this group's frame: its meshes are untransformed.
                        '#include <begin_vertex>\nv_xz = position.xz;'
                    );
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <dithering_pars_fragment>',
                        dither_pars + '\n' + simplex2d + '\n' + FOG_PARS +
                        '\nuniform vec2 maze_origin;'
                    ).replace(
                        '#include <dithering_fragment>',
                        dither
                    ).replace(
                        '#include <clipping_planes_fragment>',
                        '#include <clipping_planes_fragment>\n' + extra_frag
                    );
                };
                return mat;
            };
            const fade = 'if (opacity_all < 1.0 && dither4x4(gl_FragCoord.xy, opacity_all) < 0.5) discard;';
            this.wall_mat = fill_material({ color: this.color }, 1, fade);
            const walls = new THREE.Mesh(this.fill_geom, this.wall_mat);
            walls.frustumCulled = false;
            this.add(walls);

            // Carpets: per-vertex hue, darkened by noise in maze coordinates.
            const carpet_mat = fill_material({ vertexColors: true }, 1, fade);
            const carpet_frag = carpet_mat.onBeforeCompile;
            carpet_mat.onBeforeCompile = (shader) => {
                carpet_frag(shader);
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <color_fragment>',
                    '#include <color_fragment>\n' +
                    `diffuseColor.rgb *= mix(${CARPET_DARK.toFixed(2)}, 1.0, ` +
                    `0.5 + 0.5 * snoise((v_xz + maze_origin) / ${CARPET_NOISE_SIZE.toFixed(1)}));`
                );
            };
            const carpets = new THREE.Mesh(this.carpet_geom, carpet_mat);
            carpets.frustumCulled = false;
            this.add(carpets);

            // The floor: opacity from noise, faded with the fog and level.
            // Pushed back past the walls' bottom edges.
            this.floor_mat = fill_material({ color: this.color }, 2,
                'float floor_alpha = mix(' + FLOOR_MIN.toFixed(2) + ', ' + FLOOR_MAX.toFixed(2) +
                ', smoothstep(' + FLOOR_NOISE_LO.toFixed(2) + ', ' + FLOOR_NOISE_HI.toFixed(2) +
                ', snoise((v_xz + maze_origin) / ' + FLOOR_NOISE_SIZE.toFixed(1) + ')))' +
                ' * fog_alpha() * opacity_all;\n' +
                'if (dither4x4(gl_FragCoord.xy, floor_alpha) < 0.5) discard;');
            const floor_geom = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2);
            this.add(new THREE.Mesh(floor_geom, this.floor_mat));
        });
    }

    // Show level L: its colour, on everything (the walls are rebuilt by
    // build()). The fills' materials hold copies of the colour.
    set_level(level) {
        this.level = level;
        this.color.set(this.levels.color(level));
        this.ramps.set_color(this.color);
        this.wall_mat?.color.copy(this.color);
        this.floor_mat?.color.copy(this.color);
    }

    // The fog's centre, in this group's frame (x, z).
    set_viewer(x, z) {
        this.uniforms.fog_centre.value.set(x, z);
    }

    // Fade the whole level, 0..1.
    set_opacity(opacity) {
        this.uniforms.opacity_all.value = opacity;
        this.visible = opacity > 0;
    }

    // Per frame: fade the props with the fog and the level.
    update() {
        const { fog_centre, fog_near, fog_far, opacity_all } = this.uniforms;
        const fog = (x, z) => {
            const d = Math.hypot(x - fog_centre.value.x, z - fog_centre.value.y);
            const f = Math.min(1, Math.max(0, (fog_far.value - d) / (fog_far.value - fog_near.value)));
            return (0.5 - 0.5 * Math.cos(Math.PI * f)) * opacity_all.value;
        };
        this.ramps.begin();
        for (const [matrix, x, z] of this.ramp_list) {
            this.ramps.add_instance(matrix, fog(x, z));
        }
        this.ramps.end();
    }

    // A window panel for kind (1 rect, 2 round): { points, tris, hole }, in
    // (u, v) over the wall face (u 0..length along it, v 0..height).
    window_shape(kind) {
        const len = this.cell - this.thickness, h = this.height;
        const cu = len / 2, cv = h / 2;
        let hole;
        if (kind == 1) {
            const hw = len * WINDOW_SCALE / 2, hh = h * WINDOW_SCALE / 2;
            hole = [[cu - hw, cv - hh], [cu + hw, cv - hh], [cu + hw, cv + hh], [cu - hw, cv + hh]];
        } else {
            const r = h * WINDOW_SCALE / 2;
            hole = [];
            for (let k = 0; k < WINDOW_ROUND_SEGMENTS; k++) {
                const a = 2 * Math.PI * k / WINDOW_ROUND_SEGMENTS;
                hole.push([cu + r * Math.cos(a), cv + r * Math.sin(a)]);
            }
        }
        const outer = [[0, 0], [len, 0], [len, h], [0, h]];
        const v2 = (p) => new THREE.Vector2(p[0], p[1]);
        const tris = THREE.ShapeUtils.triangulateShape(outer.map(v2), [hole.map(v2)]);
        // The lining faces in towards the middle.
        return { points: outer.concat(hole), tris, hole, closed: true, inward: () => [cu, cv] };
    }

    // An archway's panel: the wall face (as window_shape) with an opening cut
    // from the floor, ARCH_MARGIN in from each side, topped by a semicircle
    // whose crown is ARCH_MARGIN below the wall's top. Its outline runs up one
    // side, over the arch and down the other, open along the floor.
    arch_shape() {
        const len = this.cell - this.thickness, h = this.height, m = ARCH_MARGIN;
        const r = len / 2 - m, cu = len / 2, spring = h - m - r;
        const path = [[m, 0], [m, spring]];
        for (let k = 1; k < ARCH_SEGMENTS; k++) {
            const a = Math.PI - Math.PI * k / ARCH_SEGMENTS;
            path.push([cu + r * Math.cos(a), spring + r * Math.sin(a)]);
        }
        path.push([len - m, spring], [len - m, 0]);
        const contour = [[0, 0]].concat(path, [[len, 0], [len, h], [0, h]]);
        const v2 = (p) => new THREE.Vector2(p[0], p[1]);
        const tris = THREE.ShapeUtils.triangulateShape(contour.map(v2), []);
        // The lining faces in: across the opening on its straight sides,
        // towards the arch's centre round its curve.
        return {
            points: contour, tris, hole: path, closed: false,
            inward: (v) => [cu, Math.min(v, spring)],
            jambs: [[0, m], [len - m, len]],
        };
    }

    // A unit wedge: x across -0.5..0.5, z along 0..1, its top rising from
    // y = 0 at z = 0 to y = 1 at z = 1 (a right-angled triangle, extruded
    // across x).
    wedge_geometry() {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(1, 0);
        shape.lineTo(1, 1);
        shape.lineTo(0, 0);
        // The shape's x (along) becomes z; the extrusion becomes x.
        const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
        geom.translate(0, 0, -0.5);
        geom.rotateY(-Math.PI / 2);
        return geom;
    }

    // A free Matrix4 from the pool (reused build to build).
    pooled_matrix(k) {
        while (this.matrix_pool.length <= k) {
            this.matrix_pool.push(new THREE.Matrix4());
        }
        return this.matrix_pool[k];
    }

    // Lay out the window around cell (ci, cj) of the current level, in
    // coordinates relative to it.
    build(ci, cj) {
        const { cell, thickness: t, lo, hi, spans: m, wall_side: w, levels, level } = this;
        const maze = levels.maze(level);
        this.uniforms.maze_origin.value.set(ci * cell, cj * cell);

        // Walls and archways of the cells lo - 1 .. hi + 1 each way (an
        // archway's doorway counts as a wall span, cut by its arch).
        for (let a = 0; a < w; a++) {
            for (let b = 0; b < w; b++) {
                const i = ci + lo - 1 + a, j = cj + lo - 1 + b, k = a + b * w;
                this.east_wall[k] = maze.east_open(i, j) ? 0 : 1;
                this.north_wall[k] = maze.north_open(i, j) ? 0 : 1;
                this.east_arch[k] = levels.arch(level, i, j, 0) ? 1 : 0;
                this.north_arch[k] = levels.arch(level, i, j, 1) ? 1 : 0;
            }
        }
        // Relative cell (i, j)'s walls / archways, 0 outside the grid.
        const at = (arr, i, j) => {
            const a = i - lo + 1, b = j - lo + 1;
            return a >= 0 && a < w && b >= 0 && b < w ? arr[a + b * w] : 0;
        };

        // Span s: even = the corner after cell lo - 1 + s / 2, odd = cell
        // lo + (s - 1) / 2. Boundaries alternate a post's width and a wall's
        // span, starting at the first corner post's near side.
        let x = (lo - 0.5) * cell - t / 2;
        for (let s = 0; s <= m; s++) {
            this.edges_at[s] = x;
            x += s % 2 == 0 ? t : cell - t;
        }
        let windows = 0;
        for (let sz = 0; sz < m; sz++) {
            for (let sx = 0; sx < m; sx++) {
                let solid = 0, kind = 0;
                const corner_x = lo - 1 + sx / 2, corner_z = lo - 1 + sz / 2;
                const cell_x = lo + (sx - 1) / 2, cell_z = lo + (sz - 1) / 2;
                if (sx % 2 == 0 && sz % 2 == 0) {
                    // A post, wherever any wall meets its corner (an
                    // archway always has walls running on from both sides).
                    solid = at(this.east_wall, corner_x, corner_z) | at(this.east_wall, corner_x, corner_z + 1) |
                        at(this.north_wall, corner_x, corner_z) | at(this.north_wall, corner_x + 1, corner_z);
                } else if (sx % 2 == 0) {
                    if (at(this.east_arch, corner_x, cell_z)) {
                        solid = 1;
                        kind = 3;
                    } else {
                        solid = at(this.east_wall, corner_x, cell_z);
                        kind = solid ? levels.window(level, ci + corner_x, cj + cell_z, 0) : 0;
                    }
                } else if (sz % 2 == 0) {
                    if (at(this.north_arch, cell_x, corner_z)) {
                        solid = 1;
                        kind = 3;
                    } else {
                        solid = at(this.north_wall, cell_x, corner_z);
                        kind = solid ? levels.window(level, ci + cell_x, cj + corner_z, 1) : 0;
                    }
                }
                if (kind && ++windows > MAX_WINDOWS) {
                    // Out of room: a window just stays wall; an archway's
                    // doorway stays open.
                    solid = kind == 3 ? 0 : solid;
                    kind = 0;
                }
                this.solid[sx + sz * m] = solid;
                this.window_kind[sx + sz * m] = kind;
            }
        }

        // Ramps up from this level (rising to +level_height) and down from
        // it (to -level_height).
        this.ramp_list.length = 0;
        let n = 0;
        for (let i = lo; i <= hi; i++) {
            for (let j = lo; j <= hi; j++) {
                for (const [low_level, base] of [[level, 0], [level - 1, -this.level_height]]) {
                    const uphill = levels.ramp(low_level, ci + i, cj + j);
                    if (uphill !== null && this.ramp_list.length < MAX_RAMPS) {
                        n = this.add_ramp(n, uphill, i, j, base);
                    }
                }
            }
        }

        // Carpets in the rooms overlapping the window.
        this.carpets = maze.rooms_in(ci + lo, cj + lo, ci + hi, cj + hi).slice(0, MAX_CARPETS);
        this.emit();
    }

    // Pose the wedge filling relative cell (i, j), rising along uphill
    // ([di, dj]) from height base to base + level_height: from the wall line
    // on its bottom side to the face of the wall on its top side, and between
    // the faces of the walls on either side.
    add_ramp(n, [di, dj], i, j, base) {
        const cell = this.cell, t = this.thickness;
        const dummy = this.dummy;
        dummy.rotation.set(0, Math.atan2(di, dj), 0);
        dummy.scale.set(cell - t, this.level_height, cell - t / 2);
        const x = i * cell, z = j * cell;
        dummy.position.set(x - di * cell / 2, base, z - dj * cell / 2);
        dummy.updateMatrix();
        this.ramp_list.push([this.pooled_matrix(n).copy(dummy.matrix), x, z]);
        return n + 1;
    }

    // Write the union's faces and edges, the windows, and the carpets.
    emit() {
        const m = this.spans, e = this.edges_at, h = this.height;
        const solid = (sx, sz) => sx >= 0 && sx < m && sz >= 0 && sz < m && this.solid[sx + sz * m] == 1;
        const pos = this.fill_geom.getAttribute('position').array;
        const nrm = this.fill_geom.getAttribute('normal').array;
        const lines = this.line_geom.getAttribute('position').array;
        const line_cols = this.line_geom.getAttribute('line_color').array;
        let f = 0;      // fill floats written
        let l = 0;      // line floats written
        let line_color = this.color;
        // A triangle facing along (nx, ny, nz), whichever way it was wound.
        const tri = (p0, p1, p2, nx, ny, nz) => {
            const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
            const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
            const facing = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
            for (const p of facing >= 0 ? [p0, p1, p2] : [p0, p2, p1]) {
                pos[f] = p[0]; pos[f + 1] = p[1]; pos[f + 2] = p[2];
                nrm[f] = nx; nrm[f + 1] = ny; nrm[f + 2] = nz;
                f += 3;
            }
        };
        const quad = (a, b, c, d, nx, ny, nz) => {
            tri(a, b, c, nx, ny, nz);
            tri(a, c, d, nx, ny, nz);
        };
        const line = (x0, y0, z0, x1, y1, z1) => {
            lines[l] = x0; lines[l + 1] = y0; lines[l + 2] = z0;
            lines[l + 3] = x1; lines[l + 4] = y1; lines[l + 5] = z1;
            for (let k = 0; k < 6; k += 3) {
                line_cols[l + k] = line_color.r;
                line_cols[l + k + 1] = line_color.g;
                line_cols[l + k + 2] = line_color.b;
            }
            l += 6;
        };
        // A wall span's side face, plane `at` across [s0, s1] along the wall
        // (axis 0: the face lies across x, the wall runs along z; axis 1 the
        // reverse), facing `normal` (+-1), with its bottom edge: plain, or
        // cut round a window or archway, in which case the hole's outline is
        // drawn on it and, if `line_hole`, the hole lined through to the far
        // face at `far`.
        const face = (axis, at, s0, s1, normal, kind, far, line_hole) => {
            const point = (u, v, plane = at) => axis == 0 ? [plane, v, s0 + u] : [s0 + u, v, plane];
            const [nx, nz] = axis == 0 ? [normal, 0] : [0, normal];
            if (kind == 0) {
                quad(point(0, 0), point(0, h), point(s1 - s0, h), point(s1 - s0, 0), nx, 0, nz);
                line(...point(0, 0), ...point(s1 - s0, 0));
                return;
            }
            const shape = this.window_shapes[kind];
            for (const [a, b, c] of shape.tris) {
                const pa = shape.points[a], pb = shape.points[b], pc = shape.points[c];
                tri(point(pa[0], pa[1]), point(pb[0], pb[1]), point(pc[0], pc[1]), nx, 0, nz);
            }
            // An archway's opening reaches the floor: only its jambs have a
            // bottom edge, and where their lining meets the floor too.
            for (const [u0, u1] of shape.jambs ?? [[0, s1 - s0]]) {
                line(...point(u0, 0), ...point(u1, 0));
            }
            const hole = shape.hole;
            const segments = shape.closed ? hole.length : hole.length - 1;
            for (let k = 0; k < segments; k++) {
                const [u0, v0] = hole[k], [u1, v1] = hole[(k + 1) % hole.length];
                line(...point(u0, v0), ...point(u1, v1));
                if (!line_hole) {
                    continue;
                }
                // The hole's lining, facing in (see the shapes' `inward`).
                const [cu, cv] = shape.inward((v0 + v1) / 2);
                const mu = (u0 + u1) / 2 - cu, mv = (v0 + v1) / 2 - cv;
                const len = Math.hypot(mu, mv);
                const [lx, lz] = axis == 0 ? [0, -mu / len] : [-mu / len, 0];
                quad(point(u0, v0), point(u0, v0, far), point(u1, v1, far), point(u1, v1),
                    lx, -mv / len, lz);
                if (kind == 1) {
                    // A rectangle's corners are edges through the wall.
                    line(...point(u0, v0), ...point(u0, v0, far));
                }
            }
            if (kind == 3 && line_hole) {
                for (const [u, v] of [hole[0], hole[hole.length - 1]]) {
                    line(...point(u, v), ...point(u, v, far));
                }
            }
        };

        for (let sz = 0; sz < m; sz++) {
            for (let sx = 0; sx < m; sx++) {
                if (solid(sx, sz)) {
                    quad([e[sx], h, e[sz]], [e[sx], h, e[sz + 1]],
                        [e[sx + 1], h, e[sz + 1]], [e[sx + 1], h, e[sz]], 0, 1, 0);
                }
            }
        }
        for (let a = 0; a < m; a++) {
            for (let b = 0; b <= m; b++) {
                // Boundary x = e[b] across span a in z, between spans b - 1
                // and b in x; then the same with x and z swapped. A window
                // is lined once, from its wall's west / south face.
                // (Only a wall's long faces take its window, not its ends.)
                const west = solid(b - 1, a), east = solid(b, a);
                if (west != east) {
                    const ws = west ? b - 1 : b;
                    const kind = ws % 2 == 0 && a % 2 == 1 ? this.window_kind[ws + a * m] : 0;
                    face(0, e[b], e[a], e[a + 1], west ? 1 : -1, kind, e[east ? b + 1 : b - 1], east);
                    line(e[b], h, e[a], e[b], h, e[a + 1]);
                }
                const south = solid(a, b - 1), north = solid(a, b);
                if (south != north) {
                    const ws = south ? b - 1 : b;
                    const kind = a % 2 == 1 && ws % 2 == 0 ? this.window_kind[a + ws * m] : 0;
                    face(1, e[b], e[a], e[a + 1], south ? 1 : -1, kind, e[north ? b + 1 : b - 1], north);
                    line(e[a], h, e[b], e[a + 1], h, e[b]);
                }
            }
        }
        // Vertical edges where the outline turns: one or three of the four
        // spans round a boundary crossing solid, or two diagonally.
        for (let bz = 0; bz <= m; bz++) {
            for (let bx = 0; bx <= m; bx++) {
                const sw = solid(bx - 1, bz - 1), se = solid(bx, bz - 1);
                const nw = solid(bx - 1, bz), ne = solid(bx, bz);
                const count = sw + se + nw + ne;
                if (count == 1 || count == 3 || (count == 2 && sw == ne)) {
                    line(e[bx], 0, e[bz], e[bx], h, e[bz]);
                }
            }
        }

        // Carpets: a quad each in its hue (a palette colour other than the
        // level's, fixed per room), outlined in the same hue.
        const cpos = this.carpet_geom.getAttribute('position').array;
        const cnrm = this.carpet_geom.getAttribute('normal').array;
        const ccol = this.carpet_geom.getAttribute('color').array;
        const origin = this.uniforms.maze_origin.value;
        const maze = this.levels.maze(this.level);
        const own = LEVEL_COLORS.indexOf(this.levels.color(this.level));
        const hue = new THREE.Color();
        let c = 0;
        for (const room of this.carpets) {
            const pick = Math.floor(maze.cell_random(room.i, room.j, 77) * (LEVEL_COLORS.length - 1));
            hue.set(LEVEL_COLORS[pick >= own ? pick + 1 : pick]);
            const x0 = (room.i - 0.5) * this.cell - origin.x + this.thickness / 2 + CARPET_INSET;
            const z0 = (room.j - 0.5) * this.cell - origin.y + this.thickness / 2 + CARPET_INSET;
            const x1 = (room.i + room.w - 0.5) * this.cell - origin.x - this.thickness / 2 - CARPET_INSET;
            const z1 = (room.j + room.h - 0.5) * this.cell - origin.y - this.thickness / 2 - CARPET_INSET;
            const y = CARPET_Y;
            for (const [px, pz] of [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]]) {
                cpos[c] = px; cpos[c + 1] = y; cpos[c + 2] = pz;
                cnrm[c] = 0; cnrm[c + 1] = 1; cnrm[c + 2] = 0;
                ccol[c] = hue.r; ccol[c + 1] = hue.g; ccol[c + 2] = hue.b;
                c += 3;
            }
            line_color = hue;
            line(x0, y, z0, x0, y, z1);
            line(x0, y, z1, x1, y, z1);
            line(x1, y, z1, x1, y, z0);
            line(x1, y, z0, x0, y, z0);
            line_color = this.color;
        }

        this.fill_geom.setDrawRange(0, f / 3);
        this.fill_geom.getAttribute('position').needsUpdate = true;
        this.fill_geom.getAttribute('normal').needsUpdate = true;
        this.line_geom.setDrawRange(0, l / 3);
        this.line_geom.getAttribute('position').needsUpdate = true;
        this.line_geom.getAttribute('line_color').needsUpdate = true;
        this.carpet_geom.setDrawRange(0, c / 3);
        for (const name of ['position', 'normal', 'color']) {
            this.carpet_geom.getAttribute(name).needsUpdate = true;
        }
    }
}
