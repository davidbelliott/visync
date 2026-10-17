import * as THREE from 'three';
import { ResourceLoader } from '../util.js';
import { InstancedProps } from './instanced_props.js';

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
// - Staircases up from the level and down from it (see MazeLevels): solid
//   flights filling their corridor wall to wall, from the floor at the
//   bottom to the wall tops at the top, steps as tall as the walls are
//   thick. The flight down from a level shows as a hole in the floor (cut
//   out of the floor fill), lined down to the level below on its two sides,
//   with the steps going down inside it.
// - Carpets in the rooms: a rectangle in the level's colour, outlined in it,
//   either plain or patterned (see CARPET_PATTERNS), its brightness varying
//   with simplex noise.
// - Potted bonsai in some rooms (MazeLevels.plant): solid, filling the
//   middle of a cell nothing can enter, part of the walls' fill and edges
//   (see bonsai_templates).
// - Paintings on some walls (MazeLevels.painting): a rectangle of noise just
//   off the wall's face, outlined.
// - The floor: a dithered fill whose opacity follows simplex noise.
//
// Fog of war: edges fade with distance from a point (set_viewer), eased
// between fog_near and fog_far (unless made with fog_edges false: then they
// are drawn at full intensity everywhere); the floor too. The rest is lit (e.g. by a
// light whose range ends at fog_far), so it darkens with distance. Walls and
// stairs cast shadows (while the level is mostly faded in: one level casts
// at a time), and everything lit receives them. Each level's walls stand its
// own height (MazeLevels.params: a multiple of the standard height).

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
// Carpet patterns, picked per room (world units): 0 plain; 1 a checkerboard
// of CHECKER_TILE squares from the carpet's corner, the carpet's colour and
// black (as the drum kit's rug, in black and white), drawn in its shader; 2 rows of zigzags, ZIGZAG_ROW apart,
// ZIGZAG_AMP deep, one zig per ZIGZAG_PERIOD; 3 ice cream cones CONE_SIZE
// tall on an equilateral triangle grid CONE_SPACING apart (wider than a cone,
// CONE_SIZE * 0.47, so neighbours never touch), every other one along a row
// upside down. The line patterns are 1 px wireframe (the edge lines, in the
// carpet's hue), whole zigs and cones only, centred on the carpet, over a
// ground PATTERN_GROUND as bright as a plain carpet; up to
// MAX_PATTERN_LINES segments in all (past that, carpets are left plain).
const CARPET_PATTERNS = 4;
const CHECKER_TILE = 1;
const ZIGZAG_ROW = 1;
const ZIGZAG_AMP = 0.4;
const ZIGZAG_PERIOD = 1;
const CONE_SIZE = 1;
const CONE_SPACING = 1.2;
const CONE_SCOOP_SEGMENTS = 8;
const PATTERN_GROUND = 0.2;
const MAX_PATTERN_LINES = 32768;
// The floor's opacity follows simplex noise: FLOOR_MIN where it is below
// FLOOR_NOISE_LO, FLOOR_MAX above FLOOR_NOISE_HI (noise in about [-1, 1]), in
// patches FLOOR_NOISE_SIZE world units across. FLOOR_SIZE: its extent.
const FLOOR_MIN = 0.1;
const FLOOR_MAX = 0.25;
const FLOOR_NOISE_LO = -0.3;
const FLOOR_NOISE_HI = 0.7;
const FLOOR_NOISE_SIZE = 25;
const FLOOR_SIZE = 400;

// Per window (archways count as windows here), sized for the widest window
// (half 9, with unfogged edges): ~70 windows and ~25 archways typical; past
// MAX_WINDOWS the rest are left out, which bounds the buffers.
const MAX_WINDOWS = 160;
const MAX_STAIRS = 32;      // per flight length
const MAX_HOLES = 16;       // flights down; must match the floor shader
// Flight lengths (cells, = the lower level's height in standard heights).
const STAIR_LENGTHS = [1, 2, 3];
const MAX_CARPETS = 24;
// Bonsai (see bonsai_templates), world units: scaled BONSAI_SCALE[0..1] by
// their room's draw, outlined where faces meet at more than BONSAI_EDGE_ANGLE
// deg. Up to MAX_PLANTS.
const BONSAI_SCALE = [0.95, 1.1];
// Their pots' half-width (at scale 1), and how far round a pot the carpet's
// pattern lines are left out: a pot stands on the carpet, and lines just
// behind its walls would pass the depth test there (the fills are pushed back
// so edges on them draw), shimmering through its foot.
const POT_HALF = 0.55;
const POT_CLEAR = 0.25;
const BONSAI_EDGE_ANGLE = 20;
const MAX_PLANTS = 12;
// Paintings: PAINTING_W of their wall span's length wide, PAINTING_H standard
// heights tall, centred PAINTING_V standard heights up (eye level, however
// tall the walls), PAINTING_OFFSET off the wall's face. Their noise in
// patches PAINTING_NOISE world units across, between PAINTING_DARK and 1 of
// the lit colour. Up to MAX_PAINTINGS.
const PAINTING_W = 0.45;
const PAINTING_H = 0.35;
const PAINTING_V = 0.55;
const PAINTING_OFFSET = 0.03;
const PAINTING_NOISE = 0.35;
const PAINTING_DARK = 0.1;
const MAX_PAINTINGS = 48;

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

// Call seg(ax, az, bx, bz) for each line of carpet pattern `pattern` (see
// CARPET_PATTERNS; none for the shader's) on the carpet x0..x1, z0..z1.
function carpet_pattern(pattern, x0, z0, x1, z1, seg) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (pattern == 2) {
        // Zigzags along x: whole half-periods, rows whole within the carpet.
        const half = ZIGZAG_PERIOD / 2;
        const runs = Math.floor((x1 - x0) / half);
        const rows = Math.floor((z1 - z0 - ZIGZAG_AMP) / ZIGZAG_ROW) + 1;
        const sx = cx - runs * half / 2;
        const sz = cz - ((rows - 1) * ZIGZAG_ROW + ZIGZAG_AMP) / 2;
        for (let r = 0; r < rows; r++) {
            const z = sz + r * ZIGZAG_ROW;
            for (let k = 0; k < runs; k++) {
                seg(sx + k * half, z + (k % 2) * ZIGZAG_AMP,
                    sx + (k + 1) * half, z + ((k + 1) % 2) * ZIGZAG_AMP);
            }
        }
    } else if (pattern == 3) {
        // Cones on a triangle grid centred on the carpet (rows sqrt(3)/2
        // spacings apart, odd rows shifted half a spacing), those whole
        // within it. Shape in cone heights about its centre, +v towards +z
        // (flipped for upside-down ones): the cone's apex, its rim, and the
        // scoop's arc over the rim, round (0, SCOOP_V).
        const S = CONE_SPACING, H = CONE_SIZE, pitch = S * Math.sqrt(3) / 2;
        const APEX = -0.5, RIM_U = 0.22, RIM_V = 0.12, SCOOP_V = 0.2;
        const scoop_r = Math.hypot(RIM_U, RIM_V - SCOOP_V);
        const a0 = Math.atan2(RIM_V - SCOOP_V, RIM_U);
        const half_w = Math.max(RIM_U, scoop_r) * H, half_h = 0.5 * H;
        const rows = Math.floor((z1 - z0 - 2 * half_h) / pitch / 2);
        const cols = Math.ceil((x1 - x0) / S / 2) + 1;
        for (let r = -rows; r <= rows; r++) {
            const z = cz + r * pitch, shift = Math.abs(r) % 2 ? S / 2 : 0;
            for (let k = -cols; k <= cols; k++) {
                const x = cx + k * S + shift;
                if (x - half_w < x0 || x + half_w > x1) {
                    continue;
                }
                const flip = (k + (shift ? 1 : 0) + 2 * cols) % 2 ? -H : H;
                const at = (u, v) => [x + u * H, z + v * flip];
                seg(...at(0, APEX), ...at(-RIM_U, RIM_V));
                seg(...at(0, APEX), ...at(RIM_U, RIM_V));
                seg(...at(-RIM_U, RIM_V), ...at(RIM_U, RIM_V));
                for (let q = 0; q < CONE_SCOOP_SEGMENTS; q++) {
                    const t0 = a0 + (Math.PI - 2 * a0) * q / CONE_SCOOP_SEGMENTS;
                    const t1 = a0 + (Math.PI - 2 * a0) * (q + 1) / CONE_SCOOP_SEGMENTS;
                    seg(...at(scoop_r * Math.cos(t0), SCOOP_V + scoop_r * Math.sin(t0)),
                        ...at(scoop_r * Math.cos(t1), SCOOP_V + scoop_r * Math.sin(t1)));
                }
            }
        }
    }
}

// The two potted bonsai, origin on the floor under the pot's middle, about
// 4.5 world units tall (taller than a standard wall), as non-indexed
// triangles with flat normals (pos, nrm) and their edges (edges, segment
// endpoints): 0, a topiary, an upward cone on a round bottom on a stick; 1, a
// trunk with branches up to three spherical puffs at different heights. Both
// in the same straight-sided square pot. Low-poly, as the house style.
function bonsai_templates() {
    const parts = (list) => {
        const pos = [];
        for (const [geom, x, y, z, quat] of list) {
            const g = geom.index ? geom.toNonIndexed() : geom;
            if (quat) {
                g.applyQuaternion(quat);
            }
            g.translate(x, y, z);
            pos.push(...g.getAttribute('position').array);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geom.computeVertexNormals();        // flat: the triangles are unshared
        return {
            pos: geom.getAttribute('position').array,
            nrm: geom.getAttribute('normal').array,
            edges: new THREE.EdgesGeometry(geom, BONSAI_EDGE_ANGLE).getAttribute('position').array,
        };
    };
    // The pot: a four-sided cylinder turned square to the grid, its walls
    // vertical (1.1 across).
    const POT_H = 1.0;
    const pot = new THREE.CylinderGeometry(POT_HALF * Math.SQRT2, POT_HALF * Math.SQRT2, POT_H, 4)
        .rotateY(Math.PI / 4);
    const pot_part = [pot, 0, POT_H / 2, 0];
    // A cylinder from a to b (radius r), for trunks and branches.
    const limb = (a, b, r0, r1) => {
        const d = new THREE.Vector3().subVectors(b, a);
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
        return [new THREE.CylinderGeometry(r1, r0, d.length(), 6, 1, true), mid.x, mid.y, mid.z, quat];
    };
    const v = (x, y, z) => new THREE.Vector3(x, y, z);
    const topiary = parts([
        pot_part,
        limb(v(0, POT_H, 0), v(0, 2.5, 0), 0.1, 0.08),
        // Round bottom (a half sphere, cup down) under an upward cone.
        [new THREE.SphereGeometry(0.95, 8, 3, 0, 2 * Math.PI, Math.PI / 2, Math.PI / 2), 0, 2.6, 0],
        [new THREE.ConeGeometry(0.95, 1.9, 8, 1, true), 0, 2.6 + 0.95, 0],
    ]);
    const puffs = [[v(0, 4.0, 0.1), 0.85], [v(0.95, 3.05, -0.2), 0.62], [v(-0.85, 2.35, 0.3), 0.55]];
    const tree = parts([
        pot_part,
        limb(v(0, POT_H, 0), v(0.05, 3.7, 0.1), 0.2, 0.12),
        limb(v(0.04, 2.8, 0.05), puffs[1][0], 0.08, 0.06),
        limb(v(0.02, 2.1, 0.05), puffs[2][0], 0.08, 0.06),
        ...puffs.map(([c, r]) => [new THREE.IcosahedronGeometry(r, 1), c.x, c.y, c.z]),
    ]);
    return [topiary, tree];
}

export class MazeLevel extends THREE.Group {
    // levels: MazeLevels. cell: grid pitch; thickness: the walls'; height:
    // the standard wall height, which a level's own is a multiple of (world
    // units). half: cells drawn either side of the centre cell.
    // fog_edges: whether the edges (wireframe) fade with the fog too.
    constructor(levels, { cell, thickness, height, half, fog_near, fog_far, fog_edges = true }) {
        super();
        this.levels = levels;
        this.level = 0;
        this.walls = null;          // the walls' mesh, once the shaders load
        this.casting = true;        // whether its walls and stairs cast shadows
        this.cell = cell;
        this.thickness = thickness;
        this.base_height = height;
        this.height = height;       // this level's walls (set_level)
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
            fog_edges: { value: fog_edges },
            // Where this group's origin is in the maze (world units), so
            // noise patterns stay fixed to the maze as the window moves.
            maze_origin: { value: new THREE.Vector2() },
            // The holes down to staircases, cut out of the floor: (x0, z0, x1, z1)
            // each, the first hole_count of them.
            holes: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector4()) },
            hole_count: { value: 0 },
        };

        // Window panels: each kind's wall face (u along the wall, v up) cut
        // round its hole, triangulated, and the hole's outline.
        // They depend on the wall height, so are made per height.
        this.shapes_by_height = new Map();
        this.window_shapes = this.shapes_for(this.height);

        // Worst cases: every span's top, every boundary a side face (a window
        // panel at most a few dozen triangles more), edges along every
        // boundary top and bottom, verticals at every crossing, and window
        // outlines.
        const boundaries = 2 * m * (m + 1);
        // The bonsai's templates (see bonsai_templates), and the most room
        // either takes in the fill and the edges.
        this.bonsai = bonsai_templates();
        const bonsai_tris = Math.max(...this.bonsai.map((b) => b.pos.length / 9));
        const bonsai_lines = Math.max(...this.bonsai.map((b) => b.edges.length / 6));
        // A window adds its two faces' cut-round panels and its lining.
        const panel_tris = 2 * this.window_shapes[2].tris.length + 2 * WINDOW_ROUND_SEGMENTS;
        const max_tris = 2 * (m * m + boundaries) + panel_tris * MAX_WINDOWS + 4 * MAX_HOLES +
            bonsai_tris * MAX_PLANTS;
        this.fill_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'normal']) {
            const attr = new THREE.BufferAttribute(new Float32Array(max_tris * 9), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.fill_geom.setAttribute(name, attr);
        }
        const max_lines = 2 * boundaries + (m + 1) * (m + 1) + 2 * WINDOW_ROUND_SEGMENTS * MAX_WINDOWS +
            4 * MAX_CARPETS + 2 * MAX_HOLES + MAX_PATTERN_LINES + 4 * MAX_PAINTINGS +
            bonsai_lines * MAX_PLANTS;
        this.line_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'line_color']) {
            const attr = new THREE.BufferAttribute(new Float32Array(max_lines * 6), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.line_geom.setAttribute(name, attr);
        }
        this.carpet_geom = new THREE.BufferGeometry();
        // carpet_info: (u, v) world units from the carpet's corner, pattern.
        for (const name of ['position', 'normal', 'color', 'carpet_info']) {
            const attr = new THREE.BufferAttribute(new Float32Array(MAX_CARPETS * 18), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.carpet_geom.setAttribute(name, attr);
        }

        // Paintings: a quad each; painting_info: (u, v) world units from its
        // corner, and its noise's seed.
        this.painting_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'painting_info']) {
            const attr = new THREE.BufferAttribute(new Float32Array(MAX_PAINTINGS * 18), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.painting_geom.setAttribute(name, attr);
        }
        // Bonsai in the window, as [x, z, kind, turn (rad), scale], written
        // into the walls' fill and the edges by emit().
        this.plants = [];

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
                'uniform bool fog_edges;',
                'varying vec3 v_color;',
                'void main() {',
                '    gl_FragColor = vec4(v_color, (fog_edges ? fog_alpha() : 1.0) * opacity_all);',
                '    #include <colorspace_fragment>',
                '}',
            ].join('\n'),
            transparent: true,
            depthWrite: false,
        });
        const lines = new THREE.LineSegments(this.line_geom, line_mat);
        lines.frustumCulled = false;
        this.add(lines);

        // Staircases: a unit flight per length (steps as tall as the walls
        // are thick, so twice as many on a two-cell flight), posed and
        // stretched per staircase; and the ones in the window, per length,
        // as [Matrix4, x, z].
        this.stairs = new Map();
        this.stair_lists = new Map();
        for (const k of STAIR_LENGTHS) {
            const steps = Math.round(k * height / thickness);
            const props = new InstancedProps(this.flight_geometry(steps),
                { color: this.color, max: MAX_STAIRS, shadows: true });
            this.stairs.set(k, props);
            this.stair_lists.set(k, []);
            this.add(props);
        }
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
                        '\nuniform vec2 maze_origin;\nuniform vec4 holes[' + MAX_HOLES + '];' +
                        '\nuniform int hole_count;'
                    ).replace(
                        '#include <dithering_fragment>',
                        dither
                    ).replace(
                        '#include <clipping_planes_fragment>',
                        '#include <clipping_planes_fragment>\n' + extra_frag
                    );
                };
                // three caches compiled programs by onBeforeCompile's source,
                // which is the same for every material made here: key them by
                // their own fragment code too, or they'd share one program.
                mat.customProgramCacheKey = () => extra_frag;
                return mat;
            };
            const fade = 'if (opacity_all < 1.0 && dither4x4(gl_FragCoord.xy, opacity_all) < 0.5) discard;';
            this.wall_mat = fill_material({ color: this.color }, 1, fade);
            this.walls = new THREE.Mesh(this.fill_geom, this.wall_mat);
            this.walls.frustumCulled = false;
            this.walls.castShadow = this.casting;
            this.walls.receiveShadow = true;
            this.add(this.walls);

            // Carpets: per-vertex hue and pattern (see CARPET_PATTERNS),
            // darkened by noise in maze coordinates.
            const carpet_mat = fill_material({ vertexColors: true }, 1, fade);
            const carpet_frag = carpet_mat.onBeforeCompile;
            const f = (x) => x.toFixed(3);
            carpet_mat.onBeforeCompile = (shader) => {
                carpet_frag(shader);
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'attribute vec3 carpet_info;\nvarying vec3 v_carpet;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nv_carpet = carpet_info;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <common>',
                    [
                        '#include <common>',
                        'varying vec3 v_carpet;',
                    ].join('\n')
                ).replace(
                    '#include <color_fragment>',
                    [
                        '#include <color_fragment>',
                        'float pattern = v_carpet.z;',
                        'if (pattern > 1.5) {',
                        // Lines (drawn as edges): a dark ground.
                        `    diffuseColor.rgb *= ${f(PATTERN_GROUND)};`,
                        '} else if (pattern > 0.5) {',
                        // Checkerboard, the level's colour and black.
                        `    vec2 t = floor(v_carpet.xy / ${f(CHECKER_TILE)});`,
                        '    diffuseColor.rgb *= mod(t.x + t.y, 2.0);',
                        '}',
                        `diffuseColor.rgb *= mix(${f(CARPET_DARK)}, 1.0, ` +
                        `0.5 + 0.5 * snoise((v_xz + maze_origin) / ${f(CARPET_NOISE_SIZE)}));`,
                    ].join('\n')
                );
            };
            carpet_mat.customProgramCacheKey = () => 'carpet' + fade;
            const carpets = new THREE.Mesh(this.carpet_geom, carpet_mat);
            carpets.frustumCulled = false;
            carpets.receiveShadow = true;
            this.add(carpets);

            // Paintings: lit noise (see PAINTING_NOISE) in the level's colour.
            const painting_mat = this.painting_mat = fill_material({ color: this.color }, 1, fade);
            const painting_frag = painting_mat.onBeforeCompile;
            painting_mat.onBeforeCompile = (shader) => {
                painting_frag(shader);
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    'attribute vec3 painting_info;\nvarying vec3 v_paint;\n#include <common>'
                ).replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\nv_paint = painting_info;'
                );
                shader.fragmentShader = shader.fragmentShader.replace(
                    '#include <common>',
                    '#include <common>\nvarying vec3 v_paint;'
                ).replace(
                    '#include <color_fragment>',
                    '#include <color_fragment>\n' +
                    `diffuseColor.rgb *= mix(${f(PAINTING_DARK)}, 1.0, ` +
                    `0.5 + 0.5 * snoise(v_paint.xy / ${f(PAINTING_NOISE)} + v_paint.z * 97.0));`
                );
            };
            painting_mat.customProgramCacheKey = () => 'painting' + fade;
            const paintings = new THREE.Mesh(this.painting_geom, painting_mat);
            paintings.frustumCulled = false;
            paintings.receiveShadow = true;
            this.add(paintings);

            // The floor: opacity from noise, faded with the fog and level.
            // Pushed back past the walls' bottom edges.
            this.floor_mat = fill_material({ color: this.color }, 2,
                'for (int k = 0; k < ' + MAX_HOLES + '; k++) {\n' +
                '    if (k >= hole_count) break;\n' +
                '    vec4 hole = holes[k];\n' +
                '    if (v_xz.x > hole.x && v_xz.x < hole.z && v_xz.y > hole.y && v_xz.y < hole.w) discard;\n' +
                '}\n' +
                'float floor_alpha = mix(' + FLOOR_MIN.toFixed(2) + ', ' + FLOOR_MAX.toFixed(2) +
                ', smoothstep(' + FLOOR_NOISE_LO.toFixed(2) + ', ' + FLOOR_NOISE_HI.toFixed(2) +
                ', snoise((v_xz + maze_origin) / ' + FLOOR_NOISE_SIZE.toFixed(1) + ')))' +
                ' * fog_alpha() * opacity_all;\n' +
                'if (dither4x4(gl_FragCoord.xy, floor_alpha) < 0.5) discard;');
            const floor_geom = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2);
            const floor = new THREE.Mesh(floor_geom, this.floor_mat);
            floor.receiveShadow = true;
            this.add(floor);
        });
    }

    // Show level L: its colour, on everything (the walls are rebuilt by
    // build()). The fills' materials hold copies of the colour.
    set_level(level) {
        this.level = level;
        this.color.set(this.levels.color(level));
        for (const props of this.stairs.values()) {
            props.set_color(this.color);
        }
        const params = this.levels.params(level);
        this.height = this.base_height * params.height;
        this.window_shapes = this.shapes_for(this.height);
        for (const mat of [this.wall_mat, this.floor_mat, this.painting_mat]) {
            mat?.color.copy(this.color);
        }
    }

    // The fog's centre, in this group's frame (x, z).
    set_viewer(x, z) {
        this.uniforms.fog_centre.value.set(x, z);
    }

    // Fade the whole level, 0..1.
    set_opacity(opacity) {
        this.uniforms.opacity_all.value = opacity;
        this.visible = opacity > 0;
        this.casting = opacity > 0.5;
        if (this.walls) {
            this.walls.castShadow = this.casting;
        }
        for (const props of this.stairs.values()) {
            props.cast_shadows(this.casting);
        }
    }

    // Per frame: fade the stairs with the level (only: they stand solid, as
    // the walls do, however far off).
    update() {
        const { fog_centre, fog_near, fog_far, opacity_all, fog_edges } = this.uniforms;
        const fog = (x, z) => {
            const d = Math.hypot(x - fog_centre.value.x, z - fog_centre.value.y);
            const f = Math.min(1, Math.max(0, (fog_far.value - d) / (fog_far.value - fog_near.value)));
            return (0.5 - 0.5 * Math.cos(Math.PI * f)) * opacity_all.value;
        };
        for (const [k, props] of this.stairs) {
            props.begin();
            for (const [matrix, x, z] of this.stair_lists.get(k)) {
                props.add_instance(matrix, opacity_all.value,
                    fog_edges.value ? fog(x, z) : opacity_all.value);
            }
            props.end();
        }
    }

    // The window panels for walls `height` tall: [none, rect, round, arch].
    shapes_for(height) {
        let shapes = this.shapes_by_height.get(height);
        if (shapes === undefined) {
            const keep = this.height;
            this.height = height;
            shapes = [null, this.window_shape(1), this.window_shape(2), this.arch_shape()];
            this.height = keep;
            this.shapes_by_height.set(height, shapes);
        }
        return shapes;
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

    // A unit flight of `steps` stairs: x across -0.5..0.5, z along 0..1,
    // solid beneath, the top step at y = 1 ending at z = 1 (its side profile
    // extruded across x).
    flight_geometry(steps) {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(1, 0);
        shape.lineTo(1, 1);
        for (let k = steps; k >= 1; k--) {
            shape.lineTo((k - 1) / steps, k / steps);
            if (k > 1) {
                shape.lineTo((k - 1) / steps, (k - 1) / steps);
            }
        }
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

        // Staircases up from this level (rising its wall height) and down
        // from it (sunk the lower level's), both a flight as many cells long
        // as the height they climb is standard heights.
        for (const list of this.stair_lists.values()) {
            list.length = 0;
        }
        this.holes = [];            // [i, j, uphill, k] per flight down, for emit()
        let n = 0;
        for (const [low_level, below] of [[level, false], [level - 1, true]]) {
            for (const st of levels.stairs_in(low_level, ci + lo, cj + lo, ci + hi, cj + hi)) {
                const [i, j] = [st.cells[0][0] - ci, st.cells[0][1] - cj];
                const list = this.stair_lists.get(st.k);
                if (i < lo || i > hi || j < lo || j > hi || list.length >= MAX_STAIRS) {
                    continue;
                }
                const rise = st.k * this.base_height;
                if (below) {
                    if (this.holes.length >= MAX_HOLES) {
                        continue;
                    }
                    this.holes.push([i, j, st.dir, st.k]);
                }
                n = this.add_stairs(n, st, i, j, below ? -rise : 0, rise);
            }
        }
        // The holes' openings, between the walls round them, for the floor.
        const half_in = (cell - t) / 2;
        this.holes.forEach(([i, j, [di, dj], k], h) => {
            const far_i = i + di * (k - 1), far_j = j + dj * (k - 1);
            this.uniforms.holes.value[h].set(
                Math.min(i, far_i) * cell - half_in, Math.min(j, far_j) * cell - half_in,
                Math.max(i, far_i) * cell + half_in, Math.max(j, far_j) * cell + half_in);
        });
        this.uniforms.hole_count.value = this.holes.length;

        // Carpets in the rooms overlapping the window, and their plants.
        this.carpets = maze.rooms_in(ci + lo, cj + lo, ci + hi, cj + hi).slice(0, MAX_CARPETS);
        this.plants.length = 0;
        for (const room of this.carpets) {
            const plant = levels.plant(level, room);
            if (plant === null || this.plants.length >= MAX_PLANTS) {
                continue;
            }
            this.plants.push([(plant.i - ci) * cell, (plant.j - cj) * cell, plant.kind,
                plant.turn * Math.PI / 2,
                BONSAI_SCALE[0] + (BONSAI_SCALE[1] - BONSAI_SCALE[0]) * plant.size]);
        }
        this.ci = ci;
        this.cj = cj;
        this.emit();
    }

    // Pose staircase st, its first cell at relative (i, j), from height base
    // up `rise` along its uphill direction: from the wall line at its bottom
    // to the face of the wall past its last cell, and between the faces of
    // the walls either side.
    add_stairs(n, st, i, j, base, rise) {
        const cell = this.cell, t = this.thickness, [di, dj] = st.dir;
        const dummy = this.dummy;
        dummy.rotation.set(0, Math.atan2(di, dj), 0);
        dummy.scale.set(cell - t, rise, st.k * cell - t / 2);
        const x = i * cell, z = j * cell;
        dummy.position.set(x - di * cell / 2, base, z - dj * cell / 2);
        dummy.updateMatrix();
        // Fogged by its middle.
        const mid = (st.k - 1) / 2;
        this.stair_lists.get(st.k).push([this.pooled_matrix(n).copy(dummy.matrix),
            x + di * mid * cell, z + dj * mid * cell]);
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
        // face at `far`. A plain face with a painting seed (`paint`, else
        // null) has a painting hung on it.
        const ppos = this.painting_geom.getAttribute('position').array;
        const pnrm = this.painting_geom.getAttribute('normal').array;
        const pinfo = this.painting_geom.getAttribute('painting_info').array;
        let pc = 0;     // painting floats written
        const face = (axis, at, s0, s1, normal, kind, far, line_hole, paint = null) => {
            const point = (u, v, plane = at) => axis == 0 ? [plane, v, s0 + u] : [s0 + u, v, plane];
            const [nx, nz] = axis == 0 ? [normal, 0] : [0, normal];
            if (kind == 0) {
                quad(point(0, 0), point(0, h), point(s1 - s0, h), point(s1 - s0, 0), nx, 0, nz);
                line(...point(0, 0), ...point(s1 - s0, 0));
                if (paint !== null && pc < MAX_PAINTINGS * 18) {
                    const len = s1 - s0, w = PAINTING_W * len;
                    const ph = PAINTING_H * this.base_height, pv = PAINTING_V * this.base_height;
                    const u0 = (len - w) / 2, u1 = u0 + w, v0 = pv - ph / 2, v1 = pv + ph / 2;
                    const off = at + normal * PAINTING_OFFSET;
                    // Two triangles, each wound to face out from the wall (as tri()).
                    for (const t of [[[u0, v0], [u0, v1], [u1, v1]], [[u0, v0], [u1, v1], [u1, v0]]]) {
                        const [a, b, c] = t.map(([u, v]) => point(u, v, off));
                        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
                        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                        const along = (uy * vz - uz * vy) * nx + (ux * vy - uy * vx) * nz;
                        const order = along >= 0 ? [0, 1, 2] : [0, 2, 1];
                        for (const k of order) {
                            const [u, v] = t[k];
                            ppos.set(point(u, v, off), pc);
                            pnrm[pc] = nx; pnrm[pc + 1] = 0; pnrm[pc + 2] = nz;
                            pinfo[pc] = u - u0; pinfo[pc + 1] = v - v0; pinfo[pc + 2] = paint;
                            pc += 3;
                        }
                    }
                    line(...point(u0, v0, off), ...point(u0, v1, off));
                    line(...point(u0, v1, off), ...point(u1, v1, off));
                    line(...point(u1, v1, off), ...point(u1, v0, off));
                    line(...point(u1, v0, off), ...point(u0, v0, off));
                }
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
                // A long wall face's wall is the east / north edge of an
                // absolute cell (see build's spans), which fixes its painting.
                const west = solid(b - 1, a), east = solid(b, a);
                if (west != east) {
                    const ws = west ? b - 1 : b, normal = west ? 1 : -1;
                    const long = ws % 2 == 0 && a % 2 == 1;
                    const kind = long ? this.window_kind[ws + a * m] : 0;
                    const paint = long && kind == 0 ? this.levels.painting(this.level,
                        this.ci + this.lo - 1 + ws / 2, this.cj + this.lo + (a - 1) / 2, 0, normal) : null;
                    face(0, e[b], e[a], e[a + 1], normal, kind, e[east ? b + 1 : b - 1], east, paint);
                    line(e[b], h, e[a], e[b], h, e[a + 1]);
                }
                const south = solid(a, b - 1), north = solid(a, b);
                if (south != north) {
                    const ws = south ? b - 1 : b, normal = south ? 1 : -1;
                    const long = a % 2 == 1 && ws % 2 == 0;
                    const kind = long ? this.window_kind[a + ws * m] : 0;
                    const paint = long && kind == 0 ? this.levels.painting(this.level,
                        this.ci + this.lo + (a - 1) / 2, this.cj + this.lo - 1 + ws / 2, 1, normal) : null;
                    face(1, e[b], e[a], e[a + 1], normal, kind, e[north ? b + 1 : b - 1], north, paint);
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

        // Bonsai: their templates turned, scaled and stood in their cells,
        // solid with the walls.
        for (const [x, z, kind, turn, scale] of this.plants) {
            const { pos: tp, nrm: tn, edges: te } = this.bonsai[kind];
            const cs = Math.cos(turn), sn = Math.sin(turn);
            const place = (src, k) => [x + (src[k] * cs + src[k + 2] * sn) * scale,
                src[k + 1] * scale, z + (src[k + 2] * cs - src[k] * sn) * scale];
            for (let k = 0; k < tp.length; k += 9) {
                tri(place(tp, k), place(tp, k + 3), place(tp, k + 6),
                    tn[k] * cs + tn[k + 2] * sn, tn[k + 1], tn[k + 2] * cs - tn[k] * sn);
            }
            for (let k = 0; k < te.length; k += 6) {
                line(...place(te, k), ...place(te, k + 3));
            }
        }

        // The holes down to staircases: their two sides lined down to the
        // level below (the faces of its walls along the flight, from its open
        // bottom end to the wall past its top), an edge where each ends at
        // the bottom; the steps fill the rest. The rim is the bottom of this
        // level's walls round the hole, and the top step's edge.
        const half_in = (this.cell - this.thickness) / 2;
        for (const [i, j, [di, dj], k] of this.holes) {
            const lh = k * this.base_height;
            const cx = i * this.cell, cz = j * this.cell;
            // Along the flight (u, from its bottom end up, from its first
            // cell's centre) and across it (w): to x, z.
            const at = (u, w, y) => [cx + di * u - dj * w, y, cz + dj * u + di * w];
            const u0 = -this.cell / 2, u1 = (k - 1) * this.cell + half_in;
            for (const side of [-1, 1]) {
                const w = side * half_in;
                // Facing into the hole: across, away from this side.
                const nx = dj * side, nz = -di * side;
                quad(at(u0, w, -lh), at(u0, w, 0), at(u1, w, 0), at(u1, w, -lh), nx, 0, nz);
                line(...at(u0, w, -lh), ...at(u0, w, 0));
            }
        }

        // Carpets: a quad each in the level's colour and a pattern fixed per
        // room, outlined in it.
        const cpos = this.carpet_geom.getAttribute('position').array;
        const cnrm = this.carpet_geom.getAttribute('normal').array;
        const ccol = this.carpet_geom.getAttribute('color').array;
        const cinfo = this.carpet_geom.getAttribute('carpet_info').array;
        const origin = this.uniforms.maze_origin.value;
        const maze = this.levels.maze(this.level);
        const hue = this.color;
        let c = 0, pattern_lines = 0;
        for (const room of this.carpets) {
            let pattern = Math.floor(maze.cell_random(room.i, room.j, 79) * CARPET_PATTERNS);
            const x0 = (room.i - 0.5) * this.cell - origin.x + this.thickness / 2 + CARPET_INSET;
            const z0 = (room.j - 0.5) * this.cell - origin.y + this.thickness / 2 + CARPET_INSET;
            const x1 = (room.i + room.w - 0.5) * this.cell - origin.x - this.thickness / 2 - CARPET_INSET;
            const z1 = (room.j + room.h - 0.5) * this.cell - origin.y - this.thickness / 2 - CARPET_INSET;
            const y = CARPET_Y;
            // Its line pattern, if the budget has room for it all.
            let n = 0;
            carpet_pattern(pattern, x0, z0, x1, z1, () => n++);
            if (pattern_lines + n > MAX_PATTERN_LINES) {
                pattern = 0;
            } else {
                pattern_lines += n;
                line_color = hue;
                // Not under the pots (see POT_CLEAR).
                const under_pot = (ax, az, bx, bz) => this.plants.some(([px, pz, , , scale]) => {
                    const r = POT_HALF * scale + POT_CLEAR;
                    return Math.max(ax, bx) > px - r && Math.min(ax, bx) < px + r &&
                        Math.max(az, bz) > pz - r && Math.min(az, bz) < pz + r;
                });
                carpet_pattern(pattern, x0, z0, x1, z1, (ax, az, bx, bz) => {
                    if (!under_pot(ax, az, bx, bz)) {
                        line(ax, y, az, bx, y, bz);
                    }
                });
                line_color = this.color;
            }
            for (const [px, pz] of [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]]) {
                cpos[c] = px; cpos[c + 1] = y; cpos[c + 2] = pz;
                cnrm[c] = 0; cnrm[c + 1] = 1; cnrm[c + 2] = 0;
                ccol[c] = hue.r; ccol[c + 1] = hue.g; ccol[c + 2] = hue.b;
                cinfo[c] = px - x0; cinfo[c + 1] = pz - z0; cinfo[c + 2] = pattern;
                c += 3;
            }
            line_color = hue;
            line(x0, y, z0, x0, y, z1);
            line(x0, y, z1, x1, y, z1);
            line(x1, y, z1, x1, y, z0);
            line(x1, y, z0, x0, y, z0);
            line_color = this.color;
        }

        this.painting_geom.setDrawRange(0, pc / 3);
        for (const name of ['position', 'normal', 'painting_info']) {
            this.painting_geom.getAttribute(name).needsUpdate = true;
        }

        this.fill_geom.setDrawRange(0, f / 3);
        this.fill_geom.getAttribute('position').needsUpdate = true;
        this.fill_geom.getAttribute('normal').needsUpdate = true;
        this.line_geom.setDrawRange(0, l / 3);
        this.line_geom.getAttribute('position').needsUpdate = true;
        this.line_geom.getAttribute('line_color').needsUpdate = true;
        this.carpet_geom.setDrawRange(0, c / 3);
        for (const name of ['position', 'normal', 'color', 'carpet_info']) {
            this.carpet_geom.getAttribute(name).needsUpdate = true;
        }
    }
}
