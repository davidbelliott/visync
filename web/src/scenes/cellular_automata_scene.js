import * as THREE from 'three';
import { Scene } from './scene.js';
import { BeatClock } from '../util.js';
import { InstancedGeometryCollection } from '../instanced_geom.js';

// Cells per edge of the cubic board. The whole board is simulated, so this
// is the main quality/perf knob: memory and per-generation work scale with
// its cube (128 -> ~2M cells).
const GRID_SIZE = 64;
// World units between adjacent cell centers; cells draw smaller than the
// pitch so the board reads as discrete cubes without explicit grid lines.
const CELL_PITCH = 1;
const CELL_DRAW_SIZE = 1.0;
// Automaton generations per beat.
const GENS_PER_BEAT = 16;
// A rule change (with a board clear) every 16 bars of 4 beats.
const BEATS_PER_RULE = 32;
// Seed blob dropped at the box center on every beat: cells within
// SEED_RADIUS are born with probability SEED_FILL. Dense enough to satisfy
// high-birth-count rules like Clouds (a cell needs 13+ alive neighbors).
const SEED_RADIUS = 5;
const SEED_FILL = 0.2;
// Cap on drawn cubes; cells beyond it (very dense boards) go undrawn.
const MAX_INSTANCES = 1 << 18;
// Drift of the whole box: this x the shared view rotation (0.05 rad/s at
// knob 1x), slow so the evolving pattern stays readable.
const ROT_SCALE = 0.25;

// Rules to cycle through, in the standard S/B/C/N notation: survival
// neighbor counts / birth neighbor counts / cell states / neighborhood.
// An alive cell survives iff its count of alive cells among the 26 Moore
// neighbors is in S; otherwise it starts dying, fading through C - 2
// refractory states toward dead (C=2 means plain alive-or-dead). A dead
// cell with a count in B is born. Refractory cells neither count as
// neighbors nor accept births. Only 'M' (Moore) neighborhoods are
// supported, since the simulation counts neighbors with a 3x3x3 box sum.
// colors is each rule's birth -> mid-life -> death ramp; note 2-state
// rules only ever show their birth color (there are no dying states).
const RULESETS = [
    // 445: sparse skeletal growth - crisp white/magenta/blue neon
    { rule: '4/4/5/M', colors: [0xffffff, 0xff00ff, 0x0000ff] },
    // Pyroclastic: billowing plumes - white heat through ember to dark red
    { rule: '6/3/15/M', colors: [0xffffff, 0xff5500, 0x660000] },
    // Amoeba: writhing blobs - bioluminescent green sinking into teal
    { rule: '9-15/5-8,12-13,15/10/M', colors: [0xeeffee, 0x00ff80, 0x005050] },
    // Builder 1: scaffolding structures - work-light gold rusting away
    { rule: '2,6,9/4,6,8-9/10/M', colors: [0xffffff, 0xffcc00, 0x662200] },
    // 678 678: coral shells - hot pink calcifying to purple
    { rule: '6-8/5-10/15/M', colors: [0xffffff, 0x80ff80, 0x00ff00] },
    // Clouds 1: dense rolling clouds - a single icy blue-white
    { rule: '5-8/6-7/20/M', colors: [0x88ddff, 0x00ccff, 0x000066] },
    // Slow Decay: melting mass - violet rotting down to deep indigo
    { rule: '3-7/6/8/M', colors: [0xffffff, 0xaa44ff, 0x220066] },
];

const S = GRID_SIZE;
const S2 = GRID_SIZE * GRID_SIZE;
const TOTAL = GRID_SIZE * S2;

// Scratch for per-cell instance writes (no per-frame allocation).
const SCRATCH_POS = new THREE.Vector3();

// Expands a comma-separated list of counts and ranges ("13-14,17-19") into
// a lookup table indexed by neighbor count (0-26).
function parse_counts(spec) {
    const table = new Uint8Array(27);
    for (const part of spec.split(',')) {
        if (part.length == 0) {
            continue;
        }
        const bounds = part.split('-').map(Number);
        const hi = bounds.length > 1 ? bounds[1] : bounds[0];
        for (let n = bounds[0]; n <= hi; n++) {
            table[n] = 1;
        }
    }
    return table;
}

function parse_rule(notation) {
    const [survival, birth, states, neighborhood] = notation.split('/');
    if (neighborhood != 'M') {
        console.error(`unsupported neighborhood in rule ${notation}`);
    }
    return {
        notation: notation,
        survival: parse_counts(survival),
        birth: parse_counts(birth),
        num_states: parseInt(states),
    };
}

// One axis of the separable 3x3x3 box sum: dst[i] = src summed over i and
// its two neighbors along the axis, with out-of-range treated as dead.
// Three passes give every cell its 27-cell Moore sum in three adds per
// cell instead of 26 lookups. Sums max out at 27, so bytes suffice.
function box_sum_x(src, dst) {
    for (let base = 0; base < TOTAL; base += S) {
        let prev = 0;
        let cur = src[base];
        for (let x = 0; x < S - 1; x++) {
            const next = src[base + x + 1];
            dst[base + x] = prev + cur + next;
            prev = cur;
            cur = next;
        }
        dst[base + S - 1] = prev + cur;
    }
}

function box_sum_y(src, dst) {
    for (let slab = 0; slab < TOTAL; slab += S2) {
        for (let j = 0; j < S2; j++) {
            const i = slab + j;
            let v = src[i];
            if (j >= S) {
                v += src[i - S];
            }
            if (j < S2 - S) {
                v += src[i + S];
            }
            dst[i] = v;
        }
    }
}

function box_sum_z(src, dst) {
    for (let i = 0; i < TOTAL; i++) {
        let v = src[i];
        if (i >= S2) {
            v += src[i - S2];
        }
        if (i < TOTAL - S2) {
            v += src[i + S2];
        }
        dst[i] = v;
    }
}

export class CellularAutomataScene extends Scene {
    constructor(context) {
        super(context, 'automata');

        this.frustum_size = 50;
        this.cam_orth = new THREE.OrthographicCamera(
            -this.frustum_size / 2,
            this.frustum_size / 2,
            this.frustum_size / 2,
            -this.frustum_size / 2, -1000, 1000);
        this.camera = this.cam_orth;
        this.camera.rotation.x = Math.asin(1 / Math.sqrt(3));

        this.clear();
        this.base_group = new THREE.Group();
        this.add(this.base_group);

        // Lights stay outside base_group so they don't spin with the box.
        this.point_light = new THREE.PointLight("white", 100, 0, 1.0);
        this.point_light.position.set(100, 100, 100);
        this.base_group.add(this.point_light);
        this.directional_light = new THREE.DirectionalLight("white", 0.3);
        this.directional_light.position.set(-1, 1, 1);
        this.add(this.directional_light);
        this.amb_light = new THREE.AmbientLight("white", 0.2);
        this.add(this.amb_light);

        // Simulation state: per-cell values in [0, num_states), a 0/1 copy
        // of the alive cells, and two scratch buffers the box-sum passes
        // ping-pong between (the final Moore sums land in sum_a).
        this.cells = new Uint8Array(TOTAL);
        this.bin = new Uint8Array(TOTAL);
        this.sum_a = new Uint8Array(TOTAL);
        this.sum_b = new Uint8Array(TOTAL);

        this.inst_cubes = new InstancedGeometryCollection(
            this.base_group,
            new THREE.BoxGeometry(CELL_DRAW_SIZE, CELL_DRAW_SIZE, CELL_DRAW_SIZE),
            'Triangles', MAX_INSTANCES);

        this.rule_idx = 0;
        this.set_rule(0);


        // Paces generations at GENS_PER_BEAT.
        this.gen_clock = new BeatClock(this);
        this.gen_clock.start();

        // Something on screen before the first beat arrives.
        this.spawn_seed();

        // The shared view zoom scales this camera (see Scene.bind_zoom).
        this.bind_zoom();
    }

    // Switch rule, rebuild the per-state color/scale lookups, and clear the
    // board for a fresh start.
    set_rule(idx) {
        this.rule_idx = idx;
        this.rule = parse_rule(RULESETS[idx].rule);
        const [birth_color, mid_color, death_color] =
            RULESETS[idx].colors.map((c) => new THREE.Color(c));
        const alive = this.rule.num_states - 1;
        // State s runs from newborn (s == alive) down to nearly-dead
        // (s == 1): the rule's birth color through mid-life to death,
        // shrinking linearly from full size at birth to nothing when dead.
        this.state_colors = [null];
        this.state_scales = [null];
        for (let s = 1; s <= alive; s++) {
            const life = s / alive;
            const color = new THREE.Color();
            if (life >= 0.5) {
                color.lerpColors(mid_color, birth_color, (life - 0.5) * 2);
            } else {
                color.lerpColors(death_color, mid_color, life * 2);
            }
            this.state_colors.push(color);
            this.state_scales.push(new THREE.Vector3(life, life, life));
        }
        this.cells.fill(0);
        this.inst_cubes.set_num_instances(0);
        console.log(`automata rule: ${this.rule.notation}`);
    }

    // Drop a dense random blob of newborn cells at the center of the box.
    spawn_seed() {
        const alive = this.rule.num_states - 1;
        const c = GRID_SIZE / 2;
        const r = SEED_RADIUS;
        for (let dz = -r; dz <= r; dz++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (dx * dx + dy * dy + dz * dz > r * r ||
                            Math.random() >= SEED_FILL) {
                        continue;
                    }
                    this.cells[(c + dz) * S2 + (c + dy) * S + (c + dx)] = alive;
                }
            }
        }
    }

    anim_frame(dt) {
        // Free rotation from the shared view (yaw about the box's Y, pitch
        // about the viewport horizontal: XYZ euler order).
        this.base_group.rotation.x = this.view_pitch(ROT_SCALE);
        this.base_group.rotation.y = this.view_yaw(ROT_SCALE);

        // Run a full generation whenever one falls due.
        if (this.gen_clock.getElapsedBeats() >= 1 / GENS_PER_BEAT) {
            this.gen_clock.start();
            this.step();
        }
    }

    // One full generation: count neighbors (binarize + separable box sums),
    // then apply the rule and rebuild the instance buffers.
    step() {
        // Only fully-alive cells count as neighbors.
        const alive = this.rule.num_states - 1;
        for (let i = 0; i < TOTAL; i++) {
            this.bin[i] = this.cells[i] == alive ? 1 : 0;
        }
        box_sum_x(this.bin, this.sum_a);
        box_sum_y(this.sum_a, this.sum_b);
        box_sum_z(this.sum_b, this.sum_a);
        this.apply_rule_and_rebuild();
    }

    apply_rule_and_rebuild() {
        const alive = this.rule.num_states - 1;
        const survival = this.rule.survival;
        const birth = this.rule.birth;
        const cells = this.cells;
        const bin = this.bin;
        const sums = this.sum_a;    // 27-cell box sum, cell itself included
        let cursor = 0;
        let i = 0;
        for (let z = 0; z < S; z++) {
            for (let y = 0; y < S; y++) {
                for (let x = 0; x < S; x++, i++) {
                    const n = sums[i] - bin[i];
                    let c = cells[i];
                    if (c == alive) {
                        if (!survival[n]) {
                            c -= 1;
                        }
                    } else if (c > 0) {
                        c -= 1;     // refractory fade toward dead
                    } else if (birth[n]) {
                        c = alive;
                    }
                    cells[i] = c;
                    // Draw the live cells, skipping any buried under all 26
                    // alive neighbors (invisible) or past the instance cap.
                    if (c > 0 && n < 26 && cursor < MAX_INSTANCES) {
                        SCRATCH_POS.set(
                            (x + 0.5 - S / 2) * CELL_PITCH,
                            (y + 0.5 - S / 2) * CELL_PITCH,
                            (z + 0.5 - S / 2) * CELL_PITCH);
                        this.inst_cubes.set_pos(cursor, SCRATCH_POS);
                        this.inst_cubes.set_color(cursor, this.state_colors[c]);
                        this.inst_cubes.set_scale(cursor, this.state_scales[c]);
                        cursor++;
                    }
                }
            }
        }
        this.inst_cubes.set_num_instances(cursor);
    }

    handle_beat(t, channel) {
        // Land the seed on the audible beat (events arrive early).
        setTimeout(() => this.spawn_seed(), this.get_beat_delay(t) * 1000);
    }

    handle_sync(t, bpm, beat) {
        // The rule index derives from the global beat count, so it is
        // stable across scene hides/re-shows and never double-advances.
        const rule_idx = Math.floor(beat / BEATS_PER_RULE) % RULESETS.length;
        if (rule_idx != this.rule_idx) {
            this.set_rule(rule_idx);
        }
    }
}
