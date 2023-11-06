from enum import Enum
import json
import time
import rtmidi
from collections import deque
import pathlib
from websockets.sync.client import connect
from rtmidi.midiconstants import *
from rtmidi.midiutil import open_midiinput
import sys

WS_RELAY = "ws://deadfacade.net/rave/ws"
USE_STROBE = False

cur_beat_idx = 0
BEAT_RESET_TIMEOUT = 2

dmx = None
strobe = None
if USE_STROBE:
    from PyDMXControl.controllers import OpenDMXController
    from PyDMXControl.profiles.Generic import Custom
    dmx = OpenDMXController()
    strobe = dmx.add_fixture(Custom, name="ADJ Mega Flash", channels=2)

class MIDIClockReceiver:
    def __init__(self, bpm=None):
        self.bpm = bpm if bpm is not None else 120.0
        self.sync = False
        self.running = True
        self._samples = deque()
        self._last_clock = None

    def ping(self):
        now = time.time()

        if self._last_clock is not None:
            self._samples.append(now - self._last_clock)

        self._last_clock = now

        if len(self._samples) > 24:
            self._samples.popleft()

        if len(self._samples) >= 2:
            self.bpm = 2.5 / (sum(self._samples) / len(self._samples))
            self.sync = True

class BPMEstimator:
    def __init__(self, bpm=None):
        self.bpm = bpm if bpm is not None else 120.0
        self._last_clock = None

    def ping(self):
        now = time.time()
        elapsed = 0
        if self._last_clock != None:
            elapsed = now - self._last_clock
            self.bpm = 60.0 / elapsed
        self._last_clock = now
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
    def __init__(self, t, channel):
        super().__init__(t, MsgSync.Type.BEAT)
        self.channel = channel


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


class MidiInputHandler(object):
    def __init__(self, midiport, websocket):
        self.port = midiport
        self.websocket = websocket
        self._wallclock = time.time()

    def __call__(self, event, data=None):
        global cur_beat_idx
        midi_msg, deltatime = event
        self._wallclock += deltatime
        print("[%s] @%0.6f %r" % (self.port, self._wallclock, midi_msg))
        t = self._wallclock
        ws_msg = None
        if (midi_msg[0] & 0xF0 == NOTE_ON) and midi_msg[2] != 0:
            channel = (midi_msg[0] & 0xF) + 1
            note_number = midi_msg[1]
            if channel == 16:
                # This channel is used for synchronization
                elapsed = bpm_estimator.ping()
                if elapsed > BEAT_RESET_TIMEOUT:
                    cur_beat_idx = 0
                ws_msg = MsgSync(t, bpm_estimator.bpm, cur_beat_idx)
                cur_beat_idx = cur_beat_idx + 1
            elif channel == 15:
                # This channel is used for lighting control
                if USE_STROBE:
                    strobe_on()
            elif channel == 14:
                # This channel is used for graphics scene switching
                ws_msg = MsgGotoScene(t, note_number - 60)
            elif channel == 13:
                # This channel is used for moving forward/backward in the graphics scene
                ws_msg = MsgAdvanceSceneState(t, 2 * (note_number % 2) - 1)
            else:
                # Remaining channels are used for controlling elements within the scene
                ws_msg = MsgBeat(t, channel)
        elif midi_msg[0] == NOTE_OFF:
            if channel == 15:
                if USE_STROBE:
                    strobe_off()
        elif midi_msg[0] == TIMING_CLOCK:
            #clock_receiver.ping()
            print('clock')
        else:
            print(midi_msg)
        

        if ws_msg != None:
            try:
                self.websocket.send(ws_msg.to_json())
            except Exception as e:
                print(f'Error sending message: {e}')


def main():
    midiin = rtmidi.MidiIn()
    port = sys.argv[1] if len(sys.argv) > 1 else None

    try:
        midiin, port_name = open_midiinput(port)
    except (EOFError, KeyboardInterrupt):
        sys.exit()

    with connect(WS_RELAY) as websocket:
        midiin.set_callback(MidiInputHandler(port_name, websocket))
        try:
            # Just wait for keyboard interrupt,
            # everything else is handled via the input callback.
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print('')
        finally:
            print("Exit.")
            midiin.close_port()
            del midiin


if __name__ == "__main__":
    main()
