// An endless maze on the square grid, generated on demand: any cell's walls
// follow from hashing coordinates, so the maze is the same however (and
// however often) it is explored.
//
// The grid is cut into BLOCK x BLOCK blocks, each a perfect maze (one path
// between any two of its cells, carved by a randomised depth-first search
// seeded from the block's coordinates). Neighbouring blocks connect through
// doors in their shared wall: always one, plus each other cell along it with
// EXTRA_DOOR_P, which adds loops between blocks and keeps the block edges
// from reading as a regular grid of long walls. So every block reaches all
// four neighbours, and the maze can be crossed in any direction. Some blocks
// (ROOM_P of them) also hold an open room: a ROOM_MIN..ROOM_MAX cells square
// patch with its inner walls knocked through (which only adds loops, so the
// block stays connected). Cell (i, j) spans x in i +- 0.5, z in j +- 0.5
// (grid units); "north" is +z.

const BLOCK = 8;
const EXTRA_DOOR_P = 0.2;
const ROOM_P = 0.5;
const ROOM_MIN = 2;
const ROOM_MAX = 3;
// Blocks kept generated: a few screens' worth, oldest dropped first.
const MAX_CACHED_BLOCKS = 256;

// Hash integers (cell or block coordinates, and a salt choosing which
// decision) to [0, 1). Exported as maze_hash for decisions that must not
// depend on a maze's seed (e.g. ones shared by stacked mazes).
export function maze_hash(i, j, salt) {
    return hash01(i, j, salt);
}

function hash01(i, j, salt) {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Seeded generator of [0, 1) (mulberry32), for carving one block.
function make_rng(seed) {
    let a = Math.floor(seed * 4294967296) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The four ways out of a cell, (di, dj).
export const MAZE_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export class InfiniteMaze {
    // seed: integer picking which maze.
    constructor(seed = 1) {
        this.seed = seed;
        this.blocks = new Map();    // "bi,bj" -> carved block
    }

    // A fixed random number in [0, 1) for cell (i, j), for placing things
    // in the maze; salt picks independent ones.
    cell_random(i, j, salt = 0) {
        return hash01(i, j, this.seed * 4 + 1000 + salt);
    }

    // The open room in block (bi, bj), as { i, j, w, h }: its south-west
    // cell and size in cells; or null.
    room(bi, bj) {
        const room = this.block(bi, bj).room;
        return room === null ? null :
            { i: bi * BLOCK + room.x, j: bj * BLOCK + room.y, w: room.w, h: room.h };
    }

    // The rooms of the blocks overlapping cells i0..i1, j0..j1.
    rooms_in(i0, j0, i1, j1) {
        const rooms = [];
        for (let bi = Math.floor(i0 / BLOCK); bi <= Math.floor(i1 / BLOCK); bi++) {
            for (let bj = Math.floor(j0 / BLOCK); bj <= Math.floor(j1 / BLOCK); bj++) {
                const room = this.room(bi, bj);
                if (room !== null) {
                    rooms.push(room);
                }
            }
        }
        return rooms;
    }

    // Whether cell (i, j) opens towards (i + di, j + dj), a neighbour.
    open(i, j, di, dj) {
        if (di == 1) return this.east_open(i, j);
        if (di == -1) return this.east_open(i - 1, j);
        if (dj == 1) return this.north_open(i, j);
        return this.north_open(i, j - 1);
    }

    // Whether cell (i, j) opens east into (i + 1, j).
    east_open(i, j) {
        const bi = Math.floor(i / BLOCK), bj = Math.floor(j / BLOCK);
        const x = i - bi * BLOCK, y = j - bj * BLOCK;
        if (x < BLOCK - 1) {
            return this.block(bi, bj).east[x + y * BLOCK] == 1;
        }
        return this.door(bi, bj, y, 0);
    }

    // Whether cell (i, j) opens north into (i, j + 1).
    north_open(i, j) {
        const bi = Math.floor(i / BLOCK), bj = Math.floor(j / BLOCK);
        const x = i - bi * BLOCK, y = j - bj * BLOCK;
        if (y < BLOCK - 1) {
            return this.block(bi, bj).north[x + y * BLOCK] == 1;
        }
        return this.door(bi, bj, x, 1);
    }

    // Whether the wall on block (bi, bj)'s east (side 0) or north (side 1)
    // edge has a door at cell k along it.
    door(bi, bj, k, side) {
        const salt = this.seed * 4 + side;
        const forced = Math.floor(hash01(bi, bj, salt) * BLOCK);
        return k == forced || hash01(bi * BLOCK + k, bj, salt + 2) < EXTRA_DOOR_P;
    }

    // Block (bi, bj)'s inner passages: east[x + y * BLOCK] / north[...] are
    // 1 where cell (x, y) opens east / north within the block.
    block(bi, bj) {
        const key = `${bi},${bj}`;
        let block = this.blocks.get(key);
        if (block === undefined) {
            block = this.carve(make_rng(hash01(bi, bj, this.seed * 4 + 3)));
            if (this.blocks.size >= MAX_CACHED_BLOCKS) {
                this.blocks.delete(this.blocks.keys().next().value);
            }
            this.blocks.set(key, block);
        }
        return block;
    }

    // Randomised depth-first search over the block's cells.
    carve(rng) {
        const east = new Uint8Array(BLOCK * BLOCK);
        const north = new Uint8Array(BLOCK * BLOCK);
        const visited = new Uint8Array(BLOCK * BLOCK);
        const stack = [Math.floor(rng() * BLOCK * BLOCK)];
        visited[stack[0]] = 1;
        while (stack.length > 0) {
            const c = stack[stack.length - 1];
            const x = c % BLOCK, y = Math.floor(c / BLOCK);
            const next = MAZE_DIRS.filter(([dx, dy]) => {
                const nx = x + dx, ny = y + dy;
                return nx >= 0 && nx < BLOCK && ny >= 0 && ny < BLOCK && !visited[nx + ny * BLOCK];
            });
            if (next.length == 0) {
                stack.pop();
                continue;
            }
            const [dx, dy] = next[Math.floor(rng() * next.length)];
            const n = (x + dx) + (y + dy) * BLOCK;
            if (dx == 1) east[c] = 1;
            if (dx == -1) east[n] = 1;
            if (dy == 1) north[c] = 1;
            if (dy == -1) north[n] = 1;
            visited[n] = 1;
            stack.push(n);
        }
        // Knock through a room's inner walls.
        let room = null;
        if (rng() < ROOM_P) {
            const size = () => ROOM_MIN + Math.floor(rng() * (ROOM_MAX - ROOM_MIN + 1));
            const w = size(), h = size();
            room = { x: Math.floor(rng() * (BLOCK - w + 1)), y: Math.floor(rng() * (BLOCK - h + 1)), w, h };
            for (let y = room.y; y < room.y + h; y++) {
                for (let x = room.x; x < room.x + w; x++) {
                    if (x < room.x + w - 1) east[x + y * BLOCK] = 1;
                    if (y < room.y + h - 1) north[x + y * BLOCK] = 1;
                }
            }
        }
        return { east, north, room };
    }
}
