import argparse
import asyncio
from collections import deque
from enum import Enum
import json
import time
import serial_asyncio
import pathlib
import websockets
from rtmidi.midiutil import open_midiinput
from rtmidi import midiconstants
import random
from message import *
import sys

USE_STROBE = False
USE_LEDS = False
BEAT_RESET_TIMEOUT_S = 1
WS_PORT = 8765
MIN_BPM_SAMPLES = 4 * 24
NUM_BPM_SAMPLES = 16 * 24

LOG_MSGS = False
LOG_SYNC = False

if USE_LEDS:
    from blink import led_update_loop, led_handle_msgs

dmx = None
strobe = None
if USE_STROBE:
    from PyDMXControl.controllers import OpenDMXController
    from PyDMXControl.profiles.Generic import Custom
    dmx = OpenDMXController()
    strobe = dmx.add_fixture(Custom, name="ADJ Mega Flash", channels=2)


class ClockTracker:
    def __init__(self):
        self.sync_rate_hz = 120 / 60 * 24
        self.cur_sync_idx = -1      # Starts at -1 so first beat (ping, then send) will be beat 0
        self._last_clock_est = None
        self._samples = deque()
        self.sync = False


    def ping(self):
        now = time.time()
        elapsed = 0

        if self._last_clock_est != None:
            elapsed = now - self._last_clock_est
            if elapsed > BEAT_RESET_TIMEOUT_S:
                self.reset_sync()

        self._last_clock_est = now

        self._samples.append(now)

        if self.sync:
            est_syncs_elapsed = round(elapsed * self.sync_rate_hz)
            #print(f'est syncs elapsed: {est_syncs_elapsed}')

        self.cur_sync_idx += 1

        while len(self._samples) > NUM_BPM_SAMPLES:
            self._samples.popleft()

        if len(self._samples) >= MIN_BPM_SAMPLES and sum(self._samples) > 0:
            self.sync_rate_hz = (len(self._samples) - 1) / (self._samples[-1] - self._samples[0])
            self.sync = True



    def reset_sync(self):
        self.cur_sync_idx = -1
        self._last_clock = None
        self._samples.clear()
        self.sync = False
    


clock_tracker = ClockTracker()


def to_hex(st):
    return ':'.join(hex(ord(x))[2:] for x in st)


def strobe_on():
    try:
        strobe.set_channel(0, 255)
        strobe.set_channel(1, 255)
    except Exception as e:
        print(f'Error setting strobe on: {e}')


def strobe_off():
    try:
        strobe.set_channel(0, 0)
        strobe.set_channel(1, 0)
    except Exception as e:
        print(f'Error setting strobe on: {e}')





NUM_BARS = 4
fake_beat = [[] for i in range(0, NUM_BARS * 16)]
for bar in range(0, NUM_BARS):
    for i in [0, 4, 8, 12]:
        fake_beat[16 * bar + i].append(1)
    for i in [4, 12]:
        fake_beat[16 * bar + i].append(4)
    for i in range(0, 16):
        fake_beat[16 * bar + i].append(9)


def translate_note_to_msg(channel, note_number, note_vel, last_transmit_latency=0, use_note_syncs=False):
    print(f'{channel}:{note_number}:{note_vel}')
    if note_vel == 0:
        return None

    ws_msg = None
    if channel == 16 and use_note_syncs:
        # This channel is used for synchronization
        clock_tracker.ping()
        if clock_tracker.sync:
            ws_msg = MsgSync(last_transmit_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
            if LOG_SYNC:
                print(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                print(f'beat: {clock_tracker.cur_sync_idx // 24}')
    elif channel == 15:
        # Analog Rytm auto channel
        if note_number >= 12 and note_number < 36:
            ws_msg = MsgGotoScene(last_transmit_latency, note_number - 12, note_vel < 100)
        elif note_number >= 36:
            print(f'advancing {-1 if note_number % 2 == 0 else 1}')
            ws_msg = MsgAdvanceSceneState(last_transmit_latency, -1 if note_number % 2 == 0 else 1)
        else:
            ws_msg = MsgBeat(last_transmit_latency, note_number + 1, True)

    elif channel == 14:
        # This channel is used for graphics scene switching
        ws_msg = MsgGotoScene(last_transmit_latency, note_number - 60, note_vel < 100)
    elif channel == 13:
        # This channel is used for moving forward/backward in the graphics scene
        ws_msg = MsgAdvanceSceneState(last_transmit_latency, 1)
    elif channel == 12:
        ws_msg = MsgAdvanceSceneState(last_transmit_latency, -1)
    else:
        # Remaining channels are used for controlling elements within the scene
        if channel == 4:
            channel = 2
        elif channel == 9:
            channel = 4
        elif channel == 2 or channel == 5:
            channel = 3

        ws_msg = MsgBeat(last_transmit_latency, channel, True)

    return ws_msg


class RtMidiInputHandler:
    def __init__(self, websocket):
        self.websocket = websocket

    def __call__(self, event, data=None):
        t_callback = time.time()
        message, deltatime = event
        ws_msg = self.translate_midi_msg(message)
        if ws_msg:
            self.websocket.send(ws_msg.to_json())


    def translate_midi_msg(self, midi_msg):
        ws_msg = None
        if (midi_msg[0] & 0xF0 == NOTE_ON) and midi_msg[2] != 0:
            channel = (midi_msg[0] & 0xF) + 1
            note_number = midi_msg[1]
            note_vel = midi_msg[2]
            if channel == 15:   # Analog Rytm auto channel
                channel = note_number
                note_number = note_vel
        elif midi_msg[0] & 0xF0 == NOTE_OFF:
            if channel == 15:
                if USE_STROBE:
                    strobe_off()
        elif midi_msg[0] & 0xF0 == CONTROL_CHANGE:
            control_idx = midi_msg[1]
            control_val = midi_msg[2]
            # This channel is used for graphics scene switching
            #ws_msg = MsgGotoScene(last_msg_latency, int(control_val / 5), control_idx > 1)
            ws_msg = MsgControlChange(last_msg_latency, control_idx, control_val)

        if ws_msg != None and LOG_MSGS:
            print(ws_msg)

        return ws_msg


# Set of connected viewer clients
connected = set()

# Connected adapter client
adapter = None
adapter_secret = None

# Last message's roundtrip latency divided by two, in seconds
last_msg_latency = 0.0

async def handler(websocket):
    global last_msg_latency
    connected.add(websocket)
    print("Client connected")
    try:
        async for message in websocket:
            msg = json.loads(message)
            last_msg_latency = (time.time() - msg['t']) / 2
            #print(last_msg_latency)
    finally:
        # Unregister client
        connected.remove(websocket)
        print("Client disconnected")


class SerialMidiHandler:
    def __init__(self):
        self.bytes = []
        self.playing = True

    def handle_midi_byte(self, b):
        ws_msg = None
        if len(self.bytes) == 0:
            # First byte
            if b == midiconstants.TIMING_CLOCK:
                # Single-byte message
                clock_tracker.ping()
                if clock_tracker.sync and self.playing:
                    #print(f'Sync idx: {clock_tracker.cur_sync_idx}')
                    ws_msg = MsgSync(last_msg_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
                    if LOG_SYNC:
                        print(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                        print(f'beat: {clock_tracker.cur_sync_idx // 24}')
                self.bytes = []
            elif b == midiconstants.SONG_STOP:
                # Single-byte message
                self.playing = False
                self.bytes = []
            elif b == midiconstants.SONG_START:
                # Single-byte message
                self.playing = True
                clock_tracker.reset_sync()
                self.bytes = []
            elif b == midiconstants.SONG_CONTINUE:
                # Single-byte message
                self.playing = True
                self.bytes = []
            elif b & 0xF0 == midiconstants.NOTE_ON:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.NOTE_OFF:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.CONTROL_CHANGE:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.PROGRAM_CHANGE:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.PITCH_BEND:
                self.bytes = [b]
            elif b & 0xF0 == 0xA0:
                self.bytes = [b]
            else:
                print(f'unknown status byte: {b}')
                pass
        else:
            # This is not the first byte
            if self.bytes[0] & 0xF0 == midiconstants.NOTE_ON:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    channel = (self.bytes[0] & 0xF) + 1
                    note_number, note_vel = self.bytes[1:]
                    ws_msg = translate_note_to_msg(channel, note_number, note_vel)
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.NOTE_OFF:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    channel = (self.bytes[0] & 0xF) + 1
                    note_number, note_vel = self.bytes[1:]
                    ws_msg = None
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.CONTROL_CHANGE:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    print(f"control change: {self.bytes[1:]}")
                    control_idx, control_val = self.bytes[1:]
                    # This channel is used for graphics scene switching
                    ws_msg = MsgControlChange(last_msg_latency, control_idx, control_val)
                    #ws_msg = MsgGotoScene(last_msg_latency, int(control_val / 5), control_idx > 1)
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.PITCH_BEND:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    value_lo, value_hi = self.bytes[1:]
                    value = (value_hi << 7) | value_lo
                    ws_msg = MsgPitchBend(last_msg_latency, value)
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.PROGRAM_CHANGE:
                self.bytes.append(b)
                channel = (self.bytes[0] & 0xF) + 1
                value = self.bytes[1]
                print(f'program change: {channel} {value}')
                clock_tracker.cur_sync_idx = -1
                ws_msg = MsgProgramChange(last_msg_latency, channel, value)
                self.bytes = []
            elif self.bytes[0] & 0xF0 == 0xA0:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    channel = self.bytes[1] + 1
                    self.bytes = []
            else:
                self.bytes = []

        return ws_msg



async def main_loop_rtmidi(rtmidi_device):
    try:
        midiin = rtmidi.MidiIn()
        midiin, _ = open_midiinput(args.rtmidi)
        async with websockets.serve(handler, "0.0.0.0", WS_PORT):
            midi_handler = RtMidiInputHandler(websocket)
            midiin.set_callback(midi_handler)
            while True:
                time.sleep(1)
    finally:
        midiin.close_port()
        del midiin


async def main_loop_serial(serial_device, msg_queue):
    reader, _ = await serial_asyncio.open_serial_connection(url=serial_device, baudrate=31250)
    handler = SerialMidiHandler()
    while True:
        byte = int.from_bytes(await reader.read(1))
        ws_msg = handler.handle_midi_byte(byte)

        if ws_msg and ws_msg.msg_type != Msg.Type.SYNC and LOG_MSGS:
            print(ws_msg)

        if ws_msg:
            websockets.broadcast(connected, ws_msg.to_json())
            msg_queue.put_nowait(ws_msg)


async def main_loop_fake(bpm):
    global last_msg_latency
    sync_idx = 0
    beat_idx = 0
    sync_rate_hz = (bpm * 24) / 60
    state_advancing = True
    cur_advance_step = 1
    cur_advance_state = 0
    last_changed_fg = True
    cur_scenes = [1, 0] # fg, bg
    while True:
        sync_msg = MsgSync(last_msg_latency, sync_rate_hz, sync_idx)
        websockets.broadcast(connected, sync_msg.to_json())
        time_sent = time.time()
        new_beat_idx = sync_idx // 6
        if new_beat_idx != beat_idx:
            beat_idx = new_beat_idx
            cur_beats = fake_beat[beat_idx % len(fake_beat)]

            '''if new_beat_idx % 16 == 0:
                # Advance or decrease state
                adv_msg = MsgAdvanceSceneState(0, cur_advance_step)
                websockets.broadcast(connected, adv_msg.to_json())
                cur_advance_state += cur_advance_step
                if (cur_advance_state > 4 or cur_advance_state <= 0):
                    cur_advance_step *= -1'''

            '''if new_beat_idx % 128 == 0:
                # Change scene
                new_scene = (int(random.random() * 20) + 1)
                if cur_scenes[0] == 0:
                    cur_scenes[0] = new_scene
                elif cur_scenes[1] == 0:
                    cur_scenes[0] = new_scene
                else:
                    # TODO: change state here and propagate to frontend!
                    bg = last_changed_fg
                    new_scene = 0
                ch_scene_msg = MsgGotoScene(0, new_scene, bg)
                websockets.broadcast(connected, ch_scene_msg.to_json())
                last_changed_fg = not bg
                cur_scenes[1 if bg else 0] = new_scene'''

            for beat in cur_beats:
                beat_msg = MsgBeat(last_msg_latency, beat)
                websockets.broadcast(connected, beat_msg.to_json())
        time_elapsed_this_iter = time.time() - time_sent
        await asyncio.sleep(1 / sync_rate_hz - time_elapsed_this_iter)
        sync_idx += 1


async def main():
    parser = argparse.ArgumentParser(description="Rave MIDI -> web adapter")
    parser.add_argument('-f', '--fake', type=float, help='fake MIDI events with given BPM')
    parser.add_argument('-d', '--device', type=str, help='Receive MIDI messages on specified tty (default /dev/ttyserial0)')
    parser.add_argument('-r', '--rtmidi', type=str, help='Use rtmidi with specified MIDI device (string e.g. Volt)')
    args = parser.parse_args()

    args_count = len([1 for x in [args.fake, args.device, args.rtmidi] if x])
    if args_count != 1:
        print('Error: must specify exactly one of --fake, --device, or --rtmidi')
        exit(1)

    # Restart-on-error loop (only exits on KeyboardInterrupt)
    while True:
        #try:
        async with websockets.serve(handler, "0.0.0.0", WS_PORT), \
                asyncio.TaskGroup() as tg:
            queue = asyncio.Queue()
            if args.rtmidi:
                t1 = tg.create_task(main_loop_rtmidi(args.rtmidi))
            elif args.device:
                t1 = tg.create_task(main_loop_serial(args.device, queue))
            else:
                t1 = tg.create_task(main_loop_fake(args.fake))

            if USE_LEDS:
                t2 = tg.create_task(led_update_loop())
                t3 = tg.create_task(led_handle_msgs(queue))
        '''except (KeyboardInterrupt, asyncio.exceptions.CancelledError):
            break
        except Exception as e:
            print(f'Error: {e}')
            print('Connection failed, retrying...')
            await asyncio.sleep(1)
            continue'''


if __name__ == "__main__":
    asyncio.run(main())
