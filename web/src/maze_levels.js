// Stacked endless mazes (InfiniteMaze, one per level, each its own layout)
// joined by staircases, plus the features placed in them: archways over some
// doorways and windows in some walls. Everything is decided by hashing
// coordinates, so it is the same however it is explored.
//
// Each level has its own character (params()): its wall height (a multiple
// of the standard height, usually 1, sometimes 2), how often its walls have
// rectangular or round windows, how often its doorways are archways, and how
// often its blocks hold rooms and how big they get.
//
// A staircase joins level L to L + 1. It climbs level L's wall height, and
// is as many cells long as that height is multiples of the standard (so its
// pitch is always the same): a dead-end corridor of k cells, R1..Rk, carved
// into both mazes as fixed cells (InfiniteMaze): on level L open only from
// its bottom (cell B, before R1), on level L + 1 only from its top (cell T,
// past Rk). So on level L the stairs fill a blind alley wall to wall, their
// top flush with the wall beyond; on level L + 1 they are a hole walled in on
// three sides; and both mazes stay connected without them. They are crossed
// in one move, B (level L) to T (level L + 1) or back, and are otherwise
// impassable from every side on both levels.
//
// Each block has one stair site, in its middle (so even a two-cell
// staircase and the cells either end of it stay clear of the block's edges),
// used by the level pairs of one parity: alternate levels' staircases up and
// down never compete for it.

import { InfiniteMaze, BLOCK, maze_hash } from './infinite_maze.js';

// Chance a block's stair site holds a staircase (for a level pair of its
// parity, so each level has about half a staircase up and half down per
// block at 1).
const STAIRS_P = 1;
// Levels' character (see params()): chance of double-height walls; the
// ranges each level's window, archway, room and wide-hall chances are drawn
// from; and the largest rooms a level can have (it picks one of
// ROOM_LARGEST, up to the whole width of a block).
const TALL_P = 0.2;
const WINDOW_RECT_P = [0, 0.2];
const WINDOW_ROUND_P = [0, 0.2];
const ARCH_P = [0.1, 0.5];
const ROOM_P = [0.5, 1];
const WIDE_P = [0, 0.4];
const ROOM_SIZE_MIN = 2;
const ROOM_LARGEST = [3, 8];
// Levels' mazes and blocks' staircases kept generated, oldest dropped first.
const MAX_CACHED_LEVELS = 8;
const MAX_CACHED_STAIRS = 1024;

// Level colours: saturated, and never cyan (the brain's colour). Stepped
// through 5 at a time (coprime with 6), so neighbouring levels always
// differ and the order doesn't read as a plain cycle.
export const LEVEL_COLORS = ['orange', 'magenta', '#ffd000', '#ff3b3b', '#a050ff', '#ff70b0'];
const COLOR_STRIDE = 5;

// Hash salts, so each decision is independent.
const SALT_STAIRS = 9000;
const SALT_STAIRS_PARITY = 9900;
const SALT_PARAMS = 7000;
const SALT_ARCH = 8000;
const SALT_WINDOW = 8500;

function mod2(n) {
    return ((n % 2) + 2) % 2;
}

function lerp([lo, hi], f) {
    return lo + (hi - lo) * f;
}

export class MazeLevels {
    constructor(seed = 1) {
        this.seed = seed;
        this.mazes = new Map();     // level -> InfiniteMaze
        this.level_params = new Map();
        this.stair_cache = new Map();
    }

    // Level L's character: { height (wall height, in standard heights),
    // rect_p, round_p (window chances per wall), arch_p (per doorway),
    // room_p (per block), room_max (largest room side, cells), wide_p (per
    // block: halls two cells wide) }.
    params(level) {
        let p = this.level_params.get(level);
        if (p === undefined) {
            const h = (k) => maze_hash(level, k, this.seed + SALT_PARAMS);
            p = {
                height: h(0) < TALL_P ? 2 : 1,
                rect_p: lerp(WINDOW_RECT_P, h(1)),
                round_p: lerp(WINDOW_ROUND_P, h(2)),
                arch_p: lerp(ARCH_P, h(3)),
                room_p: lerp(ROOM_P, h(4)),
                room_max: ROOM_LARGEST[0] + Math.floor(h(5) * (ROOM_LARGEST[1] - ROOM_LARGEST[0] + 1)),
                wide_p: lerp(WIDE_P, h(6)),
            };
            this.level_params.set(level, p);
        }
        return p;
    }

    // Level L's maze, its staircases' cells fixed (see above).
    maze(level) {
        let maze = this.mazes.get(level);
        if (maze === undefined) {
            const p = this.params(level);
            maze = new InfiniteMaze(this.seed * 1000 + level, {
                fixed: (i, j) => this.fixed(level, i, j),
                room_p: p.room_p,
                room_min: ROOM_SIZE_MIN,
                room_max: p.room_max,
                wide_p: p.wide_p,
            });
            if (this.mazes.size >= MAX_CACHED_LEVELS) {
                this.mazes.delete(this.mazes.keys().next().value);
            }
            this.mazes.set(level, maze);
        }
        return maze;
    }

    // Level L's colour (see LEVEL_COLORS).
    color(level) {
        const n = LEVEL_COLORS.length;
        return LEVEL_COLORS[((level * COLOR_STRIDE) % n + n) % n];
    }

    // The staircase from level L up to L + 1 in block (bi, bj), or null:
    // { cells: [[i, j], ...] (R1..Rk, upwards), dir: [di, dj] (uphill),
    // k (cells long), bottom / top: [i, j] (cells B and T), key (its name,
    // for remembering it was taken) }. From hashes alone: the mazes are
    // carved to suit.
    stairs(level, bi, bj) {
        const cache_key = `${level},${bi},${bj}`;
        let st = this.stair_cache.get(cache_key);
        if (st !== undefined) {
            return st;
        }
        st = null;
        const h = (k) => maze_hash(bi, bj, this.seed + SALT_STAIRS + 8 * level + k);
        if (Math.floor(maze_hash(bi, bj, this.seed + SALT_STAIRS_PARITY) * 2) == mod2(level) &&
                h(0) < STAIRS_P) {
            // Along x or z, either way, at middle row 3 or 4 across it; R1
            // at 3 going up the axis or 4 going down, so B, the stairs and T
            // span cells 2..5.
            const along_x = h(1) < 0.5, sign = h(2) < 0.5 ? 1 : -1;
            const across = h(3) < 0.5 ? 3 : 4;
            const k = this.params(level).height;
            const start = sign > 0 ? 3 : 4;
            const cell = (u) => {
                const [x, y] = along_x ? [u, across] : [across, u];
                return [bi * BLOCK + x, bj * BLOCK + y];
            };
            const cells = [];
            for (let m = 0; m < k; m++) {
                cells.push(cell(start + sign * m));
            }
            st = {
                cells, k,
                dir: along_x ? [sign, 0] : [0, sign],
                bottom: cell(start - sign),
                top: cell(start + sign * k),
                key: `${level},${cells[0][0]},${cells[0][1]}`,
            };
        }
        if (this.stair_cache.size >= MAX_CACHED_STAIRS) {
            this.stair_cache.delete(this.stair_cache.keys().next().value);
        }
        this.stair_cache.set(cache_key, st);
        return st;
    }

    // The staircases from level L up to L + 1 in the blocks overlapping
    // cells i0..i1, j0..j1.
    stairs_in(level, i0, j0, i1, j1) {
        const list = [];
        for (let bi = Math.floor(i0 / BLOCK); bi <= Math.floor(i1 / BLOCK); bi++) {
            for (let bj = Math.floor(j0 / BLOCK); bj <= Math.floor(j1 / BLOCK); bj++) {
                const st = this.stairs(level, bi, bj);
                if (st !== null) {
                    list.push(st);
                }
            }
        }
        return list;
    }

    // The staircase from level L up to L + 1 whose cells include (i, j), as
    // { stairs, index } (which cell of it, 0 = R1), or null.
    stairs_at(level, i, j) {
        const st = this.stairs(level, Math.floor(i / BLOCK), Math.floor(j / BLOCK));
        if (st === null) {
            return null;
        }
        const index = st.cells.findIndex(([ci, cj]) => ci == i && cj == j);
        return index < 0 ? null : { stairs: st, index };
    }

    // The ways a staircase's cell (i, j) on level L opens, or null if it is
    // none: on the stairs' lower level back towards B and on up them; on
    // their upper level on towards T and back down them.
    fixed(level, i, j) {
        const up = this.stairs_at(level, i, j);
        if (up !== null) {
            const [di, dj] = up.stairs.dir;
            return up.index < up.stairs.k - 1 ? [[-di, -dj], [di, dj]] : [[-di, -dj]];
        }
        const down = this.stairs_at(level - 1, i, j);
        if (down !== null) {
            const [di, dj] = down.stairs.dir;
            return down.index > 0 ? [[di, dj], [-di, -dj]] : [[di, dj]];
        }
        return null;
    }

    // Moving from cell (i, j) of level L towards (i + di, j + dj): null if
    // blocked, else { climb, cells, height, key }: up / down a staircase
    // (climb +1 / -1) is one move of its k + 1 cells, rising `height`
    // standard heights, naming it by key; level ground is one cell (climb 0,
    // height 0, key null).
    step(level, i, j, di, dj) {
        if (!this.maze(level).open(i, j, di, dj)) {
            return null;
        }
        const ni = i + di, nj = j + dj;
        const up = this.stairs_at(level, ni, nj);
        if (up !== null) {
            const st = up.stairs;
            return up.index == 0 && st.dir[0] == di && st.dir[1] == dj ?
                { climb: 1, cells: st.k + 1, height: st.k, key: st.key } : null;
        }
        const down = this.stairs_at(level - 1, ni, nj);
        if (down !== null) {
            const st = down.stairs;
            return down.index == st.k - 1 && st.dir[0] == -di && st.dir[1] == -dj ?
                { climb: -1, cells: st.k + 1, height: st.k, key: st.key } : null;
        }
        return { climb: 0, cells: 1, height: 0, key: null };
    }

    // Whether cell (i, j) of level L is taken up by a staircase (its steps,
    // or the hole down to them).
    stairs_cell(level, i, j) {
        return this.stairs_at(level, i, j) !== null || this.stairs_at(level - 1, i, j) !== null;
    }

    // Whether the open edge (i, j, side) on level L (side 0: the cell's east
    // edge, 1: north) is spanned by an archway: a doorway (the wall line runs
    // on past both its ends), by the level's arch_p.
    arch(level, i, j, side) {
        const maze = this.maze(level);
        if (side == 0) {
            if (!maze.east_open(i, j) || maze.east_open(i, j - 1) || maze.east_open(i, j + 1)) {
                return false;
            }
        } else if (!maze.north_open(i, j) || maze.north_open(i - 1, j) || maze.north_open(i + 1, j)) {
            return false;
        }
        return maze.cell_random(i, j, SALT_ARCH + side) < this.params(level).arch_p;
    }

    // The window in the wall on edge (i, j, side) of level L: 0 = none, 1 =
    // rectangular, 2 = round, by the level's rect_p and round_p. Only closed
    // edges (walls) have them.
    window(level, i, j, side) {
        const maze = this.maze(level);
        const wall = side == 0 ? !maze.east_open(i, j) : !maze.north_open(i, j);
        if (!wall) {
            return 0;
        }
        const { rect_p, round_p } = this.params(level);
        const r = maze.cell_random(i, j, SALT_WINDOW + side);
        return r < rect_p ? 1 : r < rect_p + round_p ? 2 : 0;
    }
}
