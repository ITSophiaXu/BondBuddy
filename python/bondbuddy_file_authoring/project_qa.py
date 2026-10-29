"""Preserve Word package content and insert grounded answers at pinned question ranges."""
import copy
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from .review_corrections import package, write
from .word_patch import q, serialized, paragraph_text
from .project_files import inspect
from lxml import etree


def prepare(source, output, result):
    source, output = Path(source), Path(output)
    warnings = []
    with tempfile.TemporaryDirectory(prefix='bb-qa-doc-') as tmp:
        if source.suffix.lower() == '.doc':
            # A unique profile prevents interference between conversions or with open user files.
            profile_dir = Path(tmp) / 'profile'
            (profile_dir / 'user').mkdir(parents=True)
            (profile_dir / 'user' / 'registrymodifications.xcu').write_text(
                '<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>', encoding='utf8')
            profile = profile_dir.as_uri()
            subprocess.run(['libreoffice', '-env:UserInstallation=' + profile, '--headless', '--norestore', '--convert-to', 'docx', '--outdir', tmp, str(source)],
                           check=True, capture_output=True, timeout=90)
            source = Path(tmp) / (source.stem + '.docx')
            warnings.append('原稿为 DOC，已转换为 DOCX；请核对转换后的表格、编号和分页。')
        if source.suffix.lower() not in ('.docx', '.pdf'):
            raise ValueError('QA_DOCUMENT_REQUIRED')
        parts, root, extra = package(source, Path(tmp))
        # package() reports any accepted historical revisions; preserve that warning below.
        write(output, parts)
    snapshot = inspect(output)
    if len(snapshot['spans']) > 10000:
        raise ValueError('QA_TOO_MANY_PARAGRAPHS')
    candidates = []
    # Word list numbering is stored in paragraph/style XML, not in extracted text.
    numbered_styles = set()
    if 'word/styles.xml' in parts:
        styles = etree.fromstring(parts['word/styles.xml'], etree.XMLParser(resolve_entities=False, no_network=True))
        numbered_styles = {style.get(q('styleId')) for style in styles.findall(q('style'))
                           if style.find('./' + q('pPr') + '/' + q('numPr')) is not None}
    paragraphs = list(root.iter(q('p')))
    for i, span in enumerate(snapshot['spans']):
        text = span['text'].strip()
        if text.startswith('【待补充：原 PDF 第') and '无法提取文字' in text:
            continue
        # A numbered section title is not a billable question. Some review templates
        # use one custom list style for both the title and its substantive children.
        heading = re.sub(r'^(?:[一二三四五六七八九十百\d]+[、.．）)]|[（(][一二三四五六七八九十百\d]+[)）])\s*', '', text)
        if re.fullmatch(r'(?:对)?(?:申报材料|申请材料|内核申请材料)?(?:的)?(?:审核意见|审查意见|反馈意见|问询问题|问题清单)', heading):
            continue
        node = paragraphs[i] if i < len(paragraphs) else None
        style = node.find('./' + q('pPr') + '/' + q('pStyle')) if node is not None else None
        style_id = style.get(q('val'), '') if style is not None else ''
        numbered = node is not None and (node.find('./' + q('pPr') + '/' + q('numPr')) is not None or style_id in numbered_styles)
        numbered = numbered and not re.search(r'heading|title|标题', style_id, re.I) and len(text) > 4
        if text and (re.match(r'^(?:问题\s*[一二三四五六七八九十百\d]+|[一二三四五六七八九十百\d]+[、.．）)]|[（(][一二三四五六七八九十百\d]+[)）])', text)
                     or re.match(r'^(?:请|是否|如何|为什么|为何)', text) or text.endswith(('？', '?')) or numbered
                     or re.search(r'(?:请|应|需)(?:补充|说明|披露|核实|核查|提供|解释)', text)):
            candidates.append(i)
    # One anchor per paragraph: surrounding headings and evidence remain in the original file.
    questions = [dict(id='q' + str(i), start=i, end=i, question=snapshot['spans'][i]['text'].strip())
                 for i in candidates[:200] if len(snapshot['spans'][i]['text']) <= 16000]
    if not questions:
        warnings.append('没有找到明确的问题编号或问句。请根据原文选择问题段落后开始。')
    if len(candidates) > 200:
        warnings.append('识别到超过 200 个候选问题，请分批处理或调整范围。')
    Path(result).write_text(json.dumps(dict(snapshot=snapshot, questions=questions, warnings=warnings + extra), ensure_ascii=False), encoding='utf8')


def paragraph(text, bold=False, markdown=False):
    p = etree.Element(q('p'))
    prop = etree.SubElement(p, q('pPr'))
    etree.SubElement(prop, q('spacing'), {q('after'): '120', q('line'): '276', q('lineRule'): 'auto'})
    # Model answers share Markdown with the web view. Render simple emphasis as
    # native Word runs instead of exposing literal ** markers in formal replies.
    for segment in re.split(r'(\*\*[^*\n]+\*\*)', text) if markdown else [text]:
        if not segment:
            continue
        emphasis = markdown and segment.startswith('**') and segment.endswith('**') and len(segment) > 4
        run = etree.SubElement(p, q('r'))
        rp = etree.SubElement(run, q('rPr'))
        etree.SubElement(rp, q('rFonts'), {q('ascii'): 'Arial', q('hAnsi'): 'Arial', q('eastAsia'): '宋体'})
        etree.SubElement(rp, q('sz'), {q('val'): '22'})
        if bold or emphasis:
            etree.SubElement(rp, q('b'))
        for i, line in enumerate((segment[2:-2] if emphasis else segment).split('\n')):
            if i:
                etree.SubElement(run, q('br'))
            t = etree.SubElement(run, q('t'))
            t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
            t.text = line
    return p


def answer_blocks(text):
    """Render quoted Markdown tables as editable Word tables, preserving all cell text.

    Unknown markup remains literal text. No HTML, links or remote resources are executed.
    Percentage widths also work when the original question lives inside a table cell.
    """
    def cells(line):
        return [s.strip().replace(r'\|', '|') for s in re.split(r'(?<!\\)\|', line.strip().strip('|'))]

    lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    index, pending = 0, []
    while index < len(lines):
        header = cells(lines[index])
        separator = cells(lines[index+1]) if index+1 < len(lines) else []
        if ('|' not in lines[index] or len(header) < 2 or len(separator) != len(header)
                or not all(re.fullmatch(r':?-{3,}:?', c) for c in separator)):
            pending.append(lines[index]); index += 1
            continue
        if '\n'.join(pending).strip():
            yield paragraph('\n'.join(pending).strip(), markdown=True)
        pending = []
        rows = [header]; index += 2
        while index < len(lines) and '|' in lines[index] and lines[index].strip():
            rows.append(cells(lines[index])); index += 1
        columns = max(len(row) for row in rows)
        table = etree.Element(q('tbl'))
        prop = etree.SubElement(table, q('tblPr'))
        etree.SubElement(prop, q('tblW'), {q('w'): '5000', q('type'): 'pct'})
        etree.SubElement(prop, q('tblLayout'), {q('type'): 'fixed'})
        borders = etree.SubElement(prop, q('tblBorders'))
        for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
            etree.SubElement(borders, q(side), {q('val'): 'single', q('sz'): '4', q('color'): 'B8C2BD'})
        margins = etree.SubElement(prop, q('tblCellMar'))
        for side in ('top', 'left', 'bottom', 'right'):
            etree.SubElement(margins, q(side), {q('w'): '80', q('type'): 'dxa'})
        grid = etree.SubElement(table, q('tblGrid'))
        for _ in range(columns):
            etree.SubElement(grid, q('gridCol'))
        for number, row in enumerate(rows):
            tr = etree.SubElement(table, q('tr'))
            if number == 0:
                trprop = etree.SubElement(tr, q('trPr'))
                etree.SubElement(trprop, q('tblHeader'))
            for value in row + [''] * (columns-len(row)):
                cell = etree.SubElement(tr, q('tc')); cp = etree.SubElement(cell, q('tcPr'))
                etree.SubElement(cp, q('tcW'), {q('w'): str(5000//columns), q('type'): 'pct'})
                if number == 0:
                    etree.SubElement(cp, q('shd'), {q('fill'): 'EDF2EF'})
                cell.append(paragraph(value, bold=number == 0, markdown=True))
        yield table
    if '\n'.join(pending).strip():
        yield paragraph('\n'.join(pending).strip(), markdown=True)


def evidence(source, result):
    source = Path(source)
    if source.suffix.lower() == '.xlsx':
        from openpyxl import load_workbook
        from zipfile import ZipFile
        with ZipFile(source) as z:
            if sum(i.file_size for i in z.infolist()) > 250_000_000:
                raise ValueError('QA_EVIDENCE_TOO_LARGE')
        book = load_workbook(source, read_only=True, data_only=True, keep_links=False)
        spans = []
        try:
            for sheet in book:
                for number, row in enumerate(sheet.iter_rows(values_only=True), 1):
                    if len(spans) >= 20000:
                        raise ValueError('QA_EVIDENCE_TOO_LARGE')
                    text = ' | '.join(str(v) if v is not None else '' for v in row).strip(' |')
                    if text:
                        if len(text) > 12000:
                            raise ValueError('QA_EVIDENCE_ROW_TOO_LONG')
                        spans.append(dict(id='r' + str(len(spans)), text=text, location=sheet.title + ' 第 ' + str(number) + ' 行', sha256=hashlib.sha256(text.encode('utf8')).hexdigest()))
        finally:
            book.close()
        data = dict(version='project-file-text-v1', sha256=hashlib.sha256(source.read_bytes()).hexdigest(), format='xlsx', spans=spans,
                    warnings=['Excel 使用文件中保存的公式缓存值，未重算；空缓存或存疑数值需人工确认。'], coverage='partial')
    elif source.suffix.lower() == '.doc':
        with tempfile.TemporaryDirectory(prefix='bb-qa-evidence-') as tmp:
            output, meta = Path(tmp) / 'converted.docx', Path(tmp) / 'parsed.json'
            prepare(source, output, meta)
            data = inspect(output, complete=True)
            data.update(format='doc', sha256=hashlib.sha256(source.read_bytes()).hexdigest(), coverage='partial')
            data['warnings'].append('DOC 已转换后提取，定位请对照原稿核对。')
    else:
        data = inspect(source, complete=True)
    Path(result).write_text(json.dumps(data, ensure_ascii=False), encoding='utf8')


def fill(source, request, output):
    source, output = Path(source), Path(output)
    if hashlib.sha256(source.read_bytes()).hexdigest() != request['source_sha256']:
        raise ValueError('INPUT_REVISION_CONFLICT')
    with tempfile.TemporaryDirectory(prefix='bb-qa-fill-') as tmp:
        parts, root, _ = package(source, Path(tmp))
    original = copy.deepcopy(root)
    nodes = list(root.iter(q('p')))
    answers = {a['question_id']: a for a in request['answers']}
    if len(answers) != len(request['questions']):
        raise ValueError('QA_ANSWER_COVERAGE')
    last = -1
    for question in request['questions']:
        start, end = question['start'], question['end']
        if not (last < start <= end < len(nodes)) or '\n'.join(paragraph_text(p) for p in nodes[start:end+1]).strip() != question['question']:
            raise ValueError('QA_QUESTION_ANCHOR_CHANGED')
        last = end
        answer = answers[question['id']]
        content = [('BondBuddy 回答草稿 待人工复核', True), (answer['answer'], False)]
        if answer['status'] == 'missing':
            if not answer['missing_materials']:
                raise ValueError('QA_MISSING_LIST_REQUIRED')
            content.append(('待补材料或待确认事项\n' + '\n'.join('• ' + m for m in answer['missing_materials']), True))
        for cite in answer['citations']:
            evidence = request['evidence'][cite['asset_index']]
            span = next(s for s in evidence['snapshot']['spans'] if s['id'] == cite['span_id'])
            if cite['quote'] not in span['text']:
                raise ValueError('QA_CITATION_CHANGED')
            content.append(('回答依据：' + evidence['filename'] + ' · ' + span['location'] + '\n' + cite['quote'], False))
        if answer['approach']:
            content.append(('回答思路：' + answer['approach'], False))
        for case_id in answer['case_ids']:
            case = next(c for c in request['cases'] if c['id'] == case_id)['content']
            content.append(('参考公开案例（仅供回答思路）：' + case['title'] + '\n' + case['url'], False))
        anchor = nodes[end]
        # Fixed-height template rows must expand to fit the answer.
        for ancestor in anchor.iterancestors():
            if ancestor.tag == q('tr'):
                for height in list(ancestor.findall('./' + q('trPr') + '/' + q('trHeight'))):
                    height.getparent().remove(height)
        for index, (text, bold) in enumerate(content):
            blocks = answer_blocks(text) if index == 1 else [paragraph(text, bold)]
            for new in blocks:
                anchor.addnext(new)
                anchor = new
        # A Word cell must end in a paragraph, including when its last answer is a table.
        if anchor.tag == q('tbl') and anchor.getparent().tag == q('tc'):
            anchor.addnext(paragraph(''))
    if request.get('warnings'):
        body = root.find(q('body'))
        section = body.find(q('sectPr'))
        for note in ['材料处理说明'] + request['warnings']:
            element = paragraph(note)
            if section is not None:
                section.addprevious(element)
            else:
                body.append(element)
    # Existing text, tables, drawings, relationships, headers and footers remain in their package.
    if len(nodes) != len(list(original.iter(q('p')))):
        raise ValueError('QA_SOURCE_CHANGED')
    write(output, {**parts, 'word/document.xml': serialized(root)})


if __name__ == '__main__':
    if sys.argv[1] == 'prepare':
        prepare(*sys.argv[2:5])
    elif sys.argv[1] == 'fill':
        fill(sys.argv[2], json.loads(Path(sys.argv[3]).read_text(encoding='utf8')), sys.argv[4])
    elif sys.argv[1] == 'evidence':
        evidence(*sys.argv[2:4])
    else:
        raise ValueError('QA_OPERATION_INVALID')
