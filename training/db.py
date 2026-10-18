"""SQLite storage for hand-labelled training data.

The database holds only what a human made by hand -- track registry, labelling
sessions, and the per-frame label values -- because that is the part that
cannot be regenerated. Derived audio features live in .npz sidecars next to
the audio (see features.py), so the database stays small enough to copy
around, diff, and back up, and blowing away a stale feature cache never risks
the labels.

Labels are keyed by integer frame index rather than by float seconds: frames
are emitted at exactly session.frame_rate_hz, so the index is exact and makes
a clean primary key (float seconds would make dedup and rollback depend on
bit-level equality). Seconds are always recoverable as
frame_idx / frame_rate_hz, so labels survive a later change to the feature
framing -- they just get resampled in time at fit time.

Rollback works at two granularities. Within a pass, label.py deletes labels
after a rewind point (delete_labels_from). Across passes, a whole session can
be discarded -- sessions.py --drop. Sessions are never overwritten: labelling
the same track and channel twice leaves two independent sessions, and fitting
decides whether to average them or prefer the newest. That is deliberate; a
second pass is evidence about label noise, not a correction of the first.
"""

import hashlib
import os
import sqlite3
import time

# Bumped whenever the schema changes in a way old databases would not satisfy.
# init_schema refuses to touch a database from a newer version than it knows.
SCHEMA_VERSION = 1

# Session lifecycle. A session is 'active' while label.py is recording into it,
# so a crashed run is identifiable after the fact (its labels are still there
# and still usable -- 'active' just means nobody confirmed the pass was good).
STATUS_ACTIVE = 'active'
STATUS_COMMITTED = 'committed'
STATUS_DISCARDED = 'discarded'

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- One row per distinct audio file. `path` is stored relative to the database's
-- own directory so the whole training_data folder can be moved or copied
-- without invalidating anything; `sha256` detects the file being replaced
-- underneath us (the labels would then refer to different audio).
CREATE TABLE IF NOT EXISTS track (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    sha256      TEXT NOT NULL,
    samplerate  INTEGER NOT NULL,
    duration_s  REAL NOT NULL,
    added_at    REAL NOT NULL
);

-- A labelling axis, e.g. 'energy' or 'valence'. Free-form: axes are expected
-- to be added, renamed and abandoned as the axis set gets worked out.
CREATE TABLE IF NOT EXISTS channel (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

-- One pass of a human labelling one track. x/y channels may be null when a
-- pass only labels one axis (label.py -x with no -y).
CREATE TABLE IF NOT EXISTS session (
    id            INTEGER PRIMARY KEY,
    track_id      INTEGER NOT NULL REFERENCES track(id),
    x_channel_id  INTEGER REFERENCES channel(id),
    y_channel_id  INTEGER REFERENCES channel(id),
    status        TEXT NOT NULL,
    frame_rate_hz REAL NOT NULL,
    started_at    REAL NOT NULL,
    ended_at      REAL,
    note          TEXT
);

-- The labels themselves: one value in [0, 1] per (session, channel, frame).
-- WITHOUT ROWID because the primary key is the whole row's identity and these
-- are the bulk of the database (20 rows/second/channel of labelling).
CREATE TABLE IF NOT EXISTS label (
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channel(id),
    frame_idx  INTEGER NOT NULL,
    value      REAL NOT NULL,
    PRIMARY KEY (session_id, channel_id, frame_idx)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS label_by_channel ON label(channel_id, session_id);
"""


def file_sha256(path):
    """Hex sha256 of a file's contents, read in chunks so a long wav doesn't
    have to fit in memory."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def connect(db_path):
    """Open (creating if needed) the database at db_path and apply the schema.

    WAL keeps the GUI's periodic label flushes from blocking a concurrent
    reader (e.g. sessions.py in another terminal); foreign_keys is off by
    default in sqlite and has to be enabled per connection for the label
    cascade on session delete to actually fire.
    """
    db_path = os.path.realpath(db_path)
    parent = os.path.dirname(db_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    init_schema(conn)
    return conn


def init_schema(conn):
    with conn:
        conn.executescript(SCHEMA)
        row = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
        if row is None:
            conn.execute("INSERT INTO meta VALUES ('schema_version', ?)",
                         (str(SCHEMA_VERSION),))
        elif int(row['value']) > SCHEMA_VERSION:
            raise RuntimeError(
                f"database schema is version {row['value']}, this code knows "
                f"{SCHEMA_VERSION}; update the training code")


def db_dir(conn):
    """Directory the database file lives in -- the root that track paths are
    stored relative to."""
    for _, name, filename in conn.execute('PRAGMA database_list'):
        if name == 'main' and filename:
            return os.path.dirname(os.path.realpath(filename))
    raise RuntimeError('database is not file-backed')


def track_rel_path(conn, audio_path):
    # realpath on both sides: sqlite reports the database's resolved path, so
    # comparing it against an unresolved audio path would turn a plain sibling
    # file into a '../../..' chain wherever a symlink sits above them (macOS's
    # /var -> /private/var being the everyday case).
    return os.path.relpath(os.path.realpath(audio_path), db_dir(conn))


def get_or_create_track(conn, audio_path, samplerate, duration_s):
    """Return the track row for audio_path, inserting it on first sight.

    Returns (row, warning): warning is a human-readable string when the file's
    hash no longer matches what was recorded, meaning existing labels for this
    track refer to audio that has since changed. That is not made fatal -- a
    re-encode at the same length is usually harmless -- but the caller should
    say so out loud.
    """
    rel = track_rel_path(conn, audio_path)
    digest = file_sha256(audio_path)
    row = conn.execute('SELECT * FROM track WHERE path = ?', (rel,)).fetchone()
    if row is None:
        with conn:
            cur = conn.execute(
                'INSERT INTO track (path, sha256, samplerate, duration_s, '
                'added_at) VALUES (?, ?, ?, ?, ?)',
                (rel, digest, samplerate, duration_s, time.time()))
        row = conn.execute('SELECT * FROM track WHERE id = ?',
                           (cur.lastrowid,)).fetchone()
        return row, None

    warning = None
    if row['sha256'] != digest:
        warning = (f"'{rel}' has changed since it was first labelled "
                   f"(sha256 {row['sha256'][:12]} -> {digest[:12]}); existing "
                   f"labels for it may no longer line up with the audio")
    return row, warning


def get_or_create_channel(conn, name):
    name = name.strip()
    if not name:
        raise ValueError('channel name must not be empty')
    with conn:
        conn.execute('INSERT OR IGNORE INTO channel (name) VALUES (?)', (name,))
    return conn.execute('SELECT * FROM channel WHERE name = ?',
                        (name,)).fetchone()


def start_session(conn, track_id, x_channel_id, y_channel_id, frame_rate_hz,
                  note=None):
    with conn:
        cur = conn.execute(
            'INSERT INTO session (track_id, x_channel_id, y_channel_id, '
            'status, frame_rate_hz, started_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (track_id, x_channel_id, y_channel_id, STATUS_ACTIVE,
             frame_rate_hz, time.time(), note))
    return cur.lastrowid


def insert_labels(conn, rows):
    """Write (session_id, channel_id, frame_idx, value) tuples.

    OR REPLACE so re-labelling a frame after a rewind overwrites cleanly rather
    than colliding on the primary key.
    """
    if not rows:
        return
    with conn:
        conn.executemany(
            'INSERT OR REPLACE INTO label (session_id, channel_id, frame_idx, '
            'value) VALUES (?, ?, ?, ?)', rows)


def delete_labels_from(conn, session_id, frame_idx):
    """Drop this session's labels at or after frame_idx -- the in-pass rewind.
    Returns the number of labels removed."""
    with conn:
        cur = conn.execute(
            'DELETE FROM label WHERE session_id = ? AND frame_idx >= ?',
            (session_id, frame_idx))
    return cur.rowcount


def finish_session(conn, session_id, status):
    with conn:
        conn.execute('UPDATE session SET status = ?, ended_at = ? WHERE id = ?',
                     (status, time.time(), session_id))


def drop_session(conn, session_id):
    """Delete a session and (via ON DELETE CASCADE) its labels. Returns the
    number of labels that went with it."""
    n = conn.execute('SELECT COUNT(*) FROM label WHERE session_id = ?',
                     (session_id,)).fetchone()[0]
    with conn:
        conn.execute('DELETE FROM session WHERE id = ?', (session_id,))
    return n


def session_label_count(conn, session_id):
    return conn.execute('SELECT COUNT(*) FROM label WHERE session_id = ?',
                        (session_id,)).fetchone()[0]


def list_sessions(conn):
    return conn.execute("""
        SELECT s.*, t.path AS track_path, t.duration_s,
               xc.name AS x_channel, yc.name AS y_channel,
               (SELECT COUNT(*) FROM label l WHERE l.session_id = s.id) AS n_labels
        FROM session s
        JOIN track t ON t.id = s.track_id
        LEFT JOIN channel xc ON xc.id = s.x_channel_id
        LEFT JOIN channel yc ON yc.id = s.y_channel_id
        ORDER BY s.id
    """).fetchall()


def channel_stats(conn):
    """Per-channel totals over non-discarded sessions -- how much usable data
    each axis actually has."""
    return conn.execute("""
        SELECT c.name,
               COUNT(DISTINCT l.session_id) AS n_sessions,
               COUNT(DISTINCT s.track_id)   AS n_tracks,
               COUNT(*)                     AS n_labels,
               SUM(1.0 / s.frame_rate_hz)   AS seconds
        FROM label l
        JOIN channel c ON c.id = l.channel_id
        JOIN session s ON s.id = l.session_id
        WHERE s.status != ?
        GROUP BY c.id
        ORDER BY c.name
    """, (STATUS_DISCARDED,)).fetchall()
