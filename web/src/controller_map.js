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

// Rotation of a scene's top-level group/scene/camera: knob 8 -> signed Y
// rotation rate, knob 9 -> signed X (pitch) rate. Continuous scenes integrate
// it directly; stepped scenes show it in eased 45 deg steps (SteppedRotation).
export const CH_ROT_Y = 8;
export const CH_ROT_X = 9;

// Camera zoom (see KnobZoom): next to the rotation knobs, so the three view
// controls sit together on the controller.
export const CH_ZOOM = 10;

// A bind_to `transform` mapping a knob's normalized 0..1 value to a signed
// multiplier in [-2, 2]: the midpoint (0.5) stops a continuous rotation and the
// extremes spin it at full speed in either direction (-2 * nom_rate .. +2 * nom_rate).
export function knob_to_rate(norm) {
    return norm * 4 - 2;
}

// A bind_to `transform` mapping a knob's normalized 0..1 value to [0, max]
// with a dead zone at the bottom: the lowest `zero_zone` of the travel returns
// a literal 0 (not a float that merely rounds near it), so a sweep rests at
// exactly zero for a while, and the rest of the travel maps linearly to
// (0, max], continuous at the zone's edge. The default ~1/8 of the travel
// (16 of 128 MIDI steps) is easy to find by hand.
export function knob_with_zero_zone(max, zero_zone=0.12) {
    return (norm) => norm <= zero_zone ? 0 :
        (norm - zero_zone) / (1 - zero_zone) * max;
}
