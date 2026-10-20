"""Trusted, deterministic review edits. No model/network calls, no document reconstruction for DOCX."""
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from .word_patch import Patcher, xml, serialized, paragraph_text, q, add_layout_comments
from .annotate_review import findings_from_markdown, plain
from bondbuddy_word_delivery.writer import normalize_old_revisions


def findings(text):
    canonical, parsed = findings_from_markdown(text)
    blocks = re.split(r'^###\s+', canonical, flags=re.M)[1:]
    result = []
    for item, block in zip(parsed, blocks):
        fields = {}
        for line in block.splitlines()[1:]:
            match = re.match(r'^\s*(?:[-*]\s+)?(?:\*\*)?([^*：:]{2,12})(?:\*\*)?[：:](?:\*\*)?\s*(.*)$', line)
            if match:
                fields[match[1].strip()] = plain(match[2]).strip().strip('`')
        replacement = fields.get('替换文本', '')
        missing = fields.get('缺少材料', fields.get('待确认事项', ''))
        if missing in ('无', '无。', '无缺项', '无待确认事项'):
            missing = ''
        evidence = fields.get('核对依据', '')
        uncertain = fields.get('处理方式') != '直接修改' or bool(missing) or not evidence
        targets = item['targets']
        result.append(dict(id=item['finding_id'], category=fields.get('复核类别', '待确认'), title=plain(item['title']),
                           original=targets[0]['quote'] if len(targets) == 1 else '', replacement=replacement,
                           reason=fields.get('问题说明', item['comment_text']), evidence=evidence, missing=missing,
                           uncertain=uncertain, paragraph_id=None, decision='suggested', manual_text='', applied=False, limitation=''))
    return result


def package(source, output):
    warnings = []
    if source.suffix.lower() == '.pdf':
        from docx import Document
        import pdfplumber
        document = Document()
        with pdfplumber.open(source) as pdf:
            for i, page in enumerate(pdf.pages):
                if i:
                    document.add_page_break()
                text = page.extract_text() or ''
                if not text.strip():
                    text = f'【待补充：原 PDF 第 {i+1} 页无法提取文字，请提供可检索 PDF 或 Word，并人工核对本页内容。】'
                    warnings.append(text)
                for line in text.splitlines():
                    document.add_paragraph(line)
        path = output / 'converted.docx'
        document.save(path)
        warnings.insert(0, '原稿为 PDF，已按可提取文字转换为 Word；版式、表格与分页可能不同，请对照原 PDF 核对。')
    else:
        path = source
    with ZipFile(path) as z:
        if sum(i.file_size for i in z.infolist()) > 250_000_000:
            raise ValueError('REVIEW_SOURCE_TOO_LARGE')
        parts = {i.filename: z.read(i.filename) for i in z.infolist()}
    parts.setdefault('word/_rels/document.xml.rels', b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
    root = xml(parts['word/document.xml'])
    # The baseline is the effective text of the submitted version, not old deleted text.
    if any(root.iter(q('ins'))) or any(root.iter(q('del'))):
        normalize_old_revisions(root)
        warnings.append('原稿既有文字修订按接受后的有效文本作为本次基线，上传原件保持不变。')
    parts['word/document.xml'] = serialized(root)
    return parts, root, warnings


def write(path, parts):
    with ZipFile(path, 'w', ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)


def build(source, request, output):
    output.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    if sha != request['pin']['sha256']:
        raise ValueError('INPUT_REVISION_CONFLICT')
    parts, baseline, warnings = package(source, output)
    ps = list(baseline.iter(q('p')))
    paragraphs = [dict(id=f'p{i}', text=paragraph_text(p)) for i, p in enumerate(ps)]
    if request.get('editor'):
        previous = request['editor']
        if previous['source_sha256'] != sha or previous['paragraphs'] != paragraphs:
            raise ValueError('INPUT_REVISION_CONFLICT')
        issues = copy.deepcopy(previous['issues'])
    else:
        issues = findings(request['markdown'])
    if not issues:
        warnings.append('复核报告未提供可定位的问题条目，本次未自动修改正文。请阅读报告的覆盖范围并人工核对，不能据此认定未发现问题。')
    decisions = {d['id']: d for d in request.get('decisions', [])}
    if decisions and (len(decisions) != len(issues) or set(decisions) != {i['id'] for i in issues}):
        raise ValueError('REVIEW_DECISIONS_INVALID')
    for issue in issues:
        issue.update(decisions.get(issue['id'], {}))
        issue.update(applied=False, limitation='', paragraph_id=None)
        matches = [p for p in paragraphs if issue['original'] and p['text'].count(issue['original']) == 1]
        if len(matches) == 1 and sum(p['text'].count(issue['original']) for p in paragraphs) == 1:
            issue['paragraph_id'] = matches[0]['id']
        else:
            issue['limitation'] = '原文无法唯一定位，保留原文；请下载后人工核对。'
    revised, clean = copy.deepcopy(baseline), copy.deepcopy(baseline)
    maps = [{f'p{i}': p for i, p in enumerate(r.iter(q('p')))} for r in (revised, clean)]
    # Group edits against the unchanged paragraph; reject overlapping edits explicitly.
    for paragraph in paragraphs:
        entries = [i for i in issues if i['paragraph_id'] == paragraph['id']]
        changes = []
        for issue in entries:
            if issue['decision'] == 'original' or (issue['decision'] == 'suggested' and (issue['uncertain'] or not issue['replacement'])):
                continue
            start = paragraph['text'].index(issue['original'])
            end = start + len(issue['original'])
            changes.append((start, end, issue))
        for start, end, issue in changes:
            if any(other is not issue and start < b and a < end for a, b, other in changes):
                issue['limitation'] = '多项建议修改了同一原文，请保留其中一项后重新保存。'
        selected = [(a,b,i) for a,b,i in changes if not i['limitation']]
        updated = paragraph['text']
        for a,b,issue in sorted(selected, key=lambda x:x[0], reverse=True):
            updated = updated[:a] + (issue['manual_text'] if issue['decision']=='manual' else issue['replacement']) + updated[b:]
        if selected:
            # Work on copies: failure must not leave a partial patch in either output.
            candidates = [copy.deepcopy(m[paragraph['id']]) for m in maps]
            try:
                for candidate, tracked in zip(candidates, (True, False)):
                    Patcher(revised if tracked else clean, tracked).patch(candidate, paragraph['text'], updated)
            except ValueError:
                for _,_,issue in selected:
                    issue['limitation'] = '此处结构无法安全保留，未自动修改，请在 Word 中处理。'
            else:
                for m,candidate in zip(maps,candidates):
                    node=m[paragraph['id']]
                    node.getparent().replace(node,candidate)
                    m[paragraph['id']]=candidate
                for _,_,issue in selected:
                    issue['applied']=True
    basepath = output / 'baseline.docx'
    write(basepath, parts)
    tasks = []
    for issue in issues:
        status = '用户保留原文' if issue['decision']=='original' else '用户手动修改' if issue['decision']=='manual' and issue['applied'] else '已按建议修改' if issue['applied'] else '待人工确认，保留原文'
        note = '\n'.join(filter(None, [issue['id']+' · '+issue['title'], status, issue['reason'], '依据：'+issue['evidence'] if issue['evidence'] else '', '缺少材料：'+issue['missing'] if issue['missing'] else '', issue['limitation']]))
        anchor=issue['paragraph_id'] or (paragraphs[0]['id'] if paragraphs else None)
        if anchor:
            tasks.append(dict(target_id=anchor, text=note))
    replacements = {}
    if tasks:
        with ZipFile(basepath) as z:
            add_layout_comments(z,revised,{key:(node,) for key,node in maps[0].items()},tasks,replacements)
    replacements['word/document.xml']=serialized(revised)
    write(output/'revision.docx', {**parts,**replacements})
    # Clean output has no review marks/comments. Keep explicit unresolved-material notices visible.
    for node in list(clean.iter()):
        if node.tag in (q('commentRangeStart'),q('commentRangeEnd'),q('commentReference')) and node.getparent() is not None:
            node.getparent().remove(node)
    pending = [i for i in issues if i['decision']!='original' and (i['missing'] or i['limitation'] or (i['uncertain'] and not i['applied']))]
    if pending or warnings:
        from lxml import etree as ET
        body=clean.find(q('body'))
        lines=['复核待确认事项']+warnings+[i['id']+' '+i['title']+'：'+(i['missing'] or i['limitation'] or i['reason']) for i in pending]
        for line in lines:
            p=ET.Element(q('p')); ET.SubElement(ET.SubElement(p,q('r')),q('t')).text=line
            section=body.find(q('sectPr'))
            body.insert(body.index(section) if section is not None else len(body),p)
    cleanparts={**parts,'word/document.xml':serialized(clean)}
    # Remove orphaned comment parts and declarations in clean output.
    for name in list(cleanparts):
        if re.match(r'word/comments.*\.xml$', name):
            del cleanparts[name]
    for name in ('word/_rels/document.xml.rels','[Content_Types].xml'):
        root=xml(cleanparts[name])
        for node in list(root):
            if 'comments' in (node.get('Type','')+node.get('PartName','')).lower():
                root.remove(node)
        cleanparts[name]=serialized(root)
    write(output/'clean.docx', cleanparts)
    snapshot=dict(version='review-editor-v1',source_filename=request['filename'],source_sha256=sha,source_format=source.suffix.lower()[1:],warnings=warnings,paragraphs=paragraphs,issues=issues)
    (output/'editor.json').write_text(json.dumps(snapshot,ensure_ascii=False),encoding='utf8')
    return snapshot


if __name__ == '__main__':
    build(Path(sys.argv[1]),json.loads(Path(sys.argv[2]).read_text(encoding='utf8')),Path(sys.argv[3]))
