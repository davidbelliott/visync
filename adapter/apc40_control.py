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


# Connected viewer clients (mirrors adapter.py / control.py).
connected = set()

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
    MsgControlChange broadcasts. Invoked on rtmidi's own thread, so it hands the
    actual broadcast back to the event loop via call_soon_threadsafe."""

    def __init__(self, loop):
        self.loop = loop

    def __call__(self, event, data=None):
        message, _deltatime = event
        ws_msg = self.translate(message)
        if ws_msg is not None:
            print(ws_msg)
            self.loop.call_soon_threadsafe(
                websockets.broadcast, connected, ws_msg.to_json())

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
        return MsgControlChange(
            last_msg_latency, wheel_idx, control_val / MIDI_CC_MAX)


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
            await asyncio.Future()  # run forever
    finally:
        midiin.close_port()
        del midiin


if __name__ == "__main__":
    asyncio.run(main())
