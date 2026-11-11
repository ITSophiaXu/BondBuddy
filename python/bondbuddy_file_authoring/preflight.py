"""Diagnostic replay of current operations using the host Word checker.

The model-facing report is never an acceptance receipt. The host independently
replays its locked source and durable operations after the model exits.
"""
from __future__ import annotations

import copy
import json
import re
import tempfile
from collections import Counter
from pathlib import Path

from . import quality
from .check import STORY, package, resolve_revisions
from .fixed_edit import (Editor, MAX_LOG, load_input, regular_bytes, validate_log,
                         write_json, write_package)
from .source_outline import compare_outlines, heading_role, outline, style_map
from .template_manifest import build_nodes, sha
from .word_patch import paragraph_text, q, serialized, xml

VERSION = 'word-quality-preflight-v1'


def protect_report_path(report_path, paths):
    if any(Path(path).absolute().resolve() == report_path.resolve() for path in paths):
        raise ValueError('WORD_PREFLIGHT_REPORT_INPUT_ALIAS')


def checked_path(root, value, subdirectory=None, create_parent=False):
    """Reject aliases and links, including unsafe existing parent directories."""
    root = Path(root).resolve()
    if '..' in Path(value).parts:
        raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    path = Path(value).absolute()
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    if '..' in relative.parts or not relative.parts or (
            subdirectory and (len(relative.parts) < 2 or relative.parts[0] != subdirectory)):
        raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    current = root
    for index, part in enumerate(relative.parts):
        current = current / part
        if current.is_symlink() or (hasattr(current, 'is_junction') and current.is_junction()):
            raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
        if index < len(relative.parts) - 1:
            if create_parent and not current.exists():
                current.mkdir(mode=0o700)
            if not current.is_dir():
                raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    if path.resolve() != path:
        raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    return path


def chapter_locations(parts, root, node_ids):
    """Bounded reading locations; quality.chapters remains authoritative."""
    styles, seen = style_map(parts), Counter()
    result, key = {('preamble', 0): []}, ('preamble', 0)
    for index, paragraph in enumerate(root.iter(q('p'))):
        if any(a.tag == q('txbxContent') for a in paragraph.iterancestors()):
            continue
        role, text = heading_role(paragraph, styles), paragraph_text(paragraph)
        if role and role['kind'] == 'heading' and not any(a.tag == q('tc') for a in paragraph.iterancestors()):
            title = quality.outline_text(text)
            seen[title] += 1
            key = (title, seen[title])
            result[key] = []
        result[key].append({'paragraph_index': index, 'node_id': node_ids.get(paragraph), 'text': text,
                            'container_node_ids': [node_ids[a] for a in paragraph.iterancestors() if a in node_ids]})
    if {key: '\n'.join(p['text'] for p in entries) for key, entries in result.items()} != quality.chapters(parts, root):
        raise ValueError('WORD_PREFLIGHT_LOCATIONS_UNAVAILABLE')
    return result


def bounded_paragraphs(entries):
    return {'paragraph_count': len(entries), 'truncated': len(entries) > 40 or any(len(p['text']) > 1024 for p in entries[:40]),
            'paragraphs': [{**p, 'text': p['text'][:1024], 'text_truncated': len(p['text']) > 1024} for p in entries[:40]]}


def diagnostics(source_path, editor, clean_parts, report, operations):
    source_parts = package(source_path)
    source_root = xml(source_parts['word/document.xml'])
    source_ids = {node: key for key, (_, node) in build_nodes({'word/document.xml': source_root}).items()}
    resolve_revisions(source_root, True)
    current_root = copy.deepcopy(editor.roots['word/document.xml'])
    live_ids = {node: key for key, (_, node) in editor.nodes.items()}
    current_ids = {cloned: live_ids[node] for node, cloned in zip(editor.roots['word/document.xml'].iter(), current_root.iter()) if node in live_ids}
    resolve_revisions(current_root, True)
    if [paragraph_text(p) for p in current_root.iter(q('p'))] != [paragraph_text(p) for p in xml(clean_parts['word/document.xml']).iter(q('p'))]:
        raise ValueError('WORD_PREFLIGHT_LOCATIONS_UNAVAILABLE')
    before = chapter_locations(source_parts, source_root, source_ids)
    after = chapter_locations(clean_parts, current_root, current_ids)
    old_keys, new_keys, chapters = list(before), list(after), []
    for issue in report['issues']:
        if issue['code'] != 'WORD_SOURCE_CHAPTER_CONTENT_LOST':
            continue
        for finding in issue['chapters'][:25]:
            key = old_keys[finding['chapter_index']]
            current_key = new_keys[finding['chapter_index']] if finding['chapter_index'] < len(new_keys) else None
            source_entries, current_entries = before[key], after.get(current_key, [])
            targets = {node_id for p in source_entries + current_entries
                       for node_id in [p['node_id'], *p['container_node_ids']] if node_id}
            operation_ids = [op['id'] for op in operations if op.get('node_id') in targets]
            detail = {**finding, 'chapter_key': list(key), 'title': key[0], 'current_key_found': key in after,
                             'current_chapter_key': list(current_key) if current_key is not None else None,
                             'source': bounded_paragraphs(source_entries), 'current': bounded_paragraphs(current_entries),
                             'operation_ids': operation_ids[:200], 'operations_truncated': len(operation_ids) > 200}
            if key not in after:
                source_node_ids = {p['node_id'] for p in source_entries if p['node_id']}
                detail['current_matching_source_nodes'] = bounded_paragraphs([
                    p for entries in after.values() for p in entries if p['node_id'] in source_node_ids])
            chapters.append(detail)
    structural = compare_outlines(outline(source_parts), outline(clean_parts), flexible_text=True)
    for kind in ('headings', 'toc'):
        changes = structural[kind]['changes']
        structural[kind]['changes_truncated'] = len(changes) > 20
        structural[kind]['changes'] = changes[:20]
        for change in structural[kind]['changes']:
            for side, root, ids in [('before', source_root, source_ids), ('after', current_root, current_ids)]:
                paragraphs = list(root.iter(q('p')))
                change[side + '_truncated'] = len(change[side]) > 10
                change[side] = change[side][:10]
                for item in change[side]:
                    item['text_truncated'] = len(item['text']) > 1024
                    item['text'] = item['text'][:1024]
                    if 'paragraph' in item:
                        item['node_id'] = ids.get(paragraphs[item['paragraph']])
                        item['operation_ids'] = [op['id'] for op in operations if op.get('node_id') == item['node_id']][:200]
    return {'chapter_content': chapters, 'chapter_diagnostics_truncated': any(
            len(i.get('chapters', [])) > 25 for i in report['issues']), 'outline': structural,
            'location_scope': 'zero_based_effective_paragraph_indices_and_stable_inspect_node_ids'}


def preflight(input_path, operations_path, report_path):
    input_path = Path(input_path).absolute()
    root = input_path.parent.resolve()
    report_path = checked_path(root, report_path, 'scratch', create_parent=True)
    if report_path.suffix != '.json':
        raise ValueError('WORD_PREFLIGHT_PATH_UNSAFE')
    protect_report_path(report_path, [input_path, operations_path])
    result = {'version': VERSION, 'status': 'failed', 'scope': 'model_preflight_diagnostic_only',
              'host_acceptance': False, 'delivery_registered': False, 'release_authorized': False,
              'factual_accuracy': 'not_verified', 'visual_review': 'not_run',
              'checker_version': quality.VERSION, 'snapshot_current': False, 'quality_report': None, 'issues': []}
    try:
        input_path = checked_path(root, input_path)
        input_raw = regular_bytes(input_path)
        try:
            declared = json.loads(input_raw.decode('utf-8'))
        except (UnicodeError, json.JSONDecodeError):
            raise ValueError('WORD_EDIT_JSON_INVALID')
        if isinstance(declared, dict):
            protect_report_path(report_path, [root / declared[key] for key in ('baseline_path', 'original_pdf_path')
                                             if isinstance(declared.get(key), str) and declared[key]])
        data, source, baseline_raw = load_input(input_path)
        source = checked_path(root, source)
        if regular_bytes(input_path) != input_raw:
            raise ValueError('WORD_PREFLIGHT_INPUT_CHANGED')
        if data.get('baseline_kind') not in {'uploaded_source', 'project_output', 'reconstructed_pdf'}:
            raise ValueError('WORD_PREFLIGHT_BASELINE_KIND_INVALID')
        operations_path = checked_path(root, operations_path, 'output')
        if not operations_path.exists():
            raise ValueError('WORD_EDIT_LOG_REQUIRED')
        operations_raw = regular_bytes(operations_path)
        try:
            log = json.loads(operations_raw.decode('utf-8'))
        except (UnicodeError, json.JSONDecodeError):
            raise ValueError('WORD_EDIT_JSON_INVALID')
        validate_log(log, data, baseline_raw)
        result.update(input_hash=data['input_hash'], input_sha256=sha(input_raw),
                      baseline_sha256=sha(baseline_raw), operations_sha256=sha(operations_raw),
                      operation_count=len(log['operations']))
        original, pdf_raw = None, None
        with tempfile.TemporaryDirectory(dir=root / 'scratch', prefix='.word-quality-preflight-') as temporary:
            area = Path(temporary)
            baseline = area / 'baseline.docx'
            baseline.write_bytes(baseline_raw)
            (area / 'operations.json').write_bytes(operations_raw)
            trusted = {**data, 'baseline_path': 'baseline.docx', 'baseline_sha256': sha(baseline_raw),
                       'materials': [{'path': 'baseline.docx', 'sha256': sha(baseline_raw)}],
                       'operations_path': 'operations.json',
                       'output': {'baseline': 'baseline.docx', 'tracked': 'tracked.docx', 'clean': 'clean.docx'}}
            if data.get('original_pdf_path'):
                original = checked_path(root, root / data['original_pdf_path'])
                pdf_raw = regular_bytes(original, 100 * 1024 * 1024)
                result['original_pdf_sha256'] = sha(pdf_raw)
                (area / 'original-source.pdf').write_bytes(pdf_raw)
                trusted.update(original_pdf_path='original-source.pdf', original_pdf_sha256=sha(pdf_raw))
            editor = Editor(trusted, baseline).replay(log['operations'])
            if not editor.has_changes() and not log.get('no_changes_reason'):
                raise ValueError('WORD_EDIT_NO_CHANGES_REASON_REQUIRED')
            tracked = editor.tracked_parts()
            clean = {name: serialized(resolve_revisions(xml(raw), True)) if STORY.fullmatch(name) else raw
                     for name, raw in tracked.items()}
            write_package(area / 'tracked.docx', tracked)
            write_package(area / 'clean.docx', clean)
            write_json(area / 'input.json', trusted)
            snapshots = {path: sha(regular_bytes(path, 100 * 1024 * 1024)) for path in area.iterdir()}
            report = quality.verify(area / 'input.json')
            if any(sha(regular_bytes(path, 100 * 1024 * 1024)) != digest for path, digest in snapshots.items()):
                raise ValueError('WORD_PREFLIGHT_INPUT_CHANGED')
            result.update(status=report['status'], quality_report=report, issues=report['issues'],
                          diagnostics=diagnostics(baseline, editor, clean, report, log['operations']))
        for path in [input_path, operations_path, source, *([original] if original else [])]:
            checked_path(root, path)
        if regular_bytes(input_path) != input_raw or regular_bytes(operations_path) != operations_raw or regular_bytes(source, 100 * 1024 * 1024) != baseline_raw or (
                original is not None and regular_bytes(original, 100 * 1024 * 1024) != pdf_raw):
            raise ValueError('WORD_PREFLIGHT_INPUT_CHANGED')
        result['snapshot_current'] = True
    except Exception as exc:
        if str(exc) == 'WORD_PREFLIGHT_REPORT_INPUT_ALIAS':
            raise
        code = str(exc) if isinstance(exc, ValueError) and re.fullmatch(r'WORD_[A-Z_]+', str(exc)) else 'WORD_PREFLIGHT_FAILED'
        result.update(status='failed', issues=[{'code': code}])
    # Existing model-written reports are overwritten by this fresh computation.
    checked_path(root, report_path, 'scratch')
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_LOG:
        raise ValueError('WORD_PREFLIGHT_REPORT_LIMIT')
    write_json(report_path, result)
    return result
