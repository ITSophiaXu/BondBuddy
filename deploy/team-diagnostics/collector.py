"""Administrator-only collector. Developers never receive this write capability."""
import datetime
import json
import os
import pathlib
import re
import shlex
import shutil
import socket
import subprocess
import time

import archive
from common import ENV, canonical, command, digest, identifier, scrub, trusted_file, SECRET_NAME, DiagnosticFailure, failure_details

DOCKER = ['/usr/bin/docker', '--config', '/etc/bondbuddy-diagnostics/docker']
NODE_CONFIG = pathlib.Path('/etc/bondbuddy/elastic-node.json')


def capture_host_resources(db):
    stat = pathlib.Path('/proc/stat').read_text()
    fields = stat.splitlines()[0].split()
    if fields[0] != 'cpu' or len(fields) < 9 or any(not value.isdigit() for value in fields[1:9]):
        raise ValueError('Invalid host CPU counters')
    values = [int(value) for value in fields[1:9]]
    current = {'total': sum(values), 'idle': values[3]+values[4], 'clock': time.monotonic(),
               'logical_cpus': len(re.findall(r'^cpu\d+\s', stat, re.M))}
    if not current['logical_cpus']: raise ValueError('Missing host CPU count')
    previous = archive.checkpoint(db, 'host-cpu-baseline')
    with db: archive.set_checkpoint(db, 'host-cpu-baseline', current)
    interval, percent = None, None
    if previous:
        interval = current['clock']-previous['clock']
        total, idle = current['total']-previous['total'], current['idle']-previous['idle']
        if interval <= 0 or total <= 0 or not 0 <= idle <= total or current['logical_cpus'] != previous['logical_cpus']:
            raise ValueError('Host CPU counter reset')
        percent = 100*(total-idle)/total
    memory = dict(re.findall(r'^(MemTotal|MemAvailable):\s+(\d+)\s+kB$', pathlib.Path('/proc/meminfo').read_text(), re.M))
    machine_bytes = pathlib.Path('/etc/machine-id').read_bytes()
    machine_id = machine_bytes.decode('ascii').strip()
    if not re.fullmatch(r'[a-f0-9]{32}', machine_id): raise ValueError('Host identity unavailable')
    return {'hostname': socket.gethostname(), 'execution_host_id': digest(machine_bytes),
            'sampled_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'status': 'sampled' if previous else 'baseline', 'interval_seconds': interval,
            'cpu_percent': percent, 'logical_cpus': current['logical_cpus'], 'scope': 'collector_host_proc_stat',
            'memory_total_bytes': int(memory['MemTotal'])*1024, 'memory_available_bytes': int(memory['MemAvailable'])*1024}


def attach_worker_metadata(db, config, item):
    rows = db.execute('SELECT message,stamp FROM records WHERE source=? AND stream=? ORDER BY id DESC LIMIT 20',
                      (config['node'], item['stream'])).fetchall()
    for row in rows:
        try: value = json.loads(row['message'])
        except (ValueError, TypeError): continue
        if not isinstance(value, dict) or value.get('kind') not in (
                'worker_started', 'job_claimed', 'job_stage_started', 'job_execution_finished', 'worker_resources', 'stopped'):
            continue
        if not isinstance(value.get('worker_id'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value['worker_id']):
            continue
        hostname = value.get('container_hostname')
        if not isinstance(hostname, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', hostname): continue
        host_id = value.get('execution_host_id')
        if host_id is not None and (not isinstance(host_id, str) or not re.fullmatch(r'[a-f0-9]{64}', host_id)): continue
        identity = {'worker_id': value['worker_id'], 'container_hostname': hostname, 'execution_host_id': host_id,
                    'observed_at': row['stamp']}
        server = value.get('server_id')
        if isinstance(server, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}', server):
            identity['configured_server_id'] = server
        if value.get('cloud_provider') in ('azure','tencent','local','other'): identity['cloud_provider'] = value['cloud_provider']
        item.setdefault('worker_identity', identity)
        if item['worker_identity']['worker_id'] != value['worker_id']: continue
        if value.get('kind') == 'worker_resources' and 'resources' not in item:
            fields = ('interval_seconds','cgroup_cpu_cores','cgroup_cpu_limit_cores','cgroup_memory_bytes',
                      'cgroup_memory_limit_bytes','cgroup_throttled_seconds','cgroup_oom_count')
            resources = {key: value.get(key) for key in fields}
            if (value.get('status') in ('baseline','sampled') and
                    type(resources['cgroup_memory_bytes']) is int and
                    all(v is None or type(v) in (int,float) and 0 <= v < float('inf') for v in resources.values()) and
                    (value['status'] == 'baseline' or resources['interval_seconds'] is not None and
                     resources['interval_seconds'] > 0 and resources['cgroup_cpu_cores'] is not None)):
                age = time.time()-datetime.datetime.fromisoformat(row['stamp'].replace('Z','+00:00')).timestamp()
                item['resources'] = {'sampled_at': row['stamp'], 'stale': age > 120, 'status': value['status'], **resources}
        if 'worker_identity' in item and 'resources' in item: break


def safe_node_config(raw):
    """Fixed RCA projection. Never return service environments, role bindings or credentials."""
    value = json.loads(raw)
    if not isinstance(value, dict): raise ValueError('Invalid node configuration')
    result = {'source_sha256': digest(raw)}
    for key in ('pool_tag', 'region', 'image_sha256', 'compose_sha256',
                'seccomp_sha256', 'apparmor_sha256', 'business_overlay_sha256'):
        item = value.get(key)
        if item is not None:
            if not isinstance(item, str) or len(item) > 128 or not re.fullmatch(r'[A-Za-z0-9_.:-]+', item):
                raise ValueError('Invalid projected node configuration')
            result[key] = item
    result['runtime_uid'] = value.get('runtime_uid') if type(value.get('runtime_uid')) is int else None
    services = value.get('services', [])
    if not isinstance(services, list) or len(services) > 8: raise ValueError('Invalid node services')
    result['services'] = []
    for service in services:
        if not isinstance(service, dict): raise ValueError('Invalid node service')
        name = identifier(service.get('service_id'))
        capabilities = service.get('capabilities', [])
        if not isinstance(capabilities, list) or len(capabilities) > 16: raise ValueError('Invalid node capabilities')
        result['services'].append({'service_id': name, 'capabilities': [identifier(v) for v in capabilities]})
    proxy = value.get('private_proxy', {})
    if not isinstance(proxy, dict): raise ValueError('Invalid node proxy')
    result['proxy_ports'] = {key: proxy[key] for key in ('local_port', 'remote_port')
                             if type(proxy.get(key)) is int and 1 <= proxy[key] <= 65535}
    slots = value.get('node_slots', [])
    result['slot_count'] = len(slots) if isinstance(slots, list) else None
    return result


def capture_node_config(db, config):
    if not config.get('node_config_snapshot', False): return None
    with trusted_file(NODE_CONFIG).open('rb') as source:
        raw = source.read(256*1024+1)
    if len(raw) > 256*1024: raise ValueError('Node configuration exceeds snapshot bound')
    summary = safe_node_config(raw)
    previous = archive.checkpoint(db, 'node-config-sha256')
    if previous != summary['source_sha256']:
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        with db:
            archive.record(db, config['node'], 'node-config', 'node-config', stamp, 1, canonical(summary))
            archive.set_checkpoint(db, 'node-config-sha256', summary['source_sha256'])
    return summary


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
                    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
                    '-o', 'ConnectTimeout=10', target, operation], timeout=30, input_bytes=payload)


def sync(db, config, send=ssh):
    after = archive.checkpoint(db, 'uploaded', 0)
    batch = archive.export_batch(db, config['node'], after)
    response = send(config, 'ingest', canonical(batch).encode())
    try: reply = json.loads(response)
    except (ValueError, UnicodeError): raise DiagnosticFailure('archive_ack', 'ACK_INVALID_JSON') from None
    end = batch['records'][-1]['source_id'] if batch['records'] else after
    if not isinstance(reply, dict) or reply.get('source') != config['node'] or type(reply.get('acknowledged')) is not int or reply['acknowledged'] != end:
        raise DiagnosticFailure('archive_ack', 'ACK_MISMATCH')
    with db: archive.set_checkpoint(db, 'uploaded', end)
    return end == archive.checkpoint(db, 'sequence:' + config['node'], 0)


def collect(config, require_synced=False):
    import fcntl
    directory = pathlib.Path(config['state_directory'])
    with open(directory / 'collector.lock', 'a') as lock:
        # The independent timer can already hold the collector lock at boot.
        # Readiness waits for that bounded service instead of failing in phase
        # with every timer run; its systemd TimeoutStartSec bounds this wait.
        fcntl.flock(lock, fcntl.LOCK_EX | (0 if require_synced else fcntl.LOCK_NB))
        db = archive.connect(directory / 'archive.sqlite3', write=True)
        status = {'checked_at': time.time(), 'node': config['node'], 'errors': [], 'containers': [], 'backlog': False}
        try:
            before=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=config.get('retention_days',180))).strftime('%Y-%m-%dT%H:%M:%SZ')
            uploaded=archive.checkpoint(db,'uploaded',0) if config.get('upload') else archive.checkpoint(db,'sequence:'+config['node'],0)
            archive.prune(db,before,config['node'],uploaded)
            status['retention_days']=config.get('retention_days',180)
            headroom=shutil.disk_usage(directory).free >= config.get('minimum_free_bytes',512*1024*1024)
            if not headroom: status['errors'].append({'source':'storage','code':'INSUFFICIENT_ARCHIVE_HEADROOM'})
            try: status['host_resources'] = capture_host_resources(db)
            except (OSError, ValueError, KeyError): status['errors'].append({'source':'host-resources','code':'HOST_RESOURCE_SAMPLE_FAILED'})
            try: status['containers'] = discover(config)
            except Exception: status['errors'].append({'source': 'inventory', 'code': 'INVENTORY_UNAVAILABLE'})
            for item in status['containers']:
                if not headroom: break
                try: status['backlog'] |= capture_container(db, config, item)
                except Exception: status['errors'].append({'source': item['stream'], 'code': 'CONTAINER_CAPTURE_FAILED'})
                attach_worker_metadata(db, config, item)
                if item['state'] == 'running':
                    try:
                        item['processes'] = command(DOCKER + ['top', item['stream'], '-eo', 'pid,ppid,etimes,stat,comm'], max_bytes=65536).decode().splitlines()
                    except Exception: status['errors'].append({'source': item['stream'], 'code': 'PROCESS_METADATA_UNAVAILABLE'})
            for unit in config.get('journal_units', []):
                if not headroom: break
                try: status['backlog'] |= capture_journal(db, config, unit)
                except Exception: status['errors'].append({'source': unit, 'code': 'JOURNAL_CAPTURE_FAILED'})
            if config.get('node_config_snapshot', False):
                try: status['node_config'] = capture_node_config(db, config)
                except Exception: status['errors'].append({'source': 'node-config', 'code': 'CONFIG_SNAPSHOT_FAILED'})
            with db:
                status['last_sequence'] = archive.checkpoint(db, 'sequence:' + config['node'], 0)
                db.execute('INSERT INTO source_status VALUES(?,?) ON CONFLICT(source) DO UPDATE SET body=excluded.body', (config['node'], canonical(status)))
            if config.get('upload'):
                caught_up = False
                for _ in range(20):
                    try: caught_up = sync(db, config)
                    except Exception as error:
                        status['upload_backlog'] = True
                        status['errors'].append({'source': 'upload', **failure_details(error)})
                        raise
                    if caught_up: break
                status['upload_backlog'] = not caught_up
                if not caught_up and require_synced: raise DiagnosticFailure('archive_upload', 'UPLOAD_BACKLOG')
            if require_synced and (status['errors'] or status['backlog']):
                raise DiagnosticFailure('archive_capture', 'CAPTURE_INCOMPLETE')
            return status
        finally:
            # Persist the upload outcome as well as capture status. The previous
            # implementation saved only the pre-upload status, hiding SSH failures.
            try:
                with db:
                    db.execute('INSERT INTO source_status VALUES(?,?) ON CONFLICT(source) DO UPDATE SET body=excluded.body', (config['node'], canonical(status)))
            finally: db.close()
