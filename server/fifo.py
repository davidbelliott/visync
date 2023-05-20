from enum import Enum
import logging
import json
import time
from websocket_server import WebsocketServer
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


beat_idx = 0
def send_fake_sync(server, bpm):
    global beat_idx
    t = time.time()
    msg = MsgSync(t, bpm, beat_idx).to_json()
    server.send_message_to_all(msg)
    beat_idx = (beat_idx + 1) % 4
    print(msg)


def send_fake_beat(server):
    t = time.time()
    msg = MsgBeat(t, 0).to_json()
    server.send_message_to_all(msg)
    print(msg)

def send_msg(server, msg):
    print(msg)
    server.send_message_to_all(msg)

def send_fake_measure(server):
    bpm = 120
    sixteenths_dur = 60.0 / bpm / 4.0
    for i in range(16):
        t = time.time()
        if i % 4 == 0:
            msg = MsgSync(t, bpm, i // 4).to_json()
            send_msg(server, msg)
        if i in [0, 11]:
            msg = MsgBeat(t, 0).to_json()
            send_msg(server, msg)
        time.sleep(sixteenths_dur)


def recv(client, server, msg):
    t = float(msg)
    time_now = time.time()
    dt = time_now - t
    print(f'dt: {dt}')


def call_periodically(interval, func, args):
    def wrapper():
        call_periodically(interval, func, args)
        func(*args)
    t = threading.Timer(interval, wrapper)
    t.start()


server = WebsocketServer(host='', port=WS_PORT, loglevel=logging.DEBUG)
server.set_fn_message_received(recv)
server.run_forever(True)
#listen_fifo(server)

bpm = 120.0
seconds_per_beat = 60.0 / bpm
call_periodically(seconds_per_beat * 4, send_fake_measure, (server,))
