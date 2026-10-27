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
    for i, span in enumerate(snapshot['spans']):
        text = span['text'].strip()
        if text and (re.match(r'^(?:问题\s*[一二三四五六七八九十百\d]+|[一二三四五六七八九十百\d]+[、.．）)]|[（(][一二三四五六七八九十百\d]+[)）])', text)
                     or re.match(r'^(?:请|是否|如何|为什么|为何)', text) or text.endswith(('？', '?'))):
            candidates.append(i)
    # One anchor per paragraph: surrounding headings and evidence remain in the original file.
    questions = [dict(id='q' + str(i), start=i, end=i, question=snapshot['spans'][i]['text'].strip())
                 for i in candidates[:200] if len(snapshot['spans'][i]['text']) <= 16000]
    if not questions:
        warnings.append('没有找到明确的问题编号或问句。请根据原文选择问题段落后开始。')
    if len(candidates) > 200:
        warnings.append('识别到超过 200 个候选问题，请分批处理或调整范围。')
    Path(result).write_text(json.dumps(dict(snapshot=snapshot, questions=questions, warnings=warnings + extra), ensure_ascii=False), encoding='utf8')


def paragraph(text, bold=False):
    p = etree.Element(q('p'))
    prop = etree.SubElement(p, q('pPr'))
    etree.SubElement(prop, q('spacing'), {q('after'): '120', q('line'): '276', q('lineRule'): 'auto'})
    run = etree.SubElement(p, q('r'))
    rp = etree.SubElement(run, q('rPr'))
    etree.SubElement(rp, q('rFonts'), {q('ascii'): 'Arial', q('hAnsi'): 'Arial', q('eastAsia'): '宋体'})
    etree.SubElement(rp, q('sz'), {q('val'): '22'})
    if bold:
        etree.SubElement(rp, q('b'))
    for i, line in enumerate(text.split('\n')):
        if i:
            etree.SubElement(run, q('br'))
        t = etree.SubElement(run, q('t'))
        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        t.text = line
    return p


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
            data = json.loads(meta.read_text(encoding='utf8'))['snapshot']
            data.update(format='doc', sha256=hashlib.sha256(source.read_bytes()).hexdigest(), coverage='partial')
            data['warnings'].append('DOC 已转换后提取，定位请对照原稿核对。')
    else:
        data = inspect(source)
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
        for text, bold in content:
            new = paragraph(text, bold)
            anchor.addnext(new)
            anchor = new
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
