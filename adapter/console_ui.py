"""Curses console for adapter.py: tempo readout, performer prompt, event log.

A thin terminal UI so a show can be driven from the keyboard without a MIDI
controller, and so you can see what the adapter is actually putting on the wire.
Three regions, top to bottom:

    PERFORMER | tempo readout | client count        <- status, rewritten in place
    14:23:07.412  BEAT     ch 1                     <- event log, newest at the
    14:23:07.418  CC       knob 8 -> 0.512             bottom, scrollable
    ...
    space tap  up/down bpm  tab performer  ...      <- key hints, or the prompt

Keys (the status/tempo ones only do anything in --fake mode):
    space        tap tempo, quarter notes
    up/down      step the set tempo
    left/right   hold to nudge the tempo
    tab          prompt for a new performer name; enter sends, esc cancels
    pgup/pgdn    scroll the log; end jumps back to following it
    s            show/hide the high-rate SYNC and CC lines
    ctrl-C       quit

Needs a terminal: adapter.py skips all of this when stdin isn't a tty (under
visync.service, or a pipe), where there are no keys to read and the redraws
would just flood the log.
"""

import asyncio
import curses
import os
import sys
import time
from collections import deque

from message import Msg

# Lines of scrollback kept. At ~60 Hz of coalesced CC traffic this is a couple
# of minutes of history, which is as far back as anyone looks mid-set.
LOG_LINES = 2000

# Redraw rate, in Hz. Only paces the display; nothing waits on it.
REDRAW_HZ = 20

# Message types that arrive in the hundreds per second. They are logged like
# anything else but hidden by default (toggle with 's'), because a log that
# scrolls a screen every 20 ms shows nothing.
HIGH_RATE_TYPES = frozenset({Msg.Type.SYNC, Msg.Type.CONTROL_CHANGE,
                             Msg.Type.AUDIO_INFO})

# Short tag and colour for each message type in the log. Colours follow the
# house palette: beats and scene changes are the ones you watch, so they get
# the bright hues; clock and knob traffic stays dim.
MSG_STYLE = {
    Msg.Type.SYNC:                ('SYNC',    'dim'),
    Msg.Type.BEAT:                ('BEAT',    'cyan'),
    Msg.Type.GOTO_SCENE:          ('SCENE',   'magenta'),
    Msg.Type.ADVANCE_SCENE_STATE: ('ADVANCE', 'yellow'),
    Msg.Type.CONTROL_CHANGE:      ('CC',      'blue'),
    Msg.Type.POSE:                ('POSE',    'blue'),
    Msg.Type.AUDIO_INFO:          ('AUDIO',   'dim'),
    Msg.Type.PERFORMER:           ('ACT',     'white'),
}

# Colour name -> (curses colour, bold). Pair numbers are assigned in _init_colors
# in this dict's order.
COLORS = {
    'dim':     (curses.COLOR_WHITE,   False),
    'white':   (curses.COLOR_WHITE,   True),
    'cyan':    (curses.COLOR_CYAN,    True),
    'magenta': (curses.COLOR_MAGENTA, True),
    'yellow':  (curses.COLOR_YELLOW,  True),
    'blue':    (curses.COLOR_BLUE,    True),
    'green':   (curses.COLOR_GREEN,   True),
    'red':     (curses.COLOR_RED,     True),
}


def describe(msg):
    """One-line detail for a message, after its MSG_STYLE tag."""
    t = msg.msg_type
    if t == Msg.Type.SYNC:
        return f'idx {msg.sync_idx}  ({msg.sync_rate_hz * 60 / 24:.1f} bpm)'
    if t == Msg.Type.BEAT:
        return f'ch {msg.channel}'
    if t == Msg.Type.GOTO_SCENE:
        return f'scene {msg.scene} -> {"background" if msg.bg else "foreground"}'
    if t == Msg.Type.ADVANCE_SCENE_STATE:
        return f'{msg.steps:+d}'
    if t == Msg.Type.CONTROL_CHANGE:
        return f'knob {msg.wheel_idx} -> {msg.value:.3f}'
    if t == Msg.Type.POSE:
        return f'{len(msg.skeletons)} skeleton(s)'
    if t == Msg.Type.AUDIO_INFO:
        return f'avg {msg.avg:.1f} dB  peak {msg.peak:.1f} dB'
    if t == Msg.Type.PERFORMER:
        return msg.name
    return ''


def coalesce_key(msg):
    """What makes two consecutive messages the same log line.

    The high-rate types carry a different detail every message (a new sync
    index, a new knob value), so matching on detail would never collapse them
    and the log would be nothing but clock traffic. They collapse per stream
    instead - per knob for CC - with the line showing the newest value and a
    count. Everything else only collapses when it is an exact repeat, so
    distinct beat channels and scene changes each keep their own line."""
    if msg.msg_type == Msg.Type.CONTROL_CHANGE:
        return (msg.msg_type, msg.wheel_idx)
    if msg.msg_type in HIGH_RATE_TYPES:
        return (msg.msg_type,)
    return (msg.msg_type, describe(msg))


class LogEntry:
    """One log line, possibly standing for several coalesced messages."""

    def __init__(self, msg_type, tag, color, detail, key=None):
        self.t = time.time()
        self.msg_type = msg_type
        self.tag = tag
        self.color = color
        self.detail = detail
        self.key = key
        self.count = 1

    def text(self):
        stamp = time.strftime('%H:%M:%S', time.localtime(self.t))
        frac = f'{self.t % 1:.3f}'[1:]
        count = f'  x{self.count}' if self.count > 1 else ''
        return f'{stamp}{frac}  {self.tag:<7} {self.detail}{count}'


class Console:
    """The curses UI. `tempo` is a TempoControl in --fake mode, else None;
    `on_performer` is called with a name when one is entered."""

    def __init__(self, tempo=None, on_performer=None, hints=''):
        self.tempo = tempo
        self.on_performer = on_performer
        self.hints = hints
        self.log = deque(maxlen=LOG_LINES)
        self._live = {}            # high-rate key -> its open (roll-up) LogEntry
        self.show_high_rate = False
        self.scroll = 0            # lines scrolled up from the newest; 0 follows
        self.prompt = None         # the performer name being typed, or None
        self.performer = ''
        self.client_count = 0
        self.status_note = ''      # transient right-hand note (errors, saves)
        self.screen = None
        self._pairs = {}

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self.screen = curses.initscr()
        curses.noecho()
        curses.cbreak()            # leaves ISIG alone, so ctrl-C still quits
        self.screen.keypad(True)   # arrows/pgup arrive as single KEY_* codes
        self.screen.nodelay(True)
        try:
            curses.curs_set(0)
        except curses.error:
            pass                   # terminal with no cursor control; harmless
        self._init_colors()

    def stop(self):
        if self.screen is None:
            return
        self.screen.keypad(False)
        curses.nocbreak()
        curses.echo()
        curses.endwin()
        self.screen = None

    def _init_colors(self):
        try:
            curses.start_color()
            curses.use_default_colors()
        except curses.error:
            return                 # monochrome terminal: attrs fall back to 0
        for i, (name, (color, bold)) in enumerate(COLORS.items(), start=1):
            try:
                curses.init_pair(i, color, -1)
            except curses.error:
                continue
            self._pairs[name] = curses.color_pair(i) | (curses.A_BOLD if bold
                                                        else curses.A_DIM)

    def attr(self, name):
        return self._pairs.get(name, 0)

    # -- log ---------------------------------------------------------------

    def log_msg(self, msg):
        """Record an outgoing message. Called for every broadcast.

        A run of clock/knob traffic rolls up into one line per stream rather
        than one line per message: `self._live` holds the open entry for each
        high-rate key, and a discrete event (a beat, a scene change) closes them
        all, so the rolled-up lines stay in the right place in the timeline.
        Matching only the previous entry would never collapse anything, because
        sync and control changes interleave."""
        tag, color = MSG_STYLE.get(msg.msg_type, (f'T{int(msg.msg_type)}', 'white'))
        detail = describe(msg)
        key = coalesce_key(msg)
        self._drop_evicted()
        entry = self._live.get(key)
        if entry is not None:
            entry.count += 1
            entry.detail = detail      # show the newest value on the rolled-up line
            entry.t = time.time()
            return

        self.log.append(LogEntry(msg.msg_type, tag, color, detail, key))
        if msg.msg_type in HIGH_RATE_TYPES:
            self._live[key] = self.log[-1]
        else:
            # A discrete event: close every open roll-up so later clock traffic
            # starts a fresh line below this one instead of merging above it.
            self._live.clear()
        # Keep the view pinned to the same lines while scrolled back, so new
        # traffic doesn't drag the text out from under you.
        if self.scroll:
            self.scroll += 1

    def log_note(self, text, color='green'):
        """Record something that isn't a message (connects, errors, notices)."""
        self.log.append(LogEntry(None, 'ADAPTER', color, text, key=object()))
        self._live.clear()
        if self.scroll:
            self.scroll += 1

    def _drop_evicted(self):
        """Forget roll-ups whose line has aged out of the deque, so a counter
        can't keep ticking on a line nobody can see any more."""
        if len(self.log) < LOG_LINES:
            return
        oldest = self.log[0]
        self._live = {k: e for k, e in self._live.items() if e is not oldest}

    def visible_log(self):
        if self.show_high_rate:
            return list(self.log)
        return [e for e in self.log if e.msg_type not in HIGH_RATE_TYPES]

    # -- keys --------------------------------------------------------------

    def handle_keys(self):
        """Drain every key the terminal has buffered. Called from a reader
        callback on stdin, so it must never block."""
        while True:
            try:
                key = self.screen.getch()
            except curses.error:
                return
            if key == -1:
                return
            self._handle_key(key)

    def _handle_key(self, key):
        if self.prompt is not None:
            self._handle_prompt_key(key)
            return

        if key == ord('\t'):
            self.prompt = ''
            return
        if key == ord(' '):
            if self.tempo:
                self.tempo.tap()
            return
        if key in (ord('s'), ord('S')):
            self.show_high_rate = not self.show_high_rate
            self.scroll = 0
            return
        if key == curses.KEY_UP and self.tempo:
            self.tempo.step(1)
        elif key == curses.KEY_DOWN and self.tempo:
            self.tempo.step(-1)
        elif key == curses.KEY_RIGHT and self.tempo:
            self.tempo.nudge(1)
        elif key == curses.KEY_LEFT and self.tempo:
            self.tempo.nudge(-1)
        elif key == curses.KEY_PPAGE:
            self.scroll = min(self.scroll + self._log_height(),
                              max(0, len(self.visible_log()) - 1))
        elif key == curses.KEY_NPAGE:
            self.scroll = max(0, self.scroll - self._log_height())
        elif key == curses.KEY_HOME:
            self.scroll = max(0, len(self.visible_log()) - 1)
        elif key == curses.KEY_END:
            self.scroll = 0

    def _handle_prompt_key(self, key):
        if key in (curses.KEY_ENTER, 10, 13):
            name = self.prompt.strip()
            self.prompt = None
            if name and self.on_performer:
                self.on_performer(name)
        elif key == 27:                                   # esc
            self.prompt = None
        elif key in (curses.KEY_BACKSPACE, 127, 8):
            self.prompt = self.prompt[:-1]
        elif 32 <= key < 127:
            self.prompt += chr(key)

    # -- drawing -----------------------------------------------------------

    def _log_height(self):
        rows, _ = self.screen.getmaxyx()
        return max(1, rows - 2)         # one status row, one footer row

    def _put(self, row, col, text, attr=0):
        """Write clipped to the window. The bottom-right cell can't be written
        without scrolling, so the last column is always left alone."""
        _, cols = self.screen.getmaxyx()
        if col >= cols - 1:
            return
        try:
            self.screen.addnstr(row, col, text, cols - 1 - col, attr)
        except curses.error:
            pass

    def tempo_text(self):
        if self.tempo is None:
            return 'external clock'
        bpm = self.tempo.bpm()
        if bpm is None:
            needed = self.tempo.taps_needed()
            return f'no tempo - tap space {needed}x'
        arrow = {-1: '<<', 0: '', 1: '>>'}[self.tempo.nudge_dir]
        return f'{bpm:.1f} bpm {arrow}'.strip()

    def draw(self):
        if self.screen is None:
            return
        rows, cols = self.screen.getmaxyx()
        self.screen.erase()

        # Status row: the same fields as the frontend HUD, same order.
        col = 0
        performer = self.performer or '(no performer)'
        self._put(0, col, performer, self.attr('white'))
        col += len(performer)
        for text, color in ((f' | {self.tempo_text()}', 'cyan'),
                            (f' | {self.client_count} client'
                             f'{"" if self.client_count == 1 else "s"}', 'dim')):
            self._put(0, col, text, self.attr(color))
            col += len(text)
        if self.status_note:
            self._put(0, col, f' | {self.status_note}', self.attr('yellow'))

        # Log pane: newest at the bottom, `scroll` lines up from the end.
        entries = self.visible_log()
        height = self._log_height()
        end = len(entries) - self.scroll
        window = entries[max(0, end - height):max(0, end)]
        for i, entry in enumerate(window):
            self._put(1 + i, 0, entry.text(), self.attr(entry.color))

        # Footer: the prompt while typing, otherwise the key hints.
        if self.prompt is not None:
            label = 'performer: '
            self._put(rows - 1, 0, label, self.attr('yellow'))
            self._put(rows - 1, len(label), self.prompt + '_', self.attr('white'))
        else:
            footer = self.hints
            if self.scroll:
                footer = f'[scrolled {self.scroll} lines - end to follow]  {footer}'
            elif not self.show_high_rate:
                footer = f"[s: show sync/cc]  {footer}"
            self._put(rows - 1, 0, footer, self.attr('dim'))

        self.screen.refresh()


async def run(console):
    """Own the terminal for as long as this runs: install the key reader and
    redraw at REDRAW_HZ. Restores the terminal on the way out, including when
    cancelled, so a traceback isn't printed into a curses screen."""
    fd = sys.stdin.fileno()
    loop = asyncio.get_running_loop()
    console.start()
    loop.add_reader(fd, console.handle_keys)
    try:
        while True:
            console.draw()
            await asyncio.sleep(1.0 / REDRAW_HZ)
    finally:
        loop.remove_reader(fd)
        console.stop()
