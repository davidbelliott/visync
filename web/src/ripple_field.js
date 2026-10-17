// Superimposed damped ripples on an unbounded grid: each impact (add) sends
// out a train of rings from its cell, the sum of every recent impact's
// giving each cell's height (rest = 0). In grid cells and seconds: a ripple
// of age a reaches d = speed * a from its centre; inside that front a cell
// d away sits at
//   -amplitude * exp(-a / decay_s) * sin(2 pi (speed * a - d) / wavelength)
//       / sqrt(1 + d / spread)
// so it dips first (a strike knocks it down), then rings, dying away over
// decay_s and thinning as the ring widens (as a 2D wave's does, ~1/sqrt(d),
// from about `spread` cells out).
//
// Impacts are kept in a ring of `max`, the oldest overwritten; one counts
// until its decay falls below CUTOFF.

const CUTOFF = 0.01;

export class RippleField {
    // amplitude: height units at the centre's first dip. speed: cells/s.
    // wavelength: cells between crests. decay_s: s for amplitude to fall by
    // 1/e. spread: cells out at which the rings start thinning. max: impacts
    // remembered.
    constructor({ amplitude, speed, wavelength, decay_s, spread = 1, max = 8 }) {
        this.amplitude = amplitude;
        this.spread = spread;
        this.speed = speed;
        this.wavelength = wavelength;
        this.decay_s = decay_s;
        this.t = 0;                             // s since creation
        this.row = new Float32Array(max);
        this.col = new Float32Array(max);
        this.start = new Float64Array(max).fill(-Infinity);
        // Per impact, set each update: its front's distance (cells) and its
        // time decay times amplitude (0 once spent).
        this.front = new Float32Array(max);
        this.gain = new Float32Array(max);
        this.next = 0;
    }

    // An impact on logical cell (row, col), now.
    add(row, col) {
        const k = this.next;
        this.next = (k + 1) % this.start.length;
        this.row[k] = row;
        this.col[k] = col;
        this.start[k] = this.t;
        this.front[k] = 0;
        this.gain[k] = this.amplitude;
    }

    // Relabel the logical grid by (-d_row, -d_col) without moving anything
    // (see the scenes' rebase).
    shift_labels(d_row, d_col) {
        for (let k = 0; k < this.start.length; k++) {
            this.row[k] -= d_row;
            this.col[k] -= d_col;
        }
    }

    // Advance by dt seconds.
    update(dt) {
        this.t += dt;
        for (let k = 0; k < this.start.length; k++) {
            const age = this.t - this.start[k];
            const decay = Math.exp(-age / this.decay_s);
            this.front[k] = this.speed * age;
            this.gain[k] = decay < CUTOFF ? 0 : this.amplitude * decay;
        }
    }

    // Height of logical cell (row, col): every live ripple's, summed.
    height(row, col) {
        let y = 0;
        for (let k = 0; k < this.start.length; k++) {
            const gain = this.gain[k];
            if (gain == 0) {
                continue;
            }
            const d = Math.hypot(row - this.row[k], col - this.col[k]);
            const behind = this.front[k] - d;           // cells behind the front
            if (behind > 0) {
                y -= gain * Math.sin(2 * Math.PI * behind / this.wavelength) /
                    Math.sqrt(1 + d / this.spread);
            }
        }
        return y;
    }
}
