import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Scene, MIDI_SYNCS_PER_BEAT } from './scene.js';
import { Head } from '../components/head.js';
import { MAZE_DIRS } from '../infinite_maze.js';
import { MazeLevels } from '../maze_levels.js';
import { MazeLevel } from '../components/maze_level.js';
import { InstancedProps } from '../components/instanced_props.js';
import { SparkPool } from '../components/spark_pool.js';
import { ISOMETRIC_TILT } from '../stepped_rotation.js';
import { CH_EXPAND_Y } from '../controller_map.js';
import { lerp_scalar, ease, clamp, Spark, PhaseLockedBeats } from '../util.js';

// Rotation (rad): yaw in lockstep with the other stepped scenes (see
// stepped_rotation.js), every 45 deg from a diagonal base; pitch locked at
// the isometric tilt, looking down into the maze. The view pivots on the
// head's centre, which stays in the middle of the screen.
const YAW_BASE = Math.PI / 4;
const PITCH_BASE = ISOMETRIC_TILT;

// The maze (see MazeLevels, MazeLevel), world units: the walls' thickness
// and standard height (a level's walls are a multiple of it, and each level
// stands on top of the walls of the one below). Each level has its own
// layout, colour and character; only the head's level shows, crossfading to
// the next as it takes a staircase.
const WALL_T = 0.5;
const WALL_H = 4;
// The head stands as tall as the walls (the model is ~28 units tall and
// ~19 wide and deep, so ~2.7 across here: it turns easily in a cell).
const HEAD_MODEL_HEIGHT = 27.9;
const HEAD_SCALE = WALL_H / HEAD_MODEL_HEIGHT;
// Corridors CORRIDOR_W world units between the walls, which sets the cell
// pitch (~6.2): sized for the brain this scene first walked (1.5 times its
// width), kept so the fog and maze window (below) stay tuned.
const CORRIDOR_W = 5.7;
const CELL = CORRIDOR_W + WALL_T;
// Fog of war, world units: the maze is lit by nothing but the head's
// light, whose range ends at FOG_FAR, so it darkens to black with distance;
// edges fade (eased) from FOG_NEAR to FOG_FAR, unless FOG_EDGES is false:
// then the maze's wireframe (walls, stairs, carpets) is drawn at full
// intensity everywhere, and only the fills darken. The cones fade
// with the fog either way, edges and all. The maze window drawn
// (cells either side of the head's) spans whole cells past FOG_FAR, so
// nothing pops in; or, with unfogged edges, past the screen at the widest
// shared zoom (an isometric view ~50 units from centre to corner, plus a
// cell's walk before the window recentres).
const FOG_NEAR = 5;
const FOG_FAR = 30;
const FOG_EDGES = false;
const FOG_CELLS = Math.ceil(FOG_FAR / CELL) + 1;
const WINDOW_HALF = FOG_EDGES ? FOG_CELLS : 9;

// A translucent black floor under the head (as in the drum kit scene),
// dimming any scene layered behind this one: its opacity, and its size
// (world units), enough to cover the screen at the widest shared zoom.
const FLOOR_OPACITY = 0.5;
const FLOOR_SIZE = 400;

// Ice cream cones in a rare few cells (CONE_P of them, fixed per cell and
// level), standing at the cell's centre, turning slowly (CONE_SPIN rad per
// beat), in orange as in the ice cream scene. The model's long axis is z,
// with its tip at z = CONE_TIP_Z: CONE_BASE_ANGLE about x stands it up,
// raised so the tip meets the floor.
const CONE_P = 0.06;
const CONE_SCALE = 0.10;
const CONE_COLOR = new THREE.Color('orange');
const CONE_EDGE_ANGLE = 1;          // deg: every facet edge (see ice cream)
const CONE_BASE_ANGLE = -Math.PI / 2;
const CONE_TIP_Z = -20;
const CONE_SPIN = Math.PI / 8;
// They bob gently up off the floor and back, BOB_HEIGHT world units at the
// top, once every BOB_BEATS (a bar), each at its own fixed phase (from its
// cell) so neighbours drift in and out of step.
const BOB_HEIGHT = 0.75;
const BOB_BEATS = 4;
// The head heads straight for what it can see down a straight run of open
// cells, up to SIGHT_CELLS away (the nearest if several): first a staircase
// it has not taken, else a cone.
const SIGHT_CELLS = FOG_CELLS;
const MAX_CONES = 64;               // in view at once (two levels); ~20 typical
// Cells whose cone has been picked up, and staircases taken, oldest
// forgotten
// first.
const MAX_COLLECTED = 4096;
const MAX_TAKEN = 1024;
// When the head reaches a cone it eats it: the head flashes white, and
// plus-sign sparks (the shared Spark, as a cross facing the viewer, small as
// gantry's: SPARK_SIZE is its half-width) burst from it, one along each of
// SPARK_DIRS (an icosahedron's 12 vertices, spread evenly over every
// direction), at SPARK_SPEED world units per beat, then float up under
// negative gravity (SPARK_LIFT world units per beat per beat) for
// SPARK_BEATS.
const GOLDEN = (1 + Math.sqrt(5)) / 2;
const SPARK_DIRS = [
    [0, 1, GOLDEN], [0, 1, -GOLDEN], [0, -1, GOLDEN], [0, -1, -GOLDEN],
    [1, GOLDEN, 0], [1, -GOLDEN, 0], [-1, GOLDEN, 0], [-1, -GOLDEN, 0],
    [GOLDEN, 0, 1], [GOLDEN, 0, -1], [-GOLDEN, 0, 1], [-GOLDEN, 0, -1],
].map((v) => new THREE.Vector3(...v).normalize());
const MAX_SPARKS = 64;
const SPARK_SPEED = 6;
const SPARK_LIFT = 8;
const SPARK_BEATS = 1.5;
const SPARK_SIZE = 0.2;
const SPARK_COLOR = 'white';

// The head walks the maze one cell per MOVE_BEATS, passing the beat mid-step
// (see STEP_LEAD), turning only at right angles (it faces the way it goes, turning
// over the first TURN_FRACTION of a step). A staircase is crossed in one move,
// from the cell before it to the one past it (its k cells and one more, over
// as many MOVE_BEATS), rising or sinking a level only while on the steps,
// the levels crossfading as it does; the head never stops on the stairs. With nothing in
// sight (see SIGHT_CELLS) it picks the open way that best follows its heading, never
// turning straight back unless at a dead end, and shunning cells by
// VISIT_PENALTY per earlier visit so it backs out of dead ends and doesn't
// circle; a little JITTER keeps the route from being too predictable.
const MOVE_BEATS = 1;
// The walk starts on a random level in -START_LEVELS..START_LEVELS - 1, so
// each show opens somewhere new.
const START_LEVELS = 1000;
// false: each step at constant speed, so steps chain into one continuous
// glide through the maze. true: each step eases from rest to rest, pausing
// in every cell on the beat.
const EASED_STEPS = true;
// Beats each step starts ahead of the beat: half a step when eased, so its
// peak speed (mid-step) lands on the beat and the walk reads as driven by it,
// rather than setting off on it and peaking half a beat late (arrivals, and
// the cone-eating flash with them, fall half a beat after). None at constant
// speed, which has no peak: it arrives on the beat.
const STEP_LEAD = EASED_STEPS ? MOVE_BEATS / 2 : 0;
// The walk's beat count is phase-locked to the MIDI clock (PhaseLockedBeats)
// over a step; without that it free-runs at the tempo, at whatever phase the
// scene happened to start.
const TURN_FRACTION = 0.5;
const VISIT_PENALTY = 1.5;
const JITTER = 0.5;
// Cells remembered for VISIT_PENALTY, oldest forgotten first.
const MAX_REMEMBERED = 2048;
// The heading is knob 4's (CH_EXPAND_Y), mapped as gantry maps its
// next-target direction: a full turn over the knob's travel, from +x
// towards +z; DEFAULT_HEADING until the knob moves.
const DEFAULT_HEADING = Math.PI / 4;

// The only light in the maze, riding over the head (in head_group's frame,
// origin at the head's underside), LIGHT_ABOVE_WALLS world units above the
// tops of its level's walls, so it rises with taller levels (blending
// between levels' heights on the stairs). Decay 1 for a soft falloff, cut off
// at FOG_FAR (see the fog of war). A spotlight pointing straight down, its
// cone (widened to suit its height) reaching FOG_FAR across the floor, so it
// casts shadows in one pass (a point light would need six): walls block it,
// so only what the head can see is lit. LIGHT_PENUMBRA softens the cone's rim
// (out in the fog anyway). Centred over the head, so it holds still as the
// head turns; the face gets its own key light (Head's face light).
const LIGHT_ABOVE_WALLS = 2;
const LIGHT_INTENSITY = 6;
const LIGHT_DECAY = 1;
const LIGHT_PENUMBRA = 0.2;
// Shadow map resolution (px a side; lower it on slow hardware), and biases
// against self-shadowing acne on the walls.
const SHADOW_MAP_SIZE = 1024;
const SHADOW_BIAS = -0.0005;
const SHADOW_NORMAL_BIAS = 0.02;
// Shadows also darken the scenes layered behind, through a shadow-only plane
// on the head's floor: this dark where fully shadowed.
const FLOOR_SHADOW_OPACITY = 0.6;
// An exactly 1 px OUTLINE_COLOR outline round the head's outermost
// silhouette, drawn over everything (walls included) with no depth test, or
// none if OUTLINE is false. Screen space: the head is drawn as one flat shape
// into a mask (OUTLINE_LAYER; no bands, contours or brain, so no inner folds
// can outline), then every pixel just outside it is coloured.
const OUTLINE = true;
const OUTLINE_COLOR = new THREE.Color('cyan');
const OUTLINE_LAYER = 1;
// Eating a cone sends a 1 px white outline of the head's silhouette out from
// it, as cubetubes' kick outline: after PICKUP_RING_HOLD beats it grows to
// PICKUP_RING_SCALE times the head's size over PICKUP_RING_BEATS, fading from
// PICKUP_RING_OPACITY to nothing, dropping a faded copy (a tracer, its scale
// and opacity then) every PICKUP_TRACER_INTERVAL beats that fades out over
// PICKUP_TRACER_LIFETIME. Drawn by the outline pass, scaling the silhouette
// about the head's centre on screen (exactly the head scaled in 3D, under the
// orthographic camera); PICKUP_RINGS is the ring and its tracers.
const PICKUP_RING_HOLD = 0.1;
const PICKUP_RING_BEATS = 1;
const PICKUP_RING_SCALE = 2;
const PICKUP_RING_OPACITY = 0.8;
const PICKUP_TRACER_INTERVAL = 1 / 32;
const PICKUP_TRACER_LIFETIME = 1 / 4;
const PICKUP_RINGS = Math.ceil(PICKUP_TRACER_LIFETIME / PICKUP_TRACER_INTERVAL) + 2;

export class BrainMazeScene extends Scene {
    constructor(context) {
        super(context, 'brainmaze');

        const aspect = window.innerWidth / window.innerHeight;
        this.frustum_size = 20;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size * aspect / 2,
            this.frustum_size * aspect / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.clear();

        // base_group turns about the head's centre; world_group drops the
        // floor the head stands on (and the head) so that centre is at the
        // origin, following the head up and down stairs; maze_group slides
        // the maze under the head, its origin on the head's level's floor
        // under the window's centre cell.
        this.base_group = new THREE.Group();
        this.base_group.rotation.x = PITCH_BASE;
        // Pitch locked at the tilt: it holds the shared stepped view's pitch
        // there while it shows.
        this.stepped_pitches = [PITCH_BASE];
        this.base_group.rotation.y = YAW_BASE;
        this.add(this.base_group);
        this.world_group = new THREE.Group();
        this.base_group.add(this.world_group);
        this.maze_group = new THREE.Group();
        this.world_group.add(this.maze_group);

        this.head_group = new THREE.Group();
        this.world_group.add(this.head_group);
        this.head = new Head(HEAD_SCALE, { shadows: true });
        this.head_group.add(this.head);
        // Placed (height and cone) each frame by place_light.
        const light = this.light = new THREE.SpotLight('white', LIGHT_INTENSITY, FOG_FAR,
            Math.PI / 4, LIGHT_PENUMBRA, LIGHT_DECAY);
        this.head_group.add(light, light.target);     // target at the head's feet
        light.castShadow = true;
        light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        light.shadow.camera.near = 0.5;
        light.shadow.bias = SHADOW_BIAS;
        light.shadow.normalBias = SHADOW_NORMAL_BIAS;

        // Two level views: the head's level, and the one a staircase leads to
        // (shown, crossfading, only while taking it).
        this.levels = new MazeLevels();
        const view_options = {
            cell: CELL,
            thickness: WALL_T,
            height: WALL_H,
            half: WINDOW_HALF,
            fog_near: FOG_NEAR,
            fog_far: FOG_FAR,
            fog_edges: FOG_EDGES,
        };
        this.view = new MazeLevel(this.levels, view_options);
        this.next_view = new MazeLevel(this.levels, view_options);
        this.next_view.set_opacity(0);
        this.maze_group.add(this.view, this.next_view);

        // The black floor follows the head's feet. It writes no depth and
        // draws before the scene's other translucent parts, so it dims only
        // what lies behind the scene, never the edges drawn on the floor;
        // pushed back past the levels' floor fills, which win where solid.
        this.floor = new THREE.Mesh(
            new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({
                color: 'black',
                transparent: true,
                opacity: FLOOR_OPACITY,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4,
            }));
        this.floor.renderOrder = -2;
        this.world_group.add(this.floor);
        // The shadow-only plane on the floor (see FLOOR_SHADOW_OPACITY),
        // pushed back between the levels' floor fills and the black floor.
        // It too writes no depth, so it must draw before the edges (which
        // don't either) or it darkens those in shadow wherever the dithered
        // floor fill leaves a gap: a flickering dither pattern along them,
        // as the translucent sort by distance swaps the two while moving.
        this.shadow_floor = new THREE.Mesh(
            new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE).rotateX(-Math.PI / 2),
            new THREE.ShadowMaterial({
                opacity: FLOOR_SHADOW_OPACITY,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: 3,
                polygonOffsetUnits: 3,
            }));
        this.shadow_floor.receiveShadow = true;
        this.shadow_floor.renderOrder = -1;
        this.world_group.add(this.shadow_floor);

        // Cones, posed each frame from the lists of cones in view: [di, dj,
        // bob phase (rad), level offset (-1, 0, +1)].
        this.cone_cells = [];
        this.collected = new Set();     // "level,i,j" of eaten cones
        this.cones = null;              // InstancedProps, once loaded
        this.cone_dummy = new THREE.Object3D();
        this.cone_dummy.rotation.order = 'YXZ';     // spin about the vertical
        new STLLoader().loadAsync('stl/ice-cream-cone.stl').then((geom) => {
            this.cones = new InstancedProps(geom,
                { color: CONE_COLOR, max: MAX_CONES, edge_angle: CONE_EDGE_ANGLE, shadows: true });
            this.maze_group.add(this.cones);
        });

        // Plus-sign sparks (SparkPool, toggling with the hi-hats), in
        // maze_group's frame (shifted as it re-centres).
        this.spark_pool = new SparkPool(this,
            () => new Spark(SPARK_SIZE, SPARK_COLOR, [0, 1], true, false, true), MAX_SPARKS);
        this.maze_group.add(this.spark_pool);

        // The walk: the level and cell the head set out from, the step it
        // is taking (MAZE_DIRS entry) and its climb (+1 up a staircase, -1 down,
        // 0 level), beats elapsed and when the step began, its facing (rad)
        // turning from facing_from to facing_to, how often it has entered
        // each remembered cell ("level,i,j" -> count), and the staircases taken.
        this.heading = DEFAULT_HEADING;
        this.bind(CH_EXPAND_Y, (a) => { this.heading = a; },
            (norm) => norm * 2 * Math.PI);
        // A random level to start on, at cell (0, 0): never a staircase's,
        // and drawn again on the odd level where a bonsai fills it.
        do {
            this.level = Math.floor(Math.random() * 2 * START_LEVELS) - START_LEVELS;
        } while (this.levels.plant_at(this.level, 0, 0));
        this.cell_i = 0;
        this.cell_j = 0;
        this.step = [0, 0];
        this.climb = 0;
        this.cells = 1;                 // cells the step covers (more on stairs)
        this.rise_h = 0;                // world units a staircase step climbs
        this.walk_clock = new PhaseLockedBeats(MOVE_BEATS);
        this.beats = 0;                 // walk_clock's count, as of this frame
        this.step_start = -STEP_LEAD;
        this.visits = new Map();
        this.taken = new Set();
        this.view.set_level(this.level);
        this.set_step(this.choose_step());
        this.facing_from = this.facing_to;
        this.build_views();

        // The outline pass (see OUTLINE): a mask sized to whatever target the
        // scene is drawn to (made on first use and on a size change), the
        // flat material the head is drawn into it with, and a full-screen
        // quad marking the pixels just outside it.
        this.outline_mask = null;
        this.mask_mat = new THREE.MeshBasicMaterial({ color: 'white' });
        this.outline_quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
            uniforms: {
                mask: { value: null },
                color: { value: OUTLINE_COLOR },
                outline_on: { value: OUTLINE ? 1 : 0 },
                center: { value: new THREE.Vector2() },     // head's centre, px
                ring_scale: { value: new Float32Array(PICKUP_RINGS).fill(1) },
                ring_alpha: { value: new Float32Array(PICKUP_RINGS) },
            },
            vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: [
                `#define RINGS ${PICKUP_RINGS}`,
                'uniform sampler2D mask;',
                'uniform vec3 color;',
                'uniform float outline_on;',
                'uniform vec2 center;',
                'uniform float ring_scale[RINGS];',
                'uniform float ring_alpha[RINGS];',
                // Whether pixel p is inside the silhouette scaled by s about center.
                'float inside(vec2 p, float s) {',
                '    ivec2 size = textureSize(mask, 0);',
                '    ivec2 q = ivec2(floor(center + (p - center) / s));',
                '    return texelFetch(mask, clamp(q, ivec2(0), size - 1), 0).r;',
                '}',
                // Whether p is on that silhouette's 1 px outline: just outside it.
                'float ring(vec2 p, float s) {',
                '    if (inside(p, s) > 0.5) return 0.0;',
                '    float n = inside(p + vec2(1.0, 0.0), s) + inside(p - vec2(1.0, 0.0), s) +',
                '        inside(p + vec2(0.0, 1.0), s) + inside(p - vec2(0.0, 1.0), s);',
                '    return n > 0.5 ? 1.0 : 0.0;',
                '}',
                'void main() {',
                '    vec2 p = gl_FragCoord.xy;',
                '    float base = outline_on * ring(p, 1.0);',
                '    float a = 0.0;',
                '    for (int i = 0; i < RINGS; i++) {',
                '        if (ring_alpha[i] > 0.0) a = max(a, ring_alpha[i] * ring(p, ring_scale[i]));',
                '    }',
                '    if (base < 0.5 && a <= 0.0) discard;',
                '    gl_FragColor = base > 0.5 ? vec4(mix(color, vec3(1.0), a), 1.0) : vec4(vec3(1.0), a);',
                '}',
            ].join('\n'),
            transparent: true,
            depthTest: false,
            depthWrite: false,
        }));
        this.outline_quad.frustumCulled = false;
        this.outline_scene = new THREE.Scene();
        this.outline_scene.add(this.outline_quad);
        this.outline_cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.tmp_size = new THREE.Vector2();
        this.tmp_clear = new THREE.Color();
        this.tmp_center = new THREE.Vector3();

        // The pickup ring (see PICKUP_RING_HOLD): beats since the last cone
        // was eaten, and its tracers' birth (beats on ring_time), scale and
        // opacity, in a ring buffer.
        this.ring_beats = Infinity;
        this.ring_time = 0;
        this.last_ring_tracer = -Infinity;
        this.next_ring_tracer = 0;
        this.ring_tracer_birth = new Float32Array(PICKUP_RINGS - 1).fill(-Infinity);
        this.ring_tracer_scale = new Float32Array(PICKUP_RINGS - 1).fill(1);
        this.ring_tracer_opacity = new Float32Array(PICKUP_RINGS - 1);
        this.rings_live = false;

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    render(renderer, underlying_buffer) {
        super.render(renderer, underlying_buffer);
        if ((OUTLINE || this.rings_live) && this.head.fill !== null) {
            this.draw_outline(renderer);
        }
    }

    // Draw the head's silhouette into the mask, then its 1 px outline over
    // whatever target the scene was drawn to (the screen, or a crossfade's
    // buffer).
    draw_outline(renderer) {
        const target = renderer.getRenderTarget();
        const size = target ? this.tmp_size.set(target.width, target.height) :
            renderer.getDrawingBufferSize(this.tmp_size);
        if (this.outline_mask === null || this.outline_mask.width != size.x ||
                this.outline_mask.height != size.y) {
            this.outline_mask?.dispose();
            this.outline_mask = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false });
            this.outline_quad.material.uniforms.mask.value = this.outline_mask.texture;
        }
        this.head.fill.layers.enable(OUTLINE_LAYER);

        // The mask: only OUTLINE_LAYER, flat white on clear black, without
        // redrawing the shadow map.
        const layers = this.camera.layers.mask;
        const auto_shadows = renderer.shadowMap.autoUpdate;
        const clear_alpha = renderer.getClearAlpha();
        renderer.getClearColor(this.tmp_clear);
        renderer.shadowMap.autoUpdate = false;
        this.camera.layers.set(OUTLINE_LAYER);
        this.overrideMaterial = this.mask_mat;
        renderer.setRenderTarget(this.outline_mask);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(this, this.camera);
        this.overrideMaterial = null;
        this.camera.layers.mask = layers;
        renderer.shadowMap.autoUpdate = auto_shadows;
        renderer.setClearColor(this.tmp_clear, clear_alpha);

        // The outline (and any pickup rings, scaled about the head's centre in
        // the target's pixels), over the scene as drawn.
        const c = this.tmp_center.set(0, this.head.height / 2, 0);
        this.head_group.localToWorld(c).project(this.camera);
        this.outline_quad.material.uniforms.center.value.set(
            (c.x * 0.5 + 0.5) * size.x, (c.y * 0.5 + 0.5) * size.y);
        renderer.setRenderTarget(target);
        renderer.render(this.outline_scene, this.outline_cam);
    }

    anim_frame(dt) {
        const d_beats = dt * this.get_local_bpm() / 60;
        this.beats = this.walk_clock.advance(dt, this.get_local_bpm());
        while (this.beats - this.step_start >= MOVE_BEATS * this.cells) {
            this.arrive();
        }
        // Clamped: a phase-lock nudge can step the count back past the start.
        const frac = Math.max(0, (this.beats - this.step_start) / (MOVE_BEATS * this.cells));

        // Slide the maze under the head, which is part way along its step
        // from the window's centre cell (and up or down stairs).
        const along = EASED_STEPS ? ease(frac) : frac;
        const bx = this.step[0] * along * this.cells * CELL;
        const bz = this.step[1] * along * this.cells * CELL;
        const rise = this.stairs_rise(along);
        this.maze_group.position.set(-bx, 0, -bz);
        this.head_group.position.y = rise;
        this.floor.position.y = rise;
        this.shadow_floor.position.y = rise;
        this.world_group.position.y = -rise - this.head.height / 2;
        this.head_group.rotation.y = lerp_scalar(this.facing_from, this.facing_to,
            ease(clamp(frac / TURN_FRACTION, 0, 1)));

        // On stairs, the levels crossfade as the head climbs.
        const fade = this.rise_h > 0 ? Math.abs(rise) / this.rise_h : 0;
        this.view.set_opacity(1 - fade);
        this.next_view.set_opacity(fade);
        this.place_light(fade);
        for (const view of [this.view, this.next_view]) {
            view.set_viewer(bx, bz);
            view.update();
        }

        this.head.update(d_beats);
        this.base_group.rotation.x = this.stepped_pitch();
        this.base_group.rotation.y = YAW_BASE + this.stepped_yaw();
        this.update_cones(bx, bz, fade);
        this.spark_pool.anim_frame(dt);
        this.update_pickup_ring(d_beats);
    }

    // Set the light LIGHT_ABOVE_WALLS over the walls of the head's level,
    // blended `fade` (0..1) of the way to the next level's on the stairs,
    // its cone reaching FOG_FAR across the floor from there.
    place_light(fade) {
        const wall_h = (level) => WALL_H * this.levels.params(level).height;
        let h = wall_h(this.level);
        if (this.climb != 0) {
            h = lerp_scalar(h, wall_h(this.level + this.climb), fade);
        }
        const y = h + LIGHT_ABOVE_WALLS;
        this.light.position.set(0, y, 0);
        this.light.angle = Math.atan2(FOG_FAR, y);
    }

    // Height (world units) along a staircase move `along` (0..1) of the way
    // from the cell before the flight to the cell past it: level ground up to
    // its foot (the wall line half a cell on), then up its pitch (to the face
    // of the wall past its top, its k cells less half a wall on), then level
    // again; a move down is the same run backwards. 0 off stairs.
    stairs_rise(along) {
        const k = this.cells - 1;
        const up = (u) => clamp((u * this.cells * CELL - CELL / 2) / (k * CELL - WALL_T / 2), 0, 1);
        if (this.climb > 0) {
            return this.rise_h * up(along);
        }
        if (this.climb < 0) {
            return -this.rise_h * (1 - up(1 - along));
        }
        return 0;
    }

    // Lay out both views around the head's cell: its level, and (if the
    // step under way is a staircase) the level it leads to, offset up or down.
    build_views() {
        this.view.build(this.cell_i, this.cell_j);
        if (this.climb != 0) {
            this.next_view.set_level(this.level + this.climb);
            this.next_view.position.y = this.climb * this.rise_h;
            this.next_view.build(this.cell_i, this.cell_j);
        }
        this.list_cones();
    }

    // List the uneaten cones in view: around the head's cell on its level,
    // and on the level a staircase under way leads to.
    list_cones() {
        this.cone_cells.length = 0;
        for (const offset of this.climb != 0 ? [0, this.climb] : [0]) {
            const level = this.level + offset;
            for (let di = -WINDOW_HALF; di <= WINDOW_HALF; di++) {
                for (let dj = -WINDOW_HALF; dj <= WINDOW_HALF; dj++) {
                    const i = this.cell_i + di, j = this.cell_j + dj;
                    if (this.has_cone(level, i, j) && this.cone_cells.length < MAX_CONES) {
                        const phase = 2 * Math.PI * this.levels.maze(level).cell_random(i, j, 1);
                        this.cone_cells.push([di, dj, phase, offset]);
                    }
                }
            }
        }
    }

    // Pose the cones (spin, bob) and fade them with the fog, by distance
    // from the head at (bx, bz), and with their level's crossfade.
    update_cones(bx, bz, fade) {
        if (this.cones === null) {
            return;
        }
        const bob_angle = 2 * Math.PI * this.beats / BOB_BEATS;
        const dummy = this.cone_dummy;
        dummy.rotation.set(CONE_BASE_ANGLE, this.beats * CONE_SPIN, 0);
        dummy.scale.setScalar(CONE_SCALE);
        this.cones.begin();
        for (const [di, dj, phase, offset] of this.cone_cells) {
            const x = di * CELL, z = dj * CELL;
            const lift = BOB_HEIGHT * (0.5 - 0.5 * Math.cos(bob_angle + phase));
            dummy.position.set(x, offset * this.rise_h - CONE_TIP_Z * CONE_SCALE + lift, z);
            dummy.updateMatrix();
            const d = Math.hypot(x - bx, z - bz);
            const level_alpha = offset == 0 ? 1 - fade : fade;
            const alpha = ease(clamp((FOG_FAR - d) / (FOG_FAR - FOG_NEAR), 0, 1)) * level_alpha;
            this.cones.add_instance(dummy.matrix, alpha);
        }
        this.cones.end();
    }

    // Grow and fade the pickup ring, drop its tracers (as cubetubes'
    // update_outline_tracers), and hand the lot to the outline pass: ring 0,
    // then the tracers, each a scale and an opacity (0: off).
    update_pickup_ring(d_beats) {
        this.ring_beats += d_beats;
        this.ring_time += d_beats;
        const frac = clamp(this.ring_beats / PICKUP_RING_BEATS - PICKUP_RING_HOLD, 0, 1);
        const opacity = Number.isFinite(this.ring_beats) ? PICKUP_RING_OPACITY * (1 - frac) : 0;
        const scale = 1 + (PICKUP_RING_SCALE - 1) * frac;
        if (opacity > 0 && this.ring_time - this.last_ring_tracer >= PICKUP_TRACER_INTERVAL) {
            const i = this.next_ring_tracer;
            this.next_ring_tracer = (i + 1) % (PICKUP_RINGS - 1);
            this.last_ring_tracer = this.ring_time;
            this.ring_tracer_birth[i] = this.ring_time;
            this.ring_tracer_scale[i] = scale;
            this.ring_tracer_opacity[i] = opacity;
        }
        const { ring_scale, ring_alpha } = this.outline_quad.material.uniforms;
        ring_scale.value[0] = scale;
        ring_alpha.value[0] = opacity;
        this.rings_live = opacity > 0;
        for (let i = 0; i < PICKUP_RINGS - 1; i++) {
            const age = this.ring_time - this.ring_tracer_birth[i];
            const alpha = this.ring_tracer_opacity[i] * clamp(1 - age / PICKUP_TRACER_LIFETIME, 0, 1);
            ring_scale.value[i + 1] = this.ring_tracer_scale[i];
            ring_alpha.value[i + 1] = alpha;
            this.rings_live = this.rings_live || alpha > 0;
        }
    }

    // Burst plus signs from the head's centre, at maze_group's origin.
    spawn_sparks() {
        const beats_per_sec = this.get_local_bpm() / 60;
        for (const dir of SPARK_DIRS) {
            const spark = this.spark_pool.spawn(SPARK_BEATS / beats_per_sec);
            spark.position.set(0, this.head.height / 2, 0);
            spark.velocity.copy(dir).multiplyScalar(SPARK_SPEED * beats_per_sec);
            spark.acceleration.set(0, SPARK_LIFT * beats_per_sec * beats_per_sec, 0);
        }
    }

    // The step is done: stand in the next cell (on the next level, after a
    // staircase), remember it, eat any cone, pick the next step, and re-centre the
    // views on the new cell.
    arrive() {
        const [si, sj] = this.step;
        const climb = this.climb, cells = this.cells, rise_h = this.rise_h;
        this.cell_i += si * cells;
        this.cell_j += sj * cells;
        if (climb != 0) {
            // The view the staircase led to becomes the head's level.
            this.level += climb;
            [this.view, this.next_view] = [this.next_view, this.view];
            this.view.position.y = 0;
            this.view.set_opacity(1);
            this.next_view.set_opacity(0);
        }
        // maze_group re-centred a cell on (and maybe a level up or down):
        // keep the sparks where they were.
        for (const spark of this.spark_pool.sparks) {
            spark.position.x -= si * cells * CELL;
            spark.position.z -= sj * cells * CELL;
            spark.position.y -= climb * rise_h;
        }

        const key = `${this.level},${this.cell_i},${this.cell_j}`;
        this.visits.set(key, (this.visits.get(key) || 0) + 1);
        if (this.visits.size > MAX_REMEMBERED) {
            this.visits.delete(this.visits.keys().next().value);
        }
        if (this.has_cone(this.level, this.cell_i, this.cell_j)) {
            this.collected.add(key);
            if (this.collected.size > MAX_COLLECTED) {
                this.collected.delete(this.collected.values().next().value);
            }
            this.head.flash();
            this.spawn_sparks();
            this.ring_beats = 0;
        }

        this.facing_from = this.facing_to;
        this.step_start += MOVE_BEATS * cells;
        this.set_step(this.choose_step());
        this.build_views();
    }

    // Start step = [di, dj, climb, stairs key, cells, height (standard
    // heights)]: note a staircase as taken, and turn to face it, the short
    // way round from the current facing.
    set_step([di, dj, climb, key, cells, height]) {
        this.step = [di, dj];
        this.climb = climb;
        this.cells = cells;
        this.rise_h = height * WALL_H;
        if (key !== null) {
            this.taken.add(key);
            if (this.taken.size > MAX_TAKEN) {
                this.taken.delete(this.taken.values().next().value);
            }
        }
        let to = Math.atan2(di, dj);       // the model's front is +z
        if (this.facing_to !== undefined) {
            to += Math.round((this.facing_to - to) / (2 * Math.PI)) * 2 * Math.PI;
        }
        this.facing_to = to;
    }

    // Whether cell (i, j) of level L holds an uneaten cone (never a staircase's
    // cell, which the head can't stand in).
    has_cone(level, i, j) {
        return this.levels.maze(level).cell_random(i, j) < CONE_P &&
            !this.collected.has(`${level},${i},${j}`) && !this.levels.stairs_cell(level, i, j) &&
            !this.levels.plant_at(level, i, j);
    }

    // The ways on from the current cell: [di, dj, climb, stairs key, cells,
    // height] (see set_step) for each passable direction.
    ways_on() {
        const ways = [];
        for (const [di, dj] of MAZE_DIRS) {
            const step = this.levels.step(this.level, this.cell_i, this.cell_j, di, dj);
            if (step !== null) {
                ways.push([di, dj, step.climb, step.key, step.cells, step.height]);
            }
        }
        return ways;
    }

    // The way on from the current cell: an untaken staircase from here,
    // else towards the nearest untaken staircase in sight, else the nearest cone in
    // sight (see SIGHT_CELLS), else by the rule at MOVE_BEATS.
    choose_step() {
        const ways = this.ways_on();
        const untaken = ways.find(([, , climb, key]) => climb != 0 && !this.taken.has(key));
        if (untaken) {
            return untaken;
        }
        // Look down each level run of open cells.
        let stairs_dist = SIGHT_CELLS + 1, cone_dist = SIGHT_CELLS + 1;
        let to_stairs = null, to_cone = null;
        for (const way of ways) {
            const [di, dj, climb] = way;
            if (climb != 0) {
                continue;
            }
            let i = this.cell_i, j = this.cell_j;
            for (let k = 1; k <= SIGHT_CELLS; k++) {
                i += di;
                j += dj;
                if (k < cone_dist && this.has_cone(this.level, i, j)) {
                    cone_dist = k;
                    to_cone = way;
                }
                if (k < stairs_dist && MAZE_DIRS.some(([ri, rj]) => {
                    const step = this.levels.step(this.level, i, j, ri, rj);
                    return step !== null && step.climb != 0 && !this.taken.has(step.key);
                })) {
                    stairs_dist = k;
                    to_stairs = way;
                }
                const on = this.levels.step(this.level, i, j, di, dj);
                if (on === null || on.climb != 0) {
                    break;
                }
            }
        }
        if (to_stairs !== null) {
            return to_stairs;
        }
        if (to_cone !== null) {
            return to_cone;
        }

        const [pi, pj] = this.step;
        const hx = Math.cos(this.heading), hz = Math.sin(this.heading);
        let best = null;
        let best_score = -Infinity;
        for (const allow_back of [false, true]) {
            for (const way of ways) {
                const [di, dj, climb, , cells] = way;
                if (!allow_back && di == -pi && dj == -pj) {
                    continue;
                }
                const visits = this.visits.get(
                    `${this.level + climb},${this.cell_i + di * cells},${this.cell_j + dj * cells}`) || 0;
                const score = di * hx + dj * hz - VISIT_PENALTY * visits + JITTER * Math.random();
                if (score > best_score) {
                    best_score = score;
                    best = way;
                }
            }
            if (best !== null) {
                return best;
            }
        }
        // Never reached: every open way is passable (a staircase's cells
        // are a dead end on both levels, open only to the cells that cross
        // it).
        return [0, 0, 0, null, 1, 0];
    }

    handle_sync_raw(sync_rate_hz, sync_idx) {
        super.handle_sync_raw(sync_rate_hz, sync_idx);
        this.walk_clock.lock(sync_idx / MIDI_SYNCS_PER_BEAT);
    }

    handle_beat(t, channel) {
        this.spark_pool.handle_beat(t, channel);
        if (channel == 1) {
            setTimeout(() => {
                this.head.start_scan();
            }, this.get_beat_delay() * 1000);
        }
    }
}
