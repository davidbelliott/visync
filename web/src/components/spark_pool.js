import { Component } from './component.js';
import { BeatClock } from '../util.js';

// Hi-hat channels (closed, open): each hit toggles every pool's sparks.
export const HIHAT_CHANNELS = [9, 10];
// Beats (while shown) without a hi-hat after which sparks go back to
// flickering, their look when no hats are playing.
const HIHAT_FLICKER_BEATS = 1/8;

// A scene's sparks: a fixed ring of Sparks, reused oldest first, that toggle
// in time with the hi-hats between two looks: steadily lit, and flickering
// per frame (on and off every Spark.flicker_frames, as Spark does on its
// own). Each hit (on the latency-compensated beat) switches every active
// spark to the other; they start flickering, and go back to it after
// HIHAT_FLICKER_BEATS without a hit. The pool flickers them itself, so sparks
// made with flicker off toggle too. They never hide, however slow the hats.
//
// Add it wherever the sparks should live (it positions them in its own frame),
// and forward the scene's anim_frame and handle_beat to it: scenes nest it in
// their groups and override handle_beat, so neither reaches it on its own.
export class SparkPool extends Component {
    // scene: the owning Scene (its camera to billboard towards, its beat
    // delay). make_spark: () => a new Spark. max: the ring's size.
    constructor(scene, make_spark, max) {
        super();
        this.scene = scene;
        this.since_hihat_clock = new BeatClock(scene);
        this.sparks = [];
        for (let i = 0; i < max; i++) {
            const spark = make_spark();
            spark.active = false;
            spark.visible = false;
            spark.life_s = Infinity;
            this.sparks.push(spark);
            this.add(spark);
        }
        this.next = 0;
        this.steady = false;            // lit steadily, else flickering
    }

    // The next spark, active for life_s seconds (by default until reused);
    // the caller sets its position, velocity and so on.
    spawn(life_s = Infinity) {
        const spark = this.sparks[this.next];
        this.next = (this.next + 1) % this.sparks.length;
        spark.active = true;
        spark.life_s = life_s;
        return spark;
    }

    anim_frame(dt) {
        this.steady = (this.since_hihat_clock.getElapsedBeats() > HIHAT_FLICKER_BEATS);

        for (const spark of this.sparks) {
            if (spark.active) {
                spark.life_s -= dt;
                spark.active = spark.life_s > 0;
            }
            spark.anim_frame(dt, this.scene.camera);
            const n = spark.flicker_frames;
            spark.visible = spark.active && this.steady;//(this.steady || spark.cur_frame % (2 * n) < n);
        }
    }

    handle_beat(latency, channel) {
        if (HIHAT_CHANNELS.includes(channel)) {
            this.since_hihat_clock.start();
        }
    }
}
