// Stacked endless mazes (InfiniteMaze, one per level, each its own layout)
// joined by ramps, plus the features placed in them: archways over some
// doorways and windows in some walls. Everything is decided by hashing
// coordinates, so it is the same however it is explored.
//
// A ramp joining level L to L + 1 fills one cell, R: a solid wedge on level
// L rising from the floor at its bottom side (towards cell B) to the wall
// tops at its top side (towards cell T), where level L + 1's floor carries on.
// R is a dead end on both levels, carved that way (InfiniteMaze leaves): on
// level L open only towards B, on level L + 1 only towards T. So on level L
// the wedge fills a blind alley wall to wall, ending flush against the wall
// at its top; on level L + 1 it is a hole walled in on three sides; and both
// mazes are connected without it. Ramp sites are picked from hashes alone
// (STAIR_SITES of each block, RAMP_P of them, uphill any way), before either
// maze is carved. The walk crosses a ramp in one
// two-cell move, B (level L) to T (level L + 1) or back, and R is otherwise
// impassable from every side on both levels. Up and down ramps of a level
// sit on cells of opposite parity (by level), so no cell is both.

import { InfiniteMaze, MAZE_DIRS, BLOCK, maze_hash } from './infinite_maze.js';

// Cells that can hold a ramp, by their position within their block (both
// coordinates): inside the block (so a ramp and the cells either side of it
// never reach a block's edge, where blocks join) and three apart (so ramps
// never touch). And the chance a site of the right parity holds one: half a
// ramp up and half down per block per level.
const STAIR_SITES = [2, 5];
const RAMP_P = 0.25;
// Chance a doorway (an opening in a straight run of wall) is an archway.
const ARCH_P = 0.3;
// Chance a wall has a window; WINDOW_ROUND_P of windows are round, the rest
// rectangular.
const WINDOW_P = 0.15;
const WINDOW_ROUND_P = 0.5;
// Levels' mazes kept generated, oldest dropped first.
const MAX_CACHED_LEVELS = 8;

// Level colours: saturated, and never cyan (the brain's colour). Stepped
// through 5 at a time (coprime with 6), so neighbouring levels always
// differ and the order doesn't read as a plain cycle.
export const LEVEL_COLORS = ['orange', 'magenta', '#ffd000', '#ff3b3b', '#a050ff', '#ff70b0'];
const COLOR_STRIDE = 5;

// Hash salts, so each decision is independent.
const SALT_RAMP = 9000;
const SALT_RAMP_DIR = 9500;
const SALT_RAMP_PARITY = 9900;
const SALT_ARCH = 8000;
const SALT_WINDOW = 8500;
const SALT_WINDOW_KIND = 8700;

function mod2(n) {
    return ((n % 2) + 2) % 2;
}

export class MazeLevels {
    constructor(seed = 1) {
        this.seed = seed;
        this.mazes = new Map();     // level -> InfiniteMaze
    }

    // Level L's maze.
    maze(level) {
        let maze = this.mazes.get(level);
        if (maze === undefined) {
            // Ramp cells are leaves: on the ramp's lower level open towards
            // its bottom, on its upper level towards its top.
            maze = new InfiniteMaze(this.seed * 1000 + level, (i, j) => {
                const up = this.ramp(level, i, j);
                if (up !== null) {
                    return [-up[0], -up[1]];
                }
                return this.ramp(level - 1, i, j);
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

    // The ramp from level L up to L + 1 filling cell (i, j), as its uphill
    // direction [di, dj] (from B through the cell to T), or null. Decided by
    // hashes alone (the mazes are carved to suit).
    ramp(level, i, j) {
        const x = ((i % BLOCK) + BLOCK) % BLOCK, y = ((j % BLOCK) + BLOCK) % BLOCK;
        if (!STAIR_SITES.includes(x) || !STAIR_SITES.includes(y) ||
                Math.floor(maze_hash(i, j, SALT_RAMP_PARITY) * 2) != mod2(level) ||
                maze_hash(i, j, SALT_RAMP + level) >= RAMP_P) {
            return null;
        }
        return MAZE_DIRS[Math.floor(maze_hash(i, j, SALT_RAMP_DIR + level) * MAZE_DIRS.length)];
    }

    // A ramp's name, the same from either level, for remembering which have
    // been taken.
    ramp_key(low_level, i, j) {
        return `${low_level},${i},${j}`;
    }

    // Moving from cell (i, j) of level L towards (i + di, j + dj): null if
    // blocked, else { climb, cells, key }: a ramp up / down (climb +1 / -1)
    // is a two-cell move through it, naming it by key; level ground is one
    // cell (climb 0, key null).
    step(level, i, j, di, dj) {
        if (!this.maze(level).open(i, j, di, dj)) {
            return null;
        }
        const ni = i + di, nj = j + dj;
        const up = this.ramp(level, ni, nj);
        if (up !== null) {
            return up[0] == di && up[1] == dj ?
                { climb: 1, cells: 2, key: this.ramp_key(level, ni, nj) } : null;
        }
        const down = this.ramp(level - 1, ni, nj);
        if (down !== null) {
            return down[0] == -di && down[1] == -dj ?
                { climb: -1, cells: 2, key: this.ramp_key(level - 1, ni, nj) } : null;
        }
        return { climb: 0, cells: 1, key: null };
    }

    // Whether cell (i, j) of level L is taken up by a ramp (its wedge, or
    // the hole down to one).
    ramp_cell(level, i, j) {
        return this.ramp(level, i, j) !== null || this.ramp(level - 1, i, j) !== null;
    }

    // Whether the open edge (i, j, side) on level L is spanned by an archway:
    // a doorway (the wall line runs on past both its ends) with no ramp.
    arch(level, i, j, side) {
        const maze = this.maze(level);
        if (side == 0) {
            if (!maze.east_open(i, j) || maze.east_open(i, j - 1) || maze.east_open(i, j + 1)) {
                return false;
            }
        } else if (!maze.north_open(i, j) || maze.north_open(i - 1, j) || maze.north_open(i + 1, j)) {
            return false;
        }
        return maze.cell_random(i, j, SALT_ARCH + side) < ARCH_P;
    }

    // The window in the wall on edge (i, j, side) of level L: 0 = none, 1 =
    // rectangular, 2 = round. Only closed edges (walls) have them.
    window(level, i, j, side) {
        const maze = this.maze(level);
        const wall = side == 0 ? !maze.east_open(i, j) : !maze.north_open(i, j);
        if (!wall || maze.cell_random(i, j, SALT_WINDOW + side) >= WINDOW_P) {
            return 0;
        }
        return maze.cell_random(i, j, SALT_WINDOW_KIND + side) < WINDOW_ROUND_P ? 2 : 1;
    }
}
