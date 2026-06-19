// Message type for a control change (e.g. a knob or wheel being turned).
const MSG_TYPE_CONTROL_CHANGE = 8;

// Number of knobs exposed by a WebsocketController.
const NUM_KNOBS = 16;

export class Knob {
    // A knob holds a single normalized value in the range [0, 1]. Scenes decide
    // how to map this to whatever range a given property needs.
    constructor(default_val=0) {
        this.cur_val = default_val;
    }
}

// Abstract interface for some sort of controller (MIDI device, Kinect, etc).
// A controller exposes a set of named Knobs and reacts to incoming events.
export class Controller {
    constructor(context) {
        this.context = context;
        this.knobs = new Map();
    }

    add_knob(name, default_val=0.0) {
        this.knobs.set(name, new Knob(default_val));
    }

    get_knob_val(name) {
        return this.knobs.get(name).cur_val;
    }

    // Handle a decoded message from the controller. Subclasses override this.
    handle_message(msg) {}
}

// A Controller that receives its events over a WebSocket connection.
export class WebsocketController extends Controller {
    constructor(context, url) {
        super(context);
        this.url = url;
        for (let i = 0; i < NUM_KNOBS; i++) {
            // Knob values arrive already normalized to [0, 1] from the adapter.
            this.add_knob(i);
        }
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
            const knob = this.knobs.get(msg.wheel_idx);
            if (knob) {
                // Value is normalized [0, 1]; clamp defensively.
                knob.cur_val = Math.max(0, Math.min(1, msg.value));
            }
        }
    }
}
