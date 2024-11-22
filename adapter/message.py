import asyncio
from enum import Enum
import json
import time


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
        PITCH_BEND = 7
        CONTROL_CHANGE = 8

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


class MsgControlChange(Msg):
    def __init__(self, last_transmit_latency, wheel_idx, value):
        super().__init__(Msg.Type.CONTROL_CHANGE, last_transmit_latency)
        self.wheel_idx = wheel_idx
        self.value = value


class MsgPitchBend(Msg):
    def __init__(self, last_transmit_latency, value):
        super().__init__(Msg.Type.PITCH_BEND, last_transmit_latency)
        self.value = value


class MsgAdvanceSceneState(Msg):
    def __init__(self, last_transmit_latency, steps):
        super().__init__(Msg.Type.ADVANCE_SCENE_STATE, last_transmit_latency)
        self.steps = steps


class MsgPromotion(Msg):
    def __init__(self, secret):
        super().__init__(Msg.Type.PROMOTION, 0)
        self.secret = secret
