import argparse
import asyncio
from collections import deque
from enum import Enum
import json
import math
import os
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
BEAT_RESET_TIMEOUT_S = 1
WS_BEAT_PORT = 8765

MIN_BPM_SAMPLES = 4 * 24
NUM_BPM_SAMPLES = 16 * 24

LOG_MSGS = False
LOG_SYNC = False

# MIDI control-change values are 7-bit (0..127); we normalize them to [0, 1]
# before sending so the client deals only in normalized knob values.
MIDI_CC_MAX = 127.0

# Fake control-change knobs: sinusoids with a period of 4 bars (16 beats),
# each phase-shifted by one beat. Sent at a fixed high rate (independent of the
# sync clock) to give the impression of continuous movement.
FAKE_KNOB_MOVEMENT = True
FAKE_KNOB_COUNT = 14
FAKE_KNOB_PERIOD_BEATS = 64
FAKE_KNOB_UPDATE_HZ = 60

# Interactive tempo control for --fake (see console_ui.py). Up/down step
# the set tempo by TEMPO_STEP_BPM; left/right scale it by TEMPO_NUDGE_FACTOR
# while held, to drag the visuals forward or back against the music.
TEMPO_STEP_BPM = 0.1
TEMPO_NUDGE_FACTOR = 1.15
TEMPO_MIN_BPM = 20.0
TEMPO_MAX_BPM = 300.0
# A terminal reports no key-release event, so "held" is inferred from the
# terminal's own key auto-repeat: the nudge stays on until this long passes
# with no further repeat. It has to comfortably exceed the initial repeat delay
# (~0.5 s with macOS defaults) or a held arrow would stutter; the cost is that
# a single tap nudges for about this long.
TEMPO_NUDGE_RELEASE_S = 0.6
# Tap tempo: the space bar taps quarter notes. Every tap realigns the clock's
# beat grid to the tap, and once TEMPO_TAP_MIN taps have landed in one series
# their average spacing also sets the tempo - so a single tap just shifts the
# grid, while tapping along resets both. A gap longer than TEMPO_TAP_TIMEOUT_S
# ends the series, so the next set of taps is averaged on its own rather than
# against whatever was tapped a minute ago; 2 s is a quarter note at 30 bpm,
# below the tempo range anything here runs at.
TEMPO_TAP_MIN = 4
TEMPO_TAP_TIMEOUT_S = 2.0
# Taps closer together than this are treated as key bounce or a fumbled
# double-tap and ignored. Without it four fast taps estimate an absurd tempo and
# peg at TEMPO_MAX_BPM, which is a nasty thing to do to a set; no quarter note
# anyone means to tap is this short (it's 400 bpm).
TEMPO_TAP_MIN_SPACING_S = 0.15
# Taps kept for the estimate: enough to average out an unsteady hand, few
# enough to follow a tempo being deliberately tapped faster or slower.
TEMPO_TAP_WINDOW = 8
# What argparse stores for `--fake` with no bpm: there's no tempo yet and the
# clock stays silent until taps establish one. Not a usable bpm itself, so it
# can't be confused with one.
FAKE_TAP_TEMPO = 0.0
# Status-line redraw rate, in Hz. Only paces the display; tempo changes take
# effect on the next sync tick regardless.
TEMPO_STATUS_HZ = 20
# Largest scheduling backlog the fake clock will try to catch up on, in
# seconds. Past this (laptop slept, tempo yanked up) it restarts the schedule
# from now instead of spinning out a burst of overdue syncs.
FAKE_MAX_CATCHUP_S = 0.25

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
        log_line(f'Error setting strobe on: {e}')


def strobe_off():
    try:
        strobe.set_channel(0, 0)
        strobe.set_channel(1, 0)
    except Exception as e:
        log_line(f'Error setting strobe on: {e}')





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
    log_line(f'{channel}:{note_number}:{note_vel}')
    if note_vel == 0:
        return None

    ws_msg = None
    if channel == 16 and use_note_syncs:
        # This channel is used for synchronization
        clock_tracker.ping()
        if clock_tracker.sync:
            ws_msg = MsgSync(last_transmit_latency, clock_tracker.sync_rate_hz, clock_tracker.cur_sync_idx)
            if LOG_SYNC:
                log_line(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                log_line(f'beat: {clock_tracker.cur_sync_idx // 24}')
    elif channel == 15:
        # Analog Rytm auto channel
        if note_number >= 12 and note_number < 36:
            ws_msg = MsgGotoScene(last_transmit_latency, note_number - 12, note_vel < 100)
        elif note_number >= 36:
            log_line(f'advancing {-1 if note_number % 2 == 0 else 1}')
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
        self.loop.call_soon_threadsafe(broadcast, ws_msg)

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
                    log_line(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                    log_line(f'beat: {clock_tracker.cur_sync_idx // 24}')
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
            log_line(str(ws_msg))

        return ws_msg


# Set of connected viewer clients
connected = set()

# Connected adapter client
adapter = None
adapter_secret = None

# Last message's roundtrip latency divided by two, in seconds
last_msg_latency = 0.0

# The curses console, when one is running (see console_ui.py). None under
# visync.service or a pipe, where every call below falls back to plain prints.
console = None

# Name of the act currently playing, broadcast on change and to each new client.
cur_performer = ''


def broadcast(msg):
    """Send `msg` to every connected client, and log it in the console. Every
    outgoing message goes through here so the console's event log is complete."""
    websockets.broadcast(connected, msg.to_json())
    if console is not None:
        console.log_msg(msg)


def log_line(text):
    """Report something that isn't a message: into the console's log when one
    is running, otherwise to stdout."""
    if console is not None:
        console.log_note(text)
    else:
        print(text)


def update_client_count():
    if console is not None:
        console.client_count = len(connected)


def set_performer(name):
    """Change the act shown in the frontend HUD and tell every client."""
    global cur_performer
    cur_performer = name
    if console is not None:
        console.performer = name
    broadcast(MsgPerformer(last_msg_latency, name))


async def handler(websocket):
    global last_msg_latency
    connected.add(websocket)
    update_client_count()
    log_line("Client connected")
    # The performer only goes out when it changes, so a browser opened mid-set
    # would show nothing. Send the current one to this client alone.
    if cur_performer:
        await websocket.send(MsgPerformer(last_msg_latency, cur_performer).to_json())
    try:
        async for message in websocket:
            msg = json.loads(message)
            last_msg_latency = (time.time() - msg['t']) / 2
            #print(last_msg_latency)
    finally:
        # Unregister client
        connected.remove(websocket)
        update_client_count()
        log_line("Client disconnected")


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
                        log_line(f'sync_rate_bpm: {clock_tracker.sync_rate_hz * 60 / 24}')
                        log_line(f'beat: {clock_tracker.cur_sync_idx // 24}')
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
                log_line(f'unknown status byte: {b}')
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
                    log_line(f"control change: {self.bytes[1:]}")
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
                log_line(f'program change: {channel} {value}')
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
            log_line(str(ws_msg))

        if ws_msg:
            broadcast(ws_msg)
            msg_queue.put_nowait(ws_msg)

        if scene_cycler:
            cycle_msgs = scene_cycler.check_cycle(clock_tracker.cur_sync_idx)
            if cycle_msgs:
                for msg in cycle_msgs:
                    broadcast(msg)
            advance_msg = scene_cycler.check_advance(clock_tracker.cur_sync_idx)
            if advance_msg:
                broadcast(advance_msg)


class TempoControl:
    """The tempo main_loop_fake is currently running at, steerable from the
    terminal by the console (console_ui.py).

    `set_bpm` is the tempo the arrow keys nudge around and is what persists;
    `bpm()` is what the clock should actually run at right now, which differs
    from it only while a left/right nudge is live. Nudging changes the rate
    rather than jumping the clock, so a moment at 1.15x slides the visuals a
    fraction of a beat ahead of the music and they stay there once it lapses -
    which is the point: it's how you drag a drifting fake clock back onto the
    band. Space-bar taps are the coarse version of the same job: they move the
    grid outright instead of easing it over.

    `set_bpm` is None until a tempo exists at all, which is the state `--fake`
    with no bpm starts in; `ready` is set once one does, and main_loop_fake
    waits on it before broadcasting any sync."""

    def __init__(self, bpm=None):
        self.set_bpm = bpm
        self.nudge_dir = 0          # -1 (slower), 0 (none) or +1 (faster)
        self.nudge_expiry_s = 0.0   # monotonic time the nudge lapses at
        self._taps = deque(maxlen=TEMPO_TAP_WINDOW)   # monotonic tap times
        self._tap_grid_t = None     # time.time() of a tap the clock owes a
                                    # grid realignment to; None if none pending
        self.ready = asyncio.Event()
        if bpm is not None:
            self.ready.set()

    def bpm(self):
        """The tempo to clock at right now, or None if none is established."""
        # Lapse an expired nudge here rather than on a timer: every caller
        # wants the value as of now, and the clock loop asks 24x a beat.
        if self.nudge_dir and time.monotonic() >= self.nudge_expiry_s:
            self.nudge_dir = 0
        if self.set_bpm is None:
            return None
        return self.set_bpm * (TEMPO_NUDGE_FACTOR ** self.nudge_dir)

    def step(self, direction):
        """Move the set tempo by one TEMPO_STEP_BPM step, permanently."""
        if self.set_bpm is None:
            return             # nothing to step until taps establish a tempo
        self.set_bpm = min(TEMPO_MAX_BPM, max(TEMPO_MIN_BPM,
                                              self.set_bpm + direction * TEMPO_STEP_BPM))

    def nudge(self, direction):
        """Scale the tempo until TEMPO_NUDGE_RELEASE_S passes with no repeat."""
        self.nudge_dir = direction
        self.nudge_expiry_s = time.monotonic() + TEMPO_NUDGE_RELEASE_S

    def _prune_taps(self):
        """Drop a stale tap series, so what's left is the one being tapped now.
        Called from everything that reads the series, since all of them want it
        as of now - the same reason bpm() lapses the nudge itself."""
        if self._taps and time.monotonic() - self._taps[-1] > TEMPO_TAP_TIMEOUT_S:
            self._taps.clear()

    def tap(self):
        """Register a quarter-note tap: realign the grid to it, and re-estimate
        the tempo once the series is long enough to mean anything."""
        self._prune_taps()
        now = time.monotonic()
        if self._taps and now - self._taps[-1] < TEMPO_TAP_MIN_SPACING_S:
            return
        self._taps.append(now)
        # Wall clock, not monotonic: it's what main_loop_fake schedules on.
        self._tap_grid_t = time.time()
        if len(self._taps) >= TEMPO_TAP_MIN:
            spacing_s = (self._taps[-1] - self._taps[0]) / (len(self._taps) - 1)
            self.set_bpm = min(TEMPO_MAX_BPM, max(TEMPO_MIN_BPM, 60.0 / spacing_s))
            self.nudge_dir = 0     # a tapped tempo supersedes a live nudge
            self.ready.set()

    def taps_needed(self):
        """Taps still wanted before the current series can set a tempo."""
        self._prune_taps()
        return max(0, TEMPO_TAP_MIN - len(self._taps))

    def take_tap_grid_time(self):
        """The time of a tap the grid hasn't been realigned to yet, or None.
        Consumed by the caller, so each tap moves the grid exactly once."""
        tap_t, self._tap_grid_t = self._tap_grid_t, None
        return tap_t


async def main_loop_console(tempo):
    """Run the curses console (console_ui.py): tempo readout, scrolling event
    log of everything broadcast, and tab-to-set-performer.

    Does nothing unless stdin is a terminal: under visync.service or a pipe
    there are no keys to read and the redraws would just flood the log, so the
    adapter stays on plain prints via log_line."""
    global console
    if not sys.stdin.isatty():
        return

    import console_ui
    hints = 'tab performer   pgup/pgdn scroll   s sync/cc   ctrl-C quit'
    if tempo is not None:
        hints = 'space tap   up/down bpm   left/right nudge   ' + hints
    console = console_ui.Console(tempo=tempo, on_performer=set_performer,
                                 hints=hints)
    console.performer = cur_performer
    try:
        await console_ui.run(console)
    finally:
        console = None


async def main_loop_fake(tempo, cycle=0):
    global last_msg_latency
    sync_idx = 0
    beat_idx = 0
    state_advancing = True
    cur_advance_step = 1
    cur_advance_state = 0
    scene_cycler = SceneCycler(cycle) if cycle != 0 else None

    # With `--fake` and no bpm there is nothing to clock yet: stay off the wire
    # entirely until tap tempo establishes one, rather than broadcasting sync
    # at a guessed rate the frontend would start animating to.
    await tempo.ready.wait()
    tempo.take_tap_grid_time()   # the taps that set the tempo are behind us
    next_tick_time = time.time()

    while True:
        # A space-bar tap moves the beat grid onto it: start the schedule again
        # from the tap and round sync_idx up to the next quarter note, so the
        # tick about to go out is a downbeat. Rounding up rather than to the
        # nearest keeps sync_idx monotonic, which is what the frontend assumes
        # (it only checks whether floor(sync_idx / 24) changed). The grid lands
        # within one sync period of the tap - the loop notices it on waking,
        # not mid-sleep - which at any sane tempo is under 25 ms.
        tap_t = tempo.take_tap_grid_time()
        if tap_t is not None:
            sync_idx = -(-sync_idx // 24) * 24
            next_tick_time = tap_t

        # Re-read the tempo every tick and advance the schedule by one tick's
        # period, rather than deriving tick times from a fixed origin: a tempo
        # change then takes effect from here on without the clock jumping to
        # wherever the new rate says tick `sync_idx` should have landed.
        sync_rate_hz = (tempo.bpm() * 24) / 60
        sync_msg = MsgSync(last_msg_latency, sync_rate_hz, sync_idx)
        broadcast(sync_msg)

        if scene_cycler:
            cycle_msgs = scene_cycler.check_cycle(sync_idx)
            if cycle_msgs:
                for msg in cycle_msgs:
                    broadcast(msg)
            advance_msg = scene_cycler.check_advance(sync_idx)
            if advance_msg:
                broadcast(advance_msg)
        new_beat_idx = sync_idx // 6
        if new_beat_idx != beat_idx:
            beat_idx = new_beat_idx
            cur_beats = fake_beat[beat_idx % len(fake_beat)]

            '''if new_beat_idx % 16 == 0:
                # Advance or decrease state
                adv_msg = MsgAdvanceSceneState(0, cur_advance_step)
                broadcast(adv_msg)
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
                broadcast(ch_scene_msg)
                last_changed_fg = not bg
                cur_scenes[1 if bg else 0] = new_scene'''

            for beat in cur_beats:
                beat_msg = MsgBeat(last_msg_latency, beat)
                broadcast(beat_msg)
        sync_idx += 1
        next_tick_time += 1 / sync_rate_hz
        now = time.time()
        # Don't try to make up an unbounded backlog (sleep/suspend, a big tempo
        # jump) by firing overdue syncs back to back.
        next_tick_time = max(next_tick_time, now - FAKE_MAX_CATCHUP_S)
        await asyncio.sleep(max(0, next_tick_time - now))


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
    log_line(f"Listening to [{device_idx}] {device_name} @ {samplerate:.0f} Hz "
             f"-> MsgAudioInfo at {AUDIO_INFO_HZ} Hz")

    detector = None
    if infer_beat:
        detector = BeatDetector(samplerate, analyzer.n_bins)
        log_line("Inferring beats from audio (edit BEAT_BANDS in audio_info.py to tune):")
        for name, channel, lo, hi in detector.band_ranges():
            band = next(b for b in detector.bands if b.name == name)
            log_line(f"  {name:6s} -> beat channel {channel:2d}  "
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
                    broadcast(MsgBeat(last_msg_latency, band.channel, True))
                    log_line(f"beat {band.name:6s} ch{band.channel:<2d} "
                             f"{ratio:5.2f}x avg (energy {energy:.2e})")
            msg = MsgAudioInfo(last_msg_latency, amp_to_db(avg), amp_to_db(peak),
                               amp_to_db(spectrum), amp_to_db(smoothed), samplerate)
            broadcast(msg)
            next_tick += period
            await asyncio.sleep(max(0.0, next_tick - time.monotonic()))
    finally:
        stream.stop()
        stream.close()


async def main_loop_fake_knob_movement(tempo):
    """Continuously broadcast fake control-change messages for 16 phase-offset
    sinusoids, independent of the sync clock, for smooth knob motion."""
    # The periods are in beats, so they need a tempo to exist first.
    await tempo.ready.wait()
    beat_s = 60.0 / tempo.set_bpm
    start_time = time.time()
    period_s = [(0.5 + random.random()) * FAKE_KNOB_PERIOD_BEATS * beat_s for i in range(FAKE_KNOB_COUNT)]
    while True:
        elapsed = time.time() - start_time
        for knob in range(FAKE_KNOB_COUNT):
            phase = 2 * math.pi * (elapsed - knob * beat_s) / period_s[knob]
            # Normalized [0, 1] value, left unquantized for smooth motion.
            value = (math.sin(phase) + 1) / 2
            cc_msg = MsgControlChange(last_msg_latency, knob, value)
            broadcast(cc_msg)
        await asyncio.sleep(1.0 / FAKE_KNOB_UPDATE_HZ)


async def main():
    parser = argparse.ArgumentParser(description="Rave MIDI -> web adapter")
    parser.add_argument('-f', '--fake', type=float, nargs='?',
                        const=FAKE_TAP_TEMPO, metavar='BPM',
                        help='fake MIDI events at the given BPM, or with no BPM '
                             f'wait for {TEMPO_TAP_MIN} space-bar taps to set one '
                             'before sending any sync. When run from a terminal, '
                             'shows a live tempo readout: space taps quarter '
                             'notes (realigning the beat grid, and retapping the '
                             f'tempo), up/down step by {TEMPO_STEP_BPM} bpm, and '
                             'holding left/right nudges the tempo to slide the '
                             'visuals back or forward against the music')
    parser.add_argument('-d', '--device', type=str, help='Receive MIDI messages on specified tty (default /dev/ttyserial0)')
    parser.add_argument('-r', '--rtmidi', type=str, help='Use rtmidi with specified MIDI device (string e.g. Volt)')
    parser.add_argument('-c', '--cycle', type=int, default=0, help='Periodically cycle scenes every N bars. Default is 0 (do not cycle).')
    parser.add_argument('-a', '--audio', type=str, metavar='PATTERN',
                        help='Open the audio input device whose name contains '
                             'PATTERN (case-insensitive; must match exactly one) '
                             'and broadcast MsgAudioInfo. Use --list-devices to '
                             'see names.')
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

    args_count = sum(x is not None for x in [args.fake, args.device, args.rtmidi])
    if args_count != 1 and args.audio != None:
        print('Error: must specify exactly one of --fake, --device, or --rtmidi')
        exit(1)

    if args.fake == FAKE_TAP_TEMPO and not sys.stdin.isatty():
        print('Error: --fake with no BPM needs a terminal to tap the tempo in')
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
        async with websockets.serve(handler, "0.0.0.0", WS_BEAT_PORT), \
                asyncio.TaskGroup() as tg:
            queue = asyncio.Queue()

            have_midi_beat = False
            tempo = None
            if args.rtmidi:
                t1 = tg.create_task(main_loop_rtmidi(args.rtmidi, cycle=args.cycle))
                have_midi_beat = True
            elif args.device:
                t1 = tg.create_task(main_loop_serial(args.device, queue, cycle=args.cycle))
                have_midi_beat = True
            elif args.fake is not None:
                tempo = TempoControl(None if args.fake == FAKE_TAP_TEMPO else args.fake)
                t1 = tg.create_task(main_loop_fake(tempo, cycle=args.cycle))
                if FAKE_KNOB_MOVEMENT:
                    t_knobs = tg.create_task(main_loop_fake_knob_movement(tempo))
                have_midi_beat = True

            if args.audio is not None:
                t1 = tg.create_task(main_loop_audio(audio_device, not have_midi_beat))

            # The console runs in every mode - the event log and the performer
            # prompt are useful whatever is driving the clock. `tempo` is only
            # non-None for --fake, which is the only mode whose tempo we own.
            t_console = tg.create_task(main_loop_console(tempo))

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
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        # ctrl-C is how you quit. The console has already restored the terminal
        # on its way out (console_ui.run's finally), so just leave quietly
        # instead of printing a traceback over the screen it just cleaned up.
        pass
