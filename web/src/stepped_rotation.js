// Knob-rate rotation shown in discrete, eased steps.
//
// A hidden angle integrates the knob-set rate continuously (the same rate
// control as the free-rotation scenes); the visible angle moves to that angle
// rounded to the nearest multiple of `step` with an ease-in/ease-out tween. A
// move always runs to completion before the next starts (heading for wherever
// the target is by then), so every move starts and stops from rest.
//
// Usage, per rotation axis:
//   this.yaw = new SteppedRotation(NOM_ROT_RATE);
//   this.yaw.bind(this, CH_ROT_Y);
//   ...in anim_frame:  group.rotation.y = this.yaw.update(dt);
import { lerp_scalar, ease } from './util.js';
import { knob_to_rate } from './controller_map.js';

export class SteppedRotation {
    // nom_rate: rad/s of the hidden angle at the default 1x; the knob scales
    //   it to [-2, 2] x (centred = stopped).
    // step: visible step size in rad (PI/4 keeps isometric-friendly angles).
    // move_time: s; duration of each eased move.
    constructor(nom_rate, step=Math.PI / 4, move_time=1.0) {
        this.nom_rate = nom_rate;
        this.step = step;
        this.move_time = move_time;
        this.rate = nom_rate;   // current hidden-angle rate, rad/s
        this.hidden = 0;        // continuous knob-integrated angle, rad
        this.angle = 0;         // visible angle, rad
        this.from = 0;          // current move's start/end angles, rad
        this.to = 0;
        this.frac = 1;          // progress through the current move, 0..1
    }

    // Drive the rate from a knob channel on `scene`. sign = -1 flips the
    // direction to match a physical knob's sense for this axis.
    bind(scene, channel, sign=1) {
        scene.bind(channel, (v) => { this.rate = sign * v * this.nom_rate; },
            knob_to_rate);
    }

    // Advance by dt seconds; returns the visible angle in rad.
    update(dt) {
        this.hidden += this.rate * dt;
        const target = Math.round(this.hidden / this.step) * this.step;
        if (this.frac >= 1 && target !== this.to) {
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
