"""Render worker-authored text through the existing native revision/clean writer.

No fact approval is manufactured: the request contains literal, source-bound edits,
model evidence references and pending questions. Word integrity is checked separately.
"""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path
from datetime import datetime, timezone
from docx import Document
from docx.shared import Pt
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from .writer import build, fail
from bondbuddy_no_history_word.writer import _canonicalize_docx

VERSION = 'bondbuddy-unified-word-1.0.0'
VERSION_V2 = 'bondbuddy-unified-word-2.0.0'
sha = lambda value: hashlib.sha256(value).hexdigest()


def document(stamp):
    doc = Document()
    style = doc.styles['Normal']
    style.font.name = 'SimSun'
    style.font.size = Pt(12)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
    language = OxmlElement('w:lang')
    language.set(qn('w:eastAsia'), 'zh-CN')
    style.element.rPr.append(language)
    moment = datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone(timezone.utc)
    doc.core_properties.created = moment
    doc.core_properties.modified = moment
    doc.core_properties.author = 'BondBuddy'
    return doc


def projection_blocks(request, source):
    """Validate literal projection data and coalesce contiguous rectangular row groups."""
    pdf_source = source is not None and request.get('media_type') == 'application/pdf'
    if (not pdf_source and (source is not None or request.get('source_sha256') is not None
                            or request.get('media_type') is not None or request.get('records', []) != [])
            or any(request.get(key, []) != [] for key in ('edits', 'additions'))
            or request.get('revision_handling') is not None):
        fail('WORD_PROJECTION_SOURCE_SCOPE_INVALID')
    if pdf_source:
        if sha(Path(source).read_bytes()) != request.get('source_sha256'):
            fail('WORD_SOURCE_HASH_MISMATCH')
        records = request.get('records')
        if (not isinstance(records, list) or not records or len(records) > 100_000
                or any(not isinstance(record, dict) or not isinstance(record.get('text'), str)
                       or not isinstance(record.get('id'), str) for record in records)):
            fail('WORD_PROJECTION_SOURCE_SCOPE_INVALID')
    blocks = request.get('blocks')
    if not isinstance(blocks, list) or len(blocks) > 100_000:
        fail('WORD_PROJECTION_INVALID')
    ids, merged, audits = set(), [], []
    seen_tables = set()
    required = {'block_id', 'order', 'kind', 'text', 'rows', 'evidence', 'pending', 'heading_level',
                'style_key', 'table_id', 'row_order'}
    for block in blocks:
        if (not isinstance(block, dict) or not required <= set(block)
                or set(block) - required - {'chapter_id', 'batch_id'}
                or not isinstance(block['block_id'], str) or not 1 <= len(block['block_id']) <= 256
                or block['block_id'] in ids or type(block['order']) is not int or block['order'] < 0
                or block['kind'] not in {'heading', 'paragraph', 'table'}
                or block['style_key'] not in {'heading', 'body', 'table', 'caption'}
                or not isinstance(block['text'], str)
                or any(key in block and (not isinstance(block[key], str) or not 1 <= len(block[key]) <= 256)
                       for key in ('chapter_id', 'batch_id'))
                or any(not isinstance(block[key], list) or any(not isinstance(value, str) or not value.strip()
                                                              for value in block[key]) for key in ('evidence', 'pending'))):
            fail('WORD_PROJECTION_INVALID')
        kind = block['kind']
        if (kind == 'heading' and (type(block['heading_level']) is not int or not 1 <= block['heading_level'] <= 9
                                   or block['style_key'] != 'heading')
                or kind != 'heading' and block['heading_level'] is not None
                or kind == 'paragraph' and block['style_key'] not in {'body', 'caption'}
                or kind == 'table' and block['style_key'] != 'table'
                or kind != 'table' and (block['rows'] != [] or block['table_id'] is not None or block['row_order'] is not None)):
            fail('WORD_PROJECTION_INVALID')
        ids.add(block['block_id'])
        audits.append({key: block[key] for key in ('block_id', 'order', 'kind', 'evidence', 'pending',
                                                 'heading_level', 'style_key', 'table_id', 'row_order')})
        audits[-1].update({key: block[key] for key in ('chapter_id', 'batch_id') if key in block})
        if kind != 'table':
            merged.append({**block, '_pending_records': [(block['block_id'], item) for item in block['pending']]})
            continue
        rows = block['rows']
        if (not isinstance(block['table_id'], str) or not 1 <= len(block['table_id']) <= 256
                or type(block['row_order']) is not int or block['row_order'] < 0
                or not isinstance(rows, list) or not 2 <= len(rows) <= 128 or not isinstance(rows[0], list)
                or not 1 <= len(rows[0]) <= 32 or any(not isinstance(row, list) or len(row) != len(rows[0])
                                                    or any(not isinstance(cell, str) for cell in row) for row in rows)
                or len(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > 32 * 1024):
            fail('WORD_PROJECTION_INVALID')
        pending = [(block['block_id'], item) for item in block['pending']]
        if block['table_id'] in seen_tables:
            previous = merged[-1] if merged else None
            if (not previous or previous['kind'] != 'table' or previous['table_id'] != block['table_id']
                    or block['row_order'] != len(previous['rows']) - 1 or rows[0] != previous['rows'][0]
                    or previous.get('chapter_id') != block.get('chapter_id')
                    or block['text'] not in ('', previous['text'])):
                fail('WORD_TABLE_CONTINUATION_INVALID')
            previous['rows'].extend([list(row) for row in rows[1:]])
            previous['_pending_records'].extend(pending)
        else:
            if block['row_order'] != 0:
                fail('WORD_TABLE_CONTINUATION_INVALID')
            seen_tables.add(block['table_id'])
            merged.append({**block, 'rows': [list(row) for row in rows], '_pending_records': pending})
    return merged, audits


def fixed_projection_styles(doc):
    for name in ['Caption'] + ['Heading %s' % level for level in range(1, 10)]:
        style = doc.styles[name]
        style.font.name = 'SimSun'
        style.font.size = Pt(12 if name == 'Caption' else max(12, 18 - int(name.split()[-1])))
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), '宋体')


def render(request, source, tracked, clean, baseline):
    v2 = request.get('version') == 'unified-word-request-v2'
    if request.get('version') not in {'unified-word-request-v1', 'unified-word-request-v2'}:
        fail('WORD_PLAN_NOT_SUPPORTED')
    stamp = request['date']
    blocks, audits = projection_blocks(request, source) if v2 else (request['blocks'], None)
    handling = request.get('revision_handling')
    if handling is not None:
        if (source is None or blocks or handling.get('version') != 'review-revision-handling-v1'
                or handling.get('review_passed') is not False
                or handling.get('source_material', {}).get('sha256') != request.get('source_sha256')
                or not handling.get('source_report', {}).get('report_id')
                or not handling.get('accepted_plan', {}).get('plan_id')):
            fail('WORD_REVISION_SCOPE_MISMATCH')
        allowed = set(request.get('revision_allowed_record_ids', []))
        changed = {edit['record_id'] for edit in request['edits']}
        changed.update(addition['after_record_id'] for addition in request.get('additions', []))
        if not changed or not changed.issubset(allowed):
            fail('WORD_REVISION_SCOPE_MISMATCH')
        items = handling.get('items', [])
        if (not items or len({item['finding_id'] for item in items}) != len(items)
                or any(item.get('review_passed') is not False
                       or item.get('report_id') != handling['source_report']['report_id']
                       or item.get('status') not in ('modified', 'not_modified', 'needs_evidence') for item in items)):
            fail('WORD_REVISION_SCOPE_MISMATCH')
        handled = {handling['source_material']['material_id'] + '/' + location['record_id']
                   for item in items if item['status'] == 'modified' for location in item['locations']}
        if changed != handled:
            fail('WORD_REVISION_SCOPE_MISMATCH')
    notes = []
    if source is None or v2:
        if not blocks or not any(b.get('kind') != 'heading' and (b.get('text') or b.get('rows')) for b in blocks):
            fail('WORD_EMPTY_MANUSCRIPT')
        doc = document(stamp)
        if v2:
            fixed_projection_styles(doc)
        for i, block in enumerate(blocks):
            if block['kind'] == 'heading':
                doc.add_heading(block['text'], level=block['heading_level'] if v2 else 1)
            elif block['kind'] == 'paragraph':
                doc.add_paragraph(block['text'], style='Caption' if v2 and block['style_key'] == 'caption' else 'Normal')
            elif block['kind'] == 'table':
                rows = block['rows']
                if not rows or not rows[0] or any(len(row) != len(rows[0]) for row in rows):
                    fail('WORD_TABLE_GRID_UNSUPPORTED')
                if block['text']:
                    doc.add_paragraph(block['text'], style='Caption' if v2 else 'Normal')
                table = doc.add_table(rows=len(rows), cols=len(rows[0]))
                table.style = 'Table Grid'
                for r, row in enumerate(rows):
                    for c, text in enumerate(row):
                        table.cell(r, c).text = text
            else:
                fail('WORD_BLOCK_UNSUPPORTED')
            pending_records = block['_pending_records'] if v2 else [(f'new-{i}', item) for item in block['pending']]
            for record_id, pending in pending_records:
                doc.add_paragraph('【待人工确认】' + pending)
                notes.append({'record_id': record_id, 'message': pending})
        doc.save(clean)
        value = _canonicalize_docx(Path(clean))
        baseline_value = value
        if v2 and source is not None:
            original = document(stamp)
            for record in request['records']:
                original.add_paragraph(record['text'])
            original.save(baseline)
            baseline_value = _canonicalize_docx(Path(baseline))
        # A direct PDF reconstruction has a real text baseline, but no source
        # OOXML anchors for genuine tracked edits. Never manufacture revisions.
        for path in (tracked, clean):
            Path(path).write_bytes(value)
        Path(baseline).write_bytes(baseline_value)
        pdf_source = v2 and source is not None
        return {'writer_version': VERSION_V2 if v2 else VERSION,
                'baseline_kind': 'reconstructed_pdf' if pdf_source else 'none',
                'source_sha256': request['source_sha256'] if pdf_source else None,
                'baseline_hash': sha(baseline_value) if pdf_source else None, 'effective_baseline_sha256': sha(baseline_value),
                'revision_sha256': sha(value), 'clean_sha256': sha(value),
                'replacements': 0, 'columns': 0, 'pending': len(notes), 'pending_review': notes,
                'plan_hash': request['plan_hash'], **({'block_audit': audits} if v2 else {}),
                **({'revision_semantics': 'untracked_pdf_projection_reconstruction',
                    'source_format_preserved': False} if pdf_source else {})}
    raw = Path(source).read_bytes()
    if sha(raw) != request['source_sha256']:
        fail('WORD_SOURCE_HASH_MISMATCH')
    records = request['records']
    edits = {edit['record_id']: edit for edit in request['edits']}
    if len(edits) != len(request['edits']) or not set(edits).issubset({r['id'] for r in records}):
        fail('WORD_EDIT_ANCHOR_MISMATCH')
    source_path = Path(source)
    reconstructed = request['media_type'] != 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if reconstructed:
        doc = document(stamp)
        for record in records:
            doc.add_paragraph(record['text'])
        source_path = Path(source).with_name('reconstructed.docx')
        doc.save(source_path)
        source_path.write_bytes(_canonicalize_docx(source_path))
        records = [{**r, 'locator': {'path': [{'paragraph': i + 1}], 'stable_ref': f'docx:p{i+1:04d}'}} for i, r in enumerate(records)]
    previews, replacements, review = [], [], []
    for record in records:
        edit = edits.get(record['id'])
        after = edit['after'] if edit else record['text']
        previews.append({'recordId': record['id'], 'locator': record['locator'], 'before': record['text'], 'after': after})
        if after != record['text']:
            replacements.append({'recordId': record['id'], 'locator': record['locator'], 'start': 0,
                                 'end': len(record['text'].encode('utf-16-le')) // 2,
                                 'before': record['text'], 'after': after})
        for pending in edit['pending'] if edit else []:
            review.append({'recordId': record['id'], 'message': pending})
            notes.append({'record_id': record['id'], 'message': pending})
    additions = request.get('additions', [])
    for addition in additions:
        for block in addition['blocks']:
            notes.extend({'record_id': addition['after_record_id'], 'message': note} for note in block['pending'])
    if not replacements and not additions:
        fail('WORD_NO_CHANGES')
    plan = {'source': {'contentHash': sha(source_path.read_bytes()), 'format': 'docx_effective'},
            'deliverable': False, 'baselineHash': sha(source_path.read_bytes()), 'planHash': request['plan_hash'],
            'textPreview': previews, 'replacements': replacements, 'columns': [], 'reviewNotes': review, 'additions': additions,
            '_delivery_date': stamp}
    result = build(source_path, plan, tracked, clean, baseline)
    return {**result, 'writer_version': VERSION, 'source_sha256': request['source_sha256'],
            'baseline_kind': 'reconstructed_pdf' if reconstructed else 'uploaded_source', 'pending': len(notes), 'pending_review': notes,
            **({'revision_handling': handling, 'review_passed': False} if handling is not None else {})}


def main():
    request_path, source, tracked, clean, baseline = sys.argv[1:]
    request = json.loads(Path(request_path).read_text(encoding='utf-8'))
    try:
        print(json.dumps(render(request, None if source == '-' else source, tracked, clean, baseline)))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
