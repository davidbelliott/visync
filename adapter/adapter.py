import argparse
import asyncio
from enum import Enum
import json
import time
import rtmidi
from collections import deque
import pathlib
from websockets.sync.client import connect
from rtmidi.midiconstants import NOTE_OFF, NOTE_ON
from rtmidi.midiutil import open_midiinput
import sys

USE_STROBE = False

MIN_BPM = 60
MAX_BPM = 200

BEAT_RESET_TIMEOUT_S = 1

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
            if elapsed > BEAT_RESET_TIMEOUT_S:
                self._samples.clear()
                self.sync = False
            else:
                if elapsed != 0:
                    self._samples.append(elapsed)

        self._last_clock = now

        while len(self._samples) > 4:
            self._samples.popleft()

        if len(self._samples) >= 4:
            bpms = [60.0 / x for x in self._samples if x != 0]
            if (len(bpms) > 0):
                self.bpm = sum(bpms) / len(bpms)
                self.sync = True

        print(f'bpm: {self.bpm} sync: {self.sync} samples: {self._samples}')
        return elapsed / 60 * self.bpm


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

    def __init__(self, msg_type, last_transmit_latency):
        self.latency = last_transmit_latency
        self.msg_type = msg_type
    
    def __repr__(self) -> str:
        return f'{self.msg_type}'

    def to_json(self):
        return json.dumps(self.__dict__)


class MsgSync(Msg):
    def __init__(self, last_transmit_latency, bpm, beat):
        super().__init__(MsgSync.Type.SYNC, last_transmit_latency)
        self.bpm = bpm
        self.beat = beat


class MsgBeat(Msg):
    def __init__(self, last_transmit_latency, channel, on=True):
        super().__init__(MsgSync.Type.BEAT, last_transmit_latency)
        self.channel = channel
        self.on = on


class MsgGotoScene(Msg):
    def __init__(self, last_transmit_latency, scene, bg=False):
        super().__init__(MsgSync.Type.GOTO_SCENE, last_transmit_latency)
        self.scene = scene
        self.bg = bg


class MsgAdvanceSceneState(Msg):
    def __init__(self, last_transmit_latency, steps):
        super().__init__(MsgSync.Type.ADVANCE_SCENE_STATE, last_transmit_latency)
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





def usage():
    print("Usage: %s [-h | --fake bpm | [port]]" % sys.argv[0])


fake_beat = [[] for i in range(0, 16)]
for i in [0, 8]:
    fake_beat[i].append(1)
for i in [2, 6, 10, 14]:
    fake_beat[i].append(2)
#for i in [0, 6]:
    #fake_beat[i].append(3)

class MidiInputHandler:
    def __init__(self, websocket):
        self.websocket = websocket
        self.cur_beat_idx = 0
        self.last_transmit_latency = 0

    def __call__(self, event, data=None):
        t_callback = time.time()
        message, deltatime = event
        ws_msg = self.translate_midi_msg(message)
        if ws_msg:
            self.websocket.send(ws_msg.to_json())
            msg_recv = self.websocket.recv(timeout=1.0)
            if msg_recv == ws_msg.to_json():
                t_recv = time.time()
                self.last_transmit_latency = (t_recv - t_callback) / 2
                print(f'Latency: {round(self.last_transmit_latency * 1000)}ms')

    def translate_midi_msg(self, midi_msg):
        ws_msg = None
        if (midi_msg[0] & 0xF0 == NOTE_ON) and midi_msg[2] != 0:
            channel = (midi_msg[0] & 0xF) + 1
            note_number = midi_msg[1]
            note_vel = midi_msg[2]
            if channel == 16:
                # This channel is used for synchronization
                bpm_estimator.ping()
                if bpm_estimator.sync:
                    ws_msg = MsgSync(self.last_transmit_latency, bpm_estimator.bpm, self.cur_beat_idx)
                self.cur_beat_idx = self.cur_beat_idx + 1
            elif channel == 15:
                # This channel is used for lighting control
                if USE_STROBE:
                    strobe_on()
            elif channel == 14:
                # This channel is used for graphics scene switching
                ws_msg = MsgGotoScene(self.last_transmit_latency, note_number - 60, note_vel < 100)
            elif channel == 13:
                # This channel is used for moving forward/backward in the graphics scene
                ws_msg = MsgAdvanceSceneState(self.last_transmit_latency, 1)
            elif channel == 12:
                ws_msg = MsgAdvanceSceneState(self.last_transmit_latency, -1)
            else:
                # Remaining channels are used for controlling elements within the scene
                ws_msg = MsgBeat(self.last_transmit_latency, channel, True)
        elif midi_msg[0] == NOTE_OFF:
            if channel == 15:
                if USE_STROBE:
                    strobe_off()
            else:
                ws_msg = MsgBeat(self.last_transmit_latency, channel, False)
        

        if ws_msg != None:
            print(ws_msg)

        return ws_msg


def main():
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
            with connect(f'ws://{args.host}:8765') as websocket:
                print('Connected to relay')
                # while True:
                if not args.fake:
                    midi_handler = MidiInputHandler(websocket)
                    midiin.set_callback(midi_handler)
                    while True:
                        time.sleep(1)
                else:
                    if beat_idx % 4 == 0:
                        ws_msg = MsgSync(time.time(), bpm, beat_idx // 4)
                        #await websocket.send(ws_msg.to_json())
                        #await websocket.recv()
                    cur_beats = fake_beat[beat_idx % len(fake_beat)]
                    for beat in cur_beats:
                        ws_msg = MsgBeat(time.time(), beat)
                        #await websocket.send(ws_msg.to_json())
                        #await websocket.recv()
                    #await asyncio.sleep(60 / bpm / 4)
                    beat_idx += 1
        except (KeyboardInterrupt, asyncio.exceptions.CancelledError):
            break
        except Exception as e:
            print(f'Error: {e}')
            print('Connection failed, retrying...')
            time.sleep(1)
            continue
        finally:
            midiin.close_port()
            del midiin


if __name__ == "__main__":
    main()