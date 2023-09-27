from enum import Enum
import json
import time
import rtmidi
from collections import deque
import pathlib
from websockets.sync.client import connect

WS_RELAY = "wss://deadfacade.net/rave/ws"
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
        return elapsed


def recv(client, msg):
    try:
        t = float(msg)
        time_now = time.time()
        dt = time_now - t
        latency_ms_round = round(dt * 1000)
        print(f'latency_ms: {latency_ms_round}')
    except:
        print(msg)
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


def handle_midi(midi, websocket):
    global cur_beat_idx
    t = time.time()
    msg = None
    channel = midi.getChannel()
    if midi.isNoteOn():
        if channel == 16:
            # This channel is used for synchronization
            elapsed = bpm_estimator.ping()
            if elapsed > BEAT_RESET_TIMEOUT:
                cur_beat_idx = 0
            msg = MsgSync(t, bpm_estimator.bpm, cur_beat_idx)
            cur_beat_idx = cur_beat_idx + 1
        elif channel == 15:
            # This channel is used for lighting control
            if USE_STROBE:
                strobe_on()
        elif channel == 14:
            # This channel is used for graphics scene switching
            msg = MsgGotoScene(t, midi.getNoteNumber() - 60)
        elif channel == 13:
            # This channel is used for moving forward/backward in the graphics scene
            msg = MsgAdvanceSceneState(t, 2 * (midi.getNoteNumber() % 2) - 1)
        else:
            # Remaining channels are used for controlling elements within the scene
            msg = MsgBeat(t, midi.getChannel())
    elif midi.isNoteOff():
        if channel == 15:
            if USE_STROBE:
                strobe_off()
    elif midi.getRawData() == b'\xf8':
        #clock_receiver.ping()
        print('clock')
    
    if msg != None:
        try:
            websocket.send(msg.to_json())
        except Exception as e:
            print(f'Error sending message: {e}')


def get_midi_events(midiin, websocket):
    while True:
        m = midiin.getMessage()
        if m:
            print(m)
            handle_midi(m, websocket)
            

def main():
    midiin = rtmidi.RtMidiIn()
    ports = range(midiin.getPortCount())
    if ports:
        portnames = [midiin.getPortName(i) for i in ports]
        port_to_open = None
        for i, p in enumerate(portnames):
            if "volt" in p.lower():
                port_to_open = i
                break
        if port_to_open == None:
            print('\n'.join(portnames))
            port_to_open = int(input("input midi port to listen to: "))
        midiin.openPort(port_to_open)
        with connect(WS_RELAY) as websocket:
            get_midi_events(midiin, websocket)
    else:
        print('NO MIDI INPUT PORTS!')
        exit(1)


if __name__ == "__main__":
    main()
