// Shared controller-knob channel assignments and binding helpers.
//
// Channels are knob/wheel indices on a controller (the APC40 mkII mapping
// lives in adapter/apc40_control.py). Scenes import these constants instead of
// hard-coding knob numbers, so the physical layout is described in one place.

// Per-axis expansion knobs. Used for grid spacing (e.g. the yellow-robot dance
// grid, X/Y) and for the tesseract's per-axis scale (intro scene), where each
// knob's normalized 0..1 value drives one axis's scale directly (0 collapses
// the axis, 1 is full size). The tesseract is 4D, so it also uses Z and W.
export const CH_EXPAND_X = 3;
export const CH_EXPAND_Y = 4;
export const CH_EXPAND_Z = 5;
export const CH_EXPAND_W = 6;

// Rotation of a scene's top-level group/scene/camera.
//   - Discretized scenes: knob 8 -> Y target, knob 9 -> X target (snapped).
//   - Continuous scenes:  knob 8 -> signed rotation rate.
export const CH_ROT_Y = 8;
export const CH_ROT_X = 9;

// Returns a binding `transform` that snaps a knob's normalized 0..1 value to
// one of (steps + 1) evenly spaced integer indices (0, 1, ..., steps). Scenes
// that rotate in discrete steps use this to pick which step a knob selects, and
// interpolate towards it.
export function knob_to_snap(steps) {
    return (norm) => Math.round(norm * steps);
}

// A bind_to `transform` mapping a knob's normalized 0..1 value to a signed
// multiplier in [-2, 2]: the midpoint (0.5) stops a continuous rotation and the
// extremes spin it at full speed in either direction (-2 * nom_rate .. +2 * nom_rate).
export function knob_to_rate(norm) {
    return norm * 4 - 2;
}
