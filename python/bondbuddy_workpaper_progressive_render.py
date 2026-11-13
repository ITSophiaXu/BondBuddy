"""Progressive Word delivery, with internal decisions separated from generated content.

The shared-batch renderer is byte-pinned by older durable runs. Keep it unchanged;
this module reuses its validation/content helpers with an explicit renderer.
"""
import base64
import copy
import hashlib
import io
import json
import sys
from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from bondbuddy_file_authoring.project_files import inspect
from bondbuddy_workpaper_source import ATTRIBUTION
from bondbuddy_workpaper_batch import (validate, expanded_facts, load, apply_role,
                                      column_groups, delivery_text, canonical_save,
                                      calculation, require, save)


def render(snapshot, batch, plan, item_id, template_path, format_path, output, validated=False):
    if not validated:
        validate(snapshot, batch, plan)
    item = next(x for x in plan['items'] if x['item_id'] == item_id)
    entry = next(x for x in batch['entries'] if x['id'] == item_id)
    spans = {s['id']: s for s in snapshot['source']['spans']}
    facts = expanded_facts(snapshot, item)
    internal_only = set(snapshot.get('internal_only_ids', []))
    fmt = load(format_path)
    doc = Document(template_path)
    sample_table = doc.tables[0] if doc.tables else None
    table_properties = copy.deepcopy(sample_table._tbl.tblPr) if sample_table is not None else None
    table_role = fmt['roles'].get('table')
    if not table_role and sample_table is not None:
        from lxml import etree
        sample_p = next((p for p in sample_table._tbl.iter(qn('w:p')) if p.find(qn('w:pPr')) is not None), None)
        if sample_p is not None:
            run_prop = next(sample_p.iter(qn('w:rPr')), None)
            table_role = dict(pPr=etree.tostring(sample_p.find(qn('w:pPr')), encoding='unicode'),
                              rPr=etree.tostring(run_prop, encoding='unicode') if run_prop is not None else '')
    fallback_table_role = not table_role
    table_role = table_role or fmt['roles'].get('body')
    body = doc.element.body
    for el in list(body):
        if el.tag != qn('w:sectPr'):
            body.remove(el)
    if any(max((sum(c['colspan'] for c in r['cells'])+r.get('before', 0)+r.get('after', 0) for r in t['rows']), default=1) > 6
           for t in snapshot['tables'] if facts.intersection(t['span_ids'])):
        # Keep the title, units and table together. Switching after the title
        # creates an almost empty portrait cover page in Word/LibreOffice.
        from docx.enum.section import WD_ORIENT
        for section in doc.sections:
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width, section.page_height = max(section.page_width, section.page_height), min(section.page_width, section.page_height)
    records = []

    def paragraph(text, ids=(), title=False):
        p = doc.add_paragraph(text)
        apply_role(p, fmt['roles'].get('title' if title else 'body'))
        if not title:
            # Some reference templates explicitly disable widow/orphan control.
            # Keep their spacing, fonts and indentation while preventing a lone
            # first/last body line from being stranded across page boundaries.
            p.paragraph_format.widow_control = True
        for sid in ids:
            if spans[sid]['text'].strip():
                records.append((p._p, sid))
        return p

    title = entry['code'] + ' ' + entry['title']
    if item['decision']['status'] != 'generate':
        title += ' — 不适用说明'
    paragraph(title, title=True)
    if item['decision']['status'] != 'generate':
        paragraph('本项要求：' + item['required_evidence'])
    emitted_tables = set()
    table_for_span = {sid: t for t in snapshot['tables'] if not t['nested'] for sid in t['span_ids']}
    table_by_id = {t['id']: t for t in snapshot['tables']}

    def write_table(source_table, parent, width):
        from docx.text.paragraph import Paragraph
        from docx.table import _Cell
        from docx.shared import Pt
        columns = max((sum(c['colspan'] for c in r['cells'])+r.get('before', 0)+r.get('after', 0) for r in source_table['rows']), default=1)
        t = parent.add_table(rows=0, cols=columns) if parent is doc else parent.add_table(rows=0, cols=columns)
        if table_properties is not None:
            t._tbl.remove(t._tbl.tblPr); t._tbl.insert(0, copy.deepcopy(table_properties))
        else:
            # A template without a table still supplies its body fonts. Use a
            # restrained grid for newly required data; no sample facts survive.
            borders = OxmlElement('w:tblBorders')
            for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
                edge = OxmlElement('w:'+side); edge.set(qn('w:val'), 'single'); edge.set(qn('w:sz'), '4'); edge.set(qn('w:color'), '808080'); borders.append(edge)
            t._tbl.tblPr.append(borders)
        t.autofit = False
        weights = source_table.get('widths', [])
        if len(weights) != columns or not all(w > 0 for w in weights):
            weights = [1]*columns
        widths = [int(width*w/sum(weights)) for w in weights]
        for col, w in zip(t.columns, widths):
            col.width = w
        for ri, source_row in enumerate(source_table['rows']):
            tr, trpr = OxmlElement('w:tr'), OxmlElement('w:trPr')
            if source_row['header'] or ri == 0:
                trpr.append(OxmlElement('w:tblHeader'))
            for key, tag in (('before', 'gridBefore'), ('after', 'gridAfter')):
                if source_row.get(key):
                    node = OxmlElement('w:'+tag); node.set(qn('w:val'), str(source_row[key])); trpr.append(node)
            tr.append(trpr); column = source_row.get('before', 0)
            for sc in source_row['cells']:
                tc, pr = OxmlElement('w:tc'), OxmlElement('w:tcPr')
                cell_width = sum(widths[column:column+sc['colspan']]); column += sc['colspan']
                cw = OxmlElement('w:tcW'); cw.set(qn('w:w'), str(int(cell_width/635))); cw.set(qn('w:type'), 'dxa'); pr.append(cw)
                if sc['colspan'] > 1:
                    gs = OxmlElement('w:gridSpan'); gs.set(qn('w:val'), str(sc['colspan'])); pr.append(gs)
                if sc['vmerge']:
                    vm = OxmlElement('w:vMerge'); vm.set(qn('w:val'), sc['vmerge']); pr.append(vm)
                tc.append(pr); tr.append(tc)
                content = sc['content'] or [dict(span_id=None)]
                for block in content:
                    if 'table_id' in block:
                        write_table(table_by_id[block['table_id']], _Cell(tc, t), cell_width)
                        continue
                    sid = block['span_id']
                    text = delivery_text(spans[sid]['text']) if sid and sid not in internal_only else ''
                    # A second empty paragraph in a populated cell is layout,
                    # not a blank financial value. Merged continuations are aliases.
                    all_blank = not any(spans[b['span_id']]['text'].strip() for b in content if b.get('span_id'))
                    if not text.strip() and all_blank and sc['vmerge'] != 'continue' and block is content[0] and sid not in internal_only:
                        text = '原文空白'
                    pe = OxmlElement('w:p'); tc.append(pe)
                    p = Paragraph(pe, t); p.add_run(text); apply_role(p, table_role)
                    if fallback_table_role:
                        pf = p.paragraph_format
                        pf.first_line_indent = Pt(0); pf.space_before = Pt(0); pf.space_after = Pt(0); pf.line_spacing = 1.0
                    if sid and spans[sid]['text'].strip() and text.strip():
                        records.append((pe, sid))
                if tc[-1].tag != qn('w:p'):
                    tc.append(OxmlElement('w:p'))
            t._tbl.append(tr)
        emitted_tables.add(source_table['id'])
        return columns

    for span in snapshot['source']['spans']:
        if span['id'] not in facts or span['id'] in internal_only:
            continue
        table = table_for_span.get(span['id'])
        if table:
            if table['id'] in emitted_tables:
                continue
            # Keep source columns/merges. Wide tables get a landscape section;
            # no column or row truncation, no guessed financial values.
            columns = max((sum(c['colspan'] for c in r['cells'])+r.get('before', 0)+r.get('after', 0) for r in table['rows']), default=1)
            section = doc.sections[-1]
            width = section.page_width - section.left_margin - section.right_margin
            for group in column_groups(table):
                write_table(group, doc, width)
        elif span['text'].strip():
            paragraph(delivery_text(span['text']), [span['id']])
    for review in plan['image_reviews']:
        if item_id in review['item_ids']:
            asset = next(x for x in snapshot['images'] if x['id'] == review['image_id'])
            section = doc.sections[-1]
            # PDF page images are reading evidence, not source citations in the
            # deliverable. Only native images are embedded in document bodies.
            if not asset.get('page'):
                data = base64.b64decode(asset['data'], validate=True)
                require(hashlib.sha256(data).hexdigest() == asset['sha256'], 'WORKPAPER_IMAGE_HASH_MISMATCH')
                from PIL import Image
                with Image.open(io.BytesIO(data)) as picture:
                    w, h = picture.size
                limit_width = section.page_width-section.left_margin-section.right_margin
                limit_height = section.page_height-section.top_margin-section.bottom_margin
                doc.add_picture(io.BytesIO(data), width=int(min(limit_width, limit_height*w/h)))
    for narrative in item['narrative']:
        paragraph(narrative['text'], narrative['sources'])
    for calc in item['calculations']:
        paragraph(calculation(calc, spans), [x['span_id'] for x in calc['operands']])
    if item['decision']['status'] != 'generate':
        labels = {'not_applicable': '事项不适用', 'missing_information': '资料未披露，暂无法形成文件', 'external_evidence': '需取得原始证据'}
        paragraph(labels[item['decision']['status']] + '：' + item['decision']['reason'])
        if item['decision']['missing_materials']:
            paragraph('尚需取得：' + '；'.join(item['decision']['missing_materials']) + '。')
    # A generated file contains disclosed facts and grounded analysis. The
    # generation decision and collection checklist stay in the internal audit;
    # material factual limitations belong in narrative, not an appended workflow
    # assessment. Explanation files above retain their reason and missing items.
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    target_ids = {p: f'p{i}' for i, p in enumerate(body.iter(qn('w:p')))}
    canonical_save(doc, output/'document.docx')
    target = inspect(output/'document.docx')
    targets = {s['id']: s for s in target['spans']}
    links = []
    for paragraph_el, sid in records:
        tid = target_ids[paragraph_el]
        links.append(dict(source_span_id=sid, source_quote=spans[sid]['text'], target_span_id=tid,
                          target_quote=targets[tid]['text'], field='事实或明细', period='', unit='',
                          source_location=spans[sid]['location'], target_location=targets[tid]['location'],
                          source_sha256=snapshot['source']['sha256'], target_sha256=target['sha256']))
    delivered = {x['source_span_id'] for x in links}
    require({x for x in facts if spans[x]['text'].strip()} - internal_only <= delivered, 'WORKPAPER_RENDER_FACT_LOST')
    # Unaltered disclosed text may legitimately discuss a future supplementation
    # obligation. Reject placeholders in authored content, not business facts.
    require(not any('[[内容' in s['text'] or ATTRIBUTION.search(s['text']) for s in target['spans']), 'WORKPAPER_PLACEHOLDER_OR_SOURCE_LABEL')
    save(output/'file-links.json', dict(links=links))
    audit = dict(item_id=item_id, decision=item['decision'], facts=sorted(facts), tables=sorted(emitted_tables),
                 images=[r for r in plan['image_reviews'] if item_id in r['item_ids']], searched_span_ids=item['searched_span_ids'])
    save(output/'internal-audit.json', audit)
    note = Document(); note.add_heading('内部编制记录', 0)
    note.add_paragraph('本批共享材料提取和编制计划；下列来源定位仅供内部核验。')
    note.add_paragraph(json.dumps(audit, ensure_ascii=False))
    canonical_save(note, output/'preparation-note.docx')
    return dict(span_count=len(target['spans']), links=len(links), tables=len(emitted_tables))


if __name__ == '__main__':
    mode, *args = sys.argv[1:]
    if mode not in ('render', 'render-validated'):
        raise ValueError('WORKPAPER_BATCH_OPERATION_INVALID')
    print(json.dumps(render(*[load(p) for p in args[:3]], *args[3:], validated=mode == 'render-validated')))
