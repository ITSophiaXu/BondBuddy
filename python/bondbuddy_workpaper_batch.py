"""One source snapshot; grounded batch plan; deterministic per-item Word delivery.

Source locations and audit data stay in JSON. No model-created table numbers are
accepted: tables are reconstructed from the pinned original, including merges.
"""
import base64
import copy
import hashlib
import io
import json
import re
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from datetime import datetime, timezone

from docx import Document
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn
from bondbuddy_file_authoring.project_files import inspect
from bondbuddy_workpaper_source import VERSION, extract, ATTRIBUTION

PLACEHOLDER = re.compile(r'\[\[内容\d*\]\]|待填写|待补充|请补充|请提供|(?:^|\n)\s*(?:来源|依据)[：:]|\b[PT]\d{3,}\b|\b(?:p\d+|table-\d+|image-\d+)\b|(?:募集说明书|募集书).{0,6}第.{1,12}[章节页]')
NUMBER = re.compile(r'(?<![A-Za-z])[-−]?\d[\d,，]*(?:\.\d+)?')
SOURCE_REFERENCE = re.compile(r'(?:详见|参见)(?:本?募集说明书|本?募集书)?第[一二三四五六七八九十百零〇\d、至\-]+[章节页](?:[“「][^”」\n]+[”」])?')


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')


def require(ok, code):
    if not ok:
        raise ValueError(code)


def canonical_save(doc, path):
    # Exact replay after a worker crash must not change a result receipt merely
    # because ZIP/core-property timestamps differ between attempts.
    doc.core_properties.created = doc.core_properties.modified = datetime(2000, 1, 1, tzinfo=timezone.utc)
    doc.core_properties.author = doc.core_properties.last_modified_by = ''
    buffer = io.BytesIO(); doc.save(buffer)
    with ZipFile(buffer) as source, ZipFile(path, 'w', compression=ZIP_DEFLATED) as target:
        for name in sorted(source.namelist()):
            info = ZipInfo(name, (2000, 1, 1, 0, 0, 0)); info.compress_type = ZIP_DEFLATED
            target.writestr(info, source.read(name))


def numbers(text):
    return {Decimal(v.replace(',', '').replace('，', '').replace('−', '-')) for v in NUMBER.findall(text)}


def delivery_text(text):
    # Strip only explicit document-location references, never business phrases
    # such as 资金来源 / 定价依据 or substantive limitations in source footnotes.
    text = SOURCE_REFERENCE.sub('', text)
    return re.sub(r'[（(]\s*[，,；;。]*\s*[）)]', '', text).strip()


def expanded_facts(snapshot, item):
    selected = set(item['facts'])
    while True:
        before = len(selected)
        for table in snapshot['tables']:
            if selected.intersection(table['span_ids']):
                selected.update(table['span_ids'])
                selected.update(table.get('context_ids', []))
        for sid in list(selected):
            selected.update(snapshot.get('dependencies', {}).get(sid, []))
        if len(selected) == before:
            break
    return selected


def calculation(calc, spans):
    operands = calc['operands']
    require(len(operands) >= 1, 'WORKPAPER_CALC_INPUT_REQUIRED')
    for x in operands:
        require(x['span_id'] in spans and Decimal(x['value']) in numbers(spans[x['span_id']]['text']), 'WORKPAPER_CALC_NOT_DISCLOSED')
        require(all(x[k].strip() for k in ('unit', 'period', 'scope')), 'WORKPAPER_CALC_CONTEXT_REQUIRED')
        require(bool(x['context_span_ids']) and set(x['context_span_ids']) <= set(spans), 'WORKPAPER_CALC_CONTEXT_REQUIRED')
        context = '\n'.join(spans[sid]['text'] for sid in x['context_span_ids'])
        require(all(x[k] in context for k in ('unit', 'period', 'scope')), 'WORKPAPER_CALC_CONTEXT_NOT_DISCLOSED')
    require(len({x['unit'] for x in operands}) == 1 and len({x['scope'] for x in operands}) == 1, 'WORKPAPER_CALC_SCOPE_MISMATCH')
    op = calc['operation']
    require(op in ('sum', 'difference', 'ratio', 'growth'), 'WORKPAPER_CALC_OPERATION_INVALID')
    if op in ('sum', 'ratio'):
        require(len({x['period'] for x in operands}) == 1, 'WORKPAPER_CALC_PERIOD_MISMATCH')
    require(all(x['period'] in calc['period'] for x in operands), 'WORKPAPER_CALC_PERIOD_MISMATCH')
    require(calc['scope'] == operands[0]['scope'], 'WORKPAPER_CALC_SCOPE_MISMATCH')
    require(calc['unit'] == ('%' if op in ('ratio', 'growth') else operands[0]['unit']), 'WORKPAPER_CALC_UNIT_MISMATCH')
    values = [Decimal(x['value']) for x in operands]
    if op == 'sum':
        value = sum(values)
        formula = ' + '.join(x['value'] for x in operands)
    else:
        require(len(values) == 2, 'WORKPAPER_CALC_ARITY_INVALID')
        a, b = values
        if op == 'difference':
            value, formula = a-b, f"{operands[0]['value']} − {operands[1]['value']}"
        else:
            require(b != 0, 'WORKPAPER_CALC_ZERO_BASE')
            value = (a/b if op == 'ratio' else (a-b)/b) * 100
            formula = (f"{a} ÷ {b}" if op == 'ratio' else f"({a} − {b}) ÷ {b}") + ' × 100%'
    require(0 <= calc['decimals'] <= 6, 'WORKPAPER_CALC_PRECISION_INVALID')
    result = str(value.quantize(Decimal(10) ** -calc['decimals'], rounding=ROUND_HALF_UP))
    bases = '；'.join(f"{x['period']}、{x['scope']}：{x['value']}{x['unit']}" for x in operands)
    return f"{calc['label']}（{calc['period']}、{calc['scope']}）：{formula} = {result}{calc['unit']}。计算基础：{bases}。"


def validate(snapshot, batch, plan):
    require(snapshot['version'] == VERSION and plan['version'] == 'workpaper-shared-plan-v1', 'WORKPAPER_PLAN_VERSION_INVALID')
    require(plan['source_sha256'] == snapshot['source']['sha256'], 'WORKPAPER_PLAN_SOURCE_CHANGED')
    spans = {s['id']: s for s in snapshot['source']['spans']}
    expected = {e['id']: e for e in batch['entries']}
    actual = [x['item_id'] for x in plan['items']]
    require(len(actual) == len(set(actual)) and set(actual) == set(expected), 'WORKPAPER_PLAN_SCOPE_MISMATCH')
    nonempty = {s['id'] for s in spans.values() if s['text'].strip()}
    require(set(plan['reviewed_span_ids']) == nonempty, 'WORKPAPER_PLAN_FULL_READING_REQUIRED')
    excluded = set()
    for group in plan['excluded']:
        require(len(group['reason'].strip()) >= 5 and set(group['span_ids']) <= nonempty, 'WORKPAPER_PLAN_EXCLUSION_INVALID')
        require(not excluded.intersection(group['span_ids']), 'WORKPAPER_PLAN_EXCLUSION_DUPLICATE')
        excluded.update(group['span_ids'])
    used = set()
    reasons = set()
    for item in plan['items']:
        decision, entry = item['decision'], expected[item['item_id']]
        require(decision['item_id'] == item['item_id'], 'WORKPAPER_PLAN_ITEM_MISMATCH')
        require(set(item['facts']) <= set(spans) and set(item['searched_span_ids']) <= set(spans), 'WORKPAPER_PLAN_UNKNOWN_FACT')
        facts = expanded_facts(snapshot, item)
        used.update(facts)
        evidence = '\n'.join(spans[x]['text'] for x in facts)
        require(item['required_evidence'].strip() and not PLACEHOLDER.search(item['required_evidence']), 'WORKPAPER_REQUIREMENT_EMPTY')
        require(len(decision['reason'].strip()) >= 8 and not PLACEHOLDER.search(decision['reason']), 'WORKPAPER_REASON_GENERIC')
        for citation in decision['citations']:
            require(citation['span_id'] in facts and citation['quote'].strip() and citation['quote'] in spans[citation['span_id']]['text'], 'WORKPAPER_DECISION_UNGROUNDED')
        require(decision['status'] in ('generate', 'not_applicable', 'missing_information', 'external_evidence'), 'WORKPAPER_DECISION_INVALID')
        if decision['status'] in ('generate', 'not_applicable'):
            require(bool(decision['citations']) and len(evidence.strip()) >= 20, 'WORKPAPER_DISCLOSED_FACT_REQUIRED')
        if decision['status'] == 'not_applicable':
            require(not re.search(r'未(?:检索|查找|找到|披露|提及)|未见|没有找到', decision['reason']), 'WORKPAPER_SILENCE_NOT_NONAPPLICABILITY')
        if decision['status'] != 'generate':
            require(decision['reason'] not in reasons, 'WORKPAPER_DUPLICATE_EXPLANATION')
            reasons.add(decision['reason'])
        if decision['status'] in ('missing_information', 'external_evidence'):
            require(bool(item['searched_span_ids']) and bool(decision['missing_materials']), 'WORKPAPER_SPECIFIC_MISSING_EVIDENCE_REQUIRED')
            require(all(len(s.strip()) >= 3 and not re.search(r'对应原始|相关资料|项目披露|该项原始|请补充|请提供', s) for s in decision['missing_materials']), 'WORKPAPER_MISSING_MATERIAL_GENERIC')
        if decision['status'] == 'generate':
            original = re.search(r'(?:访谈记录|培训记录|函证回函|银行流水|征信报告|营业执照|签章原件)$', entry['title'])
            require(not original or re.search(r'分析|说明|清单|列表|提纲|、|及', entry['title']), 'WORKPAPER_ORIGINAL_EVIDENCE_REQUIRED')
        for narrative in item['narrative']:
            require(bool(narrative['sources']) and set(narrative['sources']) <= facts, 'WORKPAPER_NARRATIVE_UNGROUNDED')
            require(not PLACEHOLDER.search(narrative['text']), 'WORKPAPER_PLACEHOLDER_OR_SOURCE_LABEL')
            supporting = '\n'.join(spans[x]['text'] for x in narrative['sources'])
            require(numbers(narrative['text']) <= numbers(supporting), 'WORKPAPER_NARRATIVE_NUMBER_NOT_DISCLOSED')
        for calc in item['calculations']:
            require({x['span_id'] for x in calc['operands']} <= facts, 'WORKPAPER_CALC_FACT_NOT_INCLUDED')
            require(all(set(x['context_span_ids']) <= facts for x in calc['operands']), 'WORKPAPER_CALC_FACT_NOT_INCLUDED')
            calculation(calc, spans)
    require(not used.intersection(excluded), 'WORKPAPER_PLAN_USED_AND_EXCLUDED')
    require(nonempty <= used | excluded, 'WORKPAPER_PLAN_UNMAPPED_DISCLOSURE')
    image_ids = {x['id'] for x in snapshot['images']}
    require(len(plan['image_reviews']) == len(image_ids) and {x['image_id'] for x in plan['image_reviews']} == image_ids, 'WORKPAPER_IMAGE_REVIEW_REQUIRED')
    for review in plan['image_reviews']:
        require(set(review['item_ids']) <= set(expected) and len(review['description'].strip()) >= 5, 'WORKPAPER_IMAGE_REVIEW_INVALID')
        require(not review['item_ids'] or review['verified'] is True, 'WORKPAPER_IMAGE_CONTENT_UNVERIFIED')
        image = next(x for x in snapshot['images'] if x['id'] == review['image_id'])
        if image.get('page'):
            relevant = {i['item_id'] for i in plan['items'] if expanded_facts(snapshot, i).intersection(image['span_ids'])}
            require(relevant <= set(review['item_ids']), 'WORKPAPER_PDF_PAGE_NOT_MAPPED')
    return dict(items=len(actual), source_spans=len(nonempty), mapped_spans=len(used & nonempty), images=len(image_ids))


def apply_role(paragraph, role):
    if not role:
        return
    for key in ('pPr',):
        existing = paragraph._p.find(qn('w:' + key))
        if existing is not None:
            paragraph._p.remove(existing)
        if role.get(key):
            paragraph._p.insert(0, parse_xml(role[key]))
    for run in paragraph.runs:
        if run._r.rPr is not None:
            run._r.remove(run._r.rPr)
        if role.get('rPr'):
            run._r.insert(0, parse_xml(role['rPr']))


def column_groups(table):
    columns = max((sum(c['colspan'] for c in r['cells'])+r.get('before', 0)+r.get('after', 0) for r in table['rows']), default=1)
    if columns <= 10:
        return [table]
    # Repeat the first two association columns in every group. A spanning header
    # is clipped to the selected columns with its original label repeated; no
    # financial value, row, subtotal or original blank is removed.
    result = []
    for start in range(2, columns, 6):
        selected = [0, 1, *range(start, min(start+6, columns))]
        rows = []
        for row in table['rows']:
            cells, offset = [], row.get('before', 0)
            for cell in row['cells']:
                kept = [i for i in selected if offset <= i < offset+cell['colspan']]
                if kept:
                    cells.append({**cell, 'colspan': len(kept)})
                offset += cell['colspan']
            rows.append({**row, 'cells': cells, 'before': sum(i < row.get('before', 0) for i in selected),
                         'after': sum(i >= offset for i in selected)})
        weights = table.get('widths', [])
        result.append({**table, 'rows': rows, 'widths': [weights[i] for i in selected] if len(weights) == columns else []})
    return result


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
    elif item['decision']['missing_materials']:
        paragraph('成果范围：' + item['decision']['reason'])
        paragraph('尚需取得：' + '；'.join(item['decision']['missing_materials']) + '。')
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
    if mode == 'extract':
        save(args[1], extract(args[0]))
    elif mode == 'validate':
        print(json.dumps(validate(*[load(p) for p in args[:3]])))
    elif mode in ('render', 'render-validated'):
        print(json.dumps(render(*[load(p) for p in args[:3]], *args[3:], validated=mode == 'render-validated')))
    else:
        raise ValueError('WORKPAPER_BATCH_OPERATION_INVALID')
