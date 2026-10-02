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
sha = lambda value: hashlib.sha256(value).hexdigest()


def document(stamp):
    doc = Document()
    style = doc.styles['Normal']
    style.font.name = 'SimSun'
    style.font.size = Pt(12)
    style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
    moment = datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone(timezone.utc)
    doc.core_properties.created = moment
    doc.core_properties.modified = moment
    doc.core_properties.author = 'BondBuddy'
    return doc


def render(request, source, tracked, clean, baseline):
    if request.get('version') != 'unified-word-request-v1':
        fail('WORD_PLAN_NOT_SUPPORTED')
    stamp = request['date']
    blocks = request['blocks']
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
    if source is None:
        if not blocks or not any(b.get('kind') != 'heading' and (b.get('text') or b.get('rows')) for b in blocks):
            fail('WORD_EMPTY_MANUSCRIPT')
        doc = document(stamp)
        for i, block in enumerate(blocks):
            if block['kind'] == 'heading':
                doc.add_heading(block['text'], level=1)
            elif block['kind'] == 'paragraph':
                doc.add_paragraph(block['text'])
            elif block['kind'] == 'table':
                rows = block['rows']
                if not rows or not rows[0] or any(len(row) != len(rows[0]) for row in rows):
                    fail('WORD_TABLE_GRID_UNSUPPORTED')
                if block['text']:
                    doc.add_paragraph(block['text'])
                table = doc.add_table(rows=len(rows), cols=len(rows[0]))
                table.style = 'Table Grid'
                for r, row in enumerate(rows):
                    for c, text in enumerate(row):
                        table.cell(r, c).text = text
            else:
                fail('WORD_BLOCK_UNSUPPORTED')
            for pending in block['pending']:
                doc.add_paragraph('【待人工确认】' + pending)
                notes.append({'record_id': f'new-{i}', 'message': pending})
        doc.save(clean)
        value = _canonicalize_docx(Path(clean))
        # First draft has no invented old text or revision markers. This same real
        # output is retained as the baseline candidate for the next explicit run.
        for path in (tracked, clean, baseline):
            Path(path).write_bytes(value)
        return {'writer_version': VERSION, 'baseline_kind': 'none', 'source_sha256': None,
                'baseline_hash': None, 'effective_baseline_sha256': sha(value),
                'revision_sha256': sha(value), 'clean_sha256': sha(value),
                'replacements': 0, 'columns': 0, 'pending': len(notes), 'pending_review': notes,
                'plan_hash': request['plan_hash']}
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
