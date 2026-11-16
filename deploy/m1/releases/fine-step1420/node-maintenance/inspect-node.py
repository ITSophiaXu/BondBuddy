"""Read-only, bounded preimage for the single #1420 execution node.
No environment, credentials, command arguments, logs or business data are emitted.
"""
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request

TARGET = 'ins-p4i0pcub'
HEX = re.compile(r'^[a-f0-9]{64}$')
PUBLIC = re.compile(r'^/opt/bondbuddy/[A-Za-z0-9_./-]+$')
FILES = {}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(args):
    p = subprocess.run(args, capture_output=True, timeout=20)
    if p.returncode:
        raise RuntimeError('command_failed')
    return p.stdout


def file_record(path):
    p = pathlib.Path(path)
    try:
        stat = p.lstat()
        if p.is_symlink() or not p.is_file() or stat.st_size > 4 * 1024 * 1024:
            return {'path': str(p), 'regular_bounded': False}
        data = p.read_bytes()
        return {'path': str(p), 'sha256': digest(data), 'bytes': len(data),
                'mode': oct(stat.st_mode & 0o7777), 'uid': stat.st_uid, 'gid': stat.st_gid}
    except FileNotFoundError:
        return {'path': str(p), 'exists': False}


def read_json(path):
    record = file_record(path)
    FILES[path] = record
    if 'sha256' not in record:
        return {}
    return json.loads(pathlib.Path(path).read_bytes())


def safe_config(config):
    result = {}
    for key in ('enabled', 'runtime_uid', 'source_sha256', 'image_sha256',
                'compose_sha256', 'adapter_sha256', 'seccomp_sha256', 'apparmor_sha256'):
        value = config.get(key)
        if isinstance(value, (bool, int)) or (isinstance(value, str) and HEX.fullmatch(value)):
            result[key] = value
    for key in ('compose_file', 'adapter_path', 'seccomp_file', 'apparmor_file'):
        value = config.get(key)
        if isinstance(value, str) and PUBLIC.fullmatch(value) and '..' not in value.split('/'):
            result[key] = value
            FILES[value] = file_record(value)
    images = config.get('images', {})
    result['images'] = {k: v for k, v in images.items()
                        if k in ('authoring', 'review') and isinstance(v, str)
                        and re.fullmatch(r'sha256:[a-f0-9]{64}', v)}
    overlay = config.get('business_overlay')
    if isinstance(overlay, dict):
        result['business_overlay'] = {k: overlay[k] for k in ('version', 'sha256', 'bytes') if k in overlay}
    result['services'] = [{'service_id': s.get('service_id'), 'capabilities': s.get('capabilities')}
                          for s in config.get('services', [])
                          if s.get('service_id') in ('authoring', 'review')]
    return result


def main():
    request = urllib.request.Request('http://metadata.tencentyun.com/latest/meta-data/instance-id')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        instance = response.read(128).decode().strip()
    if instance != TARGET:
        raise RuntimeError('target_mismatch')
    configs = {name: read_json('/etc/bondbuddy/' + name + '.json')
               for name in ('elastic-node', 'elastic-bootstrap', 'elastic-public')}
    config_summary = {name: safe_config(value) for name, value in configs.items()}
    adapter = config_summary['elastic-bootstrap'].get('adapter_path')
    if adapter:
        parent = pathlib.Path(adapter).parent
        for name in ('business-overlay.mjs', 'bootstrap.mjs', 'bootstrap-entry.mjs',
                     'bootstrap-failure.mjs', 'policy.mjs', 'compose.yaml'):
            path = str(parent / name)
            FILES[path] = file_record(path)
    unit_names = ('bondbuddy-execution-bootstrap.service', 'bondbuddy-execution-pg.service',
                  'bondbuddy-execution-transport.service')
    units = {}
    for unit in unit_names:
        unit_path = '/etc/systemd/system/' + unit
        FILES[unit_path] = file_record(unit_path)
        units[unit] = command(['systemctl', 'show', unit, '--property=ActiveState,SubState,UnitFileState',
                               '--no-pager']).decode().splitlines()
    ids = command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=bondbuddy-execution']).decode().split()
    if len(ids) > 8 or any(not re.fullmatch(r'[a-f0-9]{12,64}', item) for item in ids):
        raise RuntimeError('container_scope')
    inspected = json.loads(command(['docker', 'inspect'] + ids)) if ids else []
    containers = []
    for item in inspected:
        labels = item['Config'].get('Labels', {})
        service = labels.get('com.docker.compose.service')
        if service not in ('authoring', 'review'):
            continue
        state, host = item['State'], item['HostConfig']
        record = {'service': service, 'id': item['Id'], 'image': item['Image'],
                  'running': state['Running'], 'status': state['Status'],
                  'started_at': state['StartedAt'], 'restart_count': item['RestartCount'],
                  'user': item['Config'].get('User'), 'restart_policy': host.get('RestartPolicy'),
                  'read_only_rootfs': host.get('ReadonlyRootfs'), 'privileged': host.get('Privileged'),
                  'memory': host.get('Memory'), 'nano_cpus': host.get('NanoCpus'),
                  'pids_limit': host.get('PidsLimit'), 'security_opt': host.get('SecurityOpt'),
                  'cap_drop': host.get('CapDrop'), 'network_mode': host.get('NetworkMode'),
                  'mounts': []}
        actual_paths = []
        for mount in item['Mounts']:
            entry = {k: mount.get(k) for k in ('Type', 'Destination', 'RW')}
            source = mount.get('Source', '')
            destination = mount.get('Destination', '')
            if PUBLIC.fullmatch(source) and '..' not in source.split('/'):
                entry['Source'] = source
                if pathlib.Path(source).is_file():
                    fr = file_record(source)
                    entry['host_sha256'] = fr.get('sha256')
                    entry['bytes'] = fr.get('bytes')
                    if re.fullmatch(r'/app/[A-Za-z0-9_./-]+', destination) and '..' not in destination.split('/'):
                        actual_paths.append(destination)
            record['mounts'].append(entry)
        if state['Running']:
            if actual_paths:
                raw = command(['docker', 'exec', item['Id'], 'sha256sum', '--'] + actual_paths).decode()
                actual = {}
                for line in raw.splitlines():
                    value, path = line.split('  ', 1)
                    if not HEX.fullmatch(value) or path not in actual_paths:
                        raise RuntimeError('file_hash_output')
                    actual[path] = value
                for entry in record['mounts']:
                    if entry['Destination'] in actual:
                        entry['container_sha256'] = actual[entry['Destination']]
            # Process names only; never output model prompts or command arguments.
            top = command(['docker', 'top', item['Id'], '-eo', 'comm']).decode().splitlines()[1:]
            counts = {}
            for name in top:
                name = name.strip()
                if re.fullmatch(r'[A-Za-z0-9_.-]{1,32}', name):
                    counts[name] = counts.get(name, 0) + 1
            record['process_names'] = counts
        containers.append(record)
    disk = {path: __import__('shutil').disk_usage(path).free for path in ('/opt/bondbuddy', '/var/lib/docker')}
    result = {'schema': 'timing1420-node-preimage-v1', 'read_only': True,
              'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'instance_id': instance, 'configs': config_summary, 'files': list(FILES.values()),
              'units': units, 'containers': containers, 'free_bytes': disk}
    text = json.dumps(result, sort_keys=True, separators=(',', ':'))
    if len(text.encode()) > 55000:
        raise RuntimeError('output_bound')
    raw = text.encode()
    import base64, gzip
    print(json.dumps({"schema": "timing1420-compressed-receipt-v1", "payload_sha256": digest(raw),
                      "json_bytes": len(raw), "gzip_base64": base64.b64encode(gzip.compress(raw, mtime=0)).decode()}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'schema': 'timing1420-node-preimage-v1', 'status': 'FAIL',
                          'read_only': True, 'error_type': type(error).__name__}))
        raise SystemExit(1)
