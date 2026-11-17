"""Host-derived, snapshot-bound empty-body repair. Model text never selects nodes.

This module is called again by the collector on trusted input buffers. A scope
file in the model workspace is explanatory data, never an authorization receipt.
"""
from __future__ import annotations

import copy
import json

from .check import package, resolve_revisions
from .fixed_edit import MAX_OPERATIONS, load_editor, regular_bytes, read_json, write_json
from .preflight import chapter_locations
from .quality import chapters
from .source_outline import compare_outlines, heading_role, outline, style_map
from .template_manifest import build_nodes, sha
from .word_patch import paragraph_text, q, serialized, xml

VERSION = 'word-chapter-repair-scope-v1'


def fingerprint(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def create_scope(input_path, operations_path):
    data, source, baseline, log, editor = load_editor(input_path, operations_path)
    old_parts = package(source)
    old_root = xml(old_parts['word/document.xml'])
    old_ids = {node: key for key, (_, node) in build_nodes({'word/document.xml': old_root}).items()}
    resolve_revisions(old_root, True)
    old_styles = style_map(old_parts)
    original_bodies = {old_ids[p]: paragraph_text(p) for p in old_root.iter(q('p'))
                       if p in old_ids and paragraph_text(p).strip() and heading_role(p, old_styles) is None
                       and not any(a.tag in {q('tc'), q('txbxContent')} for a in p.iterancestors())}
    root = copy.deepcopy(editor.roots['word/document.xml'])
    ids = {node: key for key, (_, node) in editor.nodes.items()}
    current_ids = {b: ids[a] for a, b in zip(editor.roots['word/document.xml'].iter(), root.iter()) if a in ids}
    resolve_revisions(root, True)
    parts = {**old_parts, 'word/document.xml': serialized(root)}
    if compare_outlines(outline(old_parts), outline(parts), flexible_text=True)['status'] != 'unchanged':
        raise ValueError('WORD_REPAIR_STRUCTURE_UNSAFE')
    old = list(chapters(old_parts, old_root, include_heading=False).values())
    new = list(chapters(parts, root, include_heading=False).values())
    locations = list(chapter_locations(parts, root, current_ids).items())
    styles = style_map(parts)
    candidates = {current_ids[p] for p in root.iter(q('p')) if p in current_ids
                  and not paragraph_text(p).strip() and heading_role(p, styles) is None
                  and not any(a.tag in {q('tc'), q('txbxContent')} for a in p.iterancestors())}
    targets = []
    for index, text in enumerate(old):
        if not text.strip() or index >= len(new) or new[index].strip():
            continue
        key, entries = locations[index]
        # Restore every formerly nonempty body slot in the empty chapter. One
        # chapter can contain several lost paragraphs; filling only its first
        # paragraph would satisfy the chapter gate but leave other content lost.
        body_targets = [p for p in entries if p['node_id'] in candidates and p['node_id'] in original_bodies]
        if not body_targets:
            raise ValueError('WORD_REPAIR_BODY_TARGET_UNAVAILABLE')
        for target in body_targets:
            targets.append({'issue_id': fingerprint([index, target['node_id']]),
                            'chapter_index': index, 'title': key[0], 'source_text': original_bodies[target['node_id']],
                            'node_id': target['node_id'], 'before': target['text']})
    if not targets or len(targets) > 100:
        raise ValueError('WORD_REPAIR_BODY_TARGET_UNAVAILABLE')
    if len(log['operations']) + len(targets) > MAX_OPERATIONS:
        raise ValueError('WORD_REPAIR_OPERATION_LIMIT')
    scope = {'version': VERSION, 'input_hash': data['input_hash'],
             'baseline_sha256': sha(baseline), 'operations_sha256': sha(regular_bytes(operations_path)),
             'targets': targets}
    return {**scope, 'scope_sha256': fingerprint(scope)}


def apply_answers(input_path, operations_path, expected_scope, answers):
    # Recompute from trusted baseline and previous operations. Neither a forged
    # scope nor generic model edits can enlarge the permitted target set.
    scope = create_scope(input_path, operations_path)
    if scope != expected_scope:
        raise ValueError('WORD_REPAIR_SNAPSHOT_MISMATCH')
    if not isinstance(answers, dict) or set(answers) != {'version', 'scope_sha256', 'answers'} or (
            answers['version'] != 'word-chapter-repair-answers-v1' or answers['scope_sha256'] != scope['scope_sha256']):
        raise ValueError('WORD_REPAIR_ANSWERS_INVALID')
    entries = answers['answers']
    if not isinstance(entries, list) or len(entries) != len(scope['targets']):
        raise ValueError('WORD_REPAIR_ANSWERS_INVALID')
    by_id = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'issue_id', 'text'} or (
                not isinstance(entry['issue_id'], str) or entry['issue_id'] in by_id or
                not isinstance(entry['text'], str) or not entry['text'].strip() or len(entry['text']) > 30000 or
                any((ord(c) < 32 and c not in '\n\t\r') or 0xd800 <= ord(c) <= 0xdfff or ord(c) in (0xfffe, 0xffff)
                    for c in entry['text'])):
            raise ValueError('WORD_REPAIR_ANSWERS_INVALID')
        by_id[entry['issue_id']] = entry['text']
    if set(by_id) != {t['issue_id'] for t in scope['targets']}:
        raise ValueError('WORD_REPAIR_TARGET_OUT_OF_SCOPE')
    _, _, _, log, editor = load_editor(input_path, operations_path)
    additions = []
    for target in scope['targets']:
        operation = {'id': 'body_repair_' + scope['scope_sha256'][:16] + '_' + target['issue_id'][:16],
                     'kind': 'replace_text', 'node_id': target['node_id'], 'before': target['before'],
                     'after': by_id[target['issue_id']], 'reason': '补齐服务端诊断指定的章节正文'}
        editor.apply(operation)
        additions.append(operation)
    candidate = {**log, 'operations': log['operations'] + additions}
    # Do not mutate the accepted log. Full host quality checking accepts or
    # rejects the candidate; a regression leaves the durable previous log intact.
    return candidate


def command(input_path, operations_path, scope_path, answers_path=None, candidate_path=None):
    if answers_path is None:
        scope = create_scope(input_path, operations_path)
        write_json(scope_path, scope)
        return {'version': VERSION, 'target_count': len(scope['targets']), 'scope_sha256': scope['scope_sha256']}
    if not candidate_path:
        raise ValueError('WORD_EDIT_ARGUMENT_REQUIRED')
    candidate = apply_answers(input_path, operations_path, read_json(scope_path), read_json(answers_path))
    write_json(candidate_path, candidate)
    return {'version': VERSION, 'operation_count': len(candidate['operations'])}
