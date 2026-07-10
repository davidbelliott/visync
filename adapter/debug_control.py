"""On-screen slider panel -> web control-change adapter.

A mouse-driven stand-in for apc40_control.py for when the APC40 isn't
plugged in, and for dialling in exact knob values while tuning scenes (e.g.
checking the pose-derived knobs from kinect_control.py against known-good
inputs). Shows one slider per knob and broadcasts the same normalized
control-change messages on the websocket the web client already connects to.

The window is OpenCV (already a kinect_control.py dependency) rather than
tkinter, which the project venv's python isn't built with; the sliders are
drawn by hand and driven with the mouse.

Run:
    .venv/bin/python debug_control.py

Controls:
    - click / drag a slider to set it
    - right-click a slider to centre it (0.5 = stopped for the rate knobs)
    - q or Esc quits
"""

import asyncio
import json
import time

import cv2
import numpy as np
import websockets

from message import MsgControlChange

# Same websocket port adapter.py serves on, so the web client connects here
# unchanged (it just won't get any sync/beat traffic from this script).
WS_PORT = 8766

# One slider per knob, numbered like apc40_control.py: 0-7 are the track
# faders, 8-15 the top device knobs.
KNOB_COUNT = 16

# Channels the scenes actually bind (mirrors web/src/controller_map.js), shown
# next to the knob number so the interesting sliders are easy to find.
KNOB_NAMES = {
    3: "expand x",
    4: "expand y",
    8: "rot y (yaw rate)",
    9: "rot x (pitch rate)",
}

# GUI refresh rate, in Hz. Values are only broadcast when a slider moves, so
# this just paces redraws and mouse handling.
UPDATE_HZ = 60

WINDOW = "debug_control (right-click centres, q quits)"

# Panel layout, in pixels.
ROW_H = 34
MARGIN = 12
LABEL_W = 170
TRACK_W = 300
VALUE_W = 70
TRACK_X = MARGIN + LABEL_W
PANEL_W = MARGIN + LABEL_W + TRACK_W + VALUE_W + MARGIN
PANEL_H = MARGIN + KNOB_COUNT * ROW_H + MARGIN


# Connected viewer clients (mirrors adapter.py / apc40_control.py).
connected = set()

# Last message's roundtrip latency divided by two, in seconds. Updated from the
# ack messages clients send back.
last_msg_latency = 0.0

# Current slider values, one per knob. Untouched sliders are never broadcast
# (mirroring apc40_control.py's quiet idle knobs) so they can't override
# values set on the front-end by other controllers or scene defaults.
values = {idx: 0.5 for idx in range(KNOB_COUNT)}
touched = set()

# Knobs whose value changed since the last broadcast pass.
dirty = set()


async def handler(websocket):
    global last_msg_latency
    connected.add(websocket)
    print("Client connected")
    try:
        # Bring the new client up to date with every slider that has been
        # moved, so reconnects (page reloads) keep the panel state.
        for idx in sorted(touched):
            await websocket.send(
                MsgControlChange(last_msg_latency, idx, values[idx]).to_json())
        async for message in websocket:
            msg = json.loads(message)
            last_msg_latency = (time.time() - msg['t']) / 2
    finally:
        connected.remove(websocket)
        print("Client disconnected")


def clamp01(v):
    return min(1.0, max(0.0, v))


def row_at(y):
    """Knob index of the slider row containing pixel row y, or None."""
    idx = (y - MARGIN) // ROW_H
    if 0 <= idx < KNOB_COUNT:
        return int(idx)
    return None


def set_value(idx, value):
    value = clamp01(value)
    if values[idx] != value or idx not in touched:
        values[idx] = value
        touched.add(idx)
        dirty.add(idx)


class SliderMouse:
    """cv2 mouse callback: left click/drag sets the slider under the cursor,
    right click centres it. Runs on the GUI thread (inside cv2.waitKey), so it
    can touch the module state directly."""

    def __init__(self):
        self.dragging = None  # knob index while the left button is held

    def __call__(self, event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN:
            self.dragging = row_at(y)
        elif event == cv2.EVENT_LBUTTONUP:
            self.dragging = None
        elif event == cv2.EVENT_RBUTTONDOWN:
            idx = row_at(y)
            if idx is not None:
                set_value(idx, 0.5)
            return
        if self.dragging is not None:
            set_value(self.dragging, (x - TRACK_X) / TRACK_W)


def draw_panel():
    img = np.full((PANEL_H, PANEL_W, 3), 28, np.uint8)
    for idx in range(KNOB_COUNT):
        cy = MARGIN + idx * ROW_H + ROW_H // 2
        kind = "fader" if idx < 8 else "knob"
        label = f"{kind} {idx}"
        if idx in KNOB_NAMES:
            label += f"  {KNOB_NAMES[idx]}"
        cv2.putText(img, label, (MARGIN, cy + 5), cv2.FONT_HERSHEY_SIMPLEX,
                    0.45, (255, 255, 255), 1, cv2.LINE_AA)

        # Track with a centre tick (0.5 = stopped for the rate knobs).
        cv2.rectangle(img, (TRACK_X, cy - 3), (TRACK_X + TRACK_W, cy + 3),
                      (70, 70, 70), -1)
        mid_x = TRACK_X + TRACK_W // 2
        cv2.line(img, (mid_x, cy - 8), (mid_x, cy + 8), (110, 110, 110), 1)

        # Fill and handle; green once touched, grey while still idle.
        color = (0, 200, 0) if idx in touched else (140, 140, 140)
        hx = TRACK_X + int(TRACK_W * values[idx])
        cv2.rectangle(img, (TRACK_X, cy - 3), (hx, cy + 3),
                      tuple(c // 2 for c in color), -1)
        cv2.circle(img, (hx, cy), 8, color, -1, cv2.LINE_AA)

        cv2.putText(img, f"{values[idx]:.3f}", (TRACK_X + TRACK_W + 12, cy + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1,
                    cv2.LINE_AA)
    return img


async def gui_loop():
    """Redraw the panel, service the mouse, and broadcast any sliders that
    moved since the previous tick."""
    cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)
    cv2.setMouseCallback(WINDOW, SliderMouse())
    period = 1.0 / UPDATE_HZ
    try:
        while True:
            tick = time.time()
            for idx in sorted(dirty):
                websockets.broadcast(
                    connected,
                    MsgControlChange(
                        last_msg_latency, idx, values[idx]).to_json())
            dirty.clear()

            cv2.imshow(WINDOW, draw_panel())
            key = cv2.waitKey(1) & 0xFF
            if key in (ord('q'), 27):  # q or Esc
                break
            if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break  # window closed with its close button

            # Yield to the event loop (services websocket acks) and pace the
            # loop to roughly UPDATE_HZ.
            await asyncio.sleep(max(0.0, period - (time.time() - tick)))
    finally:
        cv2.destroyAllWindows()


async def main():
    async with websockets.serve(handler, "0.0.0.0", WS_PORT):
        print(f'Serving on ws://0.0.0.0:{WS_PORT} '
              f'(sliders -> knobs 0-{KNOB_COUNT - 1})')
        await gui_loop()


if __name__ == "__main__":
    asyncio.run(main())
