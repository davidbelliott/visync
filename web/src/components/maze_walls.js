import * as THREE from 'three';
import { ShaderLoader } from '../util.js';

// A window of an InfiniteMaze's walls, drawn as one solid: a lit, dithered
// fill outlined only along its true edges. Walls run between posts at the
// cells' corners, all axis-aligned and the same height, so their union is
// one footprint shape extruded upwards. build() lays that footprint out on a
// grid alternating post widths and wall spans, then emits only the faces and
// edges of the union: top faces, side faces where solid meets empty, outline
// edges along the same boundaries at the top and bottom, and vertical edges
// where the outline turns a corner. So no lines mark where a wall meets a
// post or carries straight through one, and no faces hide inside the solid.
// Rebuilt into preallocated buffers each time the window moves.
//
// Fog of war: the edges fade with distance from a point (set_viewer), per
// pixel, eased between fog_near and fog_far (world units). The fill is
// solid, lit and shaded through the house dither, so its darkness comes from
// the lighting (e.g. a light whose range ends at fog_far).
export class MazeWalls extends THREE.Group {
    // maze: InfiniteMaze. cell: grid pitch; thickness / height: the walls'
    // (world units). half: cells drawn either side of the centre cell.
    // color: THREE.Color of fill and edges.
    constructor(maze, { cell, thickness, height, half, color, fog_near, fog_far }) {
        super();
        this.maze = maze;
        this.cell = cell;
        this.thickness = thickness;
        this.height = height;
        this.half = half;

        // The footprint grid: cells lo..hi, with the corners either side of
        // each, alternating corner (even index) and cell (odd) spans, so
        // SPANS spans per side and their SPANS + 1 boundaries' coordinates.
        this.lo = -half - 1;
        this.hi = half;
        this.spans = 2 * (this.hi - this.lo + 1) + 1;
        const m = this.spans;
        this.edges_at = new Float32Array(m + 1);
        this.solid = new Uint8Array(m * m);
        // Walls on each cell's east and north sides, for the cells around the
        // grid (one more each way, for the outermost posts).
        this.wall_side = this.hi - this.lo + 3;
        this.east_wall = new Uint8Array(this.wall_side * this.wall_side);
        this.north_wall = new Uint8Array(this.wall_side * this.wall_side);

        this.fog_uniforms = {
            fog_centre: { value: new THREE.Vector2() },
            fog_near: { value: fog_near },
            fog_far: { value: fog_far },
        };

        // Worst cases: every span's top, every boundary a side face, edges
        // along every boundary top and bottom, and a vertical at every
        // boundary crossing.
        const boundaries = 2 * m * (m + 1);
        const max_quads = m * m + boundaries;
        this.fill_geom = new THREE.BufferGeometry();
        for (const name of ['position', 'normal']) {
            const attr = new THREE.BufferAttribute(new Float32Array(max_quads * 18), 3);
            attr.setUsage(THREE.DynamicDrawUsage);
            this.fill_geom.setAttribute(name, attr);
        }
        this.line_geom = new THREE.BufferGeometry();
        const line_pos = new THREE.BufferAttribute(
            new Float32Array((2 * boundaries + (m + 1) * (m + 1)) * 6), 3);
        line_pos.setUsage(THREE.DynamicDrawUsage);
        this.line_geom.setAttribute('position', line_pos);

        // The fog, given each point's footprint position (x, z).
        const fog_glsl = [
            'uniform vec2 fog_centre;',
            'uniform float fog_near;',
            'uniform float fog_far;',
            'varying vec2 v_xz;',
            'float fog_alpha() {',
            '    float f = clamp((fog_far - distance(v_xz, fog_centre)) / (fog_far - fog_near), 0.0, 1.0);',
            '    return 0.5 - 0.5 * cos(3.14159265 * f);',
            '}',
        ].join('\n');

        // Edges: blended, in front of the fill (which is pushed back).
        const line_mat = new THREE.ShaderMaterial({
            uniforms: { ...this.fog_uniforms, color: { value: color } },
            vertexShader: [
                'varying vec2 v_xz;',
                'void main() {',
                '    v_xz = position.xz;',
                '    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
                '}',
            ].join('\n'),
            fragmentShader: [
                'uniform vec3 color;',
                fog_glsl,
                'void main() {',
                '    gl_FragColor = vec4(color, fog_alpha());',
                '    #include <colorspace_fragment>',
                '}',
            ].join('\n'),
            transparent: true,
            depthWrite: false,
        });
        const lines = new THREE.LineSegments(this.line_geom, line_mat);
        lines.frustumCulled = false;
        this.add(lines);

        // Fill: solid, lit and shaded through the house dither, pushed back
        // so the edges on its surface draw. Added once the dither chunks
        // load.
        new ShaderLoader('glsl/chunks/dither_pars.frag', 'glsl/chunks/dither.frag').load().then(
            ([dither_pars, dither]) => {
                const fill_mat = new THREE.MeshLambertMaterial({
                    color: color,
                    polygonOffset: true,
                    polygonOffsetFactor: 1,
                    polygonOffsetUnits: 1,
                });
                fill_mat.onBeforeCompile = (shader) => {
                    shader.fragmentShader = shader.fragmentShader.replace(
                        '#include <dithering_pars_fragment>',
                        dither_pars
                    ).replace(
                        '#include <dithering_fragment>',
                        dither
                    );
                };
                const fill = new THREE.Mesh(this.fill_geom, fill_mat);
                fill.frustumCulled = false;
                this.add(fill);
            });
    }

    // The fog's centre, in this group's frame (x, z).
    set_viewer(x, z) {
        this.fog_uniforms.fog_centre.value.set(x, z);
    }

    // Lay out the window around cell (ci, cj), in coordinates relative to
    // it (so they stay small however far the maze is explored).
    build(ci, cj) {
        const { cell, thickness: t, lo, hi, spans: m, wall_side: w } = this;

        // Walls of the cells lo - 1 .. hi + 1 each way.
        for (let a = 0; a < w; a++) {
            for (let b = 0; b < w; b++) {
                const i = ci + lo - 1 + a, j = cj + lo - 1 + b;
                this.east_wall[a + b * w] = this.maze.east_open(i, j) ? 0 : 1;
                this.north_wall[a + b * w] = this.maze.north_open(i, j) ? 0 : 1;
            }
        }
        // Relative cell (i, j)'s east / north wall.
        const east = (i, j) => this.east_wall[(i - lo + 1) + (j - lo + 1) * w];
        const north = (i, j) => this.north_wall[(i - lo + 1) + (j - lo + 1) * w];

        // Span s: even = the corner after cell lo - 1 + s / 2, odd = cell
        // lo + (s - 1) / 2. Boundaries alternate a post's width and a wall's
        // span, starting at the first corner post's near side.
        let x = (lo - 0.5) * cell - t / 2;
        for (let s = 0; s <= m; s++) {
            this.edges_at[s] = x;
            x += s % 2 == 0 ? t : cell - t;
        }
        for (let sz = 0; sz < m; sz++) {
            for (let sx = 0; sx < m; sx++) {
                let solid = 0;
                const corner_x = lo - 1 + sx / 2, corner_z = lo - 1 + sz / 2;
                const cell_x = lo + (sx - 1) / 2, cell_z = lo + (sz - 1) / 2;
                if (sx % 2 == 0 && sz % 2 == 0) {
                    // A post, wherever any wall meets its corner.
                    solid = east(corner_x, corner_z) | east(corner_x, corner_z + 1) |
                        north(corner_x, corner_z) | north(corner_x + 1, corner_z);
                } else if (sx % 2 == 0) {
                    solid = east(corner_x, cell_z);
                } else if (sz % 2 == 0) {
                    solid = north(cell_x, corner_z);
                }
                this.solid[sx + sz * m] = solid;
            }
        }
        this.emit();
    }

    // Write the union's faces and edges from the footprint grid.
    emit() {
        const m = this.spans, e = this.edges_at, h = this.height;
        const solid = (sx, sz) => sx >= 0 && sx < m && sz >= 0 && sz < m && this.solid[sx + sz * m] == 1;
        const pos = this.fill_geom.getAttribute('position').array;
        const nrm = this.fill_geom.getAttribute('normal').array;
        const lines = this.line_geom.getAttribute('position').array;
        let f = 0;      // fill floats written
        let l = 0;      // line floats written
        const quad = (corners, nx, ny, nz) => {
            // corners: 4 points (x, y, z) in order round the quad.
            for (const k of [0, 1, 2, 0, 2, 3]) {
                pos[f] = corners[3 * k];
                pos[f + 1] = corners[3 * k + 1];
                pos[f + 2] = corners[3 * k + 2];
                nrm[f] = nx;
                nrm[f + 1] = ny;
                nrm[f + 2] = nz;
                f += 3;
            }
        };
        const line = (x0, y0, z0, x1, y1, z1) => {
            lines[l] = x0; lines[l + 1] = y0; lines[l + 2] = z0;
            lines[l + 3] = x1; lines[l + 4] = y1; lines[l + 5] = z1;
            l += 6;
        };

        for (let sz = 0; sz < m; sz++) {
            for (let sx = 0; sx < m; sx++) {
                if (solid(sx, sz)) {
                    // Top, wound to face up.
                    quad([e[sx], h, e[sz], e[sx], h, e[sz + 1],
                        e[sx + 1], h, e[sz + 1], e[sx + 1], h, e[sz]], 0, 1, 0);
                }
            }
        }
        for (let a = 0; a < m; a++) {
            for (let b = 0; b <= m; b++) {
                // Boundary x = e[b] across span a in z, between spans b - 1
                // and b in x; then the same with x and z swapped.
                const west = solid(b - 1, a), east = solid(b, a);
                if (west != east) {
                    const x = e[b], z0 = e[a], z1 = e[a + 1];
                    if (west) {
                        quad([x, 0, z0, x, h, z0, x, h, z1, x, 0, z1], 1, 0, 0);
                    } else {
                        quad([x, 0, z1, x, h, z1, x, h, z0, x, 0, z0], -1, 0, 0);
                    }
                    line(x, 0, z0, x, 0, z1);
                    line(x, h, z0, x, h, z1);
                }
                const south = solid(a, b - 1), north = solid(a, b);
                if (south != north) {
                    const z = e[b], x0 = e[a], x1 = e[a + 1];
                    if (south) {
                        quad([x1, 0, z, x1, h, z, x0, h, z, x0, 0, z], 0, 0, 1);
                    } else {
                        quad([x0, 0, z, x0, h, z, x1, h, z, x1, 0, z], 0, 0, -1);
                    }
                    line(x0, 0, z, x1, 0, z);
                    line(x0, h, z, x1, h, z);
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

        this.fill_geom.setDrawRange(0, f / 3);
        this.fill_geom.getAttribute('position').needsUpdate = true;
        this.fill_geom.getAttribute('normal').needsUpdate = true;
        this.line_geom.setDrawRange(0, l / 3);
        this.line_geom.getAttribute('position').needsUpdate = true;
    }
}
