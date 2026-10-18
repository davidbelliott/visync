"""Inspect and roll back labelling sessions.

The session is the unit of rollback: one run of label.py over one track. A pass
that came out badly gets dropped whole rather than edited, so what remains in
the database is always a set of intact human performances.

Run:
    ../adapter/.venv/bin/python sessions.py training_data/database.db --list
    ../adapter/.venv/bin/python sessions.py training_data/database.db --stats
    ../adapter/.venv/bin/python sessions.py training_data/database.db --drop 7

--stats is the one to watch while collecting: it reports how many minutes of
labels each axis has and across how many distinct tracks. Track count is the
number that matters for whether an axis will generalize -- labels within one
track are heavily autocorrelated, so ten minutes across one track is far less
evidence than ten minutes across ten.
"""

import argparse

import db


def cmd_list(conn):
    rows = db.list_sessions(conn)
    if not rows:
        print('no sessions yet')
        return
    print(f'{"id":>4}  {"status":<10} {"x channel":<14} {"y channel":<14} '
          f'{"labels":>8}  track')
    for r in rows:
        print(f'{r["id"]:>4}  {r["status"]:<10} '
              f'{(r["x_channel"] or "-"):<14} {(r["y_channel"] or "-"):<14} '
              f'{r["n_labels"]:>8}  {r["track_path"]}')
        if r['note']:
            print(f'{"":>4}  note: {r["note"]}')


def cmd_stats(conn):
    rows = db.channel_stats(conn)
    if not rows:
        print('no labels yet')
        return
    print(f'{"channel":<18} {"tracks":>7} {"sessions":>9} {"labels":>9} {"minutes":>9}')
    for r in rows:
        print(f'{r["name"]:<18} {r["n_tracks"]:>7} {r["n_sessions"]:>9} '
              f'{r["n_labels"]:>9} {r["seconds"] / 60.0:>9.1f}')


def cmd_drop(conn, session_id, assume_yes):
    row = conn.execute('SELECT * FROM session WHERE id = ?',
                       (session_id,)).fetchone()
    if row is None:
        raise SystemExit(f'no session {session_id}')
    n = db.session_label_count(conn, session_id)
    if not assume_yes:
        answer = input(f'delete session {session_id} and its {n} labels? [y/N] ')
        if answer.strip().lower() not in ('y', 'yes'):
            print('left alone')
            return
    db.drop_session(conn, session_id)
    print(f'dropped session {session_id} ({n} labels)')


def main():
    parser = argparse.ArgumentParser(
        description='Inspect and roll back labelling sessions.')
    parser.add_argument('database')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--list', action='store_true',
                       help='list every session')
    group.add_argument('--stats', action='store_true',
                       help='per-channel totals over non-discarded sessions')
    group.add_argument('--drop', type=int, metavar='ID',
                       help='delete a session and its labels')
    parser.add_argument('-y', '--yes', action='store_true',
                        help='skip the confirmation prompt on --drop')
    args = parser.parse_args()

    conn = db.connect(args.database)
    try:
        if args.list:
            cmd_list(conn)
        elif args.stats:
            cmd_stats(conn)
        else:
            cmd_drop(conn, args.drop, args.yes)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
