"""Read-only developer commands and a separate append-only machine ingestion command."""
import argparse
import base64
import json
import os
import pathlib
import re
import shutil
import time
import datetime

import archive
from collector import DOCKER, discover
from common import DiagnosticFailure, audit, canonical, command, digest, identifier, scrub, trusted_file
from database import Database, SPECS

HELP = '''BondBuddy read-only diagnostics v3
  capabilities / sources / services / status / collections
  logs [SERVICE] [--source NODE] [--from UTC] [--to UTC] [--limit 200] [--cursor CURSOR]
  db COLLECTION [--user ID] [--project ID] [--run ID] [--job ID] [--attempt ID]
                [--from UTC] [--to UTC] [--state STATE] [--limit 100] [--cursor CURSOR]
  db sessions [--time known|unknown] [--limit 100] [--cursor CURSOR]
  runs [STATE] [--cursor CURSOR] / run RUN_ID / attempt ATTEMPT_ID
  content prompt|result|exec ID --reason CODE [--offset 0] [--length 262144]
  content result ID --file operations.json --reason CODE [--offset 0] [--length 262144]
  exec-log ATTEMPT_ID --reason CODE [--offset 0] [--length 262144]
  processes [SERVICE]
All retained collected logs are pageable. sources reports stale/missing collectors.
Content pages contain base64 UTF-8 bytes after credential redaction; concatenate bytes.
No shell, arbitrary SQL, arbitrary file paths, service control or port forwarding.
'''


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('Invalid diagnostic arguments: ' + message)


def since(value):
    archive.since_timestamp(value)
    return value


def parse(args):
    if not args: return {'action': 'help'}
    if sum(len(s) for s in args) > 8192 or any(any(ord(c) < 32 for c in s) for s in args):
        raise ValueError('Invalid command encoding')
    action = args[0]
    if action in ('help', 'capabilities', 'sources', 'services', 'status', 'collections') and len(args) == 1:
        return {'action': action}
    if action == 'ingest' and len(args) == 1: return {'action': action}
    if action == 'run' or action == 'attempt':
        if len(args) != 2: raise ValueError('Expected exactly one identifier')
        return {'action': action, 'id': identifier(args[1])}
    if action == 'processes' and len(args) <= 2:
        return {'action': action, 'service': identifier(args[1]) if len(args) == 2 else None}
    parser = Parser(add_help=False, allow_abbrev=False)
    if action in ('content', 'exec-log'):
        if action == 'content': parser.add_argument('kind', choices=['prompt', 'result', 'exec'])
        parser.add_argument('id', type=identifier)
        parser.add_argument('--reason', required=True, type=identifier)
        parser.add_argument('--file', choices=['operations.json'])
        parser.add_argument('--offset', type=int, default=0)
        parser.add_argument('--length', type=int, default=262144)
        result = vars(parser.parse_args(args[1:]))
        if result.get('file') is not None and (action != 'content' or result.get('kind') != 'result'):
            raise ValueError('File selection is only allowed for content result')
        if result['offset'] < 0 or result['offset'] > 64*1024*1024 or not 1 <= result['length'] <= 1024*1024:
            raise ValueError('Invalid content page bounds')
        return {'action': 'content', 'kind': 'exec', **result}
    if action not in ('logs', 'db', 'runs'):
        raise ValueError('Unsupported diagnostic command')
    if action == 'logs':
        parser.add_argument('service', nargs='?', type=identifier)
        parser.add_argument('--source', type=identifier)
        parser.add_argument('--stream', type=identifier)
        parser.add_argument('--since', type=since)
        parser.add_argument('--until', dest='to', type=archive.timestamp)
        parser.add_argument('--tail', type=int)
    elif action == 'db':
        parser.add_argument('collection', choices=list(SPECS))
    else:
        parser.add_argument('state', nargs='?', type=identifier)
    if action != 'logs':
        for field in ('user', 'project', 'run', 'job', 'attempt', 'id'):
            parser.add_argument('--' + field, type=identifier)
        if action == 'db':
            parser.add_argument('--state', type=identifier)
            parser.add_argument('--time', choices=('known', 'unknown'))
    for field in ('from', 'to'):
        parser.add_argument('--' + field, type=archive.timestamp)
    parser.add_argument('--limit', type=int, default=200 if action == 'logs' else 100)
    parser.add_argument('--cursor')
    result = vars(parser.parse_args(args[1:]))
    if action == 'db' and result.get('time') and result['collection'] != 'sessions':
        raise ValueError('--time applies only to db sessions')
    if not 1 <= result['limit'] <= (1000 if action == 'logs' else 500): raise ValueError('Invalid page size')
    if result.get('tail') is not None and not 1 <= result['tail'] <= 5000: raise ValueError('Invalid tail size')
    if result.get('since') and result.get('from'): raise ValueError('Choose --since or --from')
    if result.get('from') and result.get('to') and result['from'] > result['to']: raise ValueError('Invalid time window')
    return {'action': 'db' if action == 'runs' else action, 'collection': 'runs', **result}


def sources(config, db):
    known = {row['source']: json.loads(row['body']) for row in db.execute('SELECT * FROM source_status')}
    expected = set(config.get('expected_sources', [])) | {config['node']}
    result = []
    for name in sorted(expected | known.keys()):
        status = known.get(name)
        result.append({'source': name, 'missing': status is None,
                       'stale': status is None or time.time()-float(status.get('checked_at', 0)) > 120,
                       'pending_records': max(0, int(status.get('last_sequence', 0))-int(status.get('received_sequence',status.get('last_sequence',0)))) if status else None,
                       'status': status})
    return {'items': result, 'coverage': 'Only registered collectors; missing/stale sources are not empty logs'}


def read_content(config, options, database):
    reference = database.content_ref(options['kind'], options['id'])
    selected = options.get('file')
    if selected is not None:
        if options['kind'] != 'result' or selected != 'operations.json':
            raise ValueError('File selection is only allowed for content result')
        reference = {**reference, 'file': selected}
    containers = [v for v in discover(config) if v['service'] == 'api' and v['state'] == 'running']
    if len(containers) != 1: raise RuntimeError('A unique active API container is required for private content reads')
    helper = trusted_file(pathlib.Path(__file__).parent / 'read-content.mjs').read_bytes()
    try:
        raw = command(DOCKER + ['exec', '-i', containers[0]['stream'], 'node', '--input-type=module', '-', canonical(reference)],
                      timeout=135 if options['kind'] == 'exec' else 45, input_bytes=helper, max_bytes=21*1024*1024)
    except DiagnosticFailure as error:
        # Only this trusted exec helper's fixed deadline exit can be classified;
        # preserve all other categories and never expose arbitrary stderr.
        if options['kind'] == 'exec' and error.details == {'stage': 'container_read', 'code': 'COMMAND_EXIT', 'exit_status': 3}:
            raise DiagnosticFailure('container_read', 'CONTENT_READ_TIMEOUT', 3) from None
        raise
    file_evidence = {}
    if selected is not None:
        try:
            payload = json.loads(raw.decode('utf-8'))
            if not isinstance(payload, dict) or payload.get('verified_parent_sha256') != reference['sha256'].strip() or not isinstance(payload.get('verified_child_sha256'), str) or not re.fullmatch('[a-f0-9]{64}', payload['verified_child_sha256']):
                raise ValueError('Invalid verified file envelope')
            child_size = payload.get('verified_child_byte_size')
            if type(child_size) is not int or not 1 <= child_size <= 1024*1024 or not isinstance(payload.get('redacted_content_base64'), str):
                raise ValueError('Invalid verified file envelope')
            content = base64.b64decode(payload['redacted_content_base64'], validate=True)
            if len(content) > 2*1024*1024:
                raise ValueError('Invalid verified file envelope')
            file_evidence = {'file': selected, 'verified_parent_sha256': payload['verified_parent_sha256'],
                             'verified_child_sha256': payload['verified_child_sha256'], 'verified_child_byte_size': child_size}
        except (ValueError, TypeError, UnicodeError) as error:
            raise ValueError('Invalid verified file envelope') from error
    else:
        content = raw
    clean = scrub(content.decode('utf-8')).encode()
    offset, length = options['offset'], options['length']
    if offset > len(clean): raise ValueError('Content offset exceeds redacted byte length')
    part = clean[offset:offset+length]
    return {'kind': options['kind'], 'id': options['id'], 'verified_source_sha256': file_evidence.get('verified_child_sha256', reference['sha256'].strip()),
            **file_evidence,
            'capture_truncated': reference.get('capture_truncated', False),
            'redacted_sha256': digest(clean), 'byte_length': len(clean), 'offset': offset,
            'next_offset': offset+len(part) if offset+len(part) < len(clean) else None,
            'encoding': 'base64', 'data': base64.b64encode(part).decode()}


def dispatch(config, actor, args, stdin=None):
    options = parse(args)
    role = config['actors'].get(actor)
    if role not in ('reader', 'ingest'): raise ValueError('Diagnostic access denied')
    action = options['action']
    if (action == 'ingest') != (role == 'ingest'): raise ValueError('Diagnostic role cannot perform this operation')
    # Audit is durable before any evidence bytes leave the machine; failure denies access.
    audit(config, actor, args)
    path = pathlib.Path(config['state_directory']) / 'archive.sqlite3'
    if action == 'ingest':
        body = stdin.read(6*1024*1024+1)
        if len(body) > 6*1024*1024: raise ValueError('Ingestion batch exceeds limit')
        # Remote uploads share the host disk with applications. Reserve headroom
        # before SQLite/WAL growth, just as local collection does.
        reserve = config.get('minimum_free_bytes',512*1024*1024)
        if shutil.disk_usage(config['state_directory']).free < reserve + 3*len(body) + 16*1024*1024:
            raise RuntimeError('Insufficient central archive headroom')
        db = archive.connect(path, write=True)
        try: return archive.ingest(db, config['ingest_sources'][actor], json.loads(body))
        finally: db.close()
    if action == 'help': return {'help': HELP}
    if action == 'capabilities':
        return {'version': 3, 'role': 'reader', 'commands': ['sources','services','status','logs','collections','db','runs','run','attempt','content','exec-log','processes'],
                'shell': False, 'writes': False, 'history': 'all retained evidence with pagination'}
    database = Database(config)
    if action == 'collections': return {'items': database.available()}
    if action == 'content': return read_content(config, options, database)
    if action == 'db':
        filters = {k:v for k,v in options.items() if k not in ('action','collection','limit','cursor') and v is not None}
        return database.page(options['collection'], filters, options['limit'], options['cursor'])
    if action in ('run','attempt'):
        key = 'run' if action == 'run' else 'attempt'
        collections = ('runs','jobs','attempts','runtime','usage','observations','errors','events','run-events','job-events','prompts','submissions','results','exec-logs','credits','reservations','performance-sessions','performance-spans') if action == 'run' else ('attempts','runtime','usage','observations','errors','results','exec-logs')
        available = {x['kind'] for x in database.available() if x['available']}
        pages = {}
        for kind in collections:
            if kind in available:
                pages[kind] = database.page(kind, {key: options['id']}, 50)
        return {'id': options['id'], 'sections': pages, 'continuation': 'Use db COLLECTION with the same filter and returned next_cursor'}
    db = archive.connect(path)
    try:
        if action == 'logs':
            filters = {k:v for k,v in options.items() if k not in ('action','collection','limit','cursor') and v is not None}
            return archive.page(db, filters, options['limit'], options['cursor'])
        result = sources(config, db)
        if action in ('sources', 'status'):
            if config.get('check_execution_registry', False):
                try:
                    registered = []; cursor = None
                    while True:
                        nodes = database.page('nodes', {}, 500, cursor)
                        registered.extend(nodes['items']); cursor = nodes['next_cursor']
                        if not cursor: break
                    known = {row['source']: row for row in result['items']}
                    result['execution_nodes'] = [{'instance_id': row['body'].get('instance_id'), 'state': row['body'].get('state'),
                        'collector': known.get(row['body'].get('instance_id'))} for row in registered]
                    result['uncovered_execution_nodes'] = [row['instance_id'] for row in result['execution_nodes']
                        if row['state'] in ('starting','ready','draining') and (not row['collector'] or row['collector']['stale'])]
                except Exception: result['execution_registry_error'] = 'REGISTRY_UNAVAILABLE'
            return result
        items = []
        for node in result['items']:
            for container in (node['status'] or {}).get('containers', []):
                if options.get('service') and container['service'] != options['service']: continue
                items.append({'source': node['source'], 'stale': node['stale'], **container})
        return {'items': items, 'coverage': result['items']}
    finally: db.close()
