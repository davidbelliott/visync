// Message type for a control change (e.g. a knob or wheel being turned).
const MSG_TYPE_CONTROL_CHANGE = 8;
// Message type for a full pose skeleton (see adapter/message.py's MsgPose).
const MSG_TYPE_POSE = 9;

// Knobs the app exposes, numbered like apc40_control.py: 0-7 are the track
// faders, 8-15 the top device knobs.
export const NUM_KNOBS = 16;

export class Knob {
    // A knob holds a single normalized value in the range [0, 1]. Scenes decide
    // how to map this to whatever range a given property needs.
    constructor(default_val=0) {
        this.cur_val = default_val;
        this.bindings = [];
    }

    // Call `apply` whenever this knob's value changes, with `transform` mapping
    // the normalized 0..1 value to whatever the target property wants.
    bind_to(apply, transform = (x) => x) {
        this.bindings.push({ apply, transform });
    }
}

// Build the app's knobs. They belong to the app rather than to any one
// controller: which socket a value arrived on says nothing about what it means,
// so every transport writes into one set of these (see main.js).
export function create_knobs() {
    const knobs = new Map();
    for (let i = 0; i < NUM_KNOBS; i++) {
        // Knob values arrive already normalized to [0, 1] from the adapter.
        knobs.set(i, new Knob());
    }
    return knobs;
}

// Apply one normalized control-change value to `knobs` and fire that knob's
// bindings. Shared by every transport that can carry a control change: a
// controller adapter's own socket (WebsocketController below) and the relay
// (see main.js).
export function apply_control_change(knobs, wheel_idx, value) {
    const knob = knobs.get(wheel_idx);
    if (!knob) {
        return;
    }
    // Value is normalized [0, 1]; clamp defensively.
    knob.cur_val = Math.max(0, Math.min(1, value));
    knob.bindings.forEach((binding) => {
        binding.apply(binding.transform(knob.cur_val));
    });
}

// Receives a controller adapter's events over its own WebSocket and applies
// them to `knobs`, reconnecting indefinitely so the adapter can come and go.
export class WebsocketController {
    constructor(context, url, knobs) {
        this.context = context;
        this.url = url;
        this.knobs = knobs;
        this.connect();
    }

    connect() {
        this.socket = new WebSocket(this.url);
        this.socket.addEventListener('message', (e) => this.on_message(e));
        this.socket.addEventListener('close', () => {
            // Try to reconnect after 1 second
            setTimeout(() => this.connect(), 1000);
        });
        this.socket.addEventListener('error', (e) => {
            console.log('Socket encountered error: ', e, 'Closing socket');
            this.socket.close();
        });
    }

    on_message(e) {
        const msg = JSON.parse(e.data);
        this.handle_message(msg);
    }

    handle_message(msg) {
        if (msg.msg_type == MSG_TYPE_CONTROL_CHANGE) {
            apply_control_change(this.knobs, msg.wheel_idx, msg.value);
        } else if (msg.msg_type == MSG_TYPE_POSE) {
            this.context.handle_pose(msg.skeletons);
        }
    }
}
