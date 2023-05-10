from enum import Enum
import logging
import sys
import time
from rtmidi.midiutil import open_midiinput
from websocket_server import WebsocketServer

WS_PORT = 8080

log = logging.getLogger('midiin_callback')
#logging.basicConfig(level=logging.DEBUG)

class SendMsg:
    class Action(Enum):
        DECK_CHANGE = 0
        BEAT = 1
        BPM = 2

    def __init__(self, msg):
        self.action = None
        self.value = 0
        if len(msg) < 3:
            print(msg)
            return
        if msg[1] == 0x30:
            self.action = SendMsg.Action.DECK_CHANGE
            self.value = msg[2] - 0x64
        elif msg[1] == 0x32 and msg[2] == 0x64:
            self.action = SendMsg.Action.BEAT
        elif msg[1] == 0x34:
            self.action = SendMsg.Action.BPM
            self.value = msg[2] + 50


    def __repr__(self):
        ret_str = ''
        if self.action == SendMsg.Action.DECK_CHANGE:
            ret_str = 'deck_change'
        elif self.action == SendMsg.Action.BEAT:
            ret_str = 'beat'
        elif self.action == SendMsg.Action.BPM:
            ret_str = 'bpm'
        ret_str += f':{self.value}'
        return ret_str


class MidiInputHandler(object):
    def __init__(self, server):
        self.server = server
        self._wallclock = time.time()

    def __call__(self, event, data=None):
        message, deltatime = event
        self._wallclock += deltatime

        send_msg = SendMsg(message)
        if send_msg.action == None:
            return

        full_str = f'{self._wallclock:06f}:{send_msg}'
        if send_msg.action == SendMsg.Action.DECK_CHANGE:
            print(full_str)
        if send_msg.action == SendMsg.Action.BEAT:
            server.send_message_to_all(full_str)


if __name__ == "__main__":
    # Prompts user for MIDI input port, unless a valid port number or name
    # is given as the first argument on the command line.
    # API backend defaults to ALSA on Linux.
    port = sys.argv[1] if len(sys.argv) > 1 else None

    server = WebsocketServer(host='', port=WS_PORT, loglevel=logging.DEBUG)
    midiin, port_name = open_midiinput(port)
    midi_input_handler = MidiInputHandler(server)
    midiin.set_callback(midi_input_handler)
    server.run_forever()
