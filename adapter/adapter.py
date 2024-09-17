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
from rtmidi.midiconstants import NOTE_ON, NOTE_OFF, CONTROL_CHANGE
from rtmidi import midiconstants
import sys

USE_STROBE = False
BEAT_RESET_TIMEOUT_S = 1
WS_PORT = 8765

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
        self.cur_sync_idx = 0
        self._last_clock = None
        self._samples = deque()
        self.sync = False


    def ping(self):
        now = time.time()
        elapsed = 0
        self.cur_sync_idx += 1

        if self._last_clock != None:
            elapsed = now - self._last_clock
            if elapsed > BEAT_RESET_TIMEOUT_S:
                self.reset_sync()
            else:
                if elapsed != 0:
                    self._samples.append(elapsed)

        self._last_clock = now

        while len(self._samples) > 4:
            self._samples.popleft()

        if len(self._samples) >= 4:
            rates = [1 / x for x in self._samples if x != 0]
            if (len(rates) > 0):
                self.sync_rate_hz = sum(rates) / len(rates)
                self.sync = True

        return elapsed / 60 * self.sync_rate_hz


    def reset_sync(self):
        self.cur_sync_idx = 0
        self._samples.clear()
        self.sync = False
    


clock_tracker = ClockTracker()


class Msg:
    # enum for each message type
    class Type(int, Enum):
        SYNC = 0
        BEAT = 1
        GOTO_SCENE = 2
        ADVANCE_SCENE_STATE = 3
        PROMOTION = 4
        PROMOTION_GRANT = 5
        ACK = 6

    def __init__(self, msg_type, last_transmit_latency):
        self.latency = last_transmit_latency
        self.msg_type = msg_type
        self.t = time.time()
    
    def __repr__(self) -> str:
        return f'{self.t}: {self.msg_type}'

    def to_json(self):
        return json.dumps(self.__dict__)


class MsgSync(Msg):
    def __init__(self, last_transmit_latency, sync_rate_hz, sync_idx):
        super().__init__(Msg.Type.SYNC, last_transmit_latency)
        self.sync_rate_hz = sync_rate_hz
        self.sync_idx = sync_idx


class MsgBeat(Msg):
    def __init__(self, last_transmit_latency, channel, on=True):
        super().__init__(Msg.Type.BEAT, last_transmit_latency)
        self.channel = channel
        self.on = on


class MsgGotoScene(Msg):
    def __init__(self, last_transmit_latency, scene, bg=False):
        super().__init__(Msg.Type.GOTO_SCENE, last_transmit_latency)
        self.scene = scene
        self.bg = bg


class MsgAdvanceSceneState(Msg):
    def __init__(self, last_transmit_latency, steps):
        super().__init__(Msg.Type.ADVANCE_SCENE_STATE, last_transmit_latency)
        self.steps = steps


class MsgPromotion(Msg):
    def __init__(self, secret):
        super().__init__(Msg.Type.PROMOTION, 0)
        self.secret = secret


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





fake_beat = [[] for i in range(0, 16)]
for i in range(0, 16, 4):
    fake_beat[i].append(1)
for i in [2, 6, 10, 14]:
    fake_beat[i].append(2)
for i in range(0, 16):
    fake_beat[i].append(4)


def translate_note_to_msg(channel, note_number, note_vel, last_transmit_latency=0, use_note_syncs=False):
    if note_vel == 0:
        return None

    ws_msg = None
    if channel == 16 and use_note_syncs:
        # This channel is used for synchronization
        clock_tracker.ping()
        if clock_tracker.sync:
            ws_msg = MsgSync(last_transmit_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
    elif channel == 15:
        # This channel is used for lighting control
        if USE_STROBE:
            strobe_on()
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
        ws_msg = MsgBeat(last_transmit_latency, channel, True)

    return ws_msg


class RtMidiInputHandler:
    def __init__(self, websocket):
        self.websocket = websocket
        self.last_transmit_latency = 0

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
        elif midi_msg[0] & 0xF0 == NOTE_OFF:
            if channel == 15:
                if USE_STROBE:
                    strobe_off()
        elif midi_msg[0] & 0xF0 == CONTROL_CHANGE:
            control_idx = midi_msg[1]
            control_val = midi_msg[2]
            # This channel is used for graphics scene switching
            ws_msg = MsgGotoScene(self.last_transmit_latency, int(control_val / 5), control_idx > 1)
        else:
            print(midi_msg)

        if ws_msg != None:
            print(ws_msg)

        return ws_msg


# Set of connected viewer clients
connected = set()

# Connected adapter client
adapter = None
adapter_secret = None

async def handler(websocket):
    connected.add(websocket)
    print("Client connected")
    try:
        async for message in websocket:
            # TODO: get estimated RTT from message
            #print(message)
            pass
    finally:
        # Unregister client
        connected.remove(websocket)
        print("Client disconnected")


class SerialMidiHandler:
    def __init__(self):
        self.bytes = []
        self.last_transmit_latency = 0
        self.playing = True

    def handle_midi_byte(self, b):
        ws_msg = None
        if len(self.bytes) == 0:
            if b == midiconstants.TIMING_CLOCK:
                clock_tracker.ping()
                if clock_tracker.sync and self.playing:
                    ws_msg = MsgSync(self.last_transmit_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
                self.bytes = []
            elif b == midiconstants.SONG_STOP:
                self.playing = False
                clock_tracker.reset_sync()
                self.bytes = []
            elif b == midiconstants.SONG_START:
                self.playing = True
                self.bytes = []
            elif b == midiconstants.SONG_CONTINUE:
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
            else:
                print(f'unknown status byte: {b}')
        else:
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
            elif self.bytes[0] & 0xF0 == CONTROL_CHANGE:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    control_idx, control_val = self.bytes[1:]
                    # This channel is used for graphics scene switching
                    ws_msg = MsgGotoScene(self.last_transmit_latency, int(control_val / 5), control_idx > 1)
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


async def main_loop_serial(serial_device):
    reader, _ = await serial_asyncio.open_serial_connection(url=serial_device, baudrate=31250)
    handler = SerialMidiHandler()
    while True:
        byte = int.from_bytes(await reader.read(1))
        ws_msg = handler.handle_midi_byte(byte)
        if ws_msg:
            websockets.broadcast(connected, ws_msg.to_json())


async def main_loop_fake(bpm):
    sync_idx = 0
    beat_idx = 0
    sync_rate_hz = (bpm * 24) / 60
    while True:
        sync_msg = MsgSync(time.time(), sync_rate_hz, sync_idx)
        websockets.broadcast(connected, sync_msg.to_json())
        new_beat_idx = sync_idx // 6
        if new_beat_idx != beat_idx:
            beat_idx = new_beat_idx
            cur_beats = fake_beat[beat_idx % len(fake_beat)]
            for beat in cur_beats:
                beat_msg = MsgBeat(time.time(), beat)
                websockets.broadcast(connected, beat_msg.to_json())
        await asyncio.sleep(1 / sync_rate_hz)
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
        try:
            async with websockets.serve(handler, "0.0.0.0", WS_PORT):
                if args.rtmidi:
                    await main_loop_rtmidi(args.rtmidi)
                elif args.device:
                    await main_loop_serial(args.device)
                else:
                    await main_loop_fake(args.fake)
        except (KeyboardInterrupt, asyncio.exceptions.CancelledError):
            break
        except Exception as e:
            print(f'Error: {e}')
            print('Connection failed, retrying...')
            time.sleep(1)
            continue


if __name__ == "__main__":
    asyncio.run(main())
