import argparse
import asyncio
from enum import Enum
import json
import time
import rtmidi
from collections import deque
import pathlib
import websockets
from rtmidi.midiconstants import *
from rtmidi.midiutil import open_midiinput
import sys

#WS_RELAY = "ws://deadfacade.net/rave/ws"
WS_RELAY = "ws://192.168.4.1:8765"
USE_STROBE = False

MIN_BPM = 60
MAX_BPM = 200

cur_beat_idx = 0
BEAT_RESET_TIMEOUT = 2

dmx = None
strobe = None
if USE_STROBE:
    from PyDMXControl.controllers import OpenDMXController
    from PyDMXControl.profiles.Generic import Custom
    dmx = OpenDMXController()
    strobe = dmx.add_fixture(Custom, name="ADJ Mega Flash", channels=2)


class BPMEstimator:
    def __init__(self, bpm=120):
        self.bpm = bpm
        self._last_clock = None
        self._samples = deque()


    def ping(self):
        now = time.time()
        elapsed = 0
        if self._last_clock != None:
            elapsed = now - self._last_clock
            if elapsed != 0:
                this_sample_bpm = 60.0 / elapsed
                if this_sample_bpm > MIN_BPM and this_sample_bpm < MAX_BPM:
                    self._samples.append(elapsed)
        self._last_clock = now

        while len(self._samples) > 24:
            self._samples.popleft()

        if len(self._samples) >= 2:
            avg_elapsed = (sum(self._samples) / len(self._samples))
            if avg_elapsed != 0:
                self.bpm = 60.0 / avg_elapsed
                self.sync = True

        print(self.bpm)
        return elapsed


def recv(client, ws_msg):
    try:
        t = float(ws_msg)
        time_now = time.time()
        dt = time_now - t
        latency_ms_round = round(dt * 1000)
        print(f'latency_ms: {latency_ms_round}')
    except:
        print(ws_msg)
        pass

bpm_estimator = BPMEstimator()

keyfile=pathlib.Path(__file__).parent / "ssl" / "reuben.key"
certfile=pathlib.Path(__file__).parent / "ssl" / "reuben.crt"




class Msg:
    # enum for each message type
    class Type(int, Enum):
        SYNC = 0
        BEAT = 1
        GOTO_SCENE = 2
        ADVANCE_SCENE_STATE = 3

    def __init__(self, t, msg_type):
        self.t = t
        self.msg_type = msg_type

    def to_json(self):
        return json.dumps(self.__dict__)


class MsgSync(Msg):
    def __init__(self, t, bpm, beat):
        super().__init__(t, MsgSync.Type.SYNC)
        self.bpm = bpm
        self.beat = beat


class MsgBeat(Msg):
    def __init__(self, t, channel, on=True):
        super().__init__(t, MsgSync.Type.BEAT)
        self.channel = channel
        self.on = on


class MsgGotoScene(Msg):
    def __init__(self, t, scene):
        super().__init__(t, MsgSync.Type.GOTO_SCENE)
        self.scene = scene


class MsgAdvanceSceneState(Msg):
    def __init__(self, t, steps):
        super().__init__(t, MsgSync.Type.ADVANCE_SCENE_STATE)
        self.steps = steps


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


def translate_midi_msg(msg):
    global cur_beat_idx
    midi_msg, deltatime = msg
    ws_msg = None
    if (midi_msg[0] & 0xF0 == NOTE_ON) and midi_msg[2] != 0:
        channel = (midi_msg[0] & 0xF) + 1
        note_number = midi_msg[1]
        print(f'note_on\t{channel}\t{note_number}')
        if channel == 16:
            # This channel is used for synchronization
            elapsed = bpm_estimator.ping()
            if elapsed > BEAT_RESET_TIMEOUT:
                cur_beat_idx = 0
            ws_msg = MsgSync(0, bpm_estimator.bpm, cur_beat_idx)
            cur_beat_idx = cur_beat_idx + 1
        elif channel == 15:
            # This channel is used for lighting control
            if USE_STROBE:
                strobe_on()
        elif channel == 14:
            # This channel is used for graphics scene switching
            ws_msg = MsgGotoScene(0, note_number - 60)
        elif channel == 13:
            # This channel is used for moving forward/backward in the graphics scene
            ws_msg = MsgAdvanceSceneState(0, 2 * (note_number % 2) - 1)
        else:
            # Remaining channels are used for controlling elements within the scene
            ws_msg = MsgBeat(0, channel, True)
    elif midi_msg[0] == NOTE_OFF:
        print(f'note_off\t{channel}\t{note_number}')
        if channel == 15:
            if USE_STROBE:
                strobe_off()
        else:
            ws_msg = MsgBeat(0, channel, False)
    elif midi_msg[0] == TIMING_CLOCK:
        #clock_receiver.ping()
        print('clock')
    

    if ws_msg != None:
        print(ws_msg)
    return ws_msg


def usage():
    print("Usage: %s [-h | --fake bpm | [port]]" % sys.argv[0])


fake_beat = [[] for i in range(0, 16)]
for i in [0, 4, 8, 12]:
    fake_beat[i].append(1)
#for i in [4, 12]:
    #fake_beat[i].append(2)
#for i in [0, 6]:
    #fake_beat[i].append(3)

async def main():
    parser = argparse.ArgumentParser(description="Rave MIDI -> web adapter")
    parser.add_argument('--fake', type=float, help='fake MIDI events with given BPM')
    parser.add_argument('host', type=str, help='the URL or IP address to connect to with websockets')
    parser.add_argument('-d', '--device', type=str, help='MIDI device to use (interactive if not specified)')
    args = parser.parse_args()

    bpm = args.fake
    beat_idx = 0
    midiin = None
    if not args.fake:
        midiin = rtmidi.MidiIn()
        midiin, _ = open_midiinput(args.device)

    while True:
        try:
            async with websockets.connect(WS_RELAY) as websocket:
                print('Connected to relay')
                while True:
                    if not args.fake:
                        midi_msg = midiin.get_message()
                        if midi_msg:
                            ws_msg = translate_midi_msg(midi_msg)
                            if ws_msg:
                                await websocket.send(ws_msg.to_json())
                                await websocket.recv()
                    else:
                        if beat_idx % 4 == 0:
                            ws_msg = MsgSync(time.time(), bpm, beat_idx // 4)
                            await websocket.send(ws_msg.to_json())
                            await websocket.recv()
                        cur_beats = fake_beat[beat_idx % len(fake_beat)]
                        for beat in cur_beats:
                            ws_msg = MsgBeat(time.time(), beat)
                            await websocket.send(ws_msg.to_json())
                            await websocket.recv()
                        await asyncio.sleep(60 / bpm / 4)
                        beat_idx += 1

        except (TimeoutError,
                ConnectionRefusedError,
                websockets.exceptions.ConnectionClosedError,
                websockets.exceptions.ConnectionClosedOK):
            print('Connection failed, retrying...')
            await asyncio.sleep(1)
            continue


if __name__ == "__main__":
    asyncio.run(main())