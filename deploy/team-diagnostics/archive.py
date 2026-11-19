"""Durable, paginated log archive; reader connections cannot mutate it."""
import datetime
import json
import pathlib
import re
import sqlite3

from common import canonical, cursor_decode, cursor_encode, digest, identifier, scrub

SCHEMA = '''
CREATE TABLE IF NOT EXISTS records (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id INTEGER NOT NULL,
 stream TEXT NOT NULL, service TEXT NOT NULL, stamp TEXT NOT NULL, ordinal INTEGER NOT NULL,
 message TEXT NOT NULL, hash TEXT NOT NULL,
 UNIQUE(source,source_id), UNIQUE(source,stream,stamp,ordinal)
);
CREATE INDEX IF NOT EXISTS log_lookup ON records(source,service,stamp,id);
CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_status (source TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (source TEXT NOT NULL, source_id INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(source,source_id));
'''
STAMP = re.compile(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z\Z')


def timestamp(value):
    match = STAMP.fullmatch(value or '')
    if not match:
        raise ValueError('Use a UTC timestamp, for example 2026-11-16T00:00:00Z')
    datetime.datetime.strptime(match[1], '%Y-%m-%dT%H:%M:%S')
    return match[1] + '.' + (match[2] or '').ljust(9, '0') + 'Z'


def since_timestamp(value):
    match = re.fullmatch(r'([1-9][0-9]{0,6})([smhd])', value)
    if not match: return timestamp(value)
    seconds = int(match[1]) * {'s':1,'m':60,'h':3600,'d':86400}[match[2]]
    if seconds > 3650*86400: raise ValueError('Time range exceeds ten years')
    return timestamp((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=seconds)).strftime('%Y-%m-%dT%H:%M:%S.%fZ'))


def connect(path, write=False):
    path = pathlib.Path(path)
    if path.is_symlink():
        raise ValueError('Archive cannot be a symbolic link')
    if not write:
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
        db.execute('PRAGMA query_only=ON')
    else:
        db = sqlite3.connect(path)
        path.chmod(0o600)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        upgrade_receipts = not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipts'").fetchone()
        db.executescript(SCHEMA)
        if upgrade_receipts:
            db.execute('INSERT OR IGNORE INTO receipts SELECT source,source_id,hash FROM records'); db.commit()
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=10000')
    return db


def checkpoint(db, key, default=None):
    row = db.execute('SELECT value FROM checkpoints WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def set_checkpoint(db, key, value):
    db.execute('INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
               (key, canonical(value)))


def record(db, source, stream, service, stamp, ordinal, message, source_id=None):
    identifier(source); identifier(stream); identifier(service)
    stamp = timestamp(stamp)
    if not isinstance(ordinal, int) or ordinal < 0 or ordinal > 10**9:
        raise ValueError('Invalid log ordinal')
    if not isinstance(message, str) or len(message.encode()) > 1024 * 1024:
        raise ValueError('Invalid log record size')
    clean = scrub(message)
    body = [source, stream, service, stamp, ordinal, clean]
    checksum = digest(body)
    if source_id is not None:
        receipt = db.execute('SELECT hash FROM receipts WHERE source=? AND source_id=?', (source,source_id)).fetchone()
        if receipt:
            if receipt['hash'] != checksum: raise ValueError('Archive receipt differs from replay')
            return source_id
    existing = db.execute('SELECT hash,source_id FROM records WHERE source=? AND stream=? AND stamp=? AND ordinal=?',
                          (source, stream, stamp, ordinal)).fetchone()
    if existing:
        if existing['hash'] != checksum or source_id is not None and existing['source_id'] != source_id:
            raise ValueError('Archive replay differs from persisted evidence')
        return existing['source_id']
    if source_id is None:
        source_id = checkpoint(db, 'sequence:' + source, 0) + 1
    if not isinstance(source_id, int) or source_id <= 0:
        raise ValueError('Invalid source sequence')
    db.execute('INSERT INTO records(source,source_id,stream,service,stamp,ordinal,message,hash) VALUES(?,?,?,?,?,?,?,?)',
               (source, source_id, stream, service, stamp, ordinal, clean, checksum))
    db.execute('INSERT INTO receipts VALUES(?,?,?)', (source,source_id,checksum))
    set_checkpoint(db, 'sequence:' + source, max(source_id, checkpoint(db, 'sequence:' + source, 0)))
    return source_id


def prune(db, before, local_source, uploaded):
    """Only administrator collector calls this; unsent local evidence cannot expire."""
    before=timestamp(before);identifier(local_source)
    if not isinstance(uploaded,int) or uploaded<0: raise ValueError('Invalid archive upload receipt')
    with db:
        count=db.execute('DELETE FROM records WHERE stamp<? AND (source<>? OR source_id<=?)',
                         (before,local_source,uploaded)).rowcount
    # Keep compact immutable hashes/sequence receipts, so a delayed retry cannot resurrect expired bytes.
    return count


def page(db, filters, limit=200, cursor=None):
    if not 1 <= limit <= 1000:
        raise ValueError('Page size must be 1..1000')
    scope = {'kind': 'logs', **filters}
    data = cursor_decode(cursor, scope) if cursor else {'after': 0, 'ceiling': db.execute('SELECT COALESCE(max(id),0) FROM records').fetchone()[0]}
    if filters.get('since') and not cursor: data['since_at'] = since_timestamp(filters['since'])
    if any(not isinstance(data.get(k), int) or data[k] < 0 for k in ('after', 'ceiling')):
        raise ValueError('Invalid log cursor')
    clauses, values = ['id>?', 'id<=?'], [data['after'], data['ceiling']]
    for key, value in filters.items():
        if key in ('source', 'service', 'stream'):
            identifier(value); clauses.append(key + '=?'); values.append(value)
        elif key in ('from', 'to'):
            clauses.append('stamp' + ('>=?' if key == 'from' else '<=?')); values.append(timestamp(value))
        elif key == 'tail' and isinstance(value, int) and 1 <= value <= 5000:
            pass
        elif key == 'since':
            clauses.append('stamp>=?'); values.append(timestamp(data['since_at']))
        else:
            raise ValueError('Unsupported log filter')
    if not cursor and filters.get('tail'):
        lower = db.execute('SELECT id FROM records WHERE ' + ' AND '.join(clauses) + ' ORDER BY id DESC LIMIT 1 OFFSET ?',
                           [*values, filters['tail'] - 1]).fetchone()
        if lower: data['after'] = lower[0] - 1; values[0] = data['after']
    rows = db.execute('SELECT * FROM records WHERE ' + ' AND '.join(clauses) + ' ORDER BY id LIMIT ?',
                      [*values, limit + 1])
    items, size, more = [], 0, False
    for row in rows:
        item = dict(row); row_size = len(canonical(item).encode())
        if len(items) >= limit or size + row_size > 4 * 1024 * 1024 and items:
            more = True
            break
        size += row_size
        items.append(item)
    rows.close()
    next_cursor = cursor_encode({**data, 'scope': digest(scope), 'after': items[-1]['id']}) if more and items else None
    return {'items': items, 'next_cursor': next_cursor, 'snapshot_max_id': data['ceiling'],
            'history': 'retained collected records; coverage is reported by sources'}


def export_batch(db, source, after, limit=500):
    rows = db.execute('SELECT source_id,stream,service,stamp,ordinal,message FROM records WHERE source=? AND source_id>? ORDER BY source_id LIMIT ?',
                      (identifier(source), after, limit))
    items, size = [], 0
    for row in rows:
        item = dict(row); size += len(canonical(item).encode())
        if size > 4 * 1024 * 1024 and items:
            break
        items.append(item)
    rows.close()
    status = db.execute('SELECT body FROM source_status WHERE source=?', (source,)).fetchone()
    return {'version': 3, 'after': after, 'records': items, 'status': json.loads(status[0]) if status else {}}


def ingest(db, source, batch):
    # Source identity comes from the authenticated Unix account, never the payload.
    if batch.get('version') != 3 or set(batch) != {'version', 'after', 'records', 'status'}:
        raise ValueError('Invalid archive batch')
    records = batch['records']
    if not isinstance(records, list) or len(records) > 500 or len(canonical(batch).encode()) > 6 * 1024 * 1024:
        raise ValueError('Invalid archive batch size')
    acknowledged = checkpoint(db, 'received:' + source, 0)
    after = batch['after']
    if not isinstance(after, int) or after < 0 or after > acknowledged:
        raise ValueError('Archive batch has a missing predecessor')
    with db:
        for item in records:
            if set(item) != {'source_id', 'stream', 'service', 'stamp', 'ordinal', 'message'} or item['source_id'] != after + 1:
                raise ValueError('Archive sequence is not contiguous')
            record(db, source, **item)
            after = item['source_id']
        acknowledged = max(acknowledged, after)
        set_checkpoint(db, 'received:' + source, acknowledged)
        import time
        status = {**scrub(batch['status']), 'received_sequence': acknowledged, 'received_at': time.time()}
        db.execute('INSERT INTO source_status VALUES(?,?) ON CONFLICT(source) DO UPDATE SET body=excluded.body',
                   (source, canonical(status)))
    return {'acknowledged': acknowledged, 'source': source}
