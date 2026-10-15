import argparse
import asyncio

import websockets
from pynput.mouse import Controller
from Quartz import CGDisplayPixelsWide, CGDisplayPixelsHigh, CGMainDisplayID

from message import MsgControlChange

# Same websocket port adapter.py serves on, so the web client connects here
# unchanged (it just won't get any sync/beat traffic from this script).
WS_PORT = 8766

# How often we sample the cursor and broadcast, in Hz.
UPDATE_HZ = 60

# Knob indices to drive. The WebsocketController on the client maps a
# control-change `wheel_idx` straight onto its knob of the same index, and the
# yellow-robot scene binds knobs 3 (x spread) and 4 (y spread).
X_WHEEL_IDX = 8
Y_WHEEL_IDX = 9


# Connected viewer clients (mirrors adapter.py).
connected = set()


async def handler(websocket):
    connected.add(websocket)
    print("Client connected")
    try:
        # Nothing clients send matters; just hold the connection until it closes.
        async for _ in websocket:
            pass
    finally:
        connected.remove(websocket)
        print("Client disconnected")


def screen_size():
    did = CGMainDisplayID()
    return CGDisplayPixelsWide(did), CGDisplayPixelsHigh(did)


async def main_loop_mouse(x_idx, y_idx, invert_y):
    """Sample the global cursor position and broadcast it as two normalized
    control-change knobs (x and y), one per axis."""
    mouse = Controller()
    width, height = screen_size()
    while True:
        px, py = mouse.position
        # Normalize to [0, 1] and clamp (multi-monitor setups can report
        # positions outside the main display's bounds).
        x = min(1.0, max(0.0, px / width))
        y = min(1.0, max(0.0, py / height))
        # Screen y grows downward; invert so moving the mouse up raises the
        # value, which reads more naturally as a knob.
        if invert_y:
            y = 1.0 - y

        # Broadcast unconditionally every tick (like adapter's fake knobs) so a
        # freshly-connected client always gets the current position promptly.
        websockets.broadcast(
            connected, MsgControlChange(x_idx, x).to_json())
        websockets.broadcast(
            connected, MsgControlChange(y_idx, y).to_json())

        await asyncio.sleep(1.0 / UPDATE_HZ)


async def main():
    parser = argparse.ArgumentParser(
        description="Mouse X/Y -> web control-change adapter")
    parser.add_argument('-x', '--x-idx', type=int, default=X_WHEEL_IDX,
                        help=f'knob index driven by mouse X (default {X_WHEEL_IDX})')
    parser.add_argument('-y', '--y-idx', type=int, default=Y_WHEEL_IDX,
                        help=f'knob index driven by mouse Y (default {Y_WHEEL_IDX})')
    parser.add_argument('--no-invert-y', action='store_true',
                        help='do not invert Y (top of screen becomes 0)')
    args = parser.parse_args()

    async with websockets.serve(handler, "0.0.0.0", WS_PORT):
        print(f'Serving on ws://0.0.0.0:{WS_PORT} '
              f'(mouse X -> knob {args.x_idx}, mouse Y -> knob {args.y_idx})')
        await main_loop_mouse(args.x_idx, args.y_idx, not args.no_invert_y)


if __name__ == "__main__":
    asyncio.run(main())
