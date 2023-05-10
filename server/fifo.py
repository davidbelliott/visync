import logging
import time
from websocket_server import WebsocketServer
WS_PORT = 8080

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
                    msg = f'{t:06f}:beat'
                    server.send_message_to_all(msg)
                    print(msg)
                    cur_buf = ''
                else:
                    cur_buf += c

def recv(client, server, msg):
    t = float(msg)
    time_now = time.time()
    dt = time_now - t
    print(f'dt: {dt}')


server = WebsocketServer(host='', port=WS_PORT, loglevel=logging.DEBUG)
server.set_fn_message_received(recv)
server.run_forever(True)
listen_fifo(server)
