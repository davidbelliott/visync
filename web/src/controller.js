// Message type for a control change (e.g. a knob or wheel being turned).
const MSG_TYPE_CONTROL_CHANGE = 8;

// Number of knobs exposed by a WebsocketController.
const NUM_KNOBS = 16;

export class Knob {
    constructor(min_val=0, max_val=1, default_val=0) {
        this.min_val = min_val;
        this.max_val = max_val;
        this.default_val = default_val;
        this.cur_val = default_val;
    }

    // Current value mapped to the range [0, 1]. This is the controller-agnostic
    // value that bindings consume.
    get norm() {
        return (this.cur_val - this.min_val) / (this.max_val - this.min_val);
    }
}

// Abstract interface for some sort of controller (MIDI device, Kinect, etc).
// A controller exposes a set of named Knobs and reacts to incoming events.
export class Controller {
    constructor(context) {
        this.context = context;
        this.knobs = new Map();
    }

    add_knob(name, min_val=0.0, max_val=1.0, default_val=0.0) {
        this.knobs.set(name, new Knob(min_val, max_val, default_val));
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
            // MIDI control change values are 7-bit (0..127).
            this.add_knob(i, 0, 127, 0);
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
                knob.cur_val = msg.value;
            }
        }
    }
}
