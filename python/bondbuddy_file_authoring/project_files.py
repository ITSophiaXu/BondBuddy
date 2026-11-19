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


def coverage_is_complete(warnings):
    """Only unread content blocks coverage.

    A PDF is always converted to an editable Word package, and existing revisions
    are normalized to their accepted text. Those are layout/provenance notices,
    not evidence that text was missed. Blank pages, images and embedded content
    still make the snapshot partial until they are actually read.
    """
    advisory = ('原稿为 PDF，', '原稿既有文字修订')
    return not any(not (isinstance(warning, str) and warning.startswith(advisory)) for warning in warnings)


def inspect(path, complete=False, packaged=None):
    path = Path(path)
    if path.suffix.lower() not in ('.docx', '.pdf'):
        raise ValueError('FILE_FORMAT_UNSUPPORTED')
    if packaged is None:
        with tempfile.TemporaryDirectory(prefix='bb-file-inspect-') as tmp:
            parts, root, warnings = package(path, Path(tmp))
    else:
        parts, root, warnings = packaged
        warnings = list(warnings)
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
    if complete:
        for name, content in sorted(parts.items()):
            if re.fullmatch(r'word/(footnotes|endnotes|header\d*|footer\d*)\.xml', name):
                extra = xml(content)
                for index, paragraph in enumerate(extra.iter(q('p'))):
                    text = paragraph_text(paragraph)
                    spans.append(dict(id=f'{Path(name).stem}-p{index}', text=text,
                                      location=f'{Path(name).stem} / 段落 {index+1}',
                                      sha256=hashlib.sha256(text.encode('utf8')).hexdigest()))
        images = [name for name in parts if name.startswith('word/media/')]
        if images:
            warnings.append(f'含 {len(images)} 个图片对象，须阅读其中信息；文字提取不能证明图片已完整覆盖。')
        if any(root.iter(q('altChunk'))):
            warnings.append('含嵌入内容，需要另行读取，尚不能确认全文覆盖。')
    if not any(s['text'].strip() for s in spans):
        warnings.append('文件没有可提取的文字，需补充可检索 PDF 或 Word 后重新检查。')
    return dict(version='project-file-text-v1', sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                format=path.suffix.lower()[1:], spans=spans, warnings=warnings,
                coverage='complete' if coverage_is_complete(warnings) else 'partial')



def table_layout(path, packaged=None):
    """Private host layout proof; keep the versioned text snapshot unchanged.

    Only whole-width rows in a genuine multi-column grid qualify. A one-column
    table, vertical merge, omitted grid positions, nested table or drawing stays
    on the ordinary cell path. The collector still requires verbatim full text
    before a proven whole-width paragraph may live outside a table.
    """
    path = Path(path)
    if path.suffix.lower() not in ('.docx', '.pdf'):
        raise ValueError('FILE_FORMAT_UNSUPPORTED')
    if packaged is None:
        with tempfile.TemporaryDirectory(prefix='bb-table-layout-') as tmp:
            _, root, _ = package(path, Path(tmp))
    else:
        _, root, _ = packaged
    full_cells = set()
    blocked = {q('drawing'), q('pict'), q('object'), q('altChunk'), q('tbl')}
    for table in root.iter(q('tbl')):
        grid = table.find(q('tblGrid'))
        columns = len(list(grid.iterchildren(q('gridCol')))) if grid is not None else 0
        rows = list(table.iterchildren(q('tr')))
        has_data_grid = any(sum(any(paragraph_text(p).strip() for p in c.iter(q('p')))
                                   for c in r.iterchildren(q('tc'))) >= 2 for r in rows)
        if columns < 2 or not has_data_grid:
            continue
        for row in rows:
            cells = list(row.iterchildren(q('tc')))
            if len(cells) != 1:
                continue
            cell = cells[0]
            span = cell.find('./' + q('tcPr') + '/' + q('gridSpan'))
            if span is None or span.get(q('val')) != str(columns):
                continue
            if any(cell.find('./' + q('tcPr') + '/' + q(name)) is not None
                   for name in ('vMerge', 'hMerge')):
                continue
            offsets = [row.find('./' + q('trPr') + '/' + q(name))
                       for name in ('gridBefore', 'gridAfter')]
            if any(n is not None and n.get(q('val')) != '0' for n in offsets):
                continue
            if any(n.tag in blocked for n in cell.iter()):
                continue
            full_cells.add(cell)
    ids = []
    for index, paragraph in enumerate(root.iter(q('p'))):
        cell = next((a for a in paragraph.iterancestors() if a.tag == q('tc')), None)
        if cell in full_cells and paragraph_text(paragraph).strip():
            ids.append(f'p{index}')
    return dict(version='workpaper-table-layout-v1', sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                full_width_span_ids=ids)


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
    """Produce a file revision from all verified, nonoverlapping conflicts."""
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
    for finding in request.get('manual_findings', []):
        # Unresolved evidence stays a comment and never changes the document text.
        pid = finding.get('target_span_id')
        if pid not in maps[0]:
            pid = next(iter(maps[0]), None)
        if pid:
            comments.append(dict(target_id=pid, text='\n'.join([
                '文件一致性检查 · 需人工确认（原文未修改）',
                finding.get('reason', ''), '原文：' + finding.get('original', ''),
                '基准募集书：' + request['source_filename'],
                '参考依据：' + (finding.get('source_quote') or '缺少可核验依据，请补充材料。')])))
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


def source_diff(before, after):
    """Align by text, not paragraph indexes; insertions must not shift all links.

    Expand a changed table to its complete cell group so a revised period/header
    also invalidates links to numbers whose literal value did not change.
    """
    from difflib import SequenceMatcher
    left = [s for s in before['spans'] if s['text'].strip()]
    right = [s for s in after['spans'] if s['text'].strip()]
    changes = []
    if [s['text'] for s in left] == [s['text'] for s in right]:
        return []
    for tag, a, b, c, d in SequenceMatcher(None, [s['text'] for s in left],
                                        [s['text'] for s in right], autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        old, new = left[a:b], right[c:d]
        def tables(group, spans):
            names = {s['location'].split(' / 行 ')[0] for s in group if ' / 行 ' in s['location']}
            return [s for s in spans if s in group or s['location'].split(' / 行 ')[0] in names]
        old, new = tables(old, left), tables(new, right)
        changes.append(dict(before_ids=[s['id'] for s in old], after_ids=[s['id'] for s in new],
                            before='\n'.join(s['text'] for s in old), after='\n'.join(s['text'] for s in new),
                            location=(old or new)[0]['location']))
    unique = {json.dumps([c['before_ids'], c['after_ids']]): c for c in changes}
    return list(unique.values())


if __name__ == '__main__':
    if sys.argv[1] in ('inspect', 'inspect-complete'):
        Path(sys.argv[3]).write_text(json.dumps(inspect(sys.argv[2], complete=sys.argv[1]=='inspect-complete'), ensure_ascii=False), encoding='utf8')
    elif sys.argv[1] == 'table-layout':
        Path(sys.argv[3]).write_text(json.dumps(table_layout(sys.argv[2]), ensure_ascii=False), encoding='utf8')
    elif sys.argv[1] == 'diff':
        before, after = [json.loads(Path(p).read_text(encoding='utf8')) for p in sys.argv[2:4]]
        Path(sys.argv[4]).write_text(json.dumps(source_diff(before, after), ensure_ascii=False), encoding='utf8')
    elif sys.argv[1] == 'patch':
        patch(sys.argv[2], json.loads(Path(sys.argv[3]).read_text(encoding='utf8')), sys.argv[4])
    else:
        raise ValueError('UNKNOWN_FILE_OPERATION')
