import argparse
import asyncio
from collections import deque
from enum import Enum
import json
import math
import time
import serial_asyncio
import pathlib
import websockets
import rtmidi
from rtmidi.midiutil import open_midiinput
from rtmidi import midiconstants
import random
from message import *
import sys

USE_STROBE = False
USE_LEDS = False
FAKE_KNOB_MOVEMENT = False
BEAT_RESET_TIMEOUT_S = 1
WS_PORT = 8765
MIN_BPM_SAMPLES = 4 * 24
NUM_BPM_SAMPLES = 16 * 24

LOG_MSGS = False
LOG_SYNC = False

# MIDI control-change values are 7-bit (0..127); we normalize them to [0, 1]
# before sending so the client deals only in normalized knob values.
MIDI_CC_MAX = 127.0

# Fake control-change knobs: 16 sinusoids with a period of 4 bars (16 beats),
# each phase-shifted by one beat. Sent at a fixed high rate (independent of the
# sync clock) to give the impression of continuous movement.
FAKE_KNOB_COUNT = 16
FAKE_KNOB_PERIOD_BEATS = 16
FAKE_KNOB_UPDATE_HZ = 60

# Rate at which -a/--audio broadcasts MsgAudioInfo. Each message summarizes the
# input since the previous one, so this sets both the broadcast rate and the
# amplitude-averaging window; 60 Hz matches the frontend frame rate.
AUDIO_INFO_HZ = 120

if USE_LEDS:
    from blink import led_update_loop, led_handle_msgs

dmx = None
strobe = None
if USE_STROBE:
    from PyDMXControl.controllers import OpenDMXController
    from PyDMXControl.profiles.Generic import Custom
    dmx = OpenDMXController()
    strobe = dmx.add_fixture(Custom, name="ADJ Mega Flash", channels=2)


class ClockTracker:
    def __init__(self):
        self.sync_rate_hz = 120 / 60 * 24
        self.cur_sync_idx = -1      # Starts at -1 so first beat (ping, then send) will be beat 0
        self._last_clock_est = None
        self._samples = deque()
        self.sync = False


    def ping(self):
        now = time.time()
        elapsed = 0

        if self._last_clock_est != None:
            elapsed = now - self._last_clock_est
            if elapsed > BEAT_RESET_TIMEOUT_S:
                self.reset_sync()

        self._last_clock_est = now

        self._samples.append(now)

        if self.sync:
            est_syncs_elapsed = round(elapsed * self.sync_rate_hz)
            #print(f'est syncs elapsed: {est_syncs_elapsed}')

        self.cur_sync_idx += 1

        while len(self._samples) > NUM_BPM_SAMPLES:
            self._samples.popleft()

        if len(self._samples) >= MIN_BPM_SAMPLES and sum(self._samples) > 0:
            self.sync_rate_hz = (len(self._samples) - 1) / (self._samples[-1] - self._samples[0])
            self.sync = True



    def reset_sync(self):
        self.cur_sync_idx = -1
        self._last_clock = None
        self._samples.clear()
        self.sync = False
    


clock_tracker = ClockTracker()


NUM_SCENES = 23

class SceneCycler:
    def __init__(self, cycle_interval):
        self.cycle_interval = cycle_interval * 4 * 24   # 24 syncs per beat
        self.cur_scenes = [1, 0]  # [fg, bg]

    def check_cycle(self, sync_idx):
        """Returns a list of MsgGotoScene if it's time to cycle, otherwise None."""
        if self.cycle_interval == 0 or sync_idx % self.cycle_interval != 0:
            return None

        fg, bg = self.cur_scenes
        messages = []

        if fg and bg:
            # Both have scenes: blank fg
            self.cur_scenes[0] = 0
            messages.append(MsgGotoScene(0, 0, False))
        else:
            # At least one blank: add new scene
            if fg == 0 and bg:
                # Promote bg to fg first
                messages.append(MsgGotoScene(0, bg, False))
                self.cur_scenes[0] = bg
            # Add new scene to bg (or fg if both were blank)
            new_scene = random.randint(1, NUM_SCENES)
            target_bg = (self.cur_scenes[0] != 0)
            self.cur_scenes[1 if target_bg else 0] = new_scene
            messages.append(MsgGotoScene(0, new_scene, target_bg))

        return messages

    def check_advance(self, sync_idx):
        """Returns a MsgAdvanceSceneState if we're at the halfway point between scene changes."""
        if (self.cycle_interval != 0 and sync_idx % self.cycle_interval == self.cycle_interval // 2):
            return MsgAdvanceSceneState(0, 1)
        else:
            return None


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





NUM_BARS = 4
fake_beat = [[] for i in range(0, NUM_BARS * 16)]
for bar in range(0, NUM_BARS):
    for i in [0, 4, 8, 12]:
        fake_beat[16 * bar + i].append(1)
    for i in [4, 12]:
        fake_beat[16 * bar + i].append(4)
    for i in range(0, 16, 2):
        if i in [2, 6, 10, 14]:
            fake_beat[16 * bar + i].append(10)
        else:
            fake_beat[16 * bar + i].append(9)


def translate_note_to_msg(channel, note_number, note_vel, last_transmit_latency=0, use_note_syncs=False):
    print(f'{channel}:{note_number}:{note_vel}')
    if note_vel == 0:
        return None

    ws_msg = None
    if channel == 16 and use_note_syncs:
        # This channel is used for synchronization
        clock_tracker.ping()
        if clock_tracker.sync:
            ws_msg = MsgSync(last_transmit_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
            if LOG_SYNC:
                print(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                print(f'beat: {clock_tracker.cur_sync_idx // 24}')
    elif channel == 15:
        # Analog Rytm auto channel
        if note_number >= 12 and note_number < 36:
            ws_msg = MsgGotoScene(last_transmit_latency, note_number - 12, note_vel < 100)
        elif note_number >= 36:
            print(f'advancing {-1 if note_number % 2 == 0 else 1}')
            ws_msg = MsgAdvanceSceneState(last_transmit_latency, -1 if note_number % 2 == 0 else 1)
        else:
            ws_msg = MsgBeat(last_transmit_latency, note_number + 1, True)

    elif channel == 14:
        # This channel is used for graphics scene switching
        ws_msg = MsgGotoScene(last_transmit_latency, note_number - 60, note_vel < 100)
    elif channel == 13:
        # This channel is used for moving forward/backward in the graphics scene
        ws_msg = MsgAdvanceSceneState(last_transmit_latency, 1)
    elif channel == 12:
        ws_msg = MsgAdvanceSceneState(last_transmit_latency, -1)
    else:
        # Remaining channels are used for controlling elements within the scene
        '''if channel == 4:
            channel = 2
        elif channel == 9:
            channel = 4
        elif channel == 2 or channel == 5:
            channel = 3'''

        ws_msg = MsgBeat(last_transmit_latency, channel, True)

    return ws_msg


class RtMidiInputHandler:
    def __init__(self, loop, cycle=0):
        self.playing = True
        # rtmidi invokes __call__ from its own MIDI input thread, not the
        # asyncio loop; broadcasting (which writes to transports) must be
        # marshaled back via call_soon_threadsafe
        self.loop = loop
        self.scene_cycler = SceneCycler(cycle) if cycle != 0 else None

    def broadcast(self, ws_msg):
        self.loop.call_soon_threadsafe(websockets.broadcast, connected, ws_msg.to_json())

    def __call__(self, event, data=None):
        t_callback = time.time()
        message, deltatime = event
        ws_msg = self.translate_midi_msg(message)
        if ws_msg:
            self.broadcast(ws_msg)

        if self.scene_cycler:
            cycle_msgs = self.scene_cycler.check_cycle(clock_tracker.cur_sync_idx)
            if cycle_msgs:
                for msg in cycle_msgs:
                    self.broadcast(msg)
            advance_msg = self.scene_cycler.check_advance(clock_tracker.cur_sync_idx)
            if advance_msg:
                self.broadcast(advance_msg)


    def translate_midi_msg(self, midi_msg):
        # rtmidi hands us one fully-assembled message per call (unlike
        # SerialMidiHandler, which reassembles bytes off the wire itself), so
        # this mirrors SerialMidiHandler.handle_midi_byte's status-byte
        # dispatch without the byte-buffering.
        status = midi_msg[0]
        ws_msg = None

        if status == midiconstants.TIMING_CLOCK:
            clock_tracker.ping()
            if clock_tracker.sync and self.playing:
                ws_msg = MsgSync(last_msg_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
                if LOG_SYNC:
                    print(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                    print(f'beat: {clock_tracker.cur_sync_idx // 24}')
        elif status == midiconstants.SONG_STOP:
            self.playing = False
        elif status == midiconstants.SONG_START:
            self.playing = True
            clock_tracker.reset_sync()
        elif status == midiconstants.SONG_CONTINUE:
            self.playing = True
        elif status & 0xF0 == midiconstants.NOTE_ON and midi_msg[2] != 0:
            channel = (status & 0xF) + 1
            note_number, note_vel = midi_msg[1], midi_msg[2]
            ws_msg = translate_note_to_msg(channel, note_number, note_vel, last_msg_latency)
        elif status & 0xF0 == midiconstants.NOTE_OFF or (
                status & 0xF0 == midiconstants.NOTE_ON and midi_msg[2] == 0):
            channel = (status & 0xF) + 1
            if channel == 15:   # Analog Rytm auto channel
                if USE_STROBE:
                    strobe_off()
        elif status & 0xF0 == midiconstants.CONTROL_CHANGE:
            control_idx = midi_msg[1]
            control_val = midi_msg[2]
            ws_msg = MsgControlChange(last_msg_latency, control_idx, control_val / MIDI_CC_MAX)

        if ws_msg != None and LOG_MSGS:
            print(ws_msg)

        return ws_msg


# Set of connected viewer clients
connected = set()

# Connected adapter client
adapter = None
adapter_secret = None

# Last message's roundtrip latency divided by two, in seconds
last_msg_latency = 0.0

async def handler(websocket):
    global last_msg_latency
    connected.add(websocket)
    print("Client connected")
    try:
        async for message in websocket:
            msg = json.loads(message)
            last_msg_latency = (time.time() - msg['t']) / 2
            #print(last_msg_latency)
    finally:
        # Unregister client
        connected.remove(websocket)
        print("Client disconnected")


class SerialMidiHandler:
    def __init__(self):
        self.bytes = []
        self.playing = True

    def handle_midi_byte(self, b):
        ws_msg = None
        if len(self.bytes) == 0:
            # First byte
            if b == midiconstants.TIMING_CLOCK:
                # Single-byte message
                clock_tracker.ping()
                if clock_tracker.sync and self.playing:
                    #print(f'Sync idx: {clock_tracker.cur_sync_idx}')
                    ws_msg = MsgSync(last_msg_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
                    if LOG_SYNC:
                        print(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                        print(f'beat: {clock_tracker.cur_sync_idx // 24}')
                self.bytes = []
            elif b == midiconstants.SONG_STOP:
                # Single-byte message
                self.playing = False
                self.bytes = []
            elif b == midiconstants.SONG_START:
                # Single-byte message
                self.playing = True
                clock_tracker.reset_sync()
                self.bytes = []
            elif b == midiconstants.SONG_CONTINUE:
                # Single-byte message
                self.playing = True
                self.bytes = []
            elif b & 0xF0 == midiconstants.NOTE_ON:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.NOTE_OFF:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.CONTROL_CHANGE:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.PROGRAM_CHANGE:
                self.bytes = [b]
            elif b & 0xF0 == midiconstants.PITCH_BEND:
                self.bytes = [b]
            elif b & 0xF0 == 0xA0:
                self.bytes = [b]
            else:
                print(f'unknown status byte: {b}')
                pass
        else:
            # This is not the first byte
            if self.bytes[0] & 0xF0 == midiconstants.NOTE_ON:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    channel = (self.bytes[0] & 0xF) + 1
                    note_number, note_vel = self.bytes[1:]
                    ws_msg = translate_note_to_msg(channel, note_number, note_vel)
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.NOTE_OFF:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    channel = (self.bytes[0] & 0xF) + 1
                    note_number, note_vel = self.bytes[1:]
                    ws_msg = None
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.CONTROL_CHANGE:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    print(f"control change: {self.bytes[1:]}")
                    control_idx, control_val = self.bytes[1:]
                    # This channel is used for graphics scene switching
                    ws_msg = MsgControlChange(last_msg_latency, control_idx, control_val / MIDI_CC_MAX)
                    #ws_msg = MsgGotoScene(last_msg_latency, int(control_val / 5), control_idx > 1)
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.PITCH_BEND:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    value_lo, value_hi = self.bytes[1:]
                    value = (value_hi << 7) | value_lo
                    ws_msg = MsgPitchBend(last_msg_latency, value)
                    self.bytes = []
            elif self.bytes[0] & 0xF0 == midiconstants.PROGRAM_CHANGE:
                self.bytes.append(b)
                channel = (self.bytes[0] & 0xF) + 1
                value = self.bytes[1]
                print(f'program change: {channel} {value}')
                clock_tracker.cur_sync_idx = -1
                ws_msg = MsgProgramChange(last_msg_latency, channel, value)
                self.bytes = []
            elif self.bytes[0] & 0xF0 == 0xA0:
                self.bytes.append(b)
                if len(self.bytes) == 3:
                    channel = self.bytes[1] + 1
                    self.bytes = []
            else:
                self.bytes = []

        return ws_msg



async def main_loop_rtmidi(rtmidi_device, cycle=0):
    # main() already serves the websocket; this task just wires up the MIDI
    # callback and broadcasts to the module-level `connected` set, same as
    # main_loop_serial/main_loop_fake.
    try:
        midiin = rtmidi.MidiIn()
        midiin, _ = open_midiinput(rtmidi_device)
        # rtmidi drops MIDI Clock (and sysex/active-sensing) by default; the
        # sync path above needs Clock through to build MsgSync.
        midiin.ignore_types(timing=False)
        midi_handler = RtMidiInputHandler(asyncio.get_running_loop(), cycle=cycle)
        midiin.set_callback(midi_handler)
        while True:
            await asyncio.sleep(1)
    finally:
        midiin.close_port()
        del midiin


async def main_loop_serial(serial_device, msg_queue, cycle=0):
    reader, _ = await serial_asyncio.open_serial_connection(url=serial_device, baudrate=31250)
    handler = SerialMidiHandler()
    scene_cycler = SceneCycler(cycle) if cycle != 0 else None
    while True:
        byte = int.from_bytes(await reader.read(1))
        ws_msg = handler.handle_midi_byte(byte)

        if ws_msg and ws_msg.msg_type != Msg.Type.SYNC and LOG_MSGS:
            print(ws_msg)

        if ws_msg:
            websockets.broadcast(connected, ws_msg.to_json())
            msg_queue.put_nowait(ws_msg)

        if scene_cycler:
            cycle_msgs = scene_cycler.check_cycle(clock_tracker.cur_sync_idx)
            if cycle_msgs:
                for msg in cycle_msgs:
                    websockets.broadcast(connected, msg.to_json())
            advance_msg = scene_cycler.check_advance(clock_tracker.cur_sync_idx)
            if advance_msg:
                websockets.broadcast(connected, advance_msg.to_json())


async def main_loop_fake(bpm, cycle=0):
    global last_msg_latency
    sync_idx = 0
    beat_idx = 0
    sync_rate_hz = (bpm * 24) / 60
    state_advancing = True
    cur_advance_step = 1
    cur_advance_state = 0
    scene_cycler = SceneCycler(cycle) if cycle != 0 else None
    start_time = time.time()
    while True:
        sync_msg = MsgSync(last_msg_latency, sync_rate_hz, sync_idx)
        websockets.broadcast(connected, sync_msg.to_json())

        if scene_cycler:
            cycle_msgs = scene_cycler.check_cycle(sync_idx)
            if cycle_msgs:
                for msg in cycle_msgs:
                    websockets.broadcast(connected, msg.to_json())
            advance_msg = scene_cycler.check_advance(sync_idx)
            if advance_msg:
                websockets.broadcast(connected, advance_msg.to_json())
        new_beat_idx = sync_idx // 6
        if new_beat_idx != beat_idx:
            beat_idx = new_beat_idx
            cur_beats = fake_beat[beat_idx % len(fake_beat)]

            '''if new_beat_idx % 16 == 0:
                # Advance or decrease state
                adv_msg = MsgAdvanceSceneState(0, cur_advance_step)
                websockets.broadcast(connected, adv_msg.to_json())
                cur_advance_state += cur_advance_step
                if (cur_advance_state > 4 or cur_advance_state <= 0):
                    cur_advance_step *= -1'''

            '''if new_beat_idx % 128 == 0:
                # Change scene
                new_scene = (int(random.random() * 20) + 1)
                if cur_scenes[0] == 0:
                    cur_scenes[0] = new_scene
                elif cur_scenes[1] == 0:
                    cur_scenes[0] = new_scene
                else:
                    # TODO: change state here and propagate to frontend!
                    bg = last_changed_fg
                    new_scene = 0
                ch_scene_msg = MsgGotoScene(0, new_scene, bg)
                websockets.broadcast(connected, ch_scene_msg.to_json())
                last_changed_fg = not bg
                cur_scenes[1 if bg else 0] = new_scene'''

            for beat in cur_beats:
                beat_msg = MsgBeat(last_msg_latency, beat)
                websockets.broadcast(connected, beat_msg.to_json())
        sync_idx += 1
        next_tick_time = start_time + sync_idx / sync_rate_hz
        await asyncio.sleep(max(0, next_tick_time - time.time()))


async def main_loop_audio(device, infer_beat=False):
    """Open the given (index, name) audio input device and broadcast a
    MsgAudioInfo at AUDIO_INFO_HZ carrying the interval's average/peak amplitude
    and the raw FFT magnitude spectrum. The sounddevice callback runs on its own
    audio thread and only accumulates; the FFT and the broadcast happen here on
    the asyncio loop thread, so the realtime audio thread never stalls.

    With infer_beat, the same spectrum also drives a BeatDetector, broadcasting
    a MsgBeat whenever one of audio_info.BEAT_BANDS jumps above its threshold."""
    import sounddevice as sd
    from audio_info import AudioAnalyzer, BeatDetector, amp_to_db

    device_idx, device_name = device
    # Run at the device's own default rate, passed explicitly so the analyzer
    # (which needs it to know where SPECTRUM_MAX_HZ falls) and the stream agree.
    # Bin k of the spectrum is then k * samplerate / FFT_SIZE Hz.
    samplerate = float(sd.query_devices(device_idx)['default_samplerate'])
    analyzer = AudioAnalyzer(samplerate)
    # latency='low' requests the device's low-latency buffering instead of
    # PortAudio's default 'high' (the likely culprit behind laggy interfaces).
    stream = sd.InputStream(device=device_idx, samplerate=samplerate, channels=1,
                            dtype='float32', latency='low',
                            callback=analyzer.callback)
    print(f"Listening to [{device_idx}] {device_name} @ {samplerate:.0f} Hz "
          f"-> MsgAudioInfo at {AUDIO_INFO_HZ} Hz")

    detector = None
    if infer_beat:
        detector = BeatDetector(samplerate, analyzer.n_bins)
        print("Inferring beats from audio (edit BEAT_BANDS in audio_info.py to tune):")
        for name, channel, lo, hi in detector.band_ranges():
            band = next(b for b in detector.bands if b.name == name)
            print(f"  {name:6s} -> beat channel {channel:2d}  "
                  f"{band.f_lo_hz:5.0f}-{band.f_hi_hz:5.0f} Hz (bins {lo}-{hi}), "
                  f"threshold {band.threshold}x")

    period = 1.0 / AUDIO_INFO_HZ
    stream.start()
    try:
        next_tick = time.monotonic()
        while True:
            now = time.monotonic()
            # Levels come back linear; the beat detector wants true power, and
            # amp_to_db() converts for the wire (see audio_info.DB_FLOOR).
            avg, peak, spectrum, smoothed = analyzer.take_snapshot(now)
            if detector is not None:
                # Beats first: they're time-critical, the audio info is not.
                for band, energy, ratio in detector.update(spectrum, now):
                    websockets.broadcast(
                        connected,
                        MsgBeat(last_msg_latency, band.channel, True).to_json())
                    print(f"beat {band.name:6s} ch{band.channel:<2d} "
                          f"{ratio:5.2f}x avg (energy {energy:.2e})")
            msg = MsgAudioInfo(last_msg_latency, amp_to_db(avg), amp_to_db(peak),
                               amp_to_db(spectrum), amp_to_db(smoothed), samplerate)
            websockets.broadcast(connected, msg.to_json())
            next_tick += period
            await asyncio.sleep(max(0.0, next_tick - time.monotonic()))
    finally:
        stream.stop()
        stream.close()


async def main_loop_fake_knob_movement(bpm):
    """Continuously broadcast fake control-change messages for 16 phase-offset
    sinusoids, independent of the sync clock, for smooth knob motion."""
    beat_s = 60.0 / bpm
    start_time = time.time()
    period_s = [(0.5 + random.random()) * FAKE_KNOB_PERIOD_BEATS * beat_s for i in range(FAKE_KNOB_COUNT)]
    while True:
        elapsed = time.time() - start_time
        for knob in range(FAKE_KNOB_COUNT):
            phase = 2 * math.pi * (elapsed - knob * beat_s) / period_s[knob]
            # Normalized [0, 1] value, left unquantized for smooth motion.
            value = (math.sin(phase) + 1) / 2
            cc_msg = MsgControlChange(last_msg_latency, knob, value)
            websockets.broadcast(connected, cc_msg.to_json())
        await asyncio.sleep(1.0 / FAKE_KNOB_UPDATE_HZ)


async def main():
    parser = argparse.ArgumentParser(description="Rave MIDI -> web adapter")
    parser.add_argument('-f', '--fake', type=float, help='fake MIDI events with given BPM')
    parser.add_argument('-d', '--device', type=str, help='Receive MIDI messages on specified tty (default /dev/ttyserial0)')
    parser.add_argument('-r', '--rtmidi', type=str, help='Use rtmidi with specified MIDI device (string e.g. Volt)')
    parser.add_argument('-c', '--cycle', type=int, default=0, help='Periodically cycle scenes every N bars. Default is 0 (do not cycle).')
    parser.add_argument('-a', '--audio', type=str, metavar='PATTERN',
                        help='Open the audio input device whose name contains '
                             'PATTERN (case-insensitive; must match exactly one) '
                             'and broadcast MsgAudioInfo. Use --list-devices to '
                             'see names.')
    parser.add_argument('-i', '--infer-beat', '--infer_beat', action='store_true',
                        help='With --audio, also infer beats from the audio and '
                             'broadcast MsgBeat per audio_info.py BEAT_BANDS')
    parser.add_argument('--list-devices', action='store_true',
                        help='List audio input devices and exit')
    args = parser.parse_args()

    if args.list_devices:
        import sounddevice as sd
        for i, dev in enumerate(sd.query_devices()):
            dirs = []
            if dev['max_input_channels'] > 0: dirs.append(f"{dev['max_input_channels']}in")
            if dev['max_output_channels'] > 0: dirs.append(f"{dev['max_output_channels']}out")
            print(f"  [{i}] {dev['name']}  ({', '.join(dirs)})")
        return

    args_count = sum(x is not None for x in [args.fake, args.device, args.rtmidi, args.audio])
    if args_count != 1:
        print('Error: must specify exactly one of --fake, --device, --rtmidi, or --audio')
        exit(1)

    if args.infer_beat and args.audio is None:
        print('Error: --infer-beat only applies to --audio')
        exit(1)

    # Resolve the audio device up front so a bad --audio pattern fails cleanly
    # here rather than tearing down the server/TaskGroup with a SystemExit.
    audio_device = None
    if args.audio is not None:
        try:
            from audio_info import resolve_audio_device, AudioDeviceError
        except ImportError as e:
            print(f"Error: --audio needs numpy and sounddevice installed ({e})")
            return
        try:
            audio_device = resolve_audio_device(args.audio)
        except AudioDeviceError as e:
            print(f"Error: {e}")
            return

    # Restart-on-error loop (only exits on KeyboardInterrupt)
    while True:
        #try:
        async with websockets.serve(handler, "0.0.0.0", WS_PORT), \
                asyncio.TaskGroup() as tg:
            queue = asyncio.Queue()
            if args.rtmidi:
                t1 = tg.create_task(main_loop_rtmidi(args.rtmidi, cycle=args.cycle))
            elif args.device:
                t1 = tg.create_task(main_loop_serial(args.device, queue, cycle=args.cycle))
            elif args.audio is not None:
                t1 = tg.create_task(main_loop_audio(audio_device, args.infer_beat))
            else:
                t1 = tg.create_task(main_loop_fake(args.fake, cycle=args.cycle))
                if FAKE_KNOB_MOVEMENT:
                    t_knobs = tg.create_task(main_loop_fake_knob_movement(args.fake))

            if USE_LEDS:
                t2 = tg.create_task(led_update_loop())
                t3 = tg.create_task(led_handle_msgs(queue))
        '''except (KeyboardInterrupt, asyncio.exceptions.CancelledError):
            break
        except Exception as e:
            print(f'Error: {e}')
            print('Connection failed, retrying...')
            await asyncio.sleep(1)
            continue'''


if __name__ == "__main__":
    asyncio.run(main())
