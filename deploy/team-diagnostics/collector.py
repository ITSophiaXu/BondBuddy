"""Administrator-only collector. Developers never receive this write capability."""
import datetime
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import time

import archive
from common import ENV, canonical, command, digest, identifier, scrub, trusted_file, SECRET_NAME

DOCKER = ['/usr/bin/docker', '--config', '/etc/bondbuddy-diagnostics/docker']


def discover(config, run=command):
    # Query labels without exposing Docker inspect's environment, mounts or commands.
    fields = '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}'
    output = run(DOCKER + ['ps', '-a', '--no-trunc', '--format', fields]).decode()
    items = []
    for line in output.splitlines():
        parts = line.split('\t')
        if len(parts) != 5:
            raise ValueError('Malformed container inventory')
        container, name, project, service, state = parts
        if project not in config.get('compose_projects', []) and name not in config.get('explicit_containers', []):
            continue
        if not re.fullmatch(r'[a-f0-9]{64}', container):
            raise ValueError('Invalid Docker container identity')
        service = service or name
        items.append({'stream': container, 'name': identifier(name), 'project': project,
                      'service': identifier(service), 'state': state})
    return items


def container_secrets(container, run=command):
    values = json.loads(run(DOCKER + ['inspect', '--format', '{{json .Config.Env}}', container])) or []
    secrets = [value.split('=', 1)[1] for value in values if '=' in value and SECRET_NAME.search(value.split('=', 1)[0])]
    return [part for value in secrets for part in [value, *value.splitlines()] if len(part) >= 8]


def consume_lines(db, config, item, lines, secrets=(), max_bytes=8*1024*1024):
    key = 'docker:' + item['stream']
    saved = archive.checkpoint(db, key, {'stamp': '1970-01-01T00:00:00.000000000Z', 'count': 0})
    latest, counts, size, partial = dict(saved), {}, 0, False
    private_key = archive.checkpoint(db, key + ':private-key', False)
    # Timestamp + occurrence preserves distinct identical lines at the same nanosecond.
    with db:
        for raw in lines:
            if len(raw) > 1024*1024 or not raw.endswith(b'\n'):
                raise ValueError('Incomplete or oversized container log record')
            text = raw.decode('utf-8', errors='replace').rstrip('\n')
            stamp, separator, message = text.partition(' ')
            stamp = archive.timestamp(stamp)
            if not separator:
                raise ValueError('Container log timestamp missing')
            if stamp < saved['stamp']:
                continue
            counts[stamp] = counts.get(stamp, 0) + 1
            ordinal = counts[stamp]
            if stamp == saved['stamp'] and ordinal <= saved['count']:
                continue
            size += len(raw)
            if re.search(r'-----BEGIN .*PRIVATE KEY-----', message): private_key = True
            clean = '[private key redacted]' if private_key else scrub(message, secrets)
            if re.search(r'-----END .*PRIVATE KEY-----', message): private_key = False
            archive.record(db, config['node'], item['stream'], item['service'], stamp, ordinal, clean)
            if stamp >= latest['stamp']:
                latest = {'stamp': stamp, 'count': ordinal}
            if size >= max_bytes:
                partial = True
                break
        archive.set_checkpoint(db, key, latest)
        archive.set_checkpoint(db, key + ':private-key', private_key)
    return partial


def capture_container(db, config, item):
    saved = archive.checkpoint(db, 'docker:' + item['stream'], {'stamp': '1970-01-01T00:00:00.000000000Z', 'count': 0})
    secrets = container_secrets(item['stream'])
    # File-backed bounded reader avoids loading entire historical Docker logs in RAM.
    import selectors
    proc = subprocess.Popen(DOCKER + ['logs', '--timestamps', '--since', saved['stamp'], item['stream']],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=ENV)
    selector = selectors.DefaultSelector(); selector.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 30

    def lines():
        pending = b''
        while time.monotonic() < deadline:
            if not selector.select(timeout=1):
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                if proc.wait(timeout=3):
                    raise RuntimeError('Container log read did not finish cleanly')
                if pending:
                    yield pending + b'\n'
                return
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                yield line + b'\n'
            if len(pending) > 1024*1024:
                raise RuntimeError('Container log line exceeds capture limit')
        raise RuntimeError('Container log read timed out')

    try:
        return consume_lines(db, config, item, lines(), secrets)
    finally:
        selector.close()
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        proc.stdout.close()


def capture_journal(db, config, unit, run=command):
    identifier(unit)
    saved = archive.checkpoint(db, 'journal:' + unit)
    args = ['/usr/bin/journalctl', '--unit', unit, '--output=json', '--no-pager', '--all', '--lines=1000', '--reverse']
    # journalctl --lines truncates newest; use forward after-cursor or initial oldest head via bounded output.
    args = ['/usr/bin/journalctl', '--unit', unit, '--output=json', '--no-pager', '--all']
    if saved:
        args += ['--after-cursor', saved]
    # stdout is streamed through a bounded head process; journal cursor advances only for committed rows.
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, env=ENV)
    import selectors
    selector = selectors.DefaultSelector(); selector.register(proc.stdout, selectors.EVENT_READ)
    pending = b''; deadline = time.monotonic() + 15; count = 0; last = saved; complete = False
    try:
        with db:
            while time.monotonic() < deadline and count < 1000:
                if not selector.select(timeout=1):
                    continue
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    if pending or proc.wait(timeout=2): raise RuntimeError('Journal source unavailable')
                    complete = True; break
                pending += chunk
                while b'\n' in pending and count < 1000:
                    raw, pending = pending.split(b'\n', 1)
                    value = json.loads(raw)
                    if not isinstance(value.get('__CURSOR'), str) or len(value['__CURSOR']) > 1024:
                        raise ValueError('Invalid journal cursor')
                    micros = int(value['__REALTIME_TIMESTAMP'])
                    stamp = datetime.datetime.fromtimestamp(micros/1000000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                    # The immutable journal cursor gives each entry a distinct stream.
                    stream = 'journal-' + digest(value['__CURSOR'])
                    archive.record(db, config['node'], stream, unit, stamp, 1, str(value.get('MESSAGE', '')))
                    last = value['__CURSOR']; count += 1
                if len(pending) > 1024*1024: raise ValueError('Oversized journal record')
            if last:
                archive.set_checkpoint(db, 'journal:' + unit, last)
        return not complete
    finally:
        selector.close()
        if proc.poll() is None: proc.terminate()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
        proc.stdout.close(); proc.stderr.close()


def ssh(config, operation, payload=None):
    upload = config['upload']
    target = identifier(upload['target'])
    ssh_config = str(trusted_file(upload['ssh_config']))
    # Dedicated machine key and pinned known-hosts live in administrator-owned SSH config.
    return command(['/usr/bin/ssh', '-F', ssh_config, '-T', '-o', 'BatchMode=yes',
                    '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes',
                    '-o', 'ConnectTimeout=10', target, operation], timeout=30, input_bytes=payload)


def sync(db, config, send=ssh):
    after = archive.checkpoint(db, 'uploaded', 0)
    batch = archive.export_batch(db, config['node'], after)
    reply = json.loads(send(config, 'ingest', canonical(batch).encode()))
    end = batch['records'][-1]['source_id'] if batch['records'] else after
    if reply.get('source') != config['node'] or reply.get('acknowledged') != end:
        raise ValueError('Central archive acknowledgement differs from batch')
    with db: archive.set_checkpoint(db, 'uploaded', end)
    return end == archive.checkpoint(db, 'sequence:' + config['node'], 0)


def collect(config, require_synced=False):
    import fcntl
    directory = pathlib.Path(config['state_directory'])
    with open(directory / 'collector.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = archive.connect(directory / 'archive.sqlite3', write=True)
        status = {'checked_at': time.time(), 'node': config['node'], 'errors': [], 'containers': [], 'backlog': False}
        try:
            before=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=config.get('retention_days',180))).strftime('%Y-%m-%dT%H:%M:%SZ')
            uploaded=archive.checkpoint(db,'uploaded',0) if config.get('upload') else archive.checkpoint(db,'sequence:'+config['node'],0)
            archive.prune(db,before,config['node'],uploaded)
            status['retention_days']=config.get('retention_days',180)
            headroom=shutil.disk_usage(directory).free >= config.get('minimum_free_bytes',512*1024*1024)
            if not headroom: status['errors'].append({'source':'storage','code':'INSUFFICIENT_ARCHIVE_HEADROOM'})
            try: status['containers'] = discover(config)
            except Exception: status['errors'].append({'source': 'inventory', 'code': 'INVENTORY_UNAVAILABLE'})
            for item in status['containers']:
                if not headroom: break
                try: status['backlog'] |= capture_container(db, config, item)
                except Exception: status['errors'].append({'source': item['stream'], 'code': 'CONTAINER_CAPTURE_FAILED'})
                if item['state'] == 'running':
                    try:
                        item['processes'] = command(DOCKER + ['top', item['stream'], '-eo', 'pid,ppid,etimes,stat,comm'], max_bytes=65536).decode().splitlines()
                    except Exception: status['errors'].append({'source': item['stream'], 'code': 'PROCESS_METADATA_UNAVAILABLE'})
            for unit in config.get('journal_units', []):
                if not headroom: break
                try: status['backlog'] |= capture_journal(db, config, unit)
                except Exception: status['errors'].append({'source': unit, 'code': 'JOURNAL_CAPTURE_FAILED'})
            with db:
                status['last_sequence'] = archive.checkpoint(db, 'sequence:' + config['node'], 0)
                db.execute('INSERT INTO source_status VALUES(?,?) ON CONFLICT(source) DO UPDATE SET body=excluded.body', (config['node'], canonical(status)))
            if config.get('upload'):
                caught_up = False
                for _ in range(20):
                    caught_up = sync(db, config)
                    if caught_up: break
                status['upload_backlog'] = not caught_up
                if not caught_up and require_synced: raise RuntimeError('Central archive still has an upload backlog')
            if require_synced and (status['errors'] or status['backlog']):
                raise RuntimeError('Log capture is not complete')
            return status
        finally:
            db.close()
