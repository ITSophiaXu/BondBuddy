"""Bounded, read-only preimage for diagnostics on the single authorized node."""
import base64
import datetime
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import urllib.request

TARGET = 'ins-p4i0pcub'
HEX = re.compile(r'[a-f0-9]{64}\Z')
SAFE_NAME = re.compile(r'[A-Za-z0-9_.-]{1,128}\Z')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def run(args):
    reply = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=15, env=ENV)
    if reply.returncode:
        return {'available': False, 'exit_code': reply.returncode}
    if len(reply.stdout) > 16000:
        raise RuntimeError('output_bound')
    return {'available': True, 'text': reply.stdout.decode(errors='replace')}


def file_record(filename):
    path = pathlib.Path(filename)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {'exists': False}
    if path.is_symlink() or not path.is_file() or info.st_size > 4 * 1024 * 1024:
        raise RuntimeError('unexpected_file')
    return {'exists': True, 'sha256': digest(path.read_bytes()), 'bytes': info.st_size,
            'mode': oct(info.st_mode & 0o7777), 'uid': info.st_uid, 'gid': info.st_gid}


def main():
    if os.geteuid() != 0:
        raise RuntimeError('root_required')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://metadata.tencentyun.com/latest/meta-data/instance-id', timeout=5) as reply:
        instance = reply.read(128).decode().strip()
    if instance != TARGET:
        raise RuntimeError('target_mismatch')
    result = {'schema': 'bb-diagnostics-node-preimage-v1', 'read_only': True,
              'instance_id': instance, 'host': socket.gethostname(),
              'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'free_bytes_var_lib': shutil.disk_usage('/var/lib').free}
    result['containers'] = run(['/usr/bin/docker', 'ps', '-a', '--no-trunc', '--filter',
        'label=com.docker.compose.project=bondbuddy-execution', '--format',
        '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.State}}'])
    units = ('bondbuddy-execution-bootstrap.service', 'bondbuddy-execution-pg.service',
             'bondbuddy-execution-transport.service', 'bondbuddy-execution-transport-renewal.service',
             'bondbuddy-diagnostics-ready.service', 'bondbuddy-diagnostics-collect.timer')
    result['units'] = {unit: run(['/usr/bin/systemctl', 'show', unit, '-p', 'LoadState',
        '-p', 'ActiveState', '-p', 'SubState', '-p', 'FragmentPath', '-p', 'DropInPaths']) for unit in units}
    result['files'] = {}
    result['config_identity'] = {}
    for filename in ('/etc/bondbuddy/elastic-node.json', '/etc/bondbuddy/elastic-bootstrap.json',
                     '/etc/bondbuddy/elastic-public.json', '/etc/bondbuddy-diagnostics/config.json'):
        record = file_record(filename)
        result['files'][filename] = record
        if not record['exists']:
            continue
        data = json.loads(pathlib.Path(filename).read_bytes())
        safe = {k: v for k, v in data.items() if k in
                ('source_sha256', 'image_sha256', 'compose_sha256', 'adapter_sha256')
                and isinstance(v, str) and HEX.fullmatch(v)}
        for key in ('version', 'node'):
            value = data.get(key)
            if isinstance(value, int) or isinstance(value, str) and SAFE_NAME.fullmatch(value):
                safe[key] = value
        for key in ('compose_projects', 'journal_units'):
            if key in data:
                safe[key] = [v for v in data[key] if isinstance(v, str) and SAFE_NAME.fullmatch(v)]
        overlay = data.get('business_overlay', {})
        if isinstance(overlay, dict) and isinstance(overlay.get('sha256'), str) and HEX.fullmatch(overlay['sha256']):
            safe['business_overlay_sha256'] = overlay['sha256']
        result['config_identity'][filename] = safe
        adapter = data.get('adapter_path')
        if isinstance(adapter, str) and re.fullmatch(r'/opt/bondbuddy/[A-Za-z0-9_./-]+', adapter) and '..' not in adapter.split('/'):
            parent = pathlib.Path(adapter).parent
            for name in ('business-overlay.mjs', 'bootstrap.mjs', 'bootstrap-entry.mjs', 'compose.yaml'):
                path = str(parent / name)
                result['files'][path] = file_record(path)
    for filename in ('/usr/local/sbin/bb-diagnostics', '/usr/local/bin/bb-diagnostics-console',
                     '/etc/systemd/system/bondbuddy-diagnostics-ready.service',
                     '/etc/systemd/system/bondbuddy-execution-bootstrap.service.d/diagnostics.conf'):
        result['files'][filename] = file_record(filename)
    raw = json.dumps(result, sort_keys=True, separators=(',', ':')).encode()
    if len(raw) > 55000:
        raise RuntimeError('receipt_bound')
    envelope = {'schema': 'bb-diagnostics-compressed-receipt-v1', 'payload_sha256': digest(raw),
                'json_bytes': len(raw), 'gzip_base64': base64.b64encode(gzip.compress(raw, mtime=0)).decode()}
    print(json.dumps(envelope, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'schema': 'bb-diagnostics-node-preimage-v1', 'status': 'FAIL',
                          'read_only': True, 'error_type': type(error).__name__}))
        raise SystemExit(1)
