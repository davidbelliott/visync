"""Ride the mouse over a 2-D pad to label a track's axes in real time.

Plays an audio file and records the mouse position, once per feature frame,
into a labelling session in the database: the pad's X maps to the -x channel
and its Y to the -y channel (up = 1). Labels are only ever appended to the
session this run created, so a pass can be thrown away wholesale without
touching earlier work.

Run:
    ../adapter/.venv/bin/python label.py training_data/track.wav \
        training_data/database.db -x valence -y energy

    # one axis only -- easier to be consistent, and what to use for anything
    # subtle; run the track again for the second axis
    ... label.py training_data/track.wav training_data/database.db -x energy

Controls:
    space       start / pause (starts paused, so you can settle the mouse first)
    r           rewind REWIND_S seconds, discarding the labels after that point
    c           drop a checkpoint at the current position
    b           jump back to the last checkpoint, discarding labels after it
    q or Esc    stop, commit the session, quit
    x           stop, discard this whole session, quit

Labels are written continuously (batched, see FLUSH_EVERY) so a crash costs at
most a second or two rather than the pass. Nothing here compensates for
reaction lag -- you react to the music a few hundred ms late, and correcting
that is the fitting step's job, on the recorded truth of what you did.

Sessions are listed and dropped with sessions.py.
"""

import argparse
import collections
import os
import threading
import time

import numpy as np
import dearpygui.dearpygui as dpg
import sounddevice as sd

import db
import features

# How far 'r' rewinds, in seconds. Long enough to get back before whatever you
# fumbled and hear the run-up to it again, short enough to not be a re-listen.
REWIND_S = 10.0

# Labels buffered in memory before a database write. At 20 frames/s/channel
# this flushes about every 2.5 s, which bounds crash loss without making the
# GUI thread wait on sqlite every frame.
FLUSH_EVERY = 100

# Seconds of recent pad positions drawn as a fading trail. Purely feedback: it
# makes it obvious when you have been sitting still versus tracking something.
TRAIL_S = 3.0

# Window geometry, in pixels. The pad is squared off inside whatever is left
# after the header (transport) and footer (key hints).
VIEWPORT_W = 900
VIEWPORT_H = 780
HEADER_H = 96
FOOTER_H = 104
PAD_INSET = 64          # room around the pad for axis labels

# House palette (see visync CLAUDE.md): black ground, neon accents.
COL_BG = (10, 10, 12, 255)
COL_GRID = (48, 48, 56, 255)
COL_FRAME = (150, 150, 160, 255)
COL_CURSOR = (0, 230, 255, 255)       # cyan crosshair + dot
COL_TRAIL = (255, 60, 200, 255)       # magenta trail
COL_TEXT = (220, 220, 230, 255)
COL_DIM = (130, 130, 145, 255)
COL_REC = (255, 120, 40, 255)         # orange = recording
COL_PAUSED = (130, 130, 145, 255)
COL_DONE = (120, 255, 160, 255)
COL_BAR_BG = (40, 40, 48, 255)
COL_BAR_LABELLED = (0, 160, 190, 255)
COL_CHECKPOINT = (255, 200, 60, 255)


class Player:
    """Plays a decoded array through the default output device, exposing the
    position that is currently *audible*.

    The sounddevice callback runs on PortAudio's thread and only moves the
    write cursor; everything else happens on the GUI thread. `position()`
    subtracts the stream's output latency from the write cursor, because the
    block just handed to the callback will not be heard for another
    latency-worth of time, and labelling against the write cursor would shift
    every label early by that much.
    """

    def __init__(self, data, samplerate):
        self.data = data                      # (n, channels) float32
        self.samplerate = samplerate
        self.total = data.shape[0]
        self.duration = self.total / samplerate
        self.playing = False
        self.finished = False

        self._lock = threading.Lock()
        self._pos = 0                         # frames written to the device
        self._pos_time = time.monotonic()     # when that write happened
        self._block_s = 0.0                   # one callback's worth, seconds
        self._latency_frames = 0

        self.stream = sd.OutputStream(
            samplerate=samplerate, channels=data.shape[1], dtype='float32',
            callback=self._callback)
        self.stream.start()
        self._latency_frames = int(self.stream.latency * samplerate)

    def _callback(self, outdata, frames, time_info, status):
        with self._lock:
            self._block_s = frames / self.samplerate
            if not self.playing:
                outdata[:] = 0.0
                self._pos_time = time.monotonic()
                return
            start = self._pos
            stop = min(start + frames, self.total)
            n = stop - start
            outdata[:n] = self.data[start:stop]
            if n < frames:
                outdata[n:] = 0.0
                self.playing = False
                self.finished = True
            self._pos = stop
            self._pos_time = time.monotonic()

    def position(self):
        """Audible position in seconds. Interpolated forward from the last
        callback so the cursor moves smoothly at the GUI's frame rate rather
        than stepping once per audio block."""
        with self._lock:
            pos, when, playing, block_s, done = (self._pos, self._pos_time,
                                                 self.playing, self._block_s,
                                                 self.finished)
        if done:
            # The callback reports 'finished' as it hands over the last block,
            # which is still a latency-worth away from being heard. Rather than
            # leave the clock stranded that far short of the end forever (and
            # the final frame or two unlabelled), call it done: the error is
            # bounded by the output latency and lands entirely in the last
            # fraction of a second.
            return self.duration
        frames = pos - self._latency_frames
        if playing:
            # Clamped to one block: past that the next callback is overdue and
            # extrapolating further would run the cursor ahead of the sound.
            elapsed = min(time.monotonic() - when, block_s)
            frames += elapsed * self.samplerate
        return min(max(frames / self.samplerate, 0.0), self.duration)

    def set_playing(self, playing):
        with self._lock:
            if playing and self._pos >= self.total:
                return
            self.playing = playing
            self._pos_time = time.monotonic()
            if playing:
                self.finished = False

    def seek(self, seconds):
        with self._lock:
            self._pos = int(min(max(seconds, 0.0), self.duration) * self.samplerate)
            self._pos_time = time.monotonic()
            self.finished = False

    def close(self):
        self.stream.stop()
        self.stream.close()


class Recorder:
    """Turns a stream of (frame index, pad position) into database rows.

    Emits exactly one label per feature frame per channel, filling in every
    frame between the last one emitted and the current playback position with
    the current pad value. That matters for two reasons: it guarantees labels
    align 1:1 with feature frames without any interpolation at fit time, and it
    means holding the mouse still records a held value rather than a gap (the
    mistake apc40_control.py's deliberately-quiet idle knobs would lead to if
    its output were recorded directly).
    """

    def __init__(self, conn, session_id, channel_ids, n_frames):
        self.conn = conn
        self.session_id = session_id
        self.channel_ids = channel_ids       # {'x': id or None, 'y': id or None}
        self.n_frames = n_frames
        self.next_frame = 0
        self.pending = []
        self.written = 0
        # Frames that have a label, for the coverage strip on the progress bar.
        self.covered = np.zeros(n_frames, dtype=bool)

    def record_upto(self, frame_idx, x, y):
        """Emit labels for every frame from next_frame through frame_idx."""
        frame_idx = min(frame_idx, self.n_frames - 1)
        while self.next_frame <= frame_idx:
            i = self.next_frame
            if self.channel_ids['x'] is not None:
                self.pending.append((self.session_id, self.channel_ids['x'], i, x))
            if self.channel_ids['y'] is not None:
                self.pending.append((self.session_id, self.channel_ids['y'], i, y))
            self.covered[i] = True
            self.next_frame += 1
        if len(self.pending) >= FLUSH_EVERY:
            self.flush()

    def rewind_to(self, frame_idx):
        """Discard labels at or after frame_idx and resume recording there."""
        frame_idx = max(0, min(frame_idx, self.n_frames))
        self.pending = [r for r in self.pending if r[2] < frame_idx]
        removed = db.delete_labels_from(self.conn, self.session_id, frame_idx)
        self.covered[frame_idx:] = False
        self.next_frame = frame_idx
        self.written = db.session_label_count(self.conn, self.session_id)
        return removed

    def flush(self):
        db.insert_labels(self.conn, self.pending)
        self.pending = []
        self.written = db.session_label_count(self.conn, self.session_id)


def fmt_time(seconds):
    seconds = max(0.0, seconds)
    return f'{int(seconds) // 60}:{int(seconds) % 60:02d}'


class Ui:
    """The pad window. Redrawn from scratch each frame -- a few dozen draw
    items, which Dear PyGui handles without breaking a sweat, and far simpler
    than keeping item handles in sync with the state."""

    DRAWLIST = 'pad_drawlist'

    def __init__(self, track_name, x_name, y_name, duration):
        self.track_name = track_name
        self.x_name = x_name
        self.y_name = y_name
        self.duration = duration
        self.trail = collections.deque()      # (t_wall, x, y)
        self.pad = (0, 0, 1, 1)               # x0, y0, x1, y1 in viewport px

    def build(self):
        dpg.create_context()
        with dpg.theme() as theme:
            with dpg.theme_component(dpg.mvAll):
                dpg.add_theme_style(dpg.mvStyleVar_WindowPadding, 0, 0,
                                    category=dpg.mvThemeCat_Core)
                dpg.add_theme_style(dpg.mvStyleVar_WindowBorderSize, 0,
                                    category=dpg.mvThemeCat_Core)
                dpg.add_theme_color(dpg.mvThemeCol_WindowBg, COL_BG,
                                    category=dpg.mvThemeCat_Core)
        dpg.bind_theme(theme)

        with dpg.window(tag='root', no_scrollbar=True, no_title_bar=True,
                        no_resize=True, no_move=True):
            dpg.add_drawlist(width=VIEWPORT_W, height=VIEWPORT_H, tag=self.DRAWLIST)

        dpg.create_viewport(title=f'label.py - {self.track_name}',
                            width=VIEWPORT_W, height=VIEWPORT_H)
        dpg.setup_dearpygui()
        dpg.show_viewport()
        dpg.set_primary_window('root', True)

    def layout(self):
        """Recompute the pad rectangle for the current window size. The pad is
        kept square so a given mouse distance means the same amount of label
        change on both axes -- an oblong pad would silently bias whichever axis
        got the long side."""
        w = max(320, dpg.get_viewport_client_width())
        h = max(320, dpg.get_viewport_client_height())
        dpg.configure_item(self.DRAWLIST, width=w, height=h)
        avail_w = w - 2 * PAD_INSET
        avail_h = h - HEADER_H - FOOTER_H
        side = max(80, min(avail_w, avail_h))
        x0 = (w - side) / 2
        y0 = HEADER_H + (avail_h - side) / 2
        self.pad = (x0, y0, x0 + side, y0 + side)
        return w, h

    def mouse_to_values(self):
        """Viewport mouse position -> (x, y) in [0, 1], y up. Clamped, so
        running off the edge of the pad pins the axis rather than losing it."""
        mx, my = dpg.get_mouse_pos(local=False)
        x0, y0, x1, y1 = self.pad
        x = (mx - x0) / max(x1 - x0, 1e-6)
        y = 1.0 - (my - y0) / max(y1 - y0, 1e-6)
        return min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0)

    def draw(self, w, h, state):
        dpg.delete_item(self.DRAWLIST, children_only=True)
        p = self.DRAWLIST
        x0, y0, x1, y1 = self.pad

        self._draw_header(w, state, p)

        # Pad: grid at quarters, brighter frame, brightest centre lines.
        dpg.draw_rectangle((x0, y0), (x1, y1), color=COL_FRAME, thickness=1.5,
                           parent=p)
        for i in range(1, 4):
            f = i / 4
            col = COL_FRAME if i == 2 else COL_GRID
            dpg.draw_line((x0 + f * (x1 - x0), y0), (x0 + f * (x1 - x0), y1),
                          color=col, thickness=1.0, parent=p)
            dpg.draw_line((x0, y0 + f * (y1 - y0)), (x1, y0 + f * (y1 - y0)),
                          color=col, thickness=1.0, parent=p)

        self._draw_axis_labels(x0, y0, x1, y1, p)

        # Trail, oldest first, drawn as one polyline.
        if len(self.trail) > 1:
            pts = [(x0 + tx * (x1 - x0), y1 - ty * (y1 - y0))
                   for _, tx, ty in self.trail]
            dpg.draw_polyline(pts, color=COL_TRAIL, thickness=2.0, parent=p)

        # Cursor: crosshair to the axes plus a filled dot.
        cx = x0 + state['x'] * (x1 - x0)
        cy = y1 - state['y'] * (y1 - y0)
        dpg.draw_line((x0, cy), (x1, cy), color=COL_CURSOR, thickness=1.0, parent=p)
        dpg.draw_line((cx, y0), (cx, y1), color=COL_CURSOR, thickness=1.0, parent=p)
        dpg.draw_circle((cx, cy), 7, color=COL_CURSOR, fill=COL_CURSOR, parent=p)

        self._draw_footer(w, h, state, p)

    def _draw_header(self, w, state, p):
        status, colour = state['status']
        dpg.draw_text((PAD_INSET, 16), self.track_name, color=COL_TEXT, size=20,
                      parent=p)
        dpg.draw_text((PAD_INSET, 42),
                      f'session {state["session_id"]}   {state["written"]} labels',
                      color=COL_DIM, size=15, parent=p)

        clock = f'{fmt_time(state["position"])} / {fmt_time(self.duration)}'
        dpg.draw_text((w - PAD_INSET - 190, 16), clock, color=COL_TEXT, size=20,
                      parent=p)
        dpg.draw_text((w - PAD_INSET - 190, 42), status, color=colour, size=15,
                      parent=p)

        # Progress bar with a coverage strip: the darker fill is elapsed time,
        # the cyan underline is what actually carries labels, so a rewind's
        # effect is visible immediately.
        bx0, bx1, by = PAD_INSET, w - PAD_INSET, 74
        dpg.draw_rectangle((bx0, by), (bx1, by + 10), color=COL_BAR_BG,
                           fill=COL_BAR_BG, parent=p)
        frac = state['position'] / self.duration if self.duration else 0.0
        if frac > 0:
            dpg.draw_rectangle((bx0, by), (bx0 + frac * (bx1 - bx0), by + 10),
                               color=colour, fill=colour, parent=p)
        cov = state['covered_frac']
        if cov > 0:
            dpg.draw_rectangle((bx0, by + 11), (bx0 + cov * (bx1 - bx0), by + 14),
                               color=COL_BAR_LABELLED, fill=COL_BAR_LABELLED,
                               parent=p)
        for t in state['checkpoints']:
            cxp = bx0 + (t / self.duration) * (bx1 - bx0) if self.duration else bx0
            dpg.draw_line((cxp, by - 4), (cxp, by + 14), color=COL_CHECKPOINT,
                          thickness=2.0, parent=p)

    def _draw_axis_labels(self, x0, y0, x1, y1, p):
        mid_y = (y0 + y1) / 2
        if self.x_name:
            dpg.draw_text(((x0 + x1) / 2 - 4 * len(self.x_name), y1 + 10),
                          self.x_name, color=COL_CURSOR, size=17, parent=p)
            dpg.draw_text((x0 - 6, y1 + 10), '0', color=COL_DIM, size=15, parent=p)
            dpg.draw_text((x1 - 8, y1 + 10), '1', color=COL_DIM, size=15, parent=p)
        if self.y_name:
            # Drawn vertically down the left inset, one character per line --
            # Dear PyGui's draw_text has no rotation.
            top = mid_y - 9 * len(self.y_name) / 2
            for i, ch in enumerate(self.y_name):
                dpg.draw_text((x0 - 34, top + i * 18), ch, color=COL_CURSOR,
                              size=17, parent=p)
            dpg.draw_text((x0 - 20, y0 - 2), '1', color=COL_DIM, size=15, parent=p)
            dpg.draw_text((x0 - 20, y1 - 16), '0', color=COL_DIM, size=15, parent=p)
        else:
            dpg.draw_text((x0 - 40, mid_y - 8), '(x only)', color=COL_DIM,
                          size=14, parent=p)

    def _draw_footer(self, w, h, state, p):
        y = h - FOOTER_H + 22
        readout = []
        if self.x_name:
            readout.append(f'{self.x_name} {state["x"]:.3f}')
        if self.y_name:
            readout.append(f'{self.y_name} {state["y"]:.3f}')
        dpg.draw_text((PAD_INSET, y), '     '.join(readout), color=COL_TEXT,
                      size=19, parent=p)
        dpg.draw_text((PAD_INSET, y + 30),
                      f'space start/pause    r rewind {REWIND_S:.0f}s    '
                      f'c checkpoint    b back to checkpoint',
                      color=COL_DIM, size=14, parent=p)
        dpg.draw_text((PAD_INSET, y + 50),
                      'q / Esc commit and quit    x discard session and quit',
                      color=COL_DIM, size=14, parent=p)

    def push_trail(self, x, y):
        now = time.monotonic()
        self.trail.append((now, x, y))
        while self.trail and now - self.trail[0][0] > TRAIL_S:
            self.trail.popleft()


def run(args):
    conn = db.connect(args.database)

    audio_path = os.path.abspath(args.audio)
    if not os.path.exists(audio_path):
        raise SystemExit(f'no such audio file: {args.audio}')
    digest = db.file_sha256(audio_path)

    feats, playback, samplerate = features.load_or_build(
        audio_path, digest, rebuild=args.rebuild_features)
    frame_rate = feats['frame_rate_hz']
    n_frames = feats['n_frames']
    duration = playback.shape[0] / samplerate

    track, warning = db.get_or_create_track(conn, audio_path, samplerate, duration)
    if warning:
        print(f'warning: {warning}')

    channels = {'x': None, 'y': None}
    for key, name in (('x', args.x), ('y', args.y)):
        if name:
            channels[key] = db.get_or_create_channel(conn, name)['id']

    session_id = db.start_session(
        conn, track['id'], channels['x'], channels['y'], frame_rate, args.note)
    print(f'session {session_id}: {os.path.basename(audio_path)} '
          f'({fmt_time(duration)}, {n_frames} frames at {frame_rate:.4g} Hz)')
    print(f'  x -> {args.x or "(unused)"}    y -> {args.y or "(unused)"}')

    recorder = Recorder(conn, session_id, channels, n_frames)
    player = Player(playback, samplerate)
    ui = Ui(os.path.basename(audio_path), args.x, args.y, duration)
    ui.build()

    if args.start > 0:
        player.seek(args.start)
        recorder.next_frame = int(args.start * frame_rate)

    checkpoints = []
    committed = True        # 'x' is the only path that flips this
    x_val = y_val = 0.5

    try:
        while dpg.is_dearpygui_running():
            # Layout first: mouse_to_values() reads the pad rectangle, which is
            # only valid once layout() has sized it against the current window.
            w, h = ui.layout()
            position = player.position()
            x_val, y_val = ui.mouse_to_values()

            if dpg.is_key_pressed(dpg.mvKey_Spacebar):
                player.set_playing(not player.playing)
                if not player.playing:
                    recorder.flush()
            if dpg.is_key_pressed(dpg.mvKey_R):
                _seek(player, recorder, max(0.0, position - REWIND_S), frame_rate)
            if dpg.is_key_pressed(dpg.mvKey_C):
                checkpoints.append(position)
                print(f'checkpoint at {fmt_time(position)}')
            if dpg.is_key_pressed(dpg.mvKey_B) and checkpoints:
                _seek(player, recorder, checkpoints[-1], frame_rate)
            if dpg.is_key_pressed(dpg.mvKey_X):
                committed = False
                break
            if dpg.is_key_pressed(dpg.mvKey_Q) or dpg.is_key_pressed(dpg.mvKey_Escape):
                break

            if player.playing or player.finished:
                # Also on the frame playback ends, so the tail of the track is
                # labelled rather than left short. record_upto is idempotent
                # once the cursor has reached the end, so repeating it costs
                # nothing.
                recorder.record_upto(int(position * frame_rate), x_val, y_val)
            if player.playing:
                ui.push_trail(x_val, y_val)

            if player.finished:
                status = ('finished - q to commit', COL_DONE)
            elif player.playing:
                status = ('recording', COL_REC)
            else:
                status = ('paused - space to start', COL_PAUSED)

            ui.draw(w, h, {
                'x': x_val, 'y': y_val,
                'position': position,
                'status': status,
                'session_id': session_id,
                'written': recorder.written + len(recorder.pending),
                'covered_frac': float(recorder.covered.mean()),
                'checkpoints': checkpoints,
            })
            dpg.render_dearpygui_frame()
    finally:
        player.close()
        dpg.destroy_context()
        recorder.flush()
        if committed:
            db.finish_session(conn, session_id, db.STATUS_COMMITTED)
            print(f'committed session {session_id}: {recorder.written} labels '
                  f'({recorder.covered.sum()} of {n_frames} frames)')
            print(f'  drop it with: python sessions.py {args.database} '
                  f'--drop {session_id}')
        else:
            n = db.drop_session(conn, session_id)
            print(f'discarded session {session_id} ({n} labels)')
        conn.close()


def _seek(player, recorder, seconds, frame_rate):
    """Move playback and roll the recorder back to match, so the labels after
    the seek point are re-recorded rather than left as a stale mixture of two
    passes."""
    was_playing = player.playing
    player.set_playing(False)
    frame_idx = int(seconds * frame_rate)
    removed = recorder.rewind_to(frame_idx)
    player.seek(seconds)
    print(f'rewound to {fmt_time(seconds)} (dropped {removed} labels)')
    player.set_playing(was_playing)


def main():
    parser = argparse.ArgumentParser(
        description='Label a track\'s axes by riding the mouse over a 2-D pad.')
    parser.add_argument('audio', help='audio file to label')
    parser.add_argument('database', help='sqlite database to append to')
    parser.add_argument('-x', metavar='CHANNEL',
                        help='channel name the pad\'s X axis labels')
    parser.add_argument('-y', metavar='CHANNEL',
                        help='channel name the pad\'s Y axis labels (up = 1)')
    parser.add_argument('--start', type=float, default=0.0, metavar='SECONDS',
                        help='begin playback partway into the track')
    parser.add_argument('--note', help='free-text note stored with the session')
    parser.add_argument('--rebuild-features', action='store_true',
                        help='re-extract the feature cache even if it is current')
    args = parser.parse_args()

    if not args.x and not args.y:
        parser.error('give at least one of -x / -y')
    run(args)


if __name__ == '__main__':
    main()
