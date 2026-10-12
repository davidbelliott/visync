// Stepped (quantised) view of a continuous rotation.
//
// Given a continuously changing source angle each frame (typically the shared
// view yaw or pitch, see view_transform.js), the visible angle moves to the
// stop nearest it (multiples of `step`, or a given set of `stops` per turn)
// with an ease-in/ease-out tween. A move always runs to completion before the
// next starts (heading for wherever the target is by then), so every move
// starts and stops from rest; it always takes the short way round. After a
// gap in updates (say the tab was hidden) it jumps straight to the current
// stop instead of easing over from where it was left.
//
// Stepped scenes don't own these: they share one SteppedView (below), so
// they all show the same orientation, as views into one space. A stepped
// scene sets `this.stepped_pitches` (the pitches it allows) and applies
// YAW_BASE + this.stepped_yaw() and this.stepped_pitch() (see Scene).
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
        if (this.stops.length == 1) {
            return this.stops[0];
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

// The one stepped view all stepped scenes share: a yaw in 45 deg steps and
// an upright pitch (starting at the isometric tilt), both from the shared
// view angles at STEPPED_SCALE. The context updates it once per frame before
// any scene, whether or not one is showing. Every stepped scene allows the
// same yaw stops (their bases differ by multiples of 45 deg), but some lock
// their pitch, so the pitch is limited to the stops every stepped scene on
// screen allows: while a pitch-locked scene shows, the others ease to its
// pitch and stay there with it.
export class SteppedView {
    constructor() {
        this.yaw_rotation = new SteppedRotation();
        this.pitch_rotation = new SteppedRotation(
            { stops: UPRIGHT_PITCHES, bounce: true, start: ISOMETRIC_TILT });
        this.yaw = 0;                   // rad, from the stepped scenes' bases
        this.pitch = ISOMETRIC_TILT;    // rad
    }

    // Advance by dt seconds. view: the ViewTransform; pitch_stops: the
    // pitches allowed now (rad; see GraphicsContext.anim_frame).
    update(dt, view, pitch_stops) {
        this.pitch_rotation.stops = pitch_stops;
        this.yaw = this.yaw_rotation.update(dt, view.yaw * STEPPED_SCALE);
        this.pitch = this.pitch_rotation.update(dt, ISOMETRIC_TILT + view.pitch * STEPPED_SCALE);
    }
}
