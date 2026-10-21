"""Exact, version-bound text anchors and conservative Word edits for project files.

The model proposes links/edits. This module reads the bytes and checks every anchor;
it never treats a model's quotation or 'consistent' label as verified evidence.
"""
import copy
import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

from .review_corrections import package, write
from .word_patch import Patcher, add_layout_comments, paragraph_text, q, serialized, xml


def inspect(path):
    path = Path(path)
    if path.suffix.lower() not in ('.docx', '.pdf'):
        raise ValueError('FILE_FORMAT_UNSUPPORTED')
    with tempfile.TemporaryDirectory(prefix='bb-file-inspect-') as tmp:
        _, root, warnings = package(path, Path(tmp))
    heading = ''
    spans = []
    tables = list(root.iter(q('tbl')))
    for index, paragraph in enumerate(root.iter(q('p'))):
        text = paragraph_text(paragraph)
        style = paragraph.find('./' + q('pPr') + '/' + q('pStyle'))
        if style is not None and re.search(r'heading|标题', style.get(q('val'), ''), re.I):
            heading = text
        location = (heading + ' / ' if heading and heading != text else '') + f'段落 {index + 1}'
        cell = next((a for a in paragraph.iterancestors() if a.tag == q('tc')), None)
        if cell is not None:
            row = cell.getparent()
            table = row.getparent()
            if table in tables:
                location = f'表格 {tables.index(table) + 1} / 行 {list(table.iterchildren(q("tr"))).index(row) + 1} / 列 {list(row.iterchildren(q("tc"))).index(cell) + 1}'
        spans.append(dict(id=f'p{index}', text=text, location=location,
                          sha256=hashlib.sha256(text.encode('utf8')).hexdigest()))
    if not any(s['text'].strip() for s in spans):
        warnings.append('文件没有可提取的文字，需补充可检索 PDF 或 Word 后重新检查。')
    return dict(version='project-file-text-v1', sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                format=path.suffix.lower()[1:], spans=spans, warnings=warnings,
                coverage='partial' if warnings else 'complete')


def anchor(snapshot, paragraph_id, quote):
    """Match within one pinned paragraph, including its table/period context."""
    paragraph = next((p for p in snapshot['spans'] if p['id'] == paragraph_id), None)
    if not paragraph or not isinstance(quote, str) or not quote.strip() or paragraph['text'].count(quote) != 1:
        raise ValueError('FILE_ANCHOR_UNRESOLVED')
    return paragraph


def validate_links(source, target, links):
    verified, unresolved = [], []
    for link in links:
        try:
            source_span = anchor(source, link['source_span_id'], link['source_quote'])
            target_span = anchor(target, link['target_span_id'], link['target_quote'])
            verified.append({**link, 'source_location': source_span['location'], 'target_location': target_span['location'],
                             'source_sha256': source['sha256'], 'target_sha256': target['sha256']})
        except (ValueError, KeyError, TypeError):
            unresolved.append({'reason': '引用无法在固定版本中准确定位，需人工核对。'})
    return {'links': verified, 'unresolved': unresolved}


def patch(path, request, output):
    """Apply only explicitly accepted, exact anchored nonoverlapping edits."""
    path, output = Path(path), Path(output)
    snapshot = inspect(path)
    if snapshot['sha256'] != request['target_sha256']:
        raise ValueError('INPUT_REVISION_CONFLICT')
    output.mkdir(parents=True, exist_ok=True)
    parts, baseline, warnings = package(path, output)
    edits = request['edits']
    if not edits or len({e['id'] for e in edits}) != len(edits):
        raise ValueError('FILE_EDIT_SELECTION_INVALID')
    grouped = {}
    for edit in edits:
        p = anchor(snapshot, edit['target_span_id'], edit['original'])
        if not isinstance(edit['replacement'], str) or edit['replacement'] == edit['original']:
            raise ValueError('FILE_EDIT_SELECTION_INVALID')
        if not edit.get('reason') or not edit.get('source_quote') or not edit.get('source_location'):
            raise ValueError('FILE_EDIT_EVIDENCE_REQUIRED')
        start = p['text'].index(edit['original'])
        grouped.setdefault(p['id'], []).append((start, start + len(edit['original']), edit))
    revised, clean = copy.deepcopy(baseline), copy.deepcopy(baseline)
    maps = [{f'p{i}': p for i, p in enumerate(root.iter(q('p')))} for root in (revised, clean)]
    patchers = [Patcher(revised, True), Patcher(clean, False)]
    for pid, entries in grouped.items():
        ordered = sorted(entries, key=lambda e: e[0])
        if any(a[1] > b[0] for a, b in zip(ordered, ordered[1:])):
            raise ValueError('FILE_EDITS_OVERLAP')
        before = next(s['text'] for s in snapshot['spans'] if s['id'] == pid)
        after = before
        for start, end, edit in reversed(ordered):
            after = after[:start] + edit['replacement'] + after[end:]
        for mapping, patcher in zip(maps, patchers):
            patcher.patch(mapping[pid], before, after)
    baseline_path = output / 'baseline.docx'
    write(baseline_path, parts)
    replacements = {}
    comments = [dict(target_id=e['target_span_id'], text='\n'.join([
        '文件一致性检查 · ' + e['id'], e['reason'],
        '基准募集书：' + request['source_filename'], '位置：' + e['source_location'],
        '依据：' + e['source_quote']])) for e in edits]
    with ZipFile(baseline_path) as z:
        add_layout_comments(z, revised, {k: (p,) for k, p in maps[0].items()}, comments, replacements)
    write(output / 'revision.docx', {**parts, **replacements, 'word/document.xml': serialized(revised)})
    for node in list(clean.iter()):
        if node.tag in (q('commentRangeStart'), q('commentRangeEnd'), q('commentReference')) and node.getparent() is not None:
            node.getparent().remove(node)
    cleanparts = {**parts, 'word/document.xml': serialized(clean)}
    for name in list(cleanparts):
        if re.match(r'word/comments.*\.xml$', name):
            del cleanparts[name]
    for name in ('word/_rels/document.xml.rels', '[Content_Types].xml'):
        root = xml(cleanparts[name])
        for node in list(root):
            if 'comments' in (node.get('Type', '') + node.get('PartName', '')).lower():
                root.remove(node)
        cleanparts[name] = serialized(root)
    write(output / 'clean.docx', cleanparts)
    result = dict(version='project-file-patch-v1', target_sha256=request['target_sha256'],
                  applied_ids=[e['id'] for e in edits], warnings=warnings)
    (output / 'patch.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf8')
    return result


if __name__ == '__main__':
    if sys.argv[1] == 'inspect':
        Path(sys.argv[3]).write_text(json.dumps(inspect(sys.argv[2]), ensure_ascii=False), encoding='utf8')
    elif sys.argv[1] == 'patch':
        patch(sys.argv[2], json.loads(Path(sys.argv[3]).read_text(encoding='utf8')), sys.argv[4])
    else:
        raise ValueError('UNKNOWN_FILE_OPERATION')
