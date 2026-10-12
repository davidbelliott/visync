// Stepped (quantised) view of a continuous rotation.
//
// Given a continuously changing source angle each frame (typically the shared
// view yaw or pitch, see view_transform.js), the visible angle moves to the
// stop nearest it (multiples of `step`, or a given set of `stops` per turn)
// with an ease-in/ease-out tween. A move always runs to completion before the
// next starts (heading for wherever the target is by then), so every move
// starts and stops from rest; it always takes the short way round. Updates
// only run while the owning scene is on screen, so after a gap (the scene
// was hidden) it jumps straight to the current stop instead of easing over
// from where it was left, which would read as a lurch on every scene change.
//
// Usage, per rotation axis:
//   this.yaw = new SteppedRotation();
//   ...in anim_frame:  group.rotation.y = this.yaw.update(dt, this.view_yaw(STEPPED_SCALE));
// and for an upright pitch (isometric views and level), starting at the tilt:
//   this.pitch = new SteppedRotation({ stops: UPRIGHT_PITCHES, bounce: true, start: PITCH_BASE });
//   ...group.rotation.x = this.pitch.update(dt, PITCH_BASE + this.view_pitch(STEPPED_SCALE));
import { lerp_scalar, ease } from './util.js';

// The isometric tilt (rad): the elevation of a view straight down a cube's
// body diagonal. Stepped pitches start from +/- this (a base added to the
// source angle; see the scenes' PITCH_BASE).
export const ISOMETRIC_TILT = Math.asin(1 / Math.sqrt(3));
const ISO = ISOMETRIC_TILT;
// Upright pitch stops (rad), for use with `bounce`: the isometric tilt below
// (looking up at the bottom), level, and above (looking down on the top).
// Anything steeper reads as upside down and is too disorienting, so the
// source pitch is folded back and forth across this range instead of
// wrapping round a full turn.
export const UPRIGHT_PITCHES = [-ISO, 0, ISO];

// Scale of every stepped scene: this x the shared view angles (so the yaw
// knob's full sweep covers 270 deg, six 45 deg steps). One value for all of them so
// their steps happen together and land on the same stops: scenes whose base
// angles agree mod 45 deg stay aligned (e.g. gantry and spinning robots both
// on odd 45 deg multiples).
export const STEPPED_SCALE = 0.75;

const TURN = 2 * Math.PI;
// A gap between updates longer than this, s, means the scene was hidden
// rather than just a slow frame (main.js caps frame dt at a fraction of it).
const STALE_SECONDS = 0.25;

export class SteppedRotation {
    // step: visible step size in rad (PI/4 keeps isometric-friendly angles),
    //   used unless `stops` (angles within one turn, rad) is given.
    // bounce: instead of repeating the stops every turn, fold the source
    //   back and forth between the lowest and highest stop (a triangle wave),
    //   so the visible angle sweeps through the stops in order, reverses at
    //   each end, and never leaves that range.
    // move_time: s; duration of each eased move.
    // start: rad; the visible angle starts on the stop nearest this (pass the
    //   scene's base angle so it doesn't ease into place when first shown).
    constructor({ step = Math.PI / 4, stops = null, bounce = false, move_time = 1.0, start = 0 } = {}) {
        this.step = step;
        this.stops = stops;
        this.bounce = bounce;
        this.move_time = move_time;
        this.angle = this.snap(start);  // visible angle, rad
        this.from = this.angle;     // current move's start/end angles, rad
        this.to = this.angle;
        this.frac = 1;              // progress through the current move, 0..1
        this.last_update_ms = -Infinity;    // performance.now() of the last update
    }

    // The stop nearest `angle` (rad).
    snap(angle) {
        if (this.stops === null) {
            return Math.round(angle / this.step) * this.step;
        }
        if (this.bounce) {
            // Reflect into [lo, hi], then the nearest stop.
            const lo = Math.min(...this.stops);
            const span = Math.max(...this.stops) - lo;
            const m = (((angle - lo) % (2 * span)) + 2 * span) % (2 * span);
            const folded = lo + (m <= span ? m : 2 * span - m);
            let best = this.stops[0];
            for (const stop of this.stops) {
                if (Math.abs(stop - folded) < Math.abs(best - folded)) {
                    best = stop;
                }
            }
            return best;
        }
        const base = Math.floor(angle / TURN) * TURN;
        let best = null;
        for (const offset of [-TURN, 0, TURN]) {
            for (const stop of this.stops) {
                const candidate = base + offset + stop;
                if (best === null || Math.abs(candidate - angle) < Math.abs(best - angle)) {
                    best = candidate;
                }
            }
        }
        return best;
    }

    // Advance by dt seconds towards the stop nearest `source` (rad); returns
    // the visible angle in rad.
    update(dt, source) {
        const target = this.snap(source);
        const now = performance.now();
        const stale = now - this.last_update_ms > STALE_SECONDS * 1000;
        this.last_update_ms = now;
        if (stale) {
            this.angle = this.from = this.to = target;
            this.frac = 1;
            return this.angle;
        }
        if (this.frac >= 1 && target !== this.to) {
            // Same orientation, whole turns closer: the short way round.
            this.angle += Math.round((target - this.angle) / TURN) * TURN;
            this.from = this.angle;
            this.to = target;
            this.frac = 0;
        }
        if (this.frac < 1) {
            this.frac = Math.min(1, this.frac + dt / this.move_time);
            this.angle = lerp_scalar(this.from, this.to, ease(this.frac));
        }
        return this.angle;
    }
}
