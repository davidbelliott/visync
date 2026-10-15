import { ease } from './util.js';

// The shuffle: the dance step the robots do (spinning robots, yellow robot,
// ddr), for anything that should shuffle in step with them. Time t is in
// half notes (beats / 2, from a clock started on a half-note beat, or any
// steady beat count / 2); it needn't wrap. Each half note is SHUFFLE_STEPS steps of an eighth note;
// in each, things hold still and then move over its last SHUFFLE_MOVE, eased,
// landing on the next eighth.
const SHUFFLE_STEPS = 4;
const SHUFFLE_MOVE = 0.8;

// How far through the current step's move t is, 0..1 (0 while holding), for
// a move over the last `move` of each step.
function step_progress(t, move) {
    const period = 1 / SHUFFLE_STEPS, t_mov = period * move;
    return Math.max(0, (t % period) - (period - t_mov)) / t_mov;
}

// Foot `side`'s (0 left, 1 right) offset at t, written to out ([x, y, z],
// returned): y the lift, 0..1, z the slide, -1 (back) .. 1 (forward), x 0.
// Over two steps a foot lifts while sliding from back to the middle, then
// sets down while sliding forward; over the next two, slides back along the
// ground: the feet half a cycle apart, so one is always down, and one lands
// on every beat. The lift is a hop, not an ease: up fast and slowing to the
// top, then falling faster and faster to strike the ground on the beat (an
// ease to rest there would look down before it, so the step read as early).
export function shuffle_foot(side, t, out = [0, 0, 0]) {
    const f = step_progress(t, SHUFFLE_MOVE);
    out[0] = 0;
    switch ((Math.floor(t * SHUFFLE_STEPS) + 2 * side) % 4) {
        case 0:
            out[1] = Math.sin(Math.PI / 2 * Math.min(1, f));
            out[2] = ease(Math.min(0, -1 + f));
            break;
        case 1:
            out[1] = Math.cos(Math.PI / 2 * Math.min(1, f));
            out[2] = ease(Math.min(1, f));
            break;
        case 2:
            out[1] = 0;
            out[2] = ease(Math.max(0, 1 - f));
            break;
        default:
            out[1] = 0;
            out[2] = ease(Math.max(-1, -f));
    }
    return out;
}

// The bob that goes with it (the body, or arms pumping), 0..1 at t: up over
// one step, down over the next. move: the share of each step spent moving
// (SHUFFLE_MOVE, as the feet, by default).
export function shuffle_bob(t, move = SHUFFLE_MOVE) {
    const f = step_progress(t, move);
    return Math.floor(t * SHUFFLE_STEPS) % 2 == 0 ? ease(Math.min(1, f)) : ease(Math.max(0, 1 - f));
}
