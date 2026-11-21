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
import zlib
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile, ZipInfo

from lxml import etree as ET

from .check import STORY, package, resolve_revisions
from .template_manifest import (KINDS, build_manifest, build_nodes, capability_limits,
                                describe_nodes, node_text, sha)
from .word_patch import Patcher, paragraph_run_reference, paragraph_text, q, run_with_text, serialized, xml

VERSION = 'word-operations-v1'
MAX_LOG = 32 * 1024 * 1024
MAX_OPERATIONS = 20_000
MAX_TEXT = 200_000
RECOVERY_BATCH_POLICY = 'authoring-batch-policy.json'
RECOVERY_BATCH_POLICY_BYTES = b'{"version":"authoring-output-limit-retry-v1"}\n'
RECOVERY_BATCH_OPERATIONS = 12
RECOVERY_BATCH_BYTES = 32 * 1024


MAX_DETAIL_TEXT = 2000
MAX_PARTIAL_REJECTIONS = 5
INSPECT_MAX_CHARS = 20_000
# Only model-facing commands add a detail object. Host-facing commands (prepare,
# finalize, preflight) keep the one-key {"error": code} protocol the worker parses.
DETAIL_COMMANDS = {'inspect', 'apply', 'revert', 'reset'}
ANCHOR_ONLY_KINDS = {'insert_paragraph', 'insert_row', 'add_comment'}


class EditError(ValueError):
    """A fixed WORD_* code plus bounded, model-facing location detail.

    str(exc) stays the bare code, so existing callers and the host protocol are
    unchanged; only the inspect/apply/revert/reset CLI prints the detail.
    """

    def __init__(self, code, **detail):
        super().__init__(code)
        self.code = code
        self.detail = {key: value for key, value in detail.items() if value is not None}


def error(code, **detail):
    raise EditError(code, **detail)


def bounded(text, limit=MAX_DETAIL_TEXT):
    return text if len(text) <= limit else text[:limit]


def annotate(exc, **detail):
    """Attach operation context to a WORD_* failure without changing its code."""
    code = str(exc)
    if not re.fullmatch(r'WORD_[A-Z_]+', code):
        return exc
    if not isinstance(exc, EditError):
        exc = EditError(code)
    for key, value in detail.items():
        if value is not None:
            exc.detail.setdefault(key, value)
    return exc


def anchor_mismatch(current, before):
    """Show the model the node's actual current text and where its copy diverged."""
    at = next((i for i, (a, b) in enumerate(zip(current, before)) if a != b), min(len(current), len(before)))
    error('WORD_EDIT_ANCHOR_MISMATCH', current_text=bounded(current),
          current_text_truncated=True if len(current) > MAX_DETAIL_TEXT else None,
          current_length=len(current), before_length=len(before), first_difference_at=at,
          current_near_difference=current[max(0, at - 20):at + 40],
          before_near_difference=before[max(0, at - 20):at + 40],
          hint='before 必须等于该节点当前完整文字（含本日志中已保存的修改）；可改用 find/replace 只写要替换的片段。')


def occurrences(text, needle):
    positions, start = [], text.find(needle)
    while start != -1:
        positions.append(start)
        start = text.find(needle, start + 1)
    return positions


def regular_bytes(path, limit=MAX_LOG):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1 or not 0 < path.stat().st_size <= limit:
        error('WORD_EDIT_FILE_INVALID')
    return path.read_bytes()


def decode_json(raw):
    try:
        result = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError):
        error('WORD_EDIT_JSON_INVALID')
    if not isinstance(result, (dict, list)):
        error('WORD_EDIT_JSON_INVALID')
    return result


def read_json(path):
    return decode_json(regular_bytes(path))


def read_operation_batch(input_path, operations_path):
    raw = regular_bytes(operations_path)
    additions = decode_json(raw)
    additions = additions if isinstance(additions, list) else [additions]
    policy = Path(input_path).resolve().parent / RECOVERY_BATCH_POLICY
    if policy.exists() or policy.is_symlink():
        if regular_bytes(policy, 256) != RECOVERY_BATCH_POLICY_BYTES:
            error('WORD_EDIT_BATCH_POLICY_INVALID')
        # A single indivisible operation (e.g. inserting an entire period column)
        # can still be assembled from small local fragments and applied atomically.
        count = sum(len(unit) if isinstance(unit, list) else 1 for unit in additions)
        if count > RECOVERY_BATCH_OPERATIONS or count > 1 and len(raw) > RECOVERY_BATCH_BYTES:
            error('WORD_EDIT_BATCH_LIMIT')
    return additions


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


def encrypted_office_source(source):
    """Recognize Office encryption stream directory records in a bounded CFB.

    This classifies an already rejected non-ZIP source; it does not parse,
    decrypt or accept the package. Ordinary legacy DOC files remain unreadable.
    """
    raw = regular_bytes(source, 100 * 1024 * 1024)
    if len(raw) < 512 or raw[:8] != bytes.fromhex('d0cf11e0a1b11ae1'):
        return False
    if raw[28:30] != b'\xfe\xff' or int.from_bytes(raw[30:32], 'little') not in (9, 12):
        return False
    # EncryptedPackage also covers rights-managed Office files whose key
    # metadata lives in DataSpaces instead of an EncryptionInfo stream.
    marker = ('EncryptedPackage' + '\0').encode('utf-16le')
    offset = raw.find(marker, 512)
    while offset != -1:
        if (offset % 128 == 0 and offset + 128 <= len(raw)
                and int.from_bytes(raw[offset + 64:offset + 66], 'little') == len(marker)
                and raw[offset + 66] == 2):
            return True
        offset = raw.find(marker, offset + 1)
    return False


def prepare_source_manifest(source):
    """Classify confirmed source data faults without hiding host/IO failures."""
    try:
        return build_manifest(source)
    except BadZipFile:
        if encrypted_office_source(source):
            error('WORD_EDIT_SOURCE_ENCRYPTED')
        error('WORD_EDIT_SOURCE_UNREADABLE')
    except (ET.XMLSyntaxError, zlib.error):
        error('WORD_EDIT_SOURCE_UNREADABLE')
    except ValueError as exc:
        # These are the bounded package reader's fixed source-data errors. A
        # missing file, permission error or unexpected manifest bug still reaches
        # the CLI as WORD_EDIT_FAILED rather than blaming the user's document.
        if str(exc) in {'WORD_PACKAGE_TOO_LARGE', 'WORD_PACKAGE_INVALID', 'WORD_XML_UNSAFE'}:
            error('WORD_EDIT_SOURCE_UNREADABLE')
        raise


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
        self.inserted_cells = set()
        self.deleted_tables = set()
        self.property_changes = {}
        self.changed_parts = set()
        self.operations = []
        self.operation_ids = set()
        self.comments = []
        self.format_origins = {}
        self.format_plan = None

    def revision_marker(self, kind):
        """Create a structural revision marker with a document-unique id."""
        if not hasattr(self, '_next_revision'):
            self._next_revision = max([int(n.get(q('id'))) for root in self.roots.values() for n in root.iter()
                                       if (n.get(q('id')) or '').isdigit()] + [0]) + 1
        marker = ET.Element(q(kind), {q('id'): str(self._next_revision), q('author'): self.data['revision_author']})
        if self.data.get('revision_date'):
            marker.set(q('date'), self.data['revision_date'])
        self._next_revision += 1
        return marker

    def target(self, node_id, tag=None):
        if not isinstance(node_id, str) or node_id not in self.nodes:
            error('WORD_EDIT_NODE_NOT_FOUND', node_id=bounded(node_id, 200) if isinstance(node_id, str) else None,
                  hint='node_id 须从 inspect 结果原样复制；新增节点为 op:<操作id>:paragraph 等。可用 inspect --find 按文字查找。')
        part, node = self.nodes[node_id]
        if tag is not None and node.tag != q(tag):
            error('WORD_EDIT_NODE_KIND_MISMATCH', node_id=node_id, actual_kind=KINDS.get(node.tag),
                  expected_kind=KINDS.get(q(tag)))
        return part, node

    def replace_paragraph(self, node_id, before, after):
        part, node = self.target(node_id, 'p')
        if paragraph_text(node) != before:
            anchor_mismatch(paragraph_text(node), before)
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

    def remember_properties(self, part, node):
        # Preserve the first state, including across several new reporting columns.
        self.property_changes.setdefault(node, (part, copy.deepcopy(node)))

    def insert_column(self, part, table, operation):
        """Add a period to a rectangular table without widening its original grid."""
        if table.tag != q('tbl'):
            error('WORD_EDIT_NODE_KIND_MISMATCH')
        limits = capability_limits(table)
        if any(limit in limits for limit in ('existing_revisions', 'fields_or_embedded_objects', 'section_break')) or table.findall('.//' + q('tbl')):
            error('WORD_EDIT_COMPLEX_COLUMN_UNSUPPORTED')
        # Vertical merges do not change a row's physical cell count; the new
        # column is independent and must not inherit vMerge. Horizontal spans
        # and irregular grids still need a different grid-splitting design.
        if any(n.tag in {q('gridSpan'), q('hMerge'), q('gridBefore'), q('gridAfter')} for n in table.iter()):
            error('WORD_EDIT_COMPLEX_COLUMN_UNSUPPORTED')
        grid = table.find(q('tblGrid'))
        rows = table.findall(q('tr'))
        columns = grid.findall(q('gridCol')) if grid is not None else []
        index = operation.get('column_index')
        position = operation.get('position', 'before')
        if type(index) is not int or not 0 <= index < len(columns):
            error('WORD_EDIT_COLUMN_INDEX_INVALID')
        if position not in {'before', 'after'}:
            error('WORD_EDIT_POSITION_INVALID')
        values = operation.get('values')
        if not rows or not isinstance(values, list) or len(values) != len(rows):
            error('WORD_EDIT_COLUMN_VALUES_INVALID')
        physical = [row.findall(q('tc')) for row in rows]
        if any(len(cells) != len(columns) for cells in physical):
            error('WORD_EDIT_COMPLEX_COLUMN_UNSUPPORTED')
        try:
            widths = [int(col.get(q('w'))) for col in columns]
        except (ValueError, TypeError):
            error('WORD_EDIT_COLUMN_WIDTH_UNSUPPORTED')
        if any(w <= 0 for w in widths) or sum(widths) < len(widths) + 1:
            error('WORD_EDIT_COLUMN_WIDTH_UNSUPPORTED')
        if any(cell.find(q('tcPr')) is None for cells in physical for cell in cells):
            error('WORD_EDIT_COLUMN_WIDTH_UNSUPPORTED')

        # Validate/construct every cell before changing the table. Copy only style
        # properties, never source text, bookmarks, relationships or comments.
        additions = []
        for cells, value in zip(physical, values):
            source = cells[index]
            ps = source.findall(q('p'))
            texts = [value] if isinstance(value, str) else value
            if not isinstance(texts, list) or len(texts) != len(ps) or not ps or source.findall(q('tbl')):
                error('WORD_EDIT_COMPLEX_CELL_UNSUPPORTED')
            added = ET.Element(q('tc'))
            copied = copy.deepcopy(source.find(q('tcPr')))
            merge = copied.find(q('vMerge'))
            if merge is not None:
                copied.remove(merge)
            added.append(copied)
            for p, value in zip(ps, texts):
                added.append(self.clone_paragraph(p, text_value(value)))
            additions.append(added)

        insert_at = index + (position == 'after')
        weights = widths[:insert_at] + [widths[index]] + widths[insert_at:]
        total, denominator = sum(widths), sum(weights)
        # Exact integer distribution retains total width; no cumulative drift.
        fitted = [total * w // denominator for w in weights]
        for i in sorted(range(len(weights)), key=lambda i: (-(total * weights[i] % denominator), i))[:total - sum(fitted)]:
            fitted[i] += 1
        if any(w <= 0 for w in fitted):
            error('WORD_EDIT_COLUMN_WIDTH_UNSUPPORTED')
        self.remember_properties(part, grid)
        grid.insert(insert_at, copy.deepcopy(columns[index]))
        for col, width in zip(grid.findall(q('gridCol')), fitted):
            col.set(q('w'), str(width))
        inserted_owners = {self.nodes[key][1] for key in self.inserted_cells | self.inserted_rows}
        for row_index, (row, cells, added) in enumerate(zip(rows, physical, additions)):
            anchor = cells[index]
            row.insert(row.index(anchor) + (position == 'after'), added)
            key = f'op:{operation["id"]}:cell:{row_index}'
            self.nodes[key] = (part, added)
            self.inserted_cells.add(key)
            for pindex, p in enumerate(added.findall(q('p'))):
                suffix = ':paragraph' if pindex == 0 else f':paragraph:{pindex}'
                self.nodes[key + suffix] = (part, p)
            for cell, width in zip(row.findall(q('tc')), fitted):
                props = cell.find(q('tcPr'))
                if cell is not added and cell not in inserted_owners and row not in inserted_owners:
                    self.remember_properties(part, props)
                cell_width = props.find(q('tcW'))
                if cell_width is None:
                    cell_width = ET.Element(q('tcW'))
                    props.insert(0, cell_width)
                cell_width.set(q('type'), 'dxa')
                cell_width.set(q('w'), str(width))
        self.changed_parts.add(part)

    def new_paragraph(self, style_node, text):
        if style_node is not None:
            return self.clone_paragraph(style_node, text)
        paragraph = ET.Element(q('p'))
        run = ET.SubElement(paragraph, q('r'))
        value = ET.SubElement(run, q('t'))
        value.text = text
        return paragraph

    def insert_table(self, part, anchor, operation):
        """Insert a plain table after/before an existing paragraph or table.

        The table is intentionally rectangular; merged grids are handled by
        insert_row/insert_column, while a brand-new table has no source merges.
        """
        if anchor.tag not in {q('p'), q('tbl')}:
            error('WORD_EDIT_NODE_KIND_MISMATCH')
        rows = operation.get('rows')
        if not isinstance(rows, list) or not 1 <= len(rows) <= 100:
            error('WORD_EDIT_TABLE_ROWS_INVALID')
        width_count = len(rows[0]) if isinstance(rows[0], list) else 0
        if not 1 <= width_count <= 20 or any(not isinstance(row, list) or len(row) != width_count for row in rows):
            error('WORD_EDIT_TABLE_ROWS_INVALID')
        values = [[text_value(value) for value in row] for row in rows]
        if not any(value.strip() for row in values for value in row):
            error('WORD_EDIT_TABLE_ROWS_INVALID')
        position = operation.get('position', 'after')
        if position not in {'before', 'after'}:
            error('WORD_EDIT_POSITION_INVALID')
        style_node = None
        style_key = operation.get('style_node_id')
        if style_key is not None:
            _, style_node = self.target(style_key, 'p')
        elif anchor.tag == q('p'):
            style_node = anchor
        else:
            style_node = next(anchor.iter(q('p')), None)
        table = ET.Element(q('tbl'))
        if anchor.tag == q('tbl') and anchor.find(q('tblPr')) is not None:
            table.append(copy.deepcopy(anchor.find(q('tblPr'))))
        else:
            props = ET.SubElement(table, q('tblPr'))
            ET.SubElement(props, q('tblW'), {q('w'): '5000', q('type'): 'pct'})
            ET.SubElement(props, q('tblLayout'), {q('type'): 'fixed'})
            borders = ET.SubElement(props, q('tblBorders'))
            for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
                ET.SubElement(borders, q(side), {q('val'): 'single', q('sz'): '4', q('color'): 'B8C2BD'})
            margins = ET.SubElement(props, q('tblCellMar'))
            for side in ('top', 'left', 'bottom', 'right'):
                ET.SubElement(margins, q(side), {q('w'): '80', q('type'): 'dxa'})
        widths = [5000 // width_count] * width_count
        widths[-1] += 5000 - sum(widths)
        grid = ET.SubElement(table, q('tblGrid'))
        for width in widths:
            ET.SubElement(grid, q('gridCol'), {q('w'): str(width)})
        self.nodes[f'op:{operation["id"]}:table'] = (part, table)
        for row_index, row in enumerate(values):
            tr = ET.SubElement(table, q('tr'))
            props = ET.SubElement(tr, q('trPr'))
            ET.SubElement(props, q('cantSplit'))
            if row_index == 0:
                ET.SubElement(props, q('tblHeader'))
            row_key = f'op:{operation["id"]}:row:{row_index}'
            self.nodes[row_key] = (part, tr)
            self.inserted_rows.add(row_key)
            for cell_index, value in enumerate(row):
                tc = ET.SubElement(tr, q('tc'))
                cell_props = ET.SubElement(tc, q('tcPr'))
                ET.SubElement(cell_props, q('tcW'), {q('w'): str(widths[cell_index]), q('type'): 'pct'})
                ET.SubElement(cell_props, q('vAlign'), {q('val'): 'center'})
                paragraph = self.new_paragraph(style_node, value)
                tc.append(paragraph)
                cell_key = f'op:{operation["id"]}:cell:{row_index}:{cell_index}'
                self.nodes[cell_key] = (part, tc)
                self.inserted_cells.add(cell_key)
                paragraph_key = cell_key + ':paragraph'
                self.nodes[paragraph_key] = (part, paragraph)
                self.inserted_paragraphs.add(paragraph_key)
                if style_key is not None:
                    self.format_origins[paragraph_key] = style_key
        parent = anchor.getparent()
        parent.insert(parent.index(anchor) + (position == 'after'), table)
        self.changed_parts.add(part)

    def delete_table(self, part, table, operation):
        """Mark every row deleted; accept removes the rows/table, reject keeps it."""
        if table.tag != q('tbl'):
            error('WORD_EDIT_NODE_KIND_MISMATCH')
        limits = capability_limits(table)
        if 'existing_revisions' in limits or 'fields_or_embedded_objects' in limits:
            error('WORD_EDIT_COMPLEX_TABLE_UNSUPPORTED')
        rows = table.findall(q('tr'))
        if not rows:
            error('WORD_EDIT_COMPLEX_TABLE_UNSUPPORTED')
        for row in rows:
            props = row.find(q('trPr'))
            if props is None:
                props = ET.Element(q('trPr'))
                row.insert(0, props)
            if props.find(q('del')) is None:
                props.append(self.revision_marker('del'))
        self.deleted_tables.add(operation['node_id'])
        self.changed_parts.add(part)

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
                  'insert_column': {'column_index', 'position', 'values'},
                  'insert_row': {'values', 'position'},
                  'insert_table': {'rows', 'style_node_id', 'position'},
                  'delete_table': set(), 'add_comment': {'text'}}
        if kind not in fields:
            error('WORD_EDIT_OPERATION_UNSUPPORTED')
        if set(operation) - common - fields[kind] or not {'id', 'kind', 'node_id', 'before'} <= set(operation):
            error('WORD_EDIT_OPERATION_INVALID')
        if 'reason' in operation:
            text_value(operation['reason'])
        part, node = self.target(operation['node_id'])
        before = text_value(operation['before'])
        if node_text(node) != before:
            anchor_mismatch(node_text(node), before)
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
        elif kind == 'insert_column':
            self.insert_column(part, node, operation)
        elif kind == 'insert_table':
            self.insert_table(part, node, operation)
        elif kind == 'delete_table':
            self.delete_table(part, node, operation)
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
                # Existing revisions, fields and section breaks cannot be cloned
                # safely. Horizontal/vertical merges can: copy each source cell's
                # tcPr and keep its gridSpan; turn a vMerge restart into a
                # continuation so the new row extends an existing vertical merge.
                limits = capability_limits(node)
                if any(limit in limits for limit in ('existing_revisions', 'fields_or_embedded_objects', 'section_break')):
                    error('WORD_EDIT_COMPLEX_ROW_UNSUPPORTED')
                cells = node.findall(q('tc'))
                values = operation.get('values')
                if not isinstance(values, list) or len(values) != len(cells) or not cells:
                    error('WORD_EDIT_ROW_VALUES_INVALID')
                table = node.getparent()
                if table.tag != q('tbl') or table.findall(q('tbl')):
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
                        copied = copy.deepcopy(props)
                        merge = copied.find(q('vMerge'))
                        if merge is not None and merge.get(q('val')) == 'restart':
                            merge.set(q('val'), 'continue')
                        new_cell.append(copied)
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
        for index, operation in enumerate(operations):
            try:
                self.apply(operation)
            except ValueError as exc:
                raise annotate(exc, phase='replay', replay_operation_index=index,
                               replay_operation_id=operation.get('id') if isinstance(operation, dict) else None) from exc
        return self

    def resolve(self, operation):
        """Expand model shorthand into the canonical, replayable operation.

        find/replace: the tool reads the node's current text, requires exactly one
        occurrence and writes the full before/after into the log, so replay and
        all downstream checks see the same canonical operation as before.
        Anchor-only kinds may omit before; the tool fills the current text.
        """
        if not isinstance(operation, dict):
            return operation
        kind = operation.get('kind')
        if 'find' not in operation and 'replace' not in operation:
            if 'before' not in operation and kind in ANCHOR_ONLY_KINDS:
                _, node = self.target(operation.get('node_id'))
                return {**operation, 'before': node_text(node)}
            return operation
        if kind not in {'replace_text', 'replace_cell_text'} or 'before' in operation or 'after' in operation \
                or 'find' not in operation or 'replace' not in operation:
            error('WORD_EDIT_FIND_REPLACE_INVALID',
                  hint='find/replace 仅用于 replace_text 或 replace_cell_text，且不能与 before/after 同时出现。')
        find, replace = text_value(operation['find']), text_value(operation['replace'])
        if not find:
            error('WORD_EDIT_FIND_REPLACE_INVALID', hint='find 不能为空。')
        _, node = self.target(operation.get('node_id'), 'p' if kind == 'replace_text' else 'tc')
        texts = [paragraph_text(node)] if kind == 'replace_text' else [paragraph_text(p) for p in node.findall(q('p'))]
        hits = [(index, position) for index, text in enumerate(texts) for position in occurrences(text, find)]
        if len(hits) != 1:
            joined = '\n'.join(texts)
            error('WORD_EDIT_FIND_NOT_FOUND' if not hits else 'WORD_EDIT_FIND_AMBIGUOUS',
                  node_id=operation.get('node_id'), occurrence_count=len(hits),
                  contexts=[texts[i][max(0, at - 20):at + len(find) + 20] for i, at in hits[:10]] or None,
                  current_text=bounded(joined), current_text_truncated=True if len(joined) > MAX_DETAIL_TEXT else None,
                  hint='find 必须在该节点当前文字中恰好出现一次（不跨段落）；出现多次时加上前后文字使其唯一。')
        hit_index, at = hits[0]
        after = [text[:at] + replace + text[at + len(find):] if index == hit_index else text
                 for index, text in enumerate(texts)]
        resolved = {key: value for key, value in operation.items() if key not in {'find', 'replace'}}
        resolved['before'] = node_text(node)
        resolved['after'] = after[0] if len(after) == 1 else after
        return resolved

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
            target_keys = self.touched | self.inserted_paragraphs | self.inserted_rows | self.inserted_cells | comment_targets
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
            for source, (story, previous) in self.property_changes.items():
                if story != part:
                    continue
                destination = at_path(root, path_to(self.roots[part], source))
                kind = 'tblGridChange' if source.tag == q('tblGrid') else 'tcPrChange'
                marker = patcher.revision_node(ET.Element(q('r')), 'ins')
                marker.remove(marker[0])
                marker.tag = q(kind)
                if kind == 'tblGridChange':
                    # CT_TblGridChange carries only an id; its inserted cells
                    # carry the author used for selective rejection.
                    marker.attrib.pop(q('author'), None)
                    marker.attrib.pop(q('date'), None)
                marker.append(copy.deepcopy(previous))
                destination.append(marker)
            inserted = self.inserted_paragraphs | self.inserted_rows | self.inserted_cells
            inserted_nodes = {self.nodes[key][1] for key in inserted}
            for key in sorted(inserted):
                if self.nodes[key][0] != part:
                    continue
                if any(ancestor in inserted_nodes for ancestor in self.nodes[key][1].iterancestors()):
                    # The outer inserted row/cell owns the structural revision.
                    continue
                node = destinations[key]
                if node.tag in {q('tr'), q('tc')}:
                    prop = 'trPr' if node.tag == q('tr') else 'tcPr'
                    props = node.find(q(prop))
                    if props is None:
                        props = ET.Element(q(prop))
                        node.insert(0, props)
                    marker = patcher.revision_node(ET.Element(q('r')), 'ins')
                    marker.remove(marker[0])
                    if node.tag == q('tc'):
                        marker.tag = q('cellIns')
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
        return bool(self.inserted_paragraphs or self.inserted_rows or self.inserted_cells or self.deleted_tables or self.comments or any(
            paragraph_text(self.original_paragraphs[key]) != paragraph_text(self.nodes[key][1])
            for key in self.touched if key in self.original_paragraphs))


def load_log(input_path, operations_path=None):
    data, source, raw = load_input(input_path)
    log = read_json(operations_path) if operations_path and Path(operations_path).exists() else empty_log(data, raw)
    validate_log(log, data, raw)
    return data, source, raw, log


def load_editor(input_path, operations_path=None):
    data, source, raw, log = load_log(input_path, operations_path)
    return data, source, raw, log, Editor(data, source).replay(log['operations'])


def apply_unit(editor, unit, unit_index):
    """Apply one atomic unit (an operation or a list of operations) and return the canonical ops."""
    operations = unit if isinstance(unit, list) else [unit]
    if not operations:
        error('WORD_EDIT_OPERATION_INVALID', unit_index=unit_index)
    resolved = []
    for offset, operation in enumerate(operations):
        try:
            canonical = editor.resolve(operation)
            editor.apply(canonical)
        except ValueError as exc:
            info = operation if isinstance(operation, dict) else {}
            raise annotate(exc, unit_index=unit_index, operation_index_in_unit=offset if isinstance(unit, list) else None,
                           operation_id=info.get('id'), node_id=info.get('node_id'), kind=info.get('kind')) from exc
        resolved.append(canonical)
    return resolved


def apply_batch(input_path, operations_path, additions, partial=False):
    data, source, raw, log, editor = load_editor(input_path, operations_path)
    count = sum(len(unit) if isinstance(unit, list) else 1 for unit in additions)
    if len(log['operations']) + count > MAX_OPERATIONS:
        error('WORD_EDIT_OPERATION_LIMIT')
    accepted, rejected, skipped = [], [], []
    for index, unit in enumerate(additions):
        if not partial:
            if isinstance(unit, list):
                error('WORD_EDIT_OPERATION_INVALID', unit_index=index,
                      hint='嵌套数组（原子组）仅在 apply --partial 下使用。')
            accepted.extend(apply_unit(editor, unit, index))
            continue
        if len(rejected) >= MAX_PARTIAL_REJECTIONS:
            skipped.append(index)
            continue
        try:
            accepted.extend(apply_unit(editor, unit, index))
        except ValueError as exc:
            code = str(exc) if re.fullmatch(r'WORD_[A-Z_]+', str(exc)) else 'WORD_EDIT_FAILED'
            operations = unit if isinstance(unit, list) else [unit]
            rejected.append({'unit_index': index, 'error': code,
                             'operation_ids': [o.get('id') for o in operations if isinstance(o, dict)],
                             'detail': exc.detail if isinstance(exc, EditError) else {}})
            # A failed unit may have changed the in-memory document before it
            # failed; rebuild from the saved log plus accepted units.
            editor = Editor(data, source).replay(log['operations'] + accepted)
    if accepted:
        log['operations'].extend(accepted)
        write_json(operations_path, log)
    result = {'version': VERSION, 'operation_count': len(log['operations']),
              'accepted_operation_ids': [o['id'] for o in accepted][-200:],
              'added_node_ids': [key for key in editor.nodes if key.startswith('op:')][-200:]}
    if partial:
        result.update(status='partial' if rejected or skipped else 'applied', rejected_units=rejected,
                      not_attempted_unit_indices=skipped or None)
        if skipped:
            result['hint'] = f'已有 {MAX_PARTIAL_REJECTIONS} 组失败，其余组未尝试；先按 rejected_units 修正再提交。'
    return result


def revert(input_path, operations_path, op_ids=None, from_op_id=None):
    data, source, raw, log = load_log(input_path, operations_path)
    if not Path(operations_path).exists():
        error('WORD_EDIT_LOG_REQUIRED')
    operations = log['operations']
    ids = [o.get('id') for o in operations]
    if bool(op_ids) == bool(from_op_id):
        error('WORD_EDIT_ARGUMENT_REQUIRED', hint='revert 需要 --op-id（可重复）或 --from-op-id 其中之一。')
    if from_op_id:
        if from_op_id not in ids:
            error('WORD_EDIT_REVERT_TARGET_NOT_FOUND', missing=[from_op_id])
        keep = operations[:ids.index(from_op_id)]
    else:
        missing = [i for i in op_ids if i not in ids]
        if missing:
            error('WORD_EDIT_REVERT_TARGET_NOT_FOUND', missing=missing[:50])
        keep = [o for o in operations if o.get('id') not in set(op_ids)]
    try:
        Editor(data, source).replay(keep)
    except ValueError as exc:
        detail = exc.detail if isinstance(exc, EditError) else {}
        error('WORD_EDIT_REVERT_CONFLICT', cause=str(exc), blocking_operation_id=detail.get('replay_operation_id'),
              hint='保留的后续操作依赖被撤销的操作（原文或新增节点）；一并撤销它们，或改用 --from-op-id。')
    kept = {o.get('id') for o in keep}
    removed = [i for i in ids if i not in kept]
    log['operations'] = keep
    write_json(operations_path, log)
    return {'version': VERSION, 'operation_count': len(keep), 'removed_operation_ids': removed[-200:],
            'removed_operation_count': len(removed)}


def reset(input_path, operations_path):
    data, source, raw, log = load_log(input_path, operations_path)
    removed = len(log['operations'])
    write_json(operations_path, empty_log(data, raw))
    return {'version': VERSION, 'operation_count': 0, 'removed_operation_count': removed}


def inspect_page(editor, raw, node=None, find=None, kind=None, offset=0, limit=30, max_chars=INSPECT_MAX_CHARS):
    if offset < 0 or not 1 <= limit <= 200:
        error('WORD_EDIT_PAGE_INVALID', offset=offset, limit=limit, max_limit=200)
    if max_chars < 1000:
        error('WORD_EDIT_PAGE_INVALID', max_chars=max_chars, min_max_chars=1000)
    if node:
        editor.target(node)
        selected = {node: editor.nodes[node]}
    else:
        selected = editor.nodes
        if kind:
            selected = {key: value for key, value in selected.items() if KINDS.get(value[1].tag) == kind}
        if find:
            selected = {key: value for key, value in selected.items() if find in node_text(value[1])}
    total = len(selected)
    window = list(selected.items())[offset:offset + limit]
    nodes, used = [], 0
    for key, value in window:
        described = describe_nodes(editor.nodes, selected={key: value})[0]
        size = len(json.dumps(described, ensure_ascii=False))
        if nodes and used + size > max_chars:
            break
        nodes.append(described)
        used += size
    following = offset + len(nodes)
    result = {'version': 'word-edit-inspect-v1', 'baseline_sha256': sha(raw),
              'offset_unit': 'unicode_code_points', 'total': total, 'nodes': nodes,
              'next_offset': following if following < total else None}
    if len(nodes) < len(window):
        result['truncated_by_size'] = True
        result['hint'] = f'单次输出上限约 {max_chars} 字符；用 --offset {following} 继续，或用 --node 读取单个节点。'
    return result


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
    parser.add_argument('command', choices=['prepare', 'inspect', 'apply', 'finalize', 'no_changes', 'preflight',
                                            'revert', 'reset'])
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
    parser.add_argument('--find')
    parser.add_argument('--kind', choices=sorted(set(KINDS.values())))
    parser.add_argument('--max-chars', type=int, default=INSPECT_MAX_CHARS)
    parser.add_argument('--partial', action='store_true')
    parser.add_argument('--op-id', action='append')
    parser.add_argument('--from-op-id')
    parser.add_argument('--confirm-reset', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            data, source, raw = load_input(args.input)
            if not args.manifest:
                error('WORD_EDIT_MANIFEST_REQUIRED')
            manifest = prepare_source_manifest(source)
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
        elif args.command == 'apply':
            if not args.operations or not args.operation_file:
                error('WORD_EDIT_ARGUMENT_REQUIRED')
            additions = read_operation_batch(args.input, args.operation_file)
            result = apply_batch(args.input, args.operations, additions, partial=args.partial)
            if result.get('status') == 'partial':
                print(json.dumps(result, ensure_ascii=False))
                print(json.dumps({'error': 'WORD_EDIT_PARTIAL_APPLY'}), file=sys.stderr)
                return 3
        elif args.command == 'revert':
            if not args.operations:
                error('WORD_EDIT_ARGUMENT_REQUIRED')
            result = revert(args.input, args.operations, args.op_id, args.from_op_id)
        elif args.command == 'reset':
            if not args.operations or not args.confirm_reset:
                error('WORD_EDIT_ARGUMENT_REQUIRED', hint='reset 会清空本轮全部已保存操作，需要 --confirm-reset。')
            result = reset(args.input, args.operations)
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
            else:
                result = inspect_page(editor, raw, node=args.node, find=args.find, kind=args.kind,
                                      offset=args.offset, limit=args.limit, max_chars=args.max_chars)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and re.fullmatch(r'WORD_[A-Z_]+', str(exc)) else 'WORD_EDIT_FAILED'
        payload = {'error': code}
        if args.command in DETAIL_COMMANDS and isinstance(exc, EditError) and exc.detail and code != 'WORD_EDIT_FAILED':
            payload['detail'] = exc.detail
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
