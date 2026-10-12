import * as THREE from 'three';
import { MAZE_DIRS } from '../infinite_maze.js';
import { InstancedProps } from './instanced_props.js';
import { lerp_scalar, ease, clamp } from '../util.js';

// Cutout men wandering one maze level (MazeLevels): flat figures as thick as
// the walls, an upside-down triangle for a head, a plus sign for one eye and
// a minus for the other, one arm bent up at a right angle and the other
// down. They walk one cell per MOVE_BEATS at constant speed (only their
// turns ease, as the brain's do: over the first TURN_FRACTION of a step),
// never onto stairs, into another's cell, or into the cells given to avoid;
// their feet dance all the while. clap() swaps their arms over (each swings
// about its upper arm, through the front); hihat() flashes their eyes, one
// then the other.
//
// Figure units are world units: feet on y = 0, facing +z (the way it walks),
// the cutout's faces at z = +-thickness / 2, WALL_H tall.

// The figure, x across (+x is his left), y up: legs from hips at
// +-HIP_X, LEG_LEN long, LEG_W wide; the torso from the hips to
// SHOULDER_Y + ARM_W / 2, TORSO_HALF_W either side; the head's top edge
// HEAD_HALF_W either side at HEAD_TOP, its point on the torso's top.
const LEG_LEN = 1.2;
const LEG_W = 0.35;
const HIP_X = 0.3;
const TORSO_HALF_W = 0.6;
const SHOULDER_Y = 2.4;
const HEAD_TOP = 4;
const HEAD_HALF_W = 0.8;
// Arms: from the shoulder out ARM_REACH (the upper arm), then the forearm at
// a right angle, FOREARM_LEN past the upper arm; ARM_W wide.
const ARM_REACH = 1;
const FOREARM_LEN = 0.8;
const ARM_W = 0.3;
// Eyes: centred EYE_X either side at EYE_Y on the head, EYE_SIZE across,
// bars EYE_BAR thick, standing EYE_PROUD proud of both faces. The plus is on
// his right (-x), the minus on his left.
const EYE_X = 0.25;
const EYE_Y = 3.4;
const EYE_SIZE = 0.26;
const EYE_BAR = 0.07;
const EYE_PROUD = 0.03;

// Colours: a white cutout (lit, so it darkens away from the light), eyes
// black holes that flash cyan, fading back over EYE_FLASH_BEATS.
const BODY_COLOR = new THREE.Color('white');
const EYE_COLOR = new THREE.Color('black');
const EYE_FLASH_COLOR = new THREE.Color('cyan');
const EYE_FLASH_BEATS = 0.5;

// Walking: beats per cell (slow next to the brain's one), and the turn's
// share of a step (the brain's).
const MOVE_BEATS = 4;
const TURN_FRACTION = 0.5;
// Dancing: KICKS_PER_BEAT kicks, the feet taking turns, each swinging the
// leg out up to KICK_ANGLE (rad) about the hip, in the figure's plane.
const KICKS_PER_BEAT = 2;
const KICK_ANGLE = 0.5;
// An arm swap takes this long (beats, eased): quick, as it's a beat hit.
const ARM_SWAP_BEATS = 0.25;
// Fading in when spawned and out when dismissed, beats.
const FADE_BEATS = 2;

// An extrusion of shape `points` ([x, y], counter-clockwise) through the
// cutout's thickness, centred on z = 0.
function cutout_geometry(shapes, thickness) {
    const geom = new THREE.ExtrudeGeometry(shapes.map((points) => new THREE.Shape(
        points.map(([x, y]) => new THREE.Vector2(x, y)))), { depth: thickness, bevelEnabled: false });
    geom.translate(0, 0, -thickness / 2);
    return geom;
}

export class CutoutDancers extends THREE.Group {
    // levels: MazeLevels. cell: grid pitch; thickness: the walls'. max: men
    // at once.
    constructor(levels, { cell, thickness, max }) {
        super();
        this.levels = levels;
        this.cell = cell;
        this.max = max;
        this.men = [];
        this.beats = 0;

        // Torso and head; one arm (his left, reaching +x from the shoulder at
        // the origin, forearm up); one leg, hanging from its hip at the
        // origin.
        const top = SHOULDER_Y + ARM_W / 2;
        const t = TORSO_HALF_W, h = HEAD_HALF_W, w = ARM_W / 2, f = ARM_REACH - ARM_W;
        this.bodies = new InstancedProps(cutout_geometry([
            [[-t, LEG_LEN], [t, LEG_LEN], [t, top], [-t, top]],
            [[0, top], [h, HEAD_TOP], [-h, HEAD_TOP]],
        ], thickness), { color: BODY_COLOR, max, shadows: true });
        this.arms = new InstancedProps(cutout_geometry([
            [[0, -w], [ARM_REACH, -w], [ARM_REACH, w + FOREARM_LEN], [f, w + FOREARM_LEN], [f, w], [0, w]],
        ], thickness), { color: BODY_COLOR, max: 2 * max, shadows: true });
        this.legs = new InstancedProps(cutout_geometry([
            [[-LEG_W / 2, -LEG_LEN], [LEG_W / 2, -LEG_LEN], [LEG_W / 2, 0], [-LEG_W / 2, 0]],
        ], thickness), { color: BODY_COLOR, max: 2 * max, shadows: true });
        this.add(this.bodies, this.arms, this.legs);

        // Eyes: plain meshes per man (their colours flash), posed with him.
        const depth = thickness + 2 * EYE_PROUD;
        const bar = new THREE.BoxGeometry(EYE_SIZE, EYE_BAR, depth);
        const upright = new THREE.BoxGeometry(EYE_BAR, EYE_SIZE, depth);
        this.eye_slots = [];
        for (let k = 0; k < max; k++) {
            const group = new THREE.Group();
            group.matrixAutoUpdate = false;
            const mats = [0, 1].map(() => new THREE.MeshBasicMaterial({ color: EYE_COLOR.clone(), transparent: true }));
            const plus = new THREE.Group();
            plus.add(new THREE.Mesh(bar, mats[0]), new THREE.Mesh(upright, mats[0]));
            plus.position.set(-EYE_X, EYE_Y, 0);
            const minus = new THREE.Mesh(bar, mats[1]);
            minus.position.set(EYE_X, EYE_Y, 0);
            group.add(plus, minus);
            group.visible = false;
            this.add(group);
            this.eye_slots.push({ group, mats });
        }
        this.eye_flash = [0, 0];        // per eye (plus, minus), 1 at a flash
        this.next_eye = 0;

        // Arms: their swing about the upper arm (rad; 0 = forearm up, PI =
        // down), easing from arm_from to arm_to; the left (+x) arm's angle,
        // the right's is the other way up.
        this.arm_from = 0;
        this.arm_to = 0;
        this.arm_start = -Infinity;

        // Scratch, so posing allocates nothing.
        this.m_man = new THREE.Matrix4();
        this.m_part = new THREE.Matrix4();
        this.m_tmp = new THREE.Matrix4();
    }

    // Swap the arms over.
    clap() {
        const now = this.arm_angle();
        this.arm_from = now;
        this.arm_to = this.arm_to > Math.PI / 2 ? 0 : Math.PI;
        this.arm_start = this.beats;
    }

    // Flash the next eye.
    hihat() {
        this.eye_flash[this.next_eye] = 1;
        this.next_eye = 1 - this.next_eye;
    }

    // The left (+x) arm's swing (rad).
    arm_angle() {
        const p = clamp((this.beats - this.arm_start) / ARM_SWAP_BEATS, 0, 1);
        return lerp_scalar(this.arm_from, this.arm_to, ease(p));
    }

    // Whether a man stands in, or is heading into, cell (i, j).
    occupies(i, j) {
        return this.men.some((man) => (man.i == i && man.j == j) ||
            (man.i + man.step[0] == i && man.j + man.step[1] == j));
    }

    // Add a man standing in cell (i, j) of level L, fading in; he sets off
    // at once (avoiding the cells in avoid, [[i, j], ...]). False if full.
    spawn(level, i, j, avoid) {
        if (this.men.length >= this.max) {
            return false;
        }
        const man = { level, i, j, step: [0, 0], start: this.beats, born: this.beats, dying: null,
            facing_from: Math.random() * 2 * Math.PI, facing_to: 0 };
        man.facing_to = man.facing_from;
        this.men.push(man);
        this.choose_step(man, avoid);
        return true;
    }

    // Fade out the men further than `half` cells (either axis) from cell
    // (ci, cj); and drop them all if they're not on level L.
    cull(level, ci, cj, half) {
        for (let k = this.men.length - 1; k >= 0; k--) {
            const man = this.men[k];
            if (man.level != level) {
                this.men.splice(k, 1);
            } else if (man.dying === null && (Math.abs(man.i - ci) > half || Math.abs(man.j - cj) > half)) {
                man.dying = this.beats;
            }
        }
    }

    // Pick a man's next step: an open level way, into no one's cell nor the
    // avoided ones, not straight back unless there's no other; or stand.
    choose_step(man, avoid) {
        const [pi, pj] = man.step;
        const ways = MAZE_DIRS.filter(([di, dj]) => {
            const step = this.levels.step(man.level, man.i, man.j, di, dj);
            const ni = man.i + di, nj = man.j + dj;
            return step !== null && step.climb == 0 && !this.levels.stairs_cell(man.level, ni, nj) &&
                !avoid.some(([ai, aj]) => ai == ni && aj == nj) &&
                !this.men.some((other) => other !== man && ((other.i == ni && other.j == nj) ||
                    (other.i + other.step[0] == ni && other.j + other.step[1] == nj)));
        });
        const on = ways.filter(([di, dj]) => !(di == -pi && dj == -pj));
        const pick = on.length > 0 ? on : ways;
        man.step = pick.length > 0 ? pick[Math.floor(Math.random() * pick.length)] : [0, 0];
        man.facing_from = man.facing_to;
        if (man.step[0] != 0 || man.step[1] != 0) {
            let to = Math.atan2(man.step[0], man.step[1]);
            to += Math.round((man.facing_to - to) / (2 * Math.PI)) * 2 * Math.PI;
            man.facing_to = to;
        }
    }

    // Advance to `beats` and pose them, in the frame of cell (ci, cj)'s
    // centre on their level's floor. avoid: cells not to step into. alpha:
    // (x, z) => the fill's opacity there (fog, level fade); edge_alpha the
    // same for the edges.
    update(beats, d_beats, ci, cj, avoid, alpha, edge_alpha) {
        this.beats = beats;
        for (const k of [0, 1]) {
            this.eye_flash[k] = Math.max(0, this.eye_flash[k] - d_beats / EYE_FLASH_BEATS);
        }
        const arm = this.arm_angle();
        const kick = Math.sin(2 * Math.PI * beats * KICKS_PER_BEAT / 2);
        for (let k = this.men.length - 1; k >= 0; k--) {
            const man = this.men[k];
            if (man.dying !== null && beats - man.dying >= FADE_BEATS) {
                this.men.splice(k, 1);
            }
        }

        this.bodies.begin();
        this.arms.begin();
        this.legs.begin();
        this.eye_slots.forEach((slot) => { slot.group.visible = false; });
        this.men.forEach((man, n) => {
            while (beats - man.start >= MOVE_BEATS) {
                man.i += man.step[0];
                man.j += man.step[1];
                man.start += MOVE_BEATS;
                this.choose_step(man, avoid);
            }
            const frac = (beats - man.start) / MOVE_BEATS;
            const x = (man.i - ci + man.step[0] * frac) * this.cell;
            const z = (man.j - cj + man.step[1] * frac) * this.cell;
            const facing = lerp_scalar(man.facing_from, man.facing_to,
                ease(clamp(frac / TURN_FRACTION, 0, 1)));
            let fade = clamp((beats - man.born) / FADE_BEATS, 0, 1);
            if (man.dying !== null) {
                fade = Math.min(fade, 1 - (beats - man.dying) / FADE_BEATS);
            }
            const a = ease(fade) * alpha(x, z), ea = ease(fade) * edge_alpha(x, z);

            const m = this.m_man.makeRotationY(facing).setPosition(x, 0, z);
            this.bodies.add_instance(m, a, ea);
            for (const side of [1, -1]) {
                // The right arm is the left turned round to reach -x, swung
                // the other way up (both swing through the front).
                const part = this.m_part.copy(m).multiply(
                    this.m_tmp.makeTranslation(side * TORSO_HALF_W, SHOULDER_Y, 0));
                if (side < 0) {
                    part.multiply(this.m_tmp.makeRotationY(Math.PI));
                }
                part.multiply(this.m_tmp.makeRotationX(side > 0 ? arm : Math.PI + arm));
                this.arms.add_instance(part, a, ea);
                // Each leg kicks out to its own side on its half of the beat.
                const swing = KICK_ANGLE * Math.max(0, side * kick);
                const leg = this.m_part.copy(m).multiply(
                    this.m_tmp.makeTranslation(side * HIP_X, LEG_LEN, 0)).multiply(
                    this.m_tmp.makeRotationZ(side * swing));
                this.legs.add_instance(leg, a, ea);
            }

            const slot = this.eye_slots[n];
            slot.group.visible = ea > 0;
            slot.group.matrix.copy(m);
            slot.group.matrixWorldNeedsUpdate = true;
            slot.mats.forEach((mat, e) => {
                mat.color.lerpColors(EYE_COLOR, EYE_FLASH_COLOR, ease(this.eye_flash[e]));
                mat.opacity = Math.max(a, ea);
            });
        });
        this.bodies.end();
        this.arms.end();
        this.legs.end();
    }

    // Whether their fills cast shadows.
    cast_shadows(on) {
        for (const props of [this.bodies, this.arms, this.legs]) {
            props.cast_shadows(on);
        }
    }
}
