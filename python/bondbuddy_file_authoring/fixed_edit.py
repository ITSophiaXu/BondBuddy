"""Bounded DOCX edits and trusted replay; operation JSON is data, never code.

All offsets are Unicode code points. Original node identities remain valid after
insertions; new nodes use op:<operation-id>:... identities returned by inspect.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import posixpath
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from lxml import etree as ET

from .check import STORY, package, resolve_revisions
from .template_manifest import (build_manifest, build_nodes, capability_limits,
                                describe_nodes, node_text, sha)
from .word_patch import Patcher, paragraph_run_reference, paragraph_text, q, run_with_text, serialized, xml

VERSION = 'word-operations-v1'
MAX_LOG = 32 * 1024 * 1024
MAX_OPERATIONS = 20_000
MAX_TEXT = 200_000


def error(code):
    raise ValueError(code)


def regular_bytes(path, limit=MAX_LOG):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1 or not 0 < path.stat().st_size <= limit:
        error('WORD_EDIT_FILE_INVALID')
    return path.read_bytes()


def read_json(path):
    try:
        result = json.loads(regular_bytes(path).decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        error('WORD_EDIT_JSON_INVALID')
    if not isinstance(result, (dict, list)):
        error('WORD_EDIT_JSON_INVALID')
    return result


def write_json(path, value):
    path = Path(path)
    if path.is_symlink():
        error('WORD_EDIT_OUTPUT_UNSAFE')
    # An exclusive temporary file cannot follow a model-created sibling symlink
    # or hard link. Replace the destination atomically after the full write.
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                     prefix=path.name + '.', suffix='.tmp', delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, ensure_ascii=False, indent=2)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_input(input_path):
    input_path = Path(input_path)
    data = read_json(input_path)
    if not isinstance(data, dict) or not re.fullmatch(r'[a-f0-9]{64}', data.get('input_hash', '')):
        error('WORD_EDIT_INPUT_INVALID')
    source_value = data.get('baseline_path')
    if not isinstance(source_value, str):
        error('WORD_EDIT_DOCX_REQUIRED')
    root = input_path.parent.resolve()
    source = root / source_value
    if not source.resolve().is_relative_to(root) or source.is_symlink() or source.suffix.lower() != '.docx':
        error('WORD_EDIT_SOURCE_UNSAFE')
    expected = data.get('baseline_sha256')
    if expected is None:
        expected = next((m.get('sha256') for m in data.get('materials', []) if m.get('path') == source_value), None)
    if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
        error('WORD_EDIT_SOURCE_HASH_REQUIRED')
    raw = regular_bytes(source, 100 * 1024 * 1024)
    if sha(raw) != expected:
        error('WORD_EDIT_SOURCE_HASH_MISMATCH')
    author = data.get('revision_author')
    if not isinstance(author, str) or not 1 <= len(author) <= 100:
        error('WORD_EDIT_AUTHOR_INVALID')
    stamp = data.get('revision_date')
    if stamp is not None:
        try:
            parsed = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
                error('WORD_EDIT_REVISION_DATE_INVALID')
        except (AttributeError, TypeError, ValueError):
            error('WORD_EDIT_REVISION_DATE_INVALID')
    return data, source, raw


def empty_log(data, raw):
    return {'version': VERSION, 'input_hash': data['input_hash'],
            'baseline_sha256': sha(raw), 'operations': []}


def validate_log(log, data, raw):
    required = {'version', 'input_hash', 'baseline_sha256', 'operations'}
    if not isinstance(log, dict) or not required <= set(log) or set(log) - required - {'no_changes_reason'}:
        error('WORD_EDIT_LOG_INVALID')
    if log['version'] != VERSION or log['input_hash'] != data['input_hash'] or log['baseline_sha256'] != sha(raw):
        error('WORD_EDIT_LOG_INPUT_MISMATCH')
    if not isinstance(log['operations'], list) or len(log['operations']) > MAX_OPERATIONS:
        error('WORD_EDIT_OPERATION_LIMIT')
    if 'no_changes_reason' in log and (not isinstance(log['no_changes_reason'], str) or not 1 <= len(log['no_changes_reason'].strip()) <= 2000):
        error('WORD_EDIT_NO_CHANGES_REASON_INVALID')


def text_value(value):
    if not isinstance(value, str) or len(value) > MAX_TEXT or any(ord(c) < 32 and c not in '\n\t\r' for c in value):
        error('WORD_EDIT_TEXT_INVALID')
    return value


def path_to(root, node):
    path = []
    while node is not root:
        parent = node.getparent()
        if parent is None:
            error('WORD_EDIT_NODE_DETACHED')
        path.append(parent.index(node))
        node = parent
    return tuple(reversed(path))


def at_path(root, path):
    for index in path:
        root = root[index]
    return root


class ReplayPatcher(Patcher):
    def __init__(self, root, author, stamp):
        super().__init__(root, True, author)
        self.stamp = stamp
        # Missing timestamps occur only in compatibility/test inputs. Omit the
        # optional date on each new marker, rather than invent a historical date.
        self.date = stamp or '2000-01-01T00:00:00Z'

    def revision_node(self, run, kind):
        node = super().revision_node(run, kind)
        if self.stamp is None:
            node.attrib.pop(q('date'), None)
        return node


class Editor:
    def __init__(self, data, source):
        self.data = data
        self.parts = package(source)
        self.roots = {part: xml(raw) for part, raw in self.parts.items() if STORY.fullmatch(part)}
        self.nodes = build_nodes(self.roots)
        self.original_paragraphs = {key: copy.deepcopy(node) for key, (_, node) in self.nodes.items() if node.tag == q('p')}
        self.touched = set()
        self.inserted_paragraphs = set()
        self.inserted_rows = set()
        self.changed_parts = set()
        self.operations = []
        self.operation_ids = set()
        self.comments = []
        self.format_origins = {}
        self.format_plan = None

    def target(self, node_id, tag=None):
        if not isinstance(node_id, str) or node_id not in self.nodes:
            error('WORD_EDIT_NODE_NOT_FOUND')
        part, node = self.nodes[node_id]
        if tag is not None and node.tag != q(tag):
            error('WORD_EDIT_NODE_KIND_MISMATCH')
        return part, node

    def replace_paragraph(self, node_id, before, after):
        part, node = self.target(node_id, 'p')
        if paragraph_text(node) != before:
            error('WORD_EDIT_ANCHOR_MISMATCH')
        limits = capability_limits(node)
        if 'existing_revisions' in limits:
            error('WORD_EDIT_EXISTING_REVISIONS_UNSUPPORTED')
        if 'fields_or_embedded_objects' in limits:
            error('WORD_EDIT_FIELD_OR_OBJECT_UNSUPPORTED')
        # Diff operates on the whole expected paragraph, not ambiguous substring positions.
        try:
            Patcher(node, False).patch(node, before, after)
        except ValueError:
            error('WORD_EDIT_PARAGRAPH_BOUNDARY_UNSUPPORTED')
        self.touched.add(node_id)
        self.changed_parts.add(part)

    def clone_paragraph(self, source, text):
        if source.find(q('pPr') + '/' + q('sectPr')) is not None:
            error('WORD_EDIT_SECTION_CLONE_UNSUPPORTED')
        if 'existing_revisions' in capability_limits(source):
            error('WORD_EDIT_EXISTING_REVISIONS_UNSUPPORTED')
        node = ET.Element(q('p'))
        props = source.find(q('pPr'))
        if props is not None:
            node.append(copy.deepcopy(props))
        reference = paragraph_run_reference(source)
        # Only format properties are inherited. No bookmark, drawing, comment or
        # relationship IDs from the source content are cloned into the new text.
        node.append(run_with_text(reference, text))
        return node

    def apply(self, operation):
        if not isinstance(operation, dict):
            error('WORD_EDIT_OPERATION_INVALID')
        op_id = operation.get('id')
        if not isinstance(op_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', op_id) or op_id in self.operation_ids:
            error('WORD_EDIT_OPERATION_ID_INVALID')
        kind = operation.get('kind')
        common = {'id', 'kind', 'node_id', 'before', 'reason'}
        fields = {'replace_text': {'after'}, 'replace_cell_text': {'after'},
                  'insert_paragraph': {'text', 'style_node_id', 'position'},
                  'insert_row': {'values', 'position'}, 'add_comment': {'text'}}
        if kind not in fields:
            error('WORD_EDIT_OPERATION_UNSUPPORTED')
        if set(operation) - common - fields[kind] or not {'id', 'kind', 'node_id', 'before'} <= set(operation):
            error('WORD_EDIT_OPERATION_INVALID')
        if 'reason' in operation:
            text_value(operation['reason'])
        part, node = self.target(operation['node_id'])
        before = text_value(operation['before'])
        if node_text(node) != before:
            error('WORD_EDIT_ANCHOR_MISMATCH')
        if kind == 'replace_text':
            self.replace_paragraph(operation['node_id'], before, text_value(operation.get('after')))
        elif kind == 'replace_cell_text':
            self.target(operation['node_id'], 'tc')
            ps = node.findall(q('p'))
            values = operation.get('after')
            values = [values] if isinstance(values, str) else values
            if not isinstance(values, list) or len(values) != len(ps) or not ps or node.findall(q('tbl')):
                error('WORD_EDIT_COMPLEX_CELL_UNSUPPORTED')
            for p, value in zip(ps, values):
                paragraph_id = next(key for key, (_, mapped) in self.nodes.items() if mapped is p)
                self.replace_paragraph(paragraph_id, paragraph_text(p), text_value(value))
        elif kind == 'add_comment':
            self.target(operation['node_id'], 'p')
            if part != 'word/document.xml':
                error('WORD_EDIT_COMMENT_STORY_UNSUPPORTED')
            text = text_value(operation.get('text'))
            if not text.strip():
                error('WORD_EDIT_TEXT_INVALID')
            self.comments.append({'node_id': operation['node_id'], 'text': text})
            self.changed_parts.add(part)
        else:
            position = operation.get('position', 'after')
            if position not in {'before', 'after'}:
                error('WORD_EDIT_POSITION_INVALID')
            if kind == 'insert_paragraph':
                self.target(operation['node_id'], 'p')
                style_part, style_node = self.target(operation.get('style_node_id', operation['node_id']), 'p')
                if style_part != part:
                    error('WORD_EDIT_CROSS_STORY_STYLE_UNSUPPORTED')
                added = self.clone_paragraph(style_node, text_value(operation.get('text')))
                key = f'op:{op_id}:paragraph'
                self.nodes[key] = (part, added)
                source_key = operation.get('style_node_id', operation['node_id'])
                self.format_origins[key] = self.format_origins.get(source_key, source_key)
                self.inserted_paragraphs.add(key)
            else:
                self.target(operation['node_id'], 'tr')
                if capability_limits(node):
                    error('WORD_EDIT_COMPLEX_ROW_UNSUPPORTED')
                cells = node.findall(q('tc'))
                values = operation.get('values')
                if not isinstance(values, list) or len(values) != len(cells) or not cells:
                    error('WORD_EDIT_ROW_VALUES_INVALID')
                # Reject irregular surrounding grids as well as merged source rows.
                table = node.getparent()
                if table.tag != q('tbl') or 'merged_or_irregular_grid' in capability_limits(table):
                    error('WORD_EDIT_COMPLEX_ROW_UNSUPPORTED')
                added = ET.Element(q('tr'))
                props = node.find(q('trPr'))
                if props is not None:
                    added.append(copy.deepcopy(props))
                for index, (cell, value) in enumerate(zip(cells, values)):
                    ps = cell.findall(q('p'))
                    paragraph_values = [value] if isinstance(value, str) else value
                    if not isinstance(paragraph_values, list) or len(paragraph_values) != len(ps) or not ps or cell.findall(q('tbl')):
                        error('WORD_EDIT_COMPLEX_CELL_UNSUPPORTED')
                    new_cell = ET.SubElement(added, q('tc'))
                    props = cell.find(q('tcPr'))
                    if props is not None:
                        new_cell.append(copy.deepcopy(props))
                    self.nodes[f'op:{op_id}:cell:{index}'] = (part, new_cell)
                    for pindex, (source_p, paragraph_value) in enumerate(zip(ps, paragraph_values)):
                        new_p = self.clone_paragraph(source_p, text_value(paragraph_value))
                        new_cell.append(new_p)
                        suffix = ':paragraph' if pindex == 0 else f':paragraph:{pindex}'
                        new_key = f'op:{op_id}:cell:{index}{suffix}'
                        source_key = next(key for key, (_, mapped) in self.nodes.items() if mapped is source_p)
                        self.format_origins[new_key] = self.format_origins.get(source_key, source_key)
                        self.nodes[new_key] = (part, new_p)
                key = f'op:{op_id}:row'
                self.nodes[key] = (part, added)
                self.inserted_rows.add(key)
            parent = node.getparent()
            parent.insert(parent.index(node) + (position == 'after'), added)
            self.changed_parts.add(part)
        self.operation_ids.add(op_id)
        self.operations.append(operation)

    def replay(self, operations):
        for operation in operations:
            self.apply(operation)
        return self

    def tracked_parts(self):
        from .format_plan import build_plan, apply_plan
        self.format_plan = build_plan(self)
        result = dict(self.parts)
        next_revision = max([int(n.get(q('id'))) for root in self.roots.values() for n in root.iter()
                             if (n.get(q('id')) or '').isdigit()] + [0]) + 1
        # Each original paragraph is diffed once against its final text. This keeps
        # repeated edits in the same CLI from nesting this run's own revisions.
        for part in sorted(self.changed_parts):
            root = copy.deepcopy(self.roots[part])
            patcher = ReplayPatcher(root, self.data['revision_author'], self.data.get('revision_date'))
            patcher.next_id = next_revision
            comment_targets = {item['node_id'] for item in self.comments}
            target_keys = self.touched | self.inserted_paragraphs | self.inserted_rows | comment_targets
            target_keys |= {item['node_id'] for item in self.format_plan['properties'] + self.format_plan['numeric_fonts']}
            destinations = {key: at_path(root, path_to(self.roots[part], node))
                            for key, (story, node) in self.nodes.items()
                            if story == part and key in target_keys}
            for key in sorted(self.touched):
                if key not in self.original_paragraphs or self.nodes[key][0] != part:
                    continue
                original = self.original_paragraphs[key]
                final_node = self.nodes[key][1]
                revised = copy.deepcopy(original)
                patcher.patch(revised, paragraph_text(original), paragraph_text(final_node))
                destination = destinations[key]
                destination.getparent().replace(destination, revised)
                destinations[key] = revised
            for key in sorted(self.inserted_paragraphs | self.inserted_rows):
                if self.nodes[key][0] != part:
                    continue
                if key in self.inserted_paragraphs and any(
                        ancestor is self.nodes[row_id][1]
                        for ancestor in self.nodes[key][1].iterancestors()
                        for row_id in self.inserted_rows):
                    # The inserted row owns the structural revision and wraps
                    # all its paragraphs, including paragraphs added afterwards.
                    continue
                node = destinations[key]
                if node.tag == q('tr'):
                    props = node.find(q('trPr'))
                    if props is None:
                        props = ET.Element(q('trPr'))
                        node.insert(0, props)
                    marker = patcher.revision_node(ET.Element(q('r')), 'ins')
                    marker.remove(marker[0])
                    props.append(marker)
                else:
                    props = node.find(q('pPr'))
                    if props is None:
                        props = ET.Element(q('pPr'))
                        node.insert(0, props)
                    run_props = props.find(q('rPr'))
                    if run_props is None:
                        run_props = ET.SubElement(props, q('rPr'))
                    marker = patcher.revision_node(ET.Element(q('r')), 'ins')
                    marker.remove(marker[0])
                    run_props.append(marker)
                for p in list(node.iter(q('p'))) if node.tag != q('p') else [node]:
                    for run in list(p.findall(q('r'))):
                        index = p.index(run)
                        p.remove(run)
                        p.insert(index, patcher.revision_node(run, 'ins'))
            apply_plan(self.format_plan, part, destinations, patcher, self.inserted_paragraphs | self.inserted_rows)
            if part == 'word/document.xml' and self.comments:
                self.add_comments(result, root, destinations, self.data.get('revision_date'))
            result[part] = serialized(root)
            next_revision = patcher.next_id
        return result

    def add_comments(self, parts, root, destinations, stamp):
        rel_ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
        content_ns = 'http://schemas.openxmlformats.org/package/2006/content-types'
        comment_type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
        relpath = 'word/_rels/document.xml.rels'
        rels = xml(parts[relpath]) if relpath in parts else ET.Element('{' + rel_ns + '}Relationships', nsmap={None: rel_ns})
        matches = [r for r in rels if r.get('Type') == comment_type]
        if len(matches) > 1:
            error('WORD_EDIT_COMMENT_RELATIONSHIP_UNSUPPORTED')
        if matches:
            relation = matches[0]
            target = relation.get('Target', '')
            if relation.get('TargetMode') == 'External' or target.startswith('/') or '\\' in target:
                error('WORD_EDIT_COMMENT_RELATIONSHIP_UNSUPPORTED')
            comment_path = posixpath.normpath(posixpath.join('word', target))
            if not comment_path.startswith('word/') or comment_path not in parts:
                error('WORD_EDIT_COMMENT_RELATIONSHIP_UNSUPPORTED')
        else:
            comment_path = 'word/comments.xml'
            used = {r.get('Id') for r in rels}
            index = 1
            while 'rId' + str(index) in used:
                index += 1
            ET.SubElement(rels, '{' + rel_ns + '}Relationship', Id='rId' + str(index), Type=comment_type, Target='comments.xml')
            parts[relpath] = serialized(rels)
            types = xml(parts['[Content_Types].xml'])
            if not any(n.get('PartName') == '/' + comment_path for n in types):
                ET.SubElement(types, '{' + content_ns + '}Override', PartName='/' + comment_path,
                              ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml')
            parts['[Content_Types].xml'] = serialized(types)
        comments = xml(parts[comment_path]) if comment_path in parts else ET.Element(q('comments'), nsmap={'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'})
        used_ids = [int(n.get(q('id'))) for parent in [comments, root] for n in parent.iter()
                    if (n.get(q('id')) or '').isdigit()]
        next_id = max(used_ids + [-1]) + 1
        for item in self.comments:
            p = destinations[item['node_id']]
            cid = str(next_id)
            next_id += 1
            p.insert(1 if p.find(q('pPr')) is not None else 0, ET.Element(q('commentRangeStart'), {q('id'): cid}))
            p.append(ET.Element(q('commentRangeEnd'), {q('id'): cid}))
            ref = ET.SubElement(p, q('r'))
            ET.SubElement(ref, q('commentReference'), {q('id'): cid})
            attrs = {q('id'): cid, q('author'): self.data['revision_author']}
            if stamp is not None:
                attrs[q('date')] = stamp
            comment = ET.SubElement(comments, q('comment'), attrs)
            cp = ET.SubElement(comment, q('p'))
            cp.append(run_with_text(ET.Element(q('r')), item['text']))
        parts[comment_path] = serialized(comments)

    def has_changes(self):
        return bool(self.inserted_paragraphs or self.inserted_rows or self.comments or any(
            paragraph_text(self.original_paragraphs[key]) != paragraph_text(self.nodes[key][1])
            for key in self.touched if key in self.original_paragraphs))


def load_editor(input_path, operations_path=None):
    data, source, raw = load_input(input_path)
    log = read_json(operations_path) if operations_path and Path(operations_path).exists() else empty_log(data, raw)
    validate_log(log, data, raw)
    return data, source, raw, log, Editor(data, source).replay(log['operations'])


def write_package(path, parts):
    """Identical locked inputs replay to identical bytes across worker retries."""
    with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
        for name in sorted(parts):
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o600 << 16
            archive.writestr(info, parts[name])


def finalize(input_path, operations_path, output_dir, skip_report=False):
    if not Path(operations_path).exists():
        error('WORD_EDIT_LOG_REQUIRED')
    data, source, raw, log, editor = load_editor(input_path, operations_path)
    if not editor.has_changes() and not log.get('no_changes_reason'):
        error('WORD_EDIT_NO_CHANGES_REASON_REQUIRED')
    output_dir = Path(output_dir)
    if output_dir.is_symlink():
        error('WORD_EDIT_OUTPUT_UNSAFE')
    output_dir.mkdir(parents=True, exist_ok=True)
    names = ['baseline.docx', 'tracked.docx', 'clean.docx', 'operations.json', 'format-report.json', 'format-plan.json']
    for name in names:
        path = output_dir / name
        if path.exists() and (path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1):
            error('WORD_EDIT_OUTPUT_UNSAFE')
    (output_dir / 'baseline.docx').write_bytes(raw)
    tracked_parts = editor.tracked_parts()
    write_json(output_dir / 'format-plan.json', editor.format_plan)
    write_package(output_dir / 'tracked.docx', tracked_parts)
    clean_parts = {name: serialized(resolve_revisions(xml(raw), True)) if STORY.fullmatch(name) else raw
                   for name, raw in tracked_parts.items()}
    write_package(output_dir / 'clean.docx', clean_parts)
    write_json(output_dir / 'operations.json', log)
    report = {'version': 'word-format-report-v1', 'status': 'not_run', 'visual_review': 'not_run'}
    if not skip_report:
        from .format_diff import audit
        report = audit(source, output_dir / 'tracked.docx', data['revision_author'], input_path, operations_path)
        write_json(output_dir / 'format-report.json', report)
    return {'version': 'word-fixed-edit-result-v1', 'input_hash': data['input_hash'],
            'baseline_sha256': sha(raw), 'operation_count': len(log['operations']),
            'no_changes': not editor.has_changes(), 'no_changes_reason': log.get('no_changes_reason') if not editor.has_changes() else None,
            'format_status': report['status'], 'content_review': 'not_performed',
            'files': {name: {'sha256': sha((output_dir / name).read_bytes()), 'byte_size': (output_dir / name).stat().st_size}
                      for name in names if (output_dir / name).is_file() and (name != 'format-report.json' or not skip_report)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'inspect', 'apply', 'finalize', 'no_changes', 'preflight'])
    parser.add_argument('--input', required=True)
    parser.add_argument('--operations')
    parser.add_argument('--operation-file')
    parser.add_argument('--manifest')
    parser.add_argument('--output-dir')
    parser.add_argument('--skip-report', action='store_true')
    parser.add_argument('--node')
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int, default=30)
    parser.add_argument('--reason')
    parser.add_argument('--report')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            data, source, raw = load_input(args.input)
            if not args.manifest:
                error('WORD_EDIT_MANIFEST_REQUIRED')
            manifest = build_manifest(source)
            write_json(args.manifest, manifest)
            result = {'version': manifest['version'], 'baseline_sha256': manifest['baseline_sha256'],
                      'node_count': len(manifest['nodes']), 'heading_count': len(manifest['headings']),
                      'supported_operations': manifest['supported_operations']}
        elif args.command == 'preflight':
            if not args.operations or not args.report:
                error('WORD_EDIT_ARGUMENT_REQUIRED')
            from .preflight import preflight
            report = preflight(args.input, args.operations, args.report)
            result = {key: value for key, value in report.items() if key not in {'quality_report', 'diagnostics'}}
            result['issues'] = [{'code': issue['code']} for issue in report['issues']]
            result['report'] = args.report
            print(json.dumps(result, ensure_ascii=False))
            if report['status'] != 'passed':
                print(json.dumps({'error': 'WORD_PREFLIGHT_REJECTED'}), file=sys.stderr)
                return 1
            return 0
        elif args.command == 'finalize':
            if not args.operations or not args.output_dir:
                error('WORD_EDIT_ARGUMENT_REQUIRED')
            result = finalize(args.input, args.operations, args.output_dir, args.skip_report)
        else:
            data, source, raw, log, editor = load_editor(args.input, args.operations)
            if args.command == 'no_changes':
                if not args.operations or not args.reason or not args.reason.strip() or len(args.reason) > 2000:
                    error('WORD_EDIT_NO_CHANGES_REASON_REQUIRED')
                if editor.has_changes():
                    error('WORD_EDIT_NO_CHANGES_CONFLICT')
                log['no_changes_reason'] = args.reason
                write_json(args.operations, log)
                result = {'version': VERSION, 'no_changes': True, 'operation_count': len(log['operations'])}
            elif args.command == 'apply':
                if not args.operations or not args.operation_file:
                    error('WORD_EDIT_ARGUMENT_REQUIRED')
                additions = read_json(args.operation_file)
                additions = additions if isinstance(additions, list) else [additions]
                if len(log['operations']) + len(additions) > MAX_OPERATIONS:
                    error('WORD_EDIT_OPERATION_LIMIT')
                for operation in additions:
                    editor.apply(operation)
                log['operations'].extend(additions)
                write_json(args.operations, log)
                result = {'version': VERSION, 'operation_count': len(log['operations']),
                          'added_node_ids': [key for key in editor.nodes if key.startswith('op:')][-200:]}
            else:
                if args.offset < 0 or not 1 <= args.limit <= 200:
                    error('WORD_EDIT_PAGE_INVALID')
                if args.node:
                    editor.target(args.node)
                    selected = {args.node: editor.nodes[args.node]}
                else:
                    selected = editor.nodes
                total = len(selected)
                page = dict(list(selected.items())[args.offset:args.offset + args.limit])
                nodes = describe_nodes(editor.nodes, selected=page)
                result = {'version': 'word-edit-inspect-v1', 'baseline_sha256': sha(raw),
                          'offset_unit': 'unicode_code_points', 'total': total,
                          'nodes': nodes}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and re.fullmatch(r'WORD_[A-Z_]+', str(exc)) else 'WORD_EDIT_FAILED'
        print(json.dumps({'error': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
