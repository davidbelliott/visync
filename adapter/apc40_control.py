import argparse
import asyncio
import json
import time

import websockets
from rtmidi.midiutil import open_midiinput
from rtmidi import midiconstants

from message import MsgControlChange

# Same websocket port adapter.py serves on, so the web client connects here
# unchanged (it just won't get any sync/beat traffic from this script).
WS_PORT = 8766

# Default substring used to find the APC40 mkII input port. open_midiinput
# matches this against the available port names.
DEFAULT_PORT = "APC40"

# MIDI control-change values are 7-bit (0..127); normalize to [0, 1] before
# sending so the client deals only in normalized knob values.
MIDI_CC_MAX = 127.0

# The APC40 mkII's eight track faders all send control-change controller #7,
# each on its own MIDI channel (0..7). We forward those to the matching knob
# index, so fader on channel N drives knob N (0..7).
FADER_CC = 7
FADER_CHANNELS = range(0, 8)

# The eight "device control" knobs across the top send control-change
# controllers #16..23 (on channel 0). We map those to knobs 8..15, so the top
# knobs continue the numbering above the eight faders.
KNOB_CC_BASE = 48
KNOB_COUNT = 8
KNOB_WHEEL_BASE = 8

# How often the broadcast loop eases the smoothed values toward the MIDI
# targets, in Hz (mirrors kinect_control.py's update rate).
UPDATE_HZ = 30

# Exponential-moving-average factor for smoothing the discrete 7-bit MIDI
# steps (as in kinect_control.py). Higher = snappier but steppier, lower =
# smoother but laggier.
SMOOTHING_ALPHA = 0.35

# Once a smoothed value is within half a MIDI step of its target it snaps to
# the target exactly and stops broadcasting, so idle knobs send nothing and
# can't override values set on the front-end by other controllers.
SNAP_EPSILON = 0.5 / MIDI_CC_MAX


# Connected viewer clients (mirrors adapter.py / control.py).
connected = set()

# Latest raw normalized value per knob from MIDI, keyed by wheel index. The
# broadcast loop smooths toward these. Only touched on the event loop thread
# (the MIDI callback hands updates over via call_soon_threadsafe).
targets = {}

# Last message's roundtrip latency divided by two, in seconds. Updated from the
# ack messages clients send back.
last_msg_latency = 0.0


async def handler(websocket):
    global last_msg_latency
    connected.add(websocket)
    print("Client connected")
    try:
        async for message in websocket:
            msg = json.loads(message)
            last_msg_latency = (time.time() - msg['t']) / 2
    finally:
        connected.remove(websocket)
        print("Client disconnected")


class Apc40FaderHandler:
    """rtmidi callback: turn track-fader control-change events into normalized
    knob targets for the broadcast loop. Invoked on rtmidi's own thread, so it
    hands the actual update back to the event loop via call_soon_threadsafe."""

    def __init__(self, loop):
        self.loop = loop

    def __call__(self, event, data=None):
        message, _deltatime = event
        translated = self.translate(message)
        if translated is not None:
            print(translated)
            wheel_idx, value = translated
            self.loop.call_soon_threadsafe(
                targets.__setitem__, wheel_idx, value)

    def translate(self, midi_msg):
        print(midi_msg)
        status, control_idx, control_val = midi_msg
        channel = status & 0x0F
        if (status & 0xF0) != midiconstants.CONTROL_CHANGE:
            return None

        wheel_idx = None
        if control_idx == FADER_CC and channel in FADER_CHANNELS:
            # Fader's MIDI channel selects which knob it drives (0..7).
            wheel_idx = channel
        elif KNOB_CC_BASE <= control_idx < KNOB_CC_BASE + KNOB_COUNT:
            # Top device knobs map to knobs 8..15.
            wheel_idx = KNOB_WHEEL_BASE + (control_idx - KNOB_CC_BASE)

        if wheel_idx is None:
            return None
        return wheel_idx, control_val / MIDI_CC_MAX


async def broadcast_loop():
    """Ease smoothed knob values toward the latest MIDI targets (as in
    kinect_control.py) so the discrete 7-bit steps reach the client as a
    continuous ramp. Unlike kinect_control, a knob is only broadcast while it
    is still converging: once it snaps to its target it goes quiet until the
    hardware moves again."""
    # Smoothed knob values, keyed by wheel index, persisted across ticks.
    smoothed = {}
    period = 1.0 / UPDATE_HZ
    while True:
        tick = time.time()
        for idx, target in targets.items():
            prev = smoothed.get(idx)
            if prev == target:
                continue  # converged; quiet until MIDI moves the target
            if prev is None:
                # First event for this knob: no ramp start point, jump there.
                value = target
            else:
                value = (SMOOTHING_ALPHA * target
                         + (1 - SMOOTHING_ALPHA) * prev)
                if abs(value - target) < SNAP_EPSILON:
                    value = target  # close enough; land exactly and go quiet
            smoothed[idx] = value
            websockets.broadcast(
                connected,
                MsgControlChange(last_msg_latency, idx, value).to_json())
        await asyncio.sleep(max(0.0, period - (time.time() - tick)))


async def main():
    parser = argparse.ArgumentParser(
        description="Akai APC40 mkII faders -> web control-change adapter")
    parser.add_argument('-p', '--port', type=str, default=DEFAULT_PORT,
                        help=f'MIDI input port name/substring (default {DEFAULT_PORT})')
    args = parser.parse_args()

    midiin, port_name = open_midiinput(args.port)
    try:
        loop = asyncio.get_running_loop()
        midiin.set_callback(Apc40FaderHandler(loop))
        async with websockets.serve(handler, "0.0.0.0", WS_PORT):
            print(f'Serving on ws://0.0.0.0:{WS_PORT} '
                  f'(APC40 "{port_name}" faders -> knobs 0-7, '
                  f'top knobs -> knobs 8-15)')
            await broadcast_loop()  # runs forever
    finally:
        midiin.close_port()
        del midiin


if __name__ == "__main__":
    asyncio.run(main())
