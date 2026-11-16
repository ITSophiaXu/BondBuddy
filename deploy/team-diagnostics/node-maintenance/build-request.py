"""Build/verify the exact public request without cloud access or dispatch."""
import argparse
import base64
import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SOURCE_COMMIT = 'ac818a21241e9427f5bd8755d8aa5f4e0da1f304'


def build(check=False):
    source = (HERE / 'inspect-node.py').read_bytes()
    if b'\r' in source:
        raise ValueError('Expected fixed LF source bytes')
    compile(source, 'inspect-node.py', 'exec')
    script = b"#!/bin/sh\nset -eu\npython3 - <<'BB_DIAGNOSTICS_PREFLIGHT'\n" + source + b'\nBB_DIAGNOSTICS_PREFLIGHT\n'
    request = {'CommandName': 'bb-diagnostics-preflight-1460-v2', 'CommandType': 'SHELL',
               'Content': base64.b64encode(script).decode(), 'InstanceIds': ['ins-p4i0pcub'],
               'Timeout': 150, 'Username': 'root', 'SaveCommand': False}
    raw = (json.dumps(request, sort_keys=True, indent=2) + '\n').encode()
    manifest = {'schema': 'bb-diagnostics-maintenance-request-v1', 'target_account': '100006372392',
        'region': 'ap-beijing', 'instance_id': 'ins-p4i0pcub', 'request_file': 'inspect-request.json',
        'request_bytes': len(raw), 'request_sha256': hashlib.sha256(raw).hexdigest(),
        'script_bytes': len(script), 'script_sha256': hashlib.sha256(script).hexdigest(),
        'source_sha256': hashlib.sha256(source).hexdigest(), 'diagnostic_component_commit': SOURCE_COMMIT,
        'scope': 'Read-only preimage; no install, key generation, restart, cloud lifecycle, IAM or scheduler changes',
        'dispatch_status': 'Prepared only; not dispatched',
        'window': 'Reuse the existing authorized unified node-maintenance window; do not start a stopped node for this inspection'}
    assert len(script) < 16 * 1024
    assert base64.b64decode(request['Content'], validate=True) == script
    content = {'inspect-request.json': raw,
               'inspect-manifest.json': (json.dumps(manifest, indent=2) + '\n').encode()}
    for name, value in content.items():
        if check:
            assert (HERE / name).read_bytes() == value, name + ' differs from reviewed source'
        else:
            (HERE / name).write_bytes(value)
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    build(parser.parse_args().check)
