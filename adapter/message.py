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
        PROGRAM_CHANGE = 8
        POSE = 9
        AUDIO_INFO = 10
        PERFORMER = 11

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
    # `value` is normalized to the range [0, 1]; consumers scale it as needed.
    def __init__(self, last_transmit_latency, wheel_idx, value):
        super().__init__(Msg.Type.CONTROL_CHANGE, last_transmit_latency)
        self.wheel_idx = wheel_idx
        self.value = value


class MsgProgramChange(Msg):
    def __init__(self, last_transmit_latency, channel, value):
        super().__init__(Msg.Type.PROGRAM_CHANGE, last_transmit_latency)
        self.channel = channel
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


class MsgAudioInfo(Msg):
    # A snapshot of the audio input, broadcast at a fixed rate by adapter.py's
    # -a/--audio mode. Every level here is in dBFS (0 dB = full scale, floored
    # at audio_info.DB_FLOOR): the log conversion happens adapter-side so the
    # values are quantized in the domain they're displayed in, which keeps the
    # resolution uniform instead of starving the quiet bins.
    #
    # `avg` and `peak` are the mean and maximum absolute sample amplitude over
    # the interval since the previous MsgAudioInfo. `spectrum` is the FFT
    # magnitude of the most recent analysis window, one value per rfft bin up to
    # audio_info.SPECTRUM_MAX_HZ, linearly spaced in frequency and normalized so
    # a full-scale sine reads ~0 dB in its bin; `spectrum_smoothed` is the same
    # thing time-averaged (on linear amplitude, before conversion). `samplerate`
    # (Hz) fixes the frequency axis: bin k is at k * samplerate / FFT_SIZE Hz.
    def __init__(self, last_transmit_latency, avg, peak, spectrum,
                 spectrum_smoothed, samplerate):
        super().__init__(Msg.Type.AUDIO_INFO, last_transmit_latency)
        self.avg = avg
        self.peak = peak
        self.spectrum = spectrum
        self.spectrum_smoothed = spectrum_smoothed
        self.samplerate = samplerate


class MsgPerformer(Msg):
    # Name of the act currently playing, shown in the frontend HUD. Broadcast
    # when it changes, and again to each client as it connects so a browser
    # opened mid-set shows the right name instead of a stale one.
    def __init__(self, last_transmit_latency, name):
        super().__init__(Msg.Type.PERFORMER, last_transmit_latency)
        self.name = name


class MsgPose(Msg):
    # skeletons: list of skeletons, one per detected person, each a list of
    # 33 [x, y, z] world-space points in metres, MediaPipe Pose's convention
    # (origin at the hip centre, x right, y down, z toward the camera). See
    # kinect_control.py's landmarks_to_array/POSE_CONNECTIONS.
    def __init__(self, last_transmit_latency, skeletons):
        super().__init__(Msg.Type.POSE, last_transmit_latency)
        self.skeletons = skeletons
