"""Derive a complete stable-node chapter inventory from the locked DOCX, without a model."""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

from .check import STORY, package, resolve_revisions
from .fixed_edit import regular_bytes
from .source_outline import heading_role, style_map
from .template_manifest import build_nodes, describe_nodes, sha
from .word_patch import paragraph_text, q, xml
from .workflow_descriptors import bounded_nodes

VERSION = 'word-chapter-inventory-v1'
MARKER = '{urn:bondbuddy:read-only-chapter-inventory}node-id'


def inventory(source):
    source = Path(source)
    original_bytes = regular_bytes(source, 100 * 1024 * 1024)
    parts = package(source)
    roots = {part: xml(raw) for part, raw in parts.items() if STORY.fullmatch(part)}
    if 'word/document.xml' not in roots:
        raise ValueError('WORD_EDIT_SOURCE_UNREADABLE')
    nodes = build_nodes(roots)
    described = bounded_nodes(describe_nodes(nodes))
    # Temporary attributes identify accepted headings by their original stable ID.
    # Neither the source bytes nor the returned node descriptions are modified.
    main = copy.deepcopy(roots['word/document.xml'])
    main_nodes = build_nodes({'word/document.xml': main})
    for node_id, (_, node) in main_nodes.items():
        node.set(MARKER, node_id)
    effective = resolve_revisions(main, True)
    body = effective.find(q('body'))
    if body is None:
        raise ValueError('WORD_EDIT_SOURCE_UNREADABLE')
    styles = style_map(parts)
    boundaries = {}
    for node in body:
        if node.tag != q('p'):
            continue
        role = heading_role(node, styles)
        title = paragraph_text(node).strip()
        if role and role['kind'] == 'heading' and role['level'] == 0 and title:
            boundaries[node.get(MARKER)] = title
    chapters = [{'title': 'preface', 'source_node_ids': []}]
    auxiliary = {'title': 'aux', 'source_node_ids': []}
    for node_id, (part, _) in nodes.items():
        if part != 'word/document.xml':
            auxiliary['source_node_ids'].append(node_id)
            continue
        if node_id in boundaries:
            chapters.append({'title': boundaries[node_id], 'source_node_ids': []})
        chapters[-1]['source_node_ids'].append(node_id)
    chapters = [chapter for chapter in chapters if chapter['source_node_ids']]
    if auxiliary['source_node_ids']:
        chapters.append(auxiliary)
    if regular_bytes(source, 100 * 1024 * 1024) != original_bytes:
        raise ValueError('WORD_EDIT_SOURCE_HASH_MISMATCH')
    return {'version': VERSION, 'source_sha256': sha(original_bytes), 'chapters': chapters, 'nodes': described}


def main():
    try:
        print(json.dumps(inventory(sys.argv[1]), ensure_ascii=False))
        return 0
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
