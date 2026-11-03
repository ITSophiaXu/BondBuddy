"""Source-row to actual replay occurrence inventory; never a financial acceptance.

Literal XLSX labels define groups; no case amounts, alias inference, period choice,
unit conversion or scope decision is supplied by this helper. Every match is pending
actual review, including original paragraphs without an operation.
"""
from __future__ import annotations
import argparse
import json
import posixpath
import re
from io import BytesIO
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zipfile import ZipFile
from lxml import etree as ET
from .fixed_edit import Editor, load_editor, regular_bytes, write_json
from .check import resolve_revisions
from .template_manifest import node_text, sha
from .word_patch import q, xml

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
IDENTITIES = ('法定代表人', '董事长', '总经理', '注册地址', '办公地址', '联系电话', '邮政编码')
FINANCIAL_ROLES = {'financial', 'interimFinancial', 'audit', 'notes'}
NUMBER = re.compile(r'(?<![\dA-Za-z])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\dA-Za-z])')
# Literal language only, not a conclusion about which period a fact belongs to.
PERIOD_LANGUAGE = re.compile(r'报告期|本期|当期|最近[一二三四五六七八九十两\d]+年(?:及|和)[一二三四五六七八九十\d]+期(?:末)?')


def compact(value):
    return re.sub(r'\s+', '', value or '')


def accepted_nodes(editor):
    for root in editor.roots.values():
        resolve_revisions(root, True)
    return {key: (part, node) for key, (part, node) in editor.nodes.items()
            if node.tag in (q('p'), q('tr')) and editor.roots[part] in node.iterancestors()}


def source_rows(path, material):
    raw = regular_bytes(path, 100 * 1024 * 1024)
    if sha(raw) != material.get('sha256'):
        raise ValueError('REVERSE_AUDIT_SOURCE_HASH_MISMATCH')
    with ZipFile(BytesIO(raw)) as z:
        if sum(i.file_size for i in z.infolist()) > 250_000_000:
            raise ValueError('REVERSE_AUDIT_XLSX_EXPANSION_LIMIT')
        names = z.namelist()
        if len(names) != len(set(names)):
            raise ValueError('REVERSE_AUDIT_DUPLICATE_ZIP_MEMBER')
        shared = []
        if 'xl/sharedStrings.xml' in names:
            shared = [''.join(n.itertext()) for n in xml(z.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        rels = {}
        for r in xml(z.read('xl/_rels/workbook.xml.rels')):
            if r.get('TargetMode') == 'External':
                continue
            target = r.get('Target', '')
            name = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not name.startswith('xl/') or '..' in name.split('/'):
                raise ValueError('REVERSE_AUDIT_XLSX_RELATION_UNSAFE')
            rels[r.get('Id')] = name
        for sheet in xml(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            part = rels.get(sheet.get('{' + REL + '}id'))
            if not part or part not in names:
                raise ValueError('REVERSE_AUDIT_XLSX_SHEET_UNAVAILABLE')
            rows = []
            for row in xml(z.read(part)).findall('s:sheetData/s:row', NS):
                cells = []
                for cell in row.findall('s:c', NS):
                    address, kind = cell.get('r'), cell.get('t')
                    if not address or not re.fullmatch(r'[A-Z]+[1-9]\d*', address):
                        raise ValueError('REVERSE_AUDIT_XLSX_CELL_ADDRESS')
                    value, formula = cell.find('s:v', NS), cell.find('s:f', NS)
                    cached = value.text if value is not None else None
                    if kind == 's':
                        if cached is None or not re.fullmatch(r'\d{1,12}', cached) or not 0 <= int(cached) < len(shared):
                            raise ValueError('REVERSE_AUDIT_SHARED_STRING_INDEX')
                        text = shared[int(cached)]
                    elif kind == 'inlineStr':
                        inline = cell.find('s:is', NS)
                        text = ''.join(inline.itertext()) if inline is not None else ''
                    elif kind == 'str':
                        text = cached or ''
                    else:
                        text = ''
                    number = None
                    numeric_problem = False
                    if kind in (None, 'n') and cached is not None:
                        try:
                            if len(cached) <= 1024 and re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?', cached):
                                parsed = Decimal(cached)
                                digits, exponent = len(parsed.as_tuple().digits), parsed.as_tuple().exponent
                                if parsed.is_finite() and isinstance(exponent, int) and max(digits + max(exponent, 0), -exponent) <= 1024:
                                    number = format(parsed, 'f')
                            numeric_problem = number is None
                        except InvalidOperation:
                            numeric_problem = True
                    cells.append({'cell': address, 'text': text, 'raw_cached': cached,
                                  'decimal': number, 'formula': formula.text if formula is not None else None,
                                  'needs_confirmation': numeric_problem or formula is not None and number is None})
                rows.append(cells)
            headers = [c for row in rows[:10] for c in row if c['text']]
            for cells in rows:
                labels = [c for c in cells if re.search(r'[\u4e00-\u9fff]', c['text']) and 2 <= len(compact(c['text'])) <= 80]
                numeric = [c for c in cells if c['decimal'] is not None or c['needs_confirmation']]
                if not labels or not numeric:
                    continue
                # The leftmost literal row label is evidence, not a inferred metric.
                label = labels[0]
                yield {'material_id': material.get('material_id'), 'material_version': material.get('material_version'),
                       'sha256': material['sha256'], 'sheet': sheet.get('name'), 'sheet_state': sheet.get('state', 'visible'), 'part': part,
                       'label_cell': label['cell'], 'label': label['text'], 'match_label': compact(label['text']),
                       'headers': headers, 'cells': numeric, 'status': 'needs_review'}


def inventory(input_path, operations_path=None):
    operations_raw = None
    if operations_path is not None:
        try:
            operations_raw = regular_bytes(operations_path)
        except (OSError, ValueError) as exc:
            raise ValueError('REVERSE_AUDIT_OPERATIONS_REQUIRED') from exc
    data, source, raw, log, editor = load_editor(input_path, operations_path)
    if operations_raw is not None and json.loads(operations_raw) != log:
        raise ValueError('REVERSE_AUDIT_OPERATIONS_CHANGED')
    original = Editor(data, source)
    before = {key: node_text(node) for key, (_, node) in accepted_nodes(original).items()}
    comments = {}
    if 'word/comments.xml' in editor.parts:
        for c in xml(editor.parts['word/comments.xml']).findall(q('comment')):
            comments[c.get(q('id'))] = '\n'.join(node_text(p) for p in c.iter(q('p')))
    records = []
    comment_operations = [op for op in log['operations'] if op['kind'] == 'add_comment']
    current = accepted_nodes(editor)
    for key, (part, node) in current.items():
        text = node_text(node)
        if not text.strip():
            continue
        previous = node.getprevious()
        following = node.getnext()
        context = [node_text(n) for n in (previous, following) if n is not None]
        anchored = [comments[n.get(q('id'))] for n in node.iter(q('commentRangeStart')) if n.get(q('id')) in comments]
        replay_comments = [{'text': item['text'], 'source': 'operations.add_comment', 'node_id': item['node_id'],
                            'operation_ids': [op['id'] for op in comment_operations if op['node_id'] == item['node_id'] and op['text'] == item['text']]}
                           for item in editor.comments if item['node_id'] == key or
                           item['node_id'] in current and current[item['node_id']][1] in node.iter()]
        records.append({'node_id': key, 'part': part, 'kind': 'paragraph' if node.tag == q('p') else 'row',
                        'in_table': any(parent.tag == q('tc') for parent in node.iterancestors()),
                        'text': text, 'text_sha256': sha(text.encode()), 'baseline_text': before.get(key),
                        'changed': key not in before or before[key] != text, 'context': context,
                        'numeric_literals': NUMBER.findall(text), 'existing_comments': anchored, 'replay_comments': replay_comments,
                        'status': 'needs_review'})
    normalized_records = [(compact(r['text']), r) for r in records]
    root = Path(input_path).resolve().parent
    groups, unsupported, source_contexts = [], [], {}
    for material in data.get('materials', []):
        if material.get('role') not in FINANCIAL_ROLES:
            continue
        value = material.get('path')
        if not isinstance(value, str):
            raise ValueError('REVERSE_AUDIT_MATERIAL_PATH')
        path = root / value
        if not path.resolve().is_relative_to(root) or path.is_symlink():
            raise ValueError('REVERSE_AUDIT_MATERIAL_UNSAFE')
        if path.suffix.lower() != '.xlsx':
            unsupported.append({'material_id': material.get('material_id'), 'path': value, 'reason': 'not_a_literal_xlsx_row_source'})
            continue
        for row in source_rows(path, material):
            context_id = material['sha256'] + ':' + row['sheet']
            source_contexts.setdefault(context_id, row.pop('headers'))
            groups.append({**row, 'source_context_id': context_id,
                           'occurrence_ids': [r['node_id'] for text, r in normalized_records if row['match_label'] in text]})
    matched_groups = {}
    for index, group in enumerate(groups):
        for node_id in group['occurrence_ids']:
            matched_groups.setdefault(node_id, []).append(index)
    review_queue = []
    for record in records:
        language = list(dict.fromkeys(PERIOD_LANGUAGE.findall(compact(record['text']))))
        if (record['kind'] != 'paragraph' or record['part'] != 'word/document.xml'
                or record['in_table'] or record['changed'] or not record['numeric_literals']
                or not language or record['node_id'] not in matched_groups):
            continue
        # A correct new copy or a comment cannot remove the original occurrence
        # from this queue. Source rows may disagree or refer to other scopes;
        # therefore these are review candidates, never expected-value verdicts.
        review_queue.append({'node_id': record['node_id'], 'text_sha256': record['text_sha256'],
                             'reason': 'unchanged_periodic_financial_narrative',
                             'period_language': language,
                             'source_group_indices': matched_groups[record['node_id']],
                             'status': 'needs_review'})
    return {'version': 'source-reverse-audit-v1', 'status': 'needs_review', 'input_hash': data['input_hash'],
            'baseline_sha256': sha(raw), 'operations_sha256': sha(operations_raw) if operations_raw is not None else None,
            'operations_canonical_sha256': sha(json.dumps(log, sort_keys=True, ensure_ascii=False).encode()),
            'inventory_mode': 'operations_replay' if operations_raw is not None else 'baseline_preview',
            'limitations': ['Literal XLSX labels only: no alias, metric, current period, scope or unit inference.',
                            'Numbers are exact cached decimals; absent formula cache is never zero.',
                            'Matched rows and paragraphs overlap intentionally; inspect both label and adjacent value cells.',
                            'All matches require source/context review, including changed=false. This is not financial acceptance.',
                            'The review queue prioritizes unchanged periodic narratives; it does not infer current periods, scopes, units or expected amounts. Absence from the queue is not approval.',
                            'Identity matches include history/signatures. Read original and replay operation comments; no forced replacement.'],
            'source_groups': groups, 'source_contexts': source_contexts,
            'review_queue': review_queue,
            'occurrences': {r['node_id']: r for r in records}, 'unsupported_sources': unsupported,
            'excluded_nodes': [key for key, (_, node) in editor.nodes.items() if node.tag in (q('p'), q('tr')) and key not in current],
            'identity_occurrences': [{**r, 'labels': [label for label in IDENTITIES if label in compact(r['text'])]}
                                     for text, r in normalized_records if any(label in text for label in IDENTITIES)]}


def write_inventory_report(input_path, operations_path, report_path):
    """A diagnostic destination must never replace any declared input file."""
    from .preflight import checked_path, protect_report_path
    input_path = Path(input_path).absolute()
    root = input_path.parent.resolve()
    try:
        input_path = checked_path(root, input_path)
        input_raw = regular_bytes(input_path)
        declared = json.loads(input_raw)
        if not isinstance(declared, dict):
            raise ValueError('REVERSE_AUDIT_INPUT_INVALID')
        protected = [input_path]
        if operations_path is not None:
            protected.append(Path(operations_path).absolute())
        protected.extend(root / declared[key] for key in ('baseline_path', 'original_pdf_path', 'operations_path')
                         if isinstance(declared.get(key), str) and declared[key])
        protected.extend(root / material['path'] for material in declared.get('materials', [])
                         if isinstance(material, dict) and isinstance(material.get('path'), str) and material['path'])

        def destination():
            path = checked_path(root, report_path)
            relative = path.relative_to(root)
            if len(relative.parts) < 2 or relative.parts[0] not in ('scratch', 'output') or path.suffix != '.json':
                raise ValueError('REVERSE_AUDIT_REPORT_UNSAFE')
            protect_report_path(path, protected)
            return path

        report = destination()
    except (OSError, ValueError, TypeError) as exc:
        raise ValueError('REVERSE_AUDIT_REPORT_UNSAFE') from exc
    result = inventory(input_path, operations_path)
    try:
        destination()
        if regular_bytes(input_path) != input_raw:
            raise ValueError('REVERSE_AUDIT_INPUT_CHANGED')
    except (OSError, ValueError) as exc:
        raise ValueError('REVERSE_AUDIT_REPORT_UNSAFE') from exc
    write_json(report, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--operations')
    parser.add_argument('--report', required=True)
    args = parser.parse_args()
    result = write_inventory_report(args.input, args.operations, args.report)
    print(json.dumps({'version': result['version'], 'status': result['status'],
                      'source_groups': len(result['source_groups']), 'identity_occurrences': len(result['identity_occurrences']),
                      'unchanged_periodic_narratives': len(result['review_queue']),
                      'report': str(Path(args.report).absolute()), 'financial_acceptance': 'not_run'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
