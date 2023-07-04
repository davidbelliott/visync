from enum import Enum
import json
import threading
import time
import rtmidi
import asyncio
import websockets
from websocket_server import WebsocketServer
from collections import deque
import logging

WS_PORT = 8080

clients_lock = threading.Lock()
midiin = rtmidi.RtMidiIn()
cur_beat_idx = 0

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


def recv(client, server, msg):
    t = float(msg)
    time_now = time.time()
    dt = time_now - t
    print(f'dt: {dt}')

clock_receiver = MIDIClockReceiver()
server = WebsocketServer(host='', port=WS_PORT, loglevel=logging.DEBUG)
server.set_fn_message_received(recv)
server.run_forever(True)


class Msg:
    # enum for each message type
    class Type(int, Enum):
        SYNC = 0
        BEAT = 1

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


def to_hex(st):
    return ':'.join(hex(ord(x))[2:] for x in st)

def translate_midi(midi):
    global cur_beat_idx
    t = time.time()
    msg = None
    if midi.isNoteOn():
        channel = midi.getChannel()
        print(f'channel: {channel}')
        if channel != 16:
            print('ON: ', midi.getMidiNoteName(midi.getNoteNumber()), midi.getVelocity())
            msg = MsgBeat(t, midi.getChannel())
        else:
            msg = MsgSync(t, clock_receiver.bpm, cur_beat_idx)
            cur_beat_idx = (cur_beat_idx + 1) % 4
    elif midi.isNoteOff():
        pass
        #print('OFF:', midi.getMidiNoteName(midi.getNoteNumber()))
    elif midi.getRawData() == b'\xf8':
        clock_receiver.ping()
    return msg.to_json() if msg != None else None


def get_midi_events():
    while True:
        m = midiin.getMessage(0) # some timeout in ms
        if m:
            msg_str = translate_midi(m)
            if msg_str != None:
                with clients_lock:
                    server.send_message_to_all(msg_str)

    
def main():
    midiin.ignoreTypes(True, False, True)
    ports = range(midiin.getPortCount())
    if ports:
        for i in ports:
            print(midiin.getPortName(i))
        idx = int(input("input midi port to listen to"))
        midiin.openPort(idx)
        get_midi_events()
    else:
        print('NO MIDI INPUT PORTS!')

if __name__ == "__main__":
    main()
