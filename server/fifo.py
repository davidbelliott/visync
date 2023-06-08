from enum import Enum
import logging
import json
import time
import sys
from websocket_server import WebsocketServer
import keyboard
WS_PORT = 8080

import threading

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


def listen_fifo(server):
    fifo_path = '/tmp/visync_fifo'
    with open(fifo_path) as fifo:
        cur_buf = ''
        while True:
            c = fifo.read(1)
            if len(c) == 1:
                if c == 'b':
                    t = time.time()
                    #msg = f'{t:06f}:{cur_buf}'
                    msg = MsgSync(t, 120, 0).to_json()
                    server.send_message_to_all(msg)
                    print(msg)
                    cur_buf = ''
                else:
                    cur_buf += c


def send_msg(server, msg):
    print(msg)
    server.send_message_to_all(msg)

beat_idx = 0
def send_fake_sync(server, bpm):
    global beat_idx
    t = time.time()
    msg = MsgSync(t, bpm, beat_idx).to_json()
    send_msg(server, msg)
    beat_idx = (beat_idx + 1) % 4

def send_fake_measure(server, bpm):
    sixteenths_dur = 60.0 / bpm / 4.0
    for i in range(32):
        t = time.time()
        if i % 4 == 0:
            msg = MsgSync(t, bpm, (i // 4) % 4).to_json()
            send_msg(server, msg)
        '''if ((i + 2) in [0, 6]) or ((i + 2 - 16) in [2, 6, 9, 13, 14]):
            msg = MsgBeat(t, 0).to_json()
            send_msg(server, msg)'''
        '''if ((i + 2) in [4, 12]) or ((i + 2 - 16) in [4, 12]):
            msg = MsgBeat(t, 1).to_json()
            send_msg(server, msg)'''

        if ((i + 2) % 32 in [0, 8]) or ((i + 2 - 16) in [0, 8]):
            msg = MsgBeat(t, 0).to_json()
            send_msg(server, msg)
        if ((i + 2) % 32 in [4, 12]) or ((i + 2 - 16) in [4, 12]):
            msg = MsgBeat(t, 1).to_json()
            send_msg(server, msg)
        time.sleep(sixteenths_dur)


def recv(client, server, msg):
    t = float(msg)
    time_now = time.time()
    dt = time_now - t
    print(f'dt: {dt}')


class PeriodicCaller:
    def __init__(self, interval, func, *args):
        self.interval = interval
        self.func = func
        self.args = args
        self.timer = None
        self.is_running = False

    def _run(self):
        self.timer = threading.Timer(self.interval, self._run)
        self.timer.start()
        self.func(*self.args)

    def start(self):
        if not self.is_running:
            self._run()
            self.is_running = True

    def stop(self):
        if self.is_running:
            self.timer.cancel()
            self.is_running = False


server = WebsocketServer(host='', port=WS_PORT, loglevel=logging.DEBUG)
server.set_fn_message_received(recv)
server.run_forever(True)
#listen_fifo(server)

def main():
    taps = []
    alpha = 0.4  # set the decay rate for the EWMA
    tempo = None
    caller = None
    while True:
        if keyboard.is_pressed(' '):  # if the spacebar is pressed
            taps.append(time.time())  # record the time of the tap
            while keyboard.is_pressed(' '):  # while the spacebar is still pressed
                pass  # do nothing

            if len(taps) == 4:
                intervals = [taps[i] - taps[i - 1] for i in range(1, len(taps))]
                new_tempo = round(60.0 / (sum(intervals) / len(intervals)))
                if tempo is None:
                    tempo = new_tempo
                else:
                    tempo = round((new_tempo + tempo) / 2.0)
                print(f"Estimated BPM: {tempo}")
                if caller is not None:
                    caller.stop()
                caller = PeriodicCaller(60.0 / tempo * 8, send_fake_measure, server, tempo)
                caller.start()
                taps = []

            time.sleep(0.01)  # small sleep to prevent high CPU usage


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1:
            bpm = int(sys.argv[1])
            caller = PeriodicCaller(60.0 / bpm * 8, send_fake_measure, server, bpm)
            caller.start()
            while True:
                time.sleep(1)
        else:
                main()
    except KeyboardInterrupt:
        print("Exiting...")
        sys.exit(0)
