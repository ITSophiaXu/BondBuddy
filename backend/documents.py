from __future__ import annotations

import csv
import io
import re
from pathlib import Path
from zipfile import ZipFile, BadZipFile
from datetime import datetime

MAX_SEGMENTS = 15000
MAX_TEXT = 3_000_000
ALLOWED = {'.docx', '.pdf', '.xlsx', '.csv', '.txt', '.md'}


def pdf_column_contexts(page):
    """Recover labelled columns in combined group/company statement pages.

    Retain native text as the citation. Geometry only adds row/column context,
    including empty columns, to avoid shifting an amount across a blank cell.
    """
    words = page.extract_words(x_tolerance=2, y_tolerance=3)
    scopes = [w for w in words if w['text'] in {'合并', '公司', '母公司'} and w['top'] < page.height * .4]
    for anchor in scopes:
        headers = sorted([w for w in scopes if abs(w['top'] - anchor['top']) < 3], key=lambda w:w['x0'])
        if len(headers) < 2:
            continue
        periods = [w for w in words if 0 < anchor['top']-w['top'] < 36 and
                   re.fullmatch(r'期末余额|期初余额|本期金额|上期金额|本年金额|上年金额|本年累计金额|上年同期金额|本期数|上期数', w['text'])]
        if len(periods) < 2:
            continue
        centers = [(w['x0'] + w['x1']) / 2 for w in headers]
        gaps = [b-a for a,b in zip(centers, centers[1:])]
        if min(gaps) < 24:
            continue
        edges = [centers[0]-gaps[0]/2] + [(a+b)/2 for a,b in zip(centers,centers[1:])] + [centers[-1]+gaps[-1]/2]
        labels = []
        for center, header in zip(centers, headers):
            period = min(periods, key=lambda w:abs((w['x0']+w['x1'])/2-center))
            labels.append(period['text'] + '/' + header['text'])
        if len(set(labels)) != len(labels):
            continue
        rows = []
        for w in sorted(words, key=lambda w:(w['top'],w['x0'])):
            row = next((r for r in rows[-3:] if abs(r['top']-w['top']) < 3), None)
            if row is None:
                row={'top':w['top'], 'words':[]}; rows.append(row)
            row['words'].append(w)
        contexts = {}
        for row in rows:
            if row['top'] <= anchor['bottom']:
                continue
            ordered = sorted(row['words'], key=lambda w:w['x0'])
            values = [[] for _ in headers]
            for w in ordered:
                if not re.fullmatch(r'[-+]?\d[\d,]*(?:\.\d+)?[%％]?|[—-]', w['text']):
                    continue
                center = (w['x0']+w['x1'])/2
                for i in range(len(headers)):
                    if edges[i] <= center < edges[i+1]:
                        values[i].append(w['text'])
                        break
            if any(values):
                key = re.sub(r'\s+', '', ''.join(w['text'] for w in ordered))
                contexts[key] = '原页列位置：' + '；'.join(label+'：'+(' '.join(value) if value else '空白（不能当作0）') for label,value in zip(labels,values))
        return contexts
    return {}


def text_diff(before, after):
    """Keep amounts and review markers whole, so a reviewer can read each change."""
    from difflib import SequenceMatcher
    tokens = r'【[^】]*】|[-+]?\d[\d,]*(?:\.\d+)?[%％]?|[A-Za-z]+|[^\d]'
    a, b = re.findall(tokens, before), re.findall(tokens, after)
    return [{'type': tag, 'old': ''.join(a[i:j]), 'new': ''.join(b[k:l])}
            for tag, i, j, k, l in SequenceMatcher(None, a, b, autojunk=False).get_opcodes()]


def parse_document(raw: bytes, name: str, file_id: str) -> dict:
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED:
        raise ValueError('支持 DOCX、PDF、XLSX、CSV、TXT 和 Markdown 文件。')
    if raw.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
        raise ValueError('文件带有权限保护或使用旧版 Office 格式，无法读取。请在有权限的 Office 中导出可读取的 DOCX / PDF 后上传。')
    if ext in {'.docx', '.xlsx'}:
        try:
            with ZipFile(io.BytesIO(raw)) as z:
                if sum(x.file_size for x in z.infolist()) > 120_000_000 or len(z.infolist()) > 15000:
                    raise ValueError('解压后的文件过大，请拆分材料后上传。')
        except BadZipFile as exc:
            raise ValueError('Office 文件无法读取，请检查格式及权限保护。') from exc
    blocks, segments, warnings = [], [], []

    def segment(text, locator, **extra):
        if len(segments) >= MAX_SEGMENTS:
            raise ValueError('单份材料的位置数量过多，请按报表或章节拆分。')
        sid = f'{file_id}:s{len(segments) + 1}'
        item = {'id': sid, 'text': str(text), 'locator': locator, **extra}
        segments.append(item)
        return item

    if ext == '.docx':
        from docx import Document
        from docx.oxml.ns import qn
        from docx.text.paragraph import Paragraph
        from docx.table import Table
        d = Document(io.BytesIO(raw))
        table_no = 0
        for index, node in enumerate(d.element.body):
            if node.tag == qn('w:p'):
                p = Paragraph(node, d)
                if not p.text.strip():
                    continue
                s = segment(p.text, f'正文段落 {index + 1}', body_index=index)
                style = p.style.name if p.style else ''
                style_heading = re.search(r'(?:Heading|标题)\s*(\d)', style)
                level = min(int(style_heading.group(1)), 3) if style_heading else 1
                toc_entry = style.lower().startswith('toc') or bool(re.search(r'\t\s*\d+\s*$', p.text))
                heading = not toc_entry and (bool(style_heading) or bool(re.match(r'^第[一二三四五六七八九十百\d]+[章节]', p.text.strip())))
                blocks.append({'type': 'heading' if heading else 'paragraph', 'level': level, 'toc_entry': toc_entry, **s})
            elif node.tag == qn('w:tbl'):
                table_no += 1
                t = Table(node, d)
                rows = []
                seen = {}
                for ri, row in enumerate(t.rows):
                    cells = []
                    for ci, cell in enumerate(row.cells):
                        # A merged cell is represented once, with stable references in the grid.
                        key = cell._tc
                        if key in seen:
                            cells.append({'id': seen[key]['id'], 'text': seen[key]['text'], 'merged': True})
                            continue
                        s = segment(cell.text, f'表 {table_no} · 第 {ri + 1} 行 · 第 {ci + 1} 列', body_index=index, row=ri, col=ci)
                        seen[key] = s
                        cells.append(s)
                    rows.append(cells)
                blocks.append({'id': f'{file_id}:table{table_no}', 'type': 'table', 'rows': rows})
        unsupported = len(d.element.xpath('.//w:txbxContent'))
        with ZipFile(io.BytesIO(raw)) as z:
            parts = [n for n in z.namelist() if re.match(r'word/(footnotes|endnotes|header\d+|footer\d+)\.xml$', n)]
        if unsupported or parts:
            warnings.append('正文和表格已提取；文本框、页眉页脚、脚注及尾注尚不自动更新，请人工检查。')
        if d.element.xpath('.//w:ins | .//w:del'):
            warnings.append('原文件含未处理修订；请先在 Word 中确认或拒绝旧修订，再作为正式底稿使用。')
    elif ext == '.pdf':
        import pdfplumber
        page_texts, scanned_pages, ocr_pages = {}, [], []
        try:
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                if len(pdf.pages) > 700:
                    raise ValueError('PDF 超过 700 页，请按报告拆分。')
                for page_no, page in enumerate(pdf.pages, 1):
                    text = page.extract_text(x_tolerance=2, y_tolerance=3) or ''
                    if not text.strip():
                        scanned_pages.append(page_no)
                    else:
                        page_texts[page_no] = {'text': text, 'ocr': False, 'columns': pdf_column_contexts(page)}
                page_count = len(pdf.pages)
            if scanned_pages:
                from .ocr import recognize_pdf_pages
                recognized, ocr_error = recognize_pdf_pages(raw, scanned_pages)
                for page_no, result in recognized.items():
                    if result['text'].strip():
                        page_texts[page_no] = result
                        ocr_pages.append(page_no)
                if ocr_error:
                    warnings.append(ocr_error)
                unread = [n for n in scanned_pages if n not in ocr_pages]
                if unread:
                    warnings.append('第 ' + '、'.join(map(str, unread)) + ' 页没有可读取正文，请人工查看原页或提供文字版。')
                if ocr_pages:
                    warnings.append('第 ' + '、'.join(map(str, ocr_pages)) + ' 页使用本机扫描识别；相关修改会保留【待确认】，请对照原页核对数字。')
            for page_no in sorted(page_texts):
                result = page_texts[page_no]
                lines = [part.strip() for part in result['text'].split('\n') if part.strip()]
                page_context = ' / '.join(lines[:7])[:1800]
                for part in lines:
                    columns = result.get('columns', {}).get(re.sub(r'\s+', '', part), '')
                    s = segment(part, f'PDF 第 {page_no} 页' + (' · 扫描识别' if result.get('ocr') else ''),
                                page=page_no, ocr=bool(result.get('ocr')), source_context=page_context + (' / ' + columns if columns else ''))
                    is_heading = bool(re.match(r'^第[一二三四五六七八九十百\d]+[章节]', part.strip()))
                    blocks.append({'type': 'heading' if is_heading else 'paragraph', 'level': 1, **s})
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError('PDF 无法读取，可能已加密或损坏，请提供可读取版本。') from exc
        warnings.append('PDF 按原页提取文字；复杂表格未恢复为可编辑网格。更新表格建议上传 DOCX 底稿，财务 PDF 可作为来源材料。')
    elif ext == '.xlsx':
        from openpyxl import load_workbook
        from openpyxl.utils import get_column_letter
        wb = load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
        try:
            for sheet in wb:
                rows = []
                if sheet.max_row > 20000 or sheet.max_column > 200:
                    raise ValueError('工作表过大，请保留相关报表区域后上传。')
                for ri, row in enumerate(sheet.iter_rows(), 1):
                    if not any(c.value is not None for c in row):
                        continue
                    cells = []
                    for ci, c in enumerate(row, 1):
                        val = '' if c.value is None else str(c.value)
                        coordinate = f'{get_column_letter(ci)}{ri}'
                        s = segment(val, f'{sheet.title} · {coordinate}', sheet=sheet.title, cell=coordinate)
                        cells.append(s)
                    rows.append(cells)
                heading = segment(sheet.title, f'工作表 {sheet.title}')
                blocks.extend([{'type': 'heading', 'level': 1, **heading}, {'type': 'table', 'id': f'{file_id}:sheet{len(blocks)}', 'rows': rows}])
        finally:
            wb.close()
        warnings.append('电子表格使用文件内保存的公式结果；未保存计算结果的单元格会保持空白，不填零。')
    else:
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            try:
                text = raw.decode('gb18030')
            except UnicodeDecodeError as exc:
                raise ValueError('文本编码无法识别，请另存为 UTF-8。') from exc
        if ext == '.csv':
            rows = []
            for ri, row in enumerate(csv.reader(io.StringIO(text))):
                rows.append([segment(v, f'第 {ri + 1} 行 · 第 {ci + 1} 列') for ci, v in enumerate(row)])
            blocks.append({'id': f'{file_id}:table1', 'type': 'table', 'rows': rows})
        else:
            lines = text.splitlines()
            i = 0
            while i < len(lines):
                line = lines[i].strip()
                if not line:
                    i += 1
                    continue
                if line.startswith('|'):
                    rows = []
                    while i < len(lines) and lines[i].strip().startswith('|'):
                        cells = [x.strip() for x in lines[i].strip().strip('|').split('|')]
                        if not all(re.fullmatch(r':?-{3,}:?', x) for x in cells):
                            rows.append([segment(v, f'第 {i + 1} 行 · 第 {ci + 1} 列') for ci, v in enumerate(cells)])
                        i += 1
                    blocks.append({'id': f'{file_id}:table{len(blocks)}', 'type': 'table', 'rows': rows})
                    continue
                heading = bool(re.match(r'^#{1,6} |^第[一二三四五六七八九十百\d]+[章节]', line))
                level = 1 if line.startswith('# ') or re.match(r'^第', line) else 2
                clean = re.sub(r'^#{1,6} ', '', line).replace('**', '')
                s = segment(clean, f'第 {i + 1} 行')
                blocks.append({'type': 'heading' if heading else 'paragraph', 'level': level, **s})
                i += 1
    if len(segments) > MAX_SEGMENTS or sum(len(s['text']) for s in segments) > MAX_TEXT:
        raise ValueError('提取内容超过单份材料限制，请拆分后上传。')
    # Keep labels beside numeric evidence even when retrieval splits a large table.
    chapter, nearby = '', []
    for block in blocks:
        if block['type'] == 'table':
            header_rows = []
            for ri, row in enumerate(block['rows'][:8]):
                text_values = [c['text'].strip() for c in row]
                has_amount = any(re.fullmatch(r'-?[\d,]+(?:\.\d+)?[%％]?', x) and not re.fullmatch(r'20\d{2}', x) for x in text_values)
                if ri and has_amount:
                    break
                header_rows.append(row)
            header = ' / '.join(' | '.join(c['text'] for c in row if c['text'].strip()) for row in header_rows)
            positions = {}
            for ri, row in enumerate(block['rows']):
                for ci, cell in enumerate(row):
                    positions.setdefault(cell['id'], []).append((ri, ci))
                    if not cell.get('merged'):
                        labels = [c['text'] for c in row[:max(ci, 1)] if c['text'].strip() and not re.fullmatch(r'[-+\d,.%％]+', c['text'].strip())]
                        column = ' | '.join(r[ci]['text'] for r in header_rows if ci < len(r) and r[ci]['text'].strip())
                        cell['source_context'] = ' / '.join([chapter, ' '.join(nearby[-2:]), header, '行名：' + ' '.join(labels[:3]), '列名：' + column])[:4000]
            for row in block['rows']:
                for cell in row:
                    if cell.get('merged'):
                        continue
                    coords = positions[cell['id']]
                    cell['rowspan'] = max(x[0] for x in coords) - min(x[0] for x in coords) + 1
                    cell['colspan'] = max(x[1] for x in coords) - min(x[1] for x in coords) + 1
        else:
            if block['type'] == 'heading':
                chapter = block['text']
            nearby.append(block['text'])
    source_checks = []
    for s in segments:
        for m in re.finditer(r'(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', s['text']):
            try:
                datetime(*map(int, m.groups()))
            except ValueError:
                issue = {'kind': 'invalid_date', 'text': '材料含无效日期“' + m.group() + '”，请核对原材料。',
                         'segment_id': s['id'], 'locator': s['locator'], 'requires_review': True}
                source_checks.append(issue)
                warnings.append(issue['text'])
    return {'blocks': blocks, 'segments': segments, 'warnings': list(dict.fromkeys(warnings)), 'page_count': locals().get('page_count'),
            'extension': ext, 'ocr_pages': locals().get('ocr_pages', []), 'source_checks': source_checks}


def targets(file):
    """Return each editable target once, including context for individual table cells."""
    result, chapter, seen = [], '前置部分', set()
    for block in file['blocks']:
        if block['type'] == 'heading':
            chapter = block['text']
        if block['type'] == 'table':
            header = ' | '.join(c['text'] for c in block['rows'][0]) if block['rows'] else ''
            for ri, row in enumerate(block['rows']):
                for ci, cell in enumerate(row):
                    if cell['id'] in seen:
                        continue
                    seen.add(cell['id'])
                    result.append({**cell, 'chapter': chapter, 'table': True, 'row': ri, 'col': ci, 'context': cell.get('source_context') or header + ' / ' + (row[0]['text'] if row else '')})
        else:
            result.append({**block, 'chapter': chapter, 'table': False, 'context': chapter})
    return result


def word_export(file, changes, view='final', original_bytes=None):
    """Create a DOCX with true w:ins/w:del revisions; never strip review brackets."""
    if file.get('extension') == '.docx' or Path(file.get('name', '')).suffix.lower() == '.docx':
        from .docx_fidelity import patch_docx
        return patch_docx(file, changes, view, original_bytes)
    from docx import Document
    from docx.shared import Pt, Inches
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from datetime import datetime, timezone
    d = Document()
    d.sections[0].page_width, d.sections[0].page_height = Inches(8.27), Inches(11.69)
    st = d.styles['Normal']
    st.font.name = '宋体'
    st.font.size = Pt(11)
    st.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), '宋体')
    st.paragraph_format.line_spacing = 1.4
    rev_id = 0
    indexed = {c['target_id']: c for c in changes if c['status'] != 'rejected'}

    def fill(p, cell):
        nonlocal rev_id
        c = indexed.get(cell['id'])
        if not c:
            p.add_run(cell['text'])
            return
        old, new = cell['text'], c['after']
        if view != 'revision':
            p.add_run(new)
            return
        for diff in text_diff(old, new):
            tag = diff['type']
            if tag == 'equal':
                p.add_run(diff['old'])
                continue
            for kind, text in [('del', diff['old']), ('ins', diff['new'])]:
                if not text:
                    continue
                rev_id += 1
                el = OxmlElement('w:' + kind)
                el.set(qn('w:id'), str(rev_id))
                el.set(qn('w:author'), '募集书 Cowork')
                el.set(qn('w:date'), datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
                r = OxmlElement('w:r')
                t = OxmlElement('w:delText' if kind == 'del' else 'w:t')
                t.set(qn('xml:space'), 'preserve')
                t.text = text
                r.append(t)
                el.append(r)
                p._p.append(el)

    for block in file['blocks']:
        if block['type'] == 'table':
            ncols = max((len(r) for r in block['rows']), default=0)
            if not ncols:
                continue
            table = d.add_table(rows=len(block['rows']), cols=ncols)
            table.style = 'Table Grid'
            for ri, row in enumerate(block['rows']):
                tr = table.rows[ri]
                if ri == 0:
                    h = OxmlElement('w:tblHeader')
                    tr._tr.get_or_add_trPr().append(h)
                for ci, cell in enumerate(row):
                    if cell.get('merged'):
                        continue
                    row_span, col_span = cell.get('rowspan', 1), cell.get('colspan', 1)
                    if row_span > 1 or col_span > 1:
                        table.cell(ri, ci).merge(table.cell(ri + row_span - 1, ci + col_span - 1))
                    fill(tr.cells[ci].paragraphs[0], cell)
                    if cell['id'] in indexed:
                        shd = OxmlElement('w:shd')
                        shd.set(qn('w:fill'), 'FFF2CC' if indexed[cell['id']]['needs_review'] else 'E5F2E9')
                        tr.cells[ci]._tc.get_or_add_tcPr().append(shd)
        else:
            p = d.add_paragraph(style='Heading 1' if block['type'] == 'heading' else None)
            fill(p, block)
    d.core_properties.title = file['name']
    d.core_properties.author = '募集书 Cowork'
    out = io.BytesIO()
    d.save(out)
    return out.getvalue()
