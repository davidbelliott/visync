"""On-screen slider panel -> web control-change adapter.

A mouse-driven stand-in for apc40_control.py for when the APC40 isn't
plugged in, and for dialling in exact knob values while tuning scenes (e.g.
checking the pose-derived knobs from kinect_control.py against known-good
inputs). Shows one slider per knob and broadcasts the same normalized
control-change messages on the websocket the web client already connects to.

The panel is Dear PyGui (GPU-accelerated Dear ImGui): its sliders drag
smoothly and, unlike the old hand-drawn OpenCV panel, you can double-click a
slider to type an exact value. Dear PyGui runs its own frame loop, so we step
it manually (`render_dearpygui_frame`) from the asyncio loop, the same way the
OpenCV version pumped `cv2.waitKey`; callbacks fire on this thread inside that
call, so they touch the module state directly.

Run:
    .venv/bin/python debug_control.py

Controls:
    - drag a slider to set it; double-click a slider to type an exact value
    - click a row's "0.5" button to centre it (0.5 = stopped for rate knobs)
    - Esc, or the window's close button, quits
"""

import asyncio
import json
import time

import dearpygui.dearpygui as dpg
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
    3: "expand x / tesseract scale x",
    4: "expand y / tesseract scale y",
    5: "tesseract scale z",
    6: "tesseract scale w",
    8: "rot y (yaw)",
    9: "rot x (pitch)",
}

# GUI refresh rate, in Hz. Values are only broadcast when a slider moves, so
# this just paces redraws and how often we yield to the websocket event loop.
UPDATE_HZ = 60

WINDOW = "debug_control (click 0.5 to centre, Esc quits)"

# Slider width in pixels; the rest of the viewport size is derived from it and
# the row count so every row (button + slider + label) fits without scrolling.
SLIDER_W = 300
VIEWPORT_W = 620
VIEWPORT_H = 40 + KNOB_COUNT * 27


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

# Theme applied to a slider once it's first touched, so moved knobs read green
# against the grey idle ones (matches the old panel's touched highlight).
touched_theme = None


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


def slider_tag(idx):
    return f"slider_{idx}"


def set_value(idx, value):
    """Record a knob's value, mark it touched/dirty, and green-highlight it the
    first time it moves. Does not push the value back into the slider widget;
    only the centre button needs that (see on_center)."""
    value = clamp01(value)
    if values[idx] != value or idx not in touched:
        newly_touched = idx not in touched
        values[idx] = value
        touched.add(idx)
        dirty.add(idx)
        if newly_touched:
            dpg.bind_item_theme(slider_tag(idx), touched_theme)


def on_slider(sender, app_data, user_data):
    """Slider drag/edit: user_data is the knob index, app_data the new value."""
    set_value(user_data, app_data)


def on_center(sender, app_data, user_data):
    """Centre button: force the widget and the stored value back to 0.5."""
    idx = user_data
    dpg.set_value(slider_tag(idx), 0.5)
    set_value(idx, 0.5)


def build_widgets():
    """Create the context, the touched-highlight theme, and one row per knob.
    Kept separate from viewport setup so the widget graph and callbacks can be
    built and exercised without a display."""
    global touched_theme
    dpg.create_context()

    with dpg.theme() as touched_theme:
        with dpg.theme_component(dpg.mvSliderFloat):
            dpg.add_theme_color(dpg.mvThemeCol_SliderGrab, (0, 200, 0))
            dpg.add_theme_color(dpg.mvThemeCol_SliderGrabActive, (0, 230, 0))
            dpg.add_theme_color(dpg.mvThemeCol_FrameBg, (0, 55, 0))

    with dpg.window(tag="main"):
        for idx in range(KNOB_COUNT):
            kind = "fader" if idx < 8 else "knob"
            label = f"{kind} {idx}"
            if idx in KNOB_NAMES:
                label += f"   {KNOB_NAMES[idx]}"
            with dpg.group(horizontal=True):
                dpg.add_button(label="0.5", width=34, user_data=idx,
                               callback=on_center)
                dpg.add_slider_float(
                    tag=slider_tag(idx), label=label, default_value=0.5,
                    min_value=0.0, max_value=1.0, clamped=True, format="%.3f",
                    width=SLIDER_W, user_data=idx, callback=on_slider)

    with dpg.handler_registry():
        dpg.add_key_release_handler(key=dpg.mvKey_Escape,
                                    callback=lambda: dpg.stop_dearpygui())


def build_ui():
    """Build the widgets, then create and show the viewport."""
    build_widgets()
    dpg.create_viewport(title=WINDOW, width=VIEWPORT_W, height=VIEWPORT_H)
    dpg.setup_dearpygui()
    dpg.show_viewport()
    dpg.set_primary_window("main", True)


async def gui_loop():
    """Step Dear PyGui one frame at a time, broadcasting any sliders that moved
    since the previous tick and yielding to the asyncio loop (which services
    websocket acks) between frames."""
    build_ui()
    period = 1.0 / UPDATE_HZ
    try:
        while dpg.is_dearpygui_running():
            tick = time.time()
            for idx in sorted(dirty):
                websockets.broadcast(
                    connected,
                    MsgControlChange(
                        last_msg_latency, idx, values[idx]).to_json())
            dirty.clear()

            dpg.render_dearpygui_frame()

            # Yield to the event loop and pace the loop to roughly UPDATE_HZ.
            await asyncio.sleep(max(0.0, period - (time.time() - tick)))
    finally:
        dpg.destroy_context()


async def main():
    async with websockets.serve(handler, "0.0.0.0", WS_PORT):
        print(f'Serving on ws://0.0.0.0:{WS_PORT} '
              f'(sliders -> knobs 0-{KNOB_COUNT - 1})')
        await gui_loop()


if __name__ == "__main__":
    asyncio.run(main())
