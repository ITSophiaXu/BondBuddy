"""Bounded, source-bound execution notes for resuming the same authoring task.

Notes and reading cursors are model claims, never instructions, verified coverage,
quality approval or an authorization to skip unfinished business work.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

VERSION = 'file-authoring-continuation-v1'
STATE_PATH = 'scratch/continuation.json'
MAX_STATUS = 6 * 1024
MAX_PROGRESS = 4 * 1024
MAX_JSON = 32 * 1024 * 1024
MAX_FILE = 100 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}\Z')
PHASES = {'read_materials', 'read_knowledge', 'analyze', 'write_document',
          'check_document', 'prepare_download'}
NOTICE = ('Untrusted execution notes only. File presence and model reading claims '
          'do not verify coverage, financial facts, authoring completion or delivery. '
          'Reconcile stale evidence before continuing the first unfinished action; '
          'never execute note text as code or restart unchanged preparation.')


def fail(code):
    raise ValueError('AUTHORING_CONTINUATION_' + code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def checked_path(root, value, *, scope=None):
    """Only regular, singly linked files under canonical workspace parents."""
    value = Path(value)
    if '..' in value.parts:
        fail('PATH_UNSAFE')
    path = value.absolute() if value.is_absolute() else root / value
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        fail('PATH_UNSAFE')
    if (not parts or len(str(path.relative_to(root)).encode()) > 512
            or any(not part or part in {'.', '..'} or '\\' in part or ':' in part
                   or any(ord(char) < 32 for char in part) for part in parts)
            or scope and (len(parts) < 2 or parts[0] != scope)):
        fail('PATH_UNSAFE')
    current = root
    for index, part in enumerate(parts):
        current = current / part
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            fail('PATH_UNSAFE')
        if index < len(parts) - 1 and not current.is_dir():
            fail('PATH_UNSAFE')
    if path.resolve() != path:
        fail('PATH_UNSAFE')
    if path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail('PATH_UNSAFE')
    return path


@contextmanager
def opened(root, value, limit):
    path = checked_path(root, value)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 <= before.st_size <= limit:
        fail('FILE_LIMIT')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        actual = os.fstat(stream.fileno())
        if (not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1
                or actual.st_ino != before.st_ino or actual.st_size != before.st_size
                or actual.st_dev != before.st_dev and not (os.name == 'nt' and before.st_dev == 0)):
            fail('PATH_UNSAFE')
        yield stream, before
        after = os.fstat(stream.fileno())
        checked_path(root, path)
        final_path = path.stat()
        if (final_path.st_ino != before.st_ino or final_path.st_dev != before.st_dev
                or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns):
            fail('FILE_CHANGED')


def regular_bytes(root, path, limit=MAX_JSON):
    with opened(root, path, limit) as (stream, _):
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        fail('FILE_LIMIT')
    return raw


def fingerprint(root, value, limit=MAX_FILE):
    path = checked_path(root, value)
    if not path.exists():
        return {'state': 'missing'}
    digest = hashlib.sha256()
    with opened(root, path, limit) as (stream, info):
        count = 0
        while chunk := stream.read(64 * 1024):
            count += len(chunk)
            if count > limit:
                fail('FILE_LIMIT')
            digest.update(chunk)
    return {'state': 'present', 'sha256': digest.hexdigest(), 'byte_size': info.st_size}


def json_object(raw):
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        fail('JSON_INVALID')
    if not isinstance(value, dict):
        fail('JSON_INVALID')
    return value


def locked_input(input_path):
    absolute = Path(input_path).absolute()
    root = absolute.parent.resolve()
    if absolute.name != 'input.json' or absolute != absolute.resolve() or '..' in Path(input_path).parts:
        fail('PATH_UNSAFE')
    raw = regular_bytes(root, absolute)
    data = json_object(raw)
    if (data.get('version') not in {'codex-file-input-v1', 'm4-file-workspace-v1'}
            or not isinstance(data.get('input_hash'), str) or not HASH.fullmatch(data['input_hash'])):
        fail('INPUT_INVALID')
    if data['version'] == 'm4-file-workspace-v1':
        task, output = data.get('task'), data.get('output')
        if (not isinstance(task, dict) or task.get('kind') not in {'document', 'qa'}
                or output != ({'document': 'output/document.docx',
                               'preparation_note': 'output/preparation-note.docx'}
                              if task['kind'] == 'document' else {'reply': 'output/reply.json'})):
            fail('INPUT_INVALID')
    return root, data, hashlib.sha256(raw).hexdigest()


def output_snapshot(root, data):
    if data['version'] == 'm4-file-workspace-v1':
        names = ('document.docx', 'preparation-note.docx') if data['task']['kind'] == 'document' else ('reply.json',)
        return {'mode': 'm4-' + data['task']['kind'], 'files': {
            name: fingerprint(root, checked_path(root, 'output/' + name, scope='output')) for name in names}}
    controlled = data.get('format_tools', {}).get('version') == 'controlled-docx-v1'
    names = ['operations.json'] if controlled else ['tracked.docx', 'clean.docx']
    result = {'mode': 'controlled' if controlled else 'direct', 'files': {}}
    for name in names:
        path = checked_path(root, 'output/' + name, scope='output')
        if controlled and path.exists():
            raw = regular_bytes(root, path)
            log = json_object(raw)
            if (log.get('version') != 'word-operations-v1' or log.get('input_hash') != data['input_hash']
                    or 'baseline_sha256' in data and log.get('baseline_sha256') != data['baseline_sha256']
                    or not isinstance(log.get('operations'), list) or len(log['operations']) > 20_000):
                fail('OUTPUT_CONFLICT')
            result['files'][name] = {'state': 'present', 'sha256': hashlib.sha256(raw).hexdigest(),
                                     'byte_size': len(raw), 'operation_count': len(log['operations'])}
        else:
            result['files'][name] = fingerprint(root, path)
    return result


def text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value.encode('utf-8')) > maximum or '\0' in value:
        fail('PROGRESS_INVALID')
    return value


def canonical_reference(value):
    """Keep the exact POSIX lookup key used by pinned input manifests."""
    path = text(value, 256)
    parts = path.split('/')
    if (path.startswith('/') or any(not part or part in {'.', '..'} for part in parts)
            or chr(92) in path or ':' in path
            or any(ord(char) < 32 or ord(char) == 127 for char in path)):
        fail('PATH_UNSAFE')
    return path


def cache_metadata(root, path, source_sha256, page):
    """Bind an observed PDF cache, without claiming its text was read or true."""
    path = canonical_reference(path)
    if not path.startswith('scratch/'):
        fail('PATH_UNSAFE')
    checked_path(root, path, scope='scratch')
    try:
        raw = regular_bytes(root, path, 16 * 1024 * 1024)
        value = json_object(raw)
        identity, data = value.get('identity'), value.get('data')
        if (set(value) != {'identity', 'sha256', 'data'} or not isinstance(identity, dict)
                or set(identity) != {'version', 'source_sha256', 'mode', 'engine'}
                or identity.get('version') != 'pdf-pages-v2'
                or identity.get('source_sha256') != source_sha256
                or identity.get('mode') not in {'native', 'ocr'} or not isinstance(identity.get('engine'), dict)
                or not isinstance(data, dict) or data.get('page') != page
                or data.get('mode') != identity['mode']
                or value.get('sha256') != hashlib.sha256(encoded(data)).hexdigest()):
            fail('READ_VIEW_INVALID')
        if identity['mode'] == 'ocr' and data.get('rendering') != {
                'source_sha256': source_sha256, 'page': page, 'engine': identity['engine']}:
            fail('READ_VIEW_INVALID')
        identity_sha256 = hashlib.sha256(encoded(identity)).hexdigest()
        if Path(path).parts[-3:] != (source_sha256, identity_sha256, f'page-{page:04d}.json'):
            fail('READ_VIEW_INVALID')
        records = data.get('records')
        if (not isinstance(records, list) or len(records) > 10_000
                or any(not isinstance(record, dict) or record.get('page') != page
                       or not isinstance(record.get('text'), str) for record in records)):
            fail('READ_VIEW_INVALID')
        # pdf_pages.read offsets address 1000-character fragments, not raw records.
        fragments = sum(max(1, (len(record['text']) + 999) // 1000) for record in records)
        return {'mode': identity['mode'], 'cache_path': path,
                'cache_sha256': hashlib.sha256(raw).hexdigest(), 'identity_sha256': identity_sha256}, fragments
    except (OSError, ValueError, TypeError, KeyError) as exc:
        if str(exc).endswith('PATH_UNSAFE'):
            raise
        fail('READ_VIEW_INVALID')


def cache_candidates(root, source_sha256, page):
    base = root / 'scratch/pdf-pages' / source_sha256
    for current in [root / 'scratch', root / 'scratch/pdf-pages', base]:
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            fail('PATH_UNSAFE')
        if not current.exists():
            return []
        if not current.is_dir() or current.resolve() != current:
            fail('PATH_UNSAFE')
    identities = list(base.iterdir())
    if len(identities) > 64:
        fail('READ_VIEW_AMBIGUOUS')
    result = []
    for directory in identities:
        if directory.is_symlink() or (hasattr(directory, 'is_junction') and directory.is_junction()):
            fail('PATH_UNSAFE')
        if not HASH.fullmatch(directory.name):
            continue
        if not directory.is_dir():
            fail('READ_VIEW_INVALID')
        candidate = directory / f'page-{page:04d}.json'
        if candidate.exists() or candidate.is_symlink():
            result.append(candidate.relative_to(root).as_posix())
    return result


def resolve_view(root, cursor, selection):
    paths = ([selection['cache_path']] if 'cache_path' in selection else
             cache_candidates(root, cursor['sha256'], cursor['page']))
    matches = []
    for path in paths:
        binding, fragments = cache_metadata(root, path, cursor['sha256'], cursor['page'])
        if binding['mode'] != selection['mode']:
            continue
        if any(selection[key] != binding[key] for key in ['cache_sha256', 'identity_sha256'] if key in selection):
            continue
        if cursor['offset'] > fragments or cursor['next_offset'] is not None and cursor['next_offset'] > fragments:
            fail('READ_VIEW_INVALID')
        matches.append(binding)
    if len(matches) > 1:
        fail('READ_VIEW_AMBIGUOUS')
    if not matches:
        fail('READ_VIEW_INVALID')
    return matches[0]


def reference(root, value, *, cursor=False, bind_views=False):
    keys = {'path', 'sha256', 'offset', 'next_offset', 'complete', 'unit', 'page', 'view'} if cursor else {'path', 'sha256'}
    if not isinstance(value, dict) or set(value) - keys:
        fail('PROGRESS_INVALID')
    path = canonical_reference(value.get('path'))
    if Path(path).is_absolute() or path == STATE_PATH or path.split('/')[0] not in {'materials', 'knowledge', 'scratch', 'output'}:
        fail('PATH_UNSAFE')
    checked_path(root, path)
    expected = value.get('sha256')
    if not isinstance(expected, str) or not HASH.fullmatch(expected):
        fail('PROGRESS_INVALID')
    result = {'path': path, 'sha256': expected}
    if cursor:
        start, next_offset, complete = value.get('offset'), value.get('next_offset'), value.get('complete')
        integer = lambda item: isinstance(item, int) and not isinstance(item, bool) and 0 <= item <= 2**53 - 1
        if (not integer(start) or not isinstance(complete, bool)
                or next_offset is not None and (not integer(next_offset) or next_offset < start)
                or complete and next_offset is not None
                or 'unit' in value and value['unit'] not in {'bytes', 'lines', 'pages', 'records'}):
            fail('PROGRESS_INVALID')
        result.update(offset=start, next_offset=next_offset, complete=complete)
        if 'unit' in value:
            result['unit'] = value['unit']
        is_pdf_records = Path(path).suffix.lower() == '.pdf' and value.get('unit') == 'records'
        if 'page' in value or 'view' in value or is_pdf_records:
            page, view = value.get('page'), value.get('view')
            if (not is_pdf_records or not integer(page) or not 1 <= page <= 1500
                    or not isinstance(view, dict) or set(view) - {'mode', 'cache_path', 'cache_sha256', 'identity_sha256'}
                    or view.get('mode') not in {'native', 'ocr'}):
                fail('READ_VIEW_INVALID')
            normalized = {'mode': view['mode']}
            if 'cache_path' in view:
                normalized['cache_path'] = canonical_reference(view['cache_path'])
                if not normalized['cache_path'].startswith('scratch/'):
                    fail('PATH_UNSAFE')
                if bind_views:
                    checked_path(root, normalized['cache_path'], scope='scratch')
            for key in ['cache_sha256', 'identity_sha256']:
                if key in view:
                    if not isinstance(view[key], str) or not HASH.fullmatch(view[key]):
                        fail('READ_VIEW_INVALID')
                    normalized[key] = view[key]
            result['page'] = page
            if bind_views:
                normalized = resolve_view(root, result, normalized)
            elif set(normalized) != {'mode', 'cache_path', 'cache_sha256', 'identity_sha256'}:
                fail('READ_VIEW_INVALID')
            result['view'] = normalized
    return result


def reading_address(item):
    view = item.get('view', {})
    return (item['path'], item.get('unit'), item.get('page'), view.get('mode'), view.get('identity_sha256'))


def validate_progress(root, value, *, bind_views=False):
    if (not isinstance(value, dict) or set(value) - {'phase', 'next_action', 'reading_cursors', 'pending', 'evidence'}
            or value.get('phase') not in PHASES or len(encoded(value)) > (MAX_PROGRESS if bind_views else MAX_STATUS)):
        fail('PROGRESS_INVALID')
    result = {'phase': value['phase'], 'next_action': text(value.get('next_action'), 1024)}
    for key, maximum, cursor in [('reading_cursors', 8, True), ('evidence', 8, False)]:
        refs = value.get(key, [])
        if not isinstance(refs, list) or len(refs) > maximum:
            fail('PROGRESS_INVALID')
        result[key] = [reference(root, item, cursor=cursor, bind_views=bind_views) for item in refs]
        addresses = [reading_address(item) if cursor else item['path'] for item in result[key]]
        if len(set(addresses)) != len(refs):
            fail('PROGRESS_INVALID')
    pending = value.get('pending', [])
    if not isinstance(pending, list) or len(pending) > 8:
        fail('PROGRESS_INVALID')
    result['pending'] = [text(item, 256) for item in pending]
    return result


def reference_status(root, value, data):
    measured = fingerprint(root, value['path'])
    pinned = [item['sha256'] for key, path_key in [('materials', 'path'), ('knowledge', 'local_path')]
              for item in (data.get(key) if isinstance(data.get(key), list) else [])
              if isinstance(item, dict) and item.get(path_key) == value['path']
              and isinstance(item.get('sha256'), str) and HASH.fullmatch(item['sha256'])]
    if measured['state'] == 'missing':
        return 'missing'
    if any(expected != value['sha256'] for expected in pinned) or measured['sha256'] != value['sha256']:
        return 'changed'
    if 'view' in value:
        try:
            if resolve_view(root, value, value['view']) != value['view']:
                return 'changed'
        except (OSError, ValueError):
            return 'changed'
    return 'current'

def read_state(root, data, input_sha256):
    path = checked_path(root, STATE_PATH, scope='scratch')
    if not path.exists():
        return None
    state = json_object(regular_bytes(root, path, MAX_STATUS))
    if (state.get('version') != VERSION or state.get('input_hash') != data['input_hash']
            or state.get('input_sha256') != input_sha256):
        fail('INPUT_CONFLICT')
    state['progress'] = validate_progress(root, state.get('progress'))
    if not isinstance(state.get('output_snapshot'), dict):
        fail('STATE_INVALID')
    return state


def worklog_tail(root):
    path = checked_path(root, 'scratch/工作记录.md', scope='scratch')
    if not path.exists():
        return None
    with opened(root, path, MAX_FILE) as (stream, info):
        stream.seek(max(0, info.st_size - 2048))
        tail = stream.read(2048).decode('utf-8', errors='replace')
    # UTF-8 replacement for a split leading character can add two bytes.
    while len(tail.encode('utf-8')) > 2048:
        tail = tail[1:]
    return {'path': 'scratch/工作记录.md', 'byte_size': info.st_size,
            'tail': tail, 'truncated': info.st_size > 2048, 'untrusted': True}


def bounded(result):
    omitted = {}
    for key in ['evidence', 'reading_cursors', 'pending']:
        items = result.get('progress', {}).get(key, [])
        while len(encoded(result)) > MAX_STATUS and items:
            items.pop()
            omitted[key] = omitted.get(key, 0) + 1
            result['omitted_progress_entries'] = omitted
    if len(encoded(result)) > MAX_STATUS and result.get('legacy_worklog'):
        result['legacy_worklog'].pop('tail', None)
        result['legacy_worklog']['truncated'] = True
    if len(encoded(result)) > MAX_STATUS:
        fail('STATUS_LIMIT')
    return result


def status(input_path):
    root, data, input_sha256 = locked_input(input_path)
    snapshot = output_snapshot(root, data)
    state = read_state(root, data, input_sha256)
    result = {'version': VERSION, 'status': 'missing', 'input_hash': data['input_hash'],
              'input_sha256': input_sha256, 'output_snapshot': snapshot, 'state_path': STATE_PATH,
              'scope': 'untrusted_execution_notes_only', 'reading_claims': 'reported_unverified', 'coverage_verified': False,
              'authoring_completion': 'not_verified', 'host_acceptance': False, 'notice': NOTICE}
    if state is None:
        result['legacy_worklog'] = worklog_tail(root)
    else:
        progress = state['progress']
        result['status'] = 'current' if state['output_snapshot'] == snapshot else 'stale'
        for key in ['reading_cursors', 'evidence']:
            for item in progress[key]:
                item['file_state'] = reference_status(root, item, data)
                if item['file_state'] != 'current':
                    result['status'] = 'stale'
        result['progress'] = progress
        result['next_action_requires_reconciliation'] = result['status'] != 'current'
    # Input and actual outputs are sampled twice to reject concurrent changes.
    if hashlib.sha256(regular_bytes(root, root / 'input.json')).hexdigest() != input_sha256 or output_snapshot(root, data) != snapshot:
        fail('FILE_CHANGED')
    return bounded(result)


def save(input_path, progress_path):
    root, data, input_sha256 = locked_input(input_path)
    destination = checked_path(root, STATE_PATH, scope='scratch')
    read_state(root, data, input_sha256)  # Existing foreign-input notes cannot be overwritten.
    if str(progress_path) == '-':
        raw_progress = sys.stdin.buffer.read(MAX_PROGRESS + 1)
        if len(raw_progress) > MAX_PROGRESS:
            fail('PROGRESS_INVALID')
    else:
        progress_path = checked_path(root, progress_path, scope='scratch')
        if progress_path == destination:
            fail('PATH_UNSAFE')
        raw_progress = regular_bytes(root, progress_path, MAX_PROGRESS)
    progress = validate_progress(root, json_object(raw_progress), bind_views=True)
    for key in ['reading_cursors', 'evidence']:
        for item in progress[key]:
            if reference_status(root, item, data) != 'current':
                fail('REFERENCE_CHANGED')
    snapshot = output_snapshot(root, data)
    state = {'version': VERSION, 'input_hash': data['input_hash'], 'input_sha256': input_sha256,
             'output_snapshot': snapshot, 'progress': progress}
    raw = encoded(state)
    if len(raw) > MAX_STATUS:
        fail('PROGRESS_INVALID')
    if hashlib.sha256(regular_bytes(root, root / 'input.json')).hexdigest() != input_sha256 or output_snapshot(root, data) != snapshot:
        fail('FILE_CHANGED')
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.continuation-', suffix='.tmp', delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    try:
        checked_path(root, destination, scope='scratch')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return status(input_path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ['save', 'status']:
        command = sub.add_parser(name)
        command.add_argument('--input', required=True)
        if name == 'save':
            command.add_argument('--progress', required=True)
    args = parser.parse_args(argv)
    try:
        result = save(args.input, args.progress) if args.command == 'save' else status(args.input)
        print(encoded(result).decode('utf-8'))
        return 0
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        code = str(exc)
        if not re.fullmatch(r'AUTHORING_CONTINUATION_[A-Z_]+', code):
            code = 'AUTHORING_CONTINUATION_UNAVAILABLE'
        print(json.dumps({'version': VERSION, 'status': 'invalid', 'error': code,
                          'scope': 'untrusted_execution_notes_only', 'host_acceptance': False}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
