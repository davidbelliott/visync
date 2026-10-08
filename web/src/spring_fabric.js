// A square patch of spring-coupled masses: a damped wave fabric.
//
// Each cell has a height (rest = 0) and a vertical velocity. Its acceleration
//   a = -anchor * y + coupling * (sum of 4 neighbours - 4 y) - damping * v
// i.e. a spring to its rest height (anchor, 1/s^2: the fabric's own bounce,
// sqrt(anchor) rad/s), springs to its neighbours (coupling, 1/s^2: ripples
// travel at about sqrt(coupling) cells/s), and viscous damping (damping, 1/s:
// amplitude decays as exp(-damping / 2 * t)). All three are plain fields and
// can be changed at any time.
//
// The patch covers a size x size window of an unbounded logical grid and can
// be moved by whole cells (set_origin): the overlap keeps its motion, newly
// covered cells start at rest. Cells beyond the window are fixed at 0, and an
// absorbing band (extra damping ramping up over edge_cells towards the border)
// soaks up ripples there instead of reflecting them back in.

// Largest semi-implicit Euler step (in units of 1 / the fastest mode's
// angular frequency) kept well under the stability limit of 2.
const MAX_STEP_OMEGA = 0.5;
// Longest frame (s) simulated in full; longer gaps (a hidden tab) are clipped
// so returning to the scene doesn't cost a burst of substeps.
const MAX_FRAME_S = 0.1;

export class SpringFabric {
    constructor(size, { anchor, coupling, damping, edge_cells = 4, edge_damping = 20 }) {
        this.size = size;
        this.anchor = anchor;
        this.coupling = coupling;
        this.damping = damping;
        // Absorbing band: extra damping (1/s) reached at the border, ramped
        // up quadratically over the outermost edge_cells (quadratic so the
        // band's inner edge doesn't itself reflect).
        this.edge_cells = edge_cells;
        this.edge_damping = edge_damping;

        this.y = new Float32Array(size * size);
        this.v = new Float32Array(size * size);
        this.scratch = new Float32Array(size * size);
        this.extra_damping = new Float32Array(size * size);
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                const from_edge = Math.min(i, j, size - 1 - i, size - 1 - j);
                const depth = Math.max(0, 1 - from_edge / edge_cells);
                this.extra_damping[i * size + j] = depth * depth;
            }
        }
        this.row0 = 0;      // logical cell at local (0, 0)
        this.col0 = 0;
    }

    // Cover the window whose first cell is (row0, col0), carrying over the
    // overlap with the old window.
    set_origin(row0, col0) {
        const dr = row0 - this.row0;
        const dc = col0 - this.col0;
        if (dr == 0 && dc == 0) {
            return;
        }
        const n = this.size;
        for (const arr of [this.y, this.v]) {
            this.scratch.fill(0);
            for (let i = 0; i < n; i++) {
                const si = i + dr;
                if (si < 0 || si >= n) {
                    continue;
                }
                for (let j = 0; j < n; j++) {
                    const sj = j + dc;
                    if (sj >= 0 && sj < n) {
                        this.scratch[i * n + j] = arr[si * n + sj];
                    }
                }
            }
            arr.set(this.scratch);
        }
        this.row0 = row0;
        this.col0 = col0;
    }

    // Relabel the logical grid by (-d_row, -d_col) without moving anything
    // (see the scenes' rebase).
    shift_labels(d_row, d_col) {
        this.row0 -= d_row;
        this.col0 -= d_col;
    }

    // Height of logical cell (row, col); 0 outside the window.
    height(row, col) {
        const i = row - this.row0;
        const j = col - this.col0;
        if (i < 0 || j < 0 || i >= this.size || j >= this.size) {
            return 0;
        }
        return this.y[i * this.size + j];
    }

    // Add `dv` (units/s) to logical cell (row, col)'s velocity: a strike on
    // that one cell (the ripples spread from it through the couplings).
    kick(row, col, dv) {
        const i = row - this.row0;
        const j = col - this.col0;
        if (i >= 0 && j >= 0 && i < this.size && j < this.size) {
            this.v[i * this.size + j] += dv;
        }
    }

    // Advance by dt seconds (substepped for stability).
    update(dt) {
        dt = Math.min(dt, MAX_FRAME_S);
        const omega_max = Math.sqrt(this.anchor + 8 * this.coupling) + this.damping + this.edge_damping;
        const steps = Math.max(1, Math.ceil(dt * omega_max / MAX_STEP_OMEGA));
        const h = dt / steps;
        const n = this.size;
        const y = this.y;
        const v = this.v;
        for (let s = 0; s < steps; s++) {
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const k = i * n + j;
                    const up = i > 0 ? y[k - n] : 0;
                    const down = i < n - 1 ? y[k + n] : 0;
                    const left = j > 0 ? y[k - 1] : 0;
                    const right = j < n - 1 ? y[k + 1] : 0;
                    const damping = this.damping + this.edge_damping * this.extra_damping[k];
                    const a = -this.anchor * y[k] +
                        this.coupling * (up + down + left + right - 4 * y[k]) -
                        damping * v[k];
                    v[k] += a * h;
                }
            }
            for (let k = 0; k < n * n; k++) {
                y[k] += v[k] * h;
            }
        }
    }
}
