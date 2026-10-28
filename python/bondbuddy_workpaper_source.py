"""Full, version-bound source extraction shared by all entries in one batch.

The model sees original image/page assets as well as native text. Native Word
cells (including nested tables) and PDF ruled-table geometry remain physical
cells, never python-docx's repeated aliases of merged cells.
"""
import base64
import hashlib
import io
import re
import tempfile
from pathlib import Path

from bondbuddy_file_authoring.project_files import inspect
from bondbuddy_file_authoring.review_corrections import package
from bondbuddy_file_authoring.word_patch import q, xml

VERSION = 'workpaper-source-v1'
ATTRIBUTION = re.compile(r'^\s*(?:(?:数据|资料|信息)来源|来源|编制依据)\s*[：:]')
CONTEXT = re.compile(r'单位\s*[：:]|币种\s*[：:]|^(?:注[：:\d一二三]|附注|备注)|(?:表|明细|情况|结构|构成|指标|续表)[：:]?$')


def asset(images, name, data, **extra):
    item = dict(id=f'image-{len(images)+1}', name=name,
                sha256=hashlib.sha256(data).hexdigest(), data=base64.b64encode(data).decode('ascii'), **extra)
    images.append(item)
    return item['id']


def table_context(snapshot):
    """Keep nearby table labels, units and notes even if only a cell was selected.

    This is a conservative structural floor; the model must still map explanations
    and disclosures elsewhere in the source. Never discard table footer rows.
    """
    spans = snapshot['source']['spans']
    indexes = {s['id']: i for i, s in enumerate(spans)}
    in_tables = {sid for t in snapshot['tables'] for sid in t['span_ids']}
    for table in snapshot['tables']:
        positions = [indexes[sid] for sid in table['span_ids']]
        context = set(table.get('context_ids', []))
        if positions:
            for start, step in ((min(positions)-1, -1), (max(positions)+1, 1)):
                cursor, found = start, 0
                while 0 <= cursor < len(spans):
                    s = spans[cursor]
                    if s['id'] in in_tables:
                        break
                    text = s['text'].strip()
                    if text and not ATTRIBUTION.search(text):
                        if not CONTEXT.search(text):
                            break
                        context.add(s['id']); found += 1
                        if found >= 12:
                            break
                    cursor += step
        table['context_ids'] = sorted(context, key=lambda sid: indexes[sid])
    snapshot['internal_only_ids'] = [s['id'] for s in spans if ATTRIBUTION.search(s['text'])]
    return snapshot


def extract_docx(path):
    with tempfile.TemporaryDirectory(prefix='bb-shared-source-') as tmp:
        parts, root, warnings = package(Path(path), Path(tmp))
    if any(root.iter(q('altChunk'))):
        raise ValueError('WORKPAPER_EMBEDDED_CONTENT_UNREADABLE')
    source = inspect(path, complete=True, packaged=(parts, root, warnings))
    roots = [(root, '')]
    for name, content in sorted(parts.items()):
        if re.fullmatch(r'word/(footnotes|endnotes|header\d*|footer\d*)\.xml', name):
            roots.append((xml(content), Path(name).stem + '-'))
    pids = {p: f'{prefix}p{i}' for r, prefix in roots for i, p in enumerate(r.iter(q('p')))}
    nodes = [t for r, _ in roots for t in r.iter(q('tbl'))]
    tids = {t: f'table-{i+1}' for i, t in enumerate(nodes)}
    tables = []

    def content_nodes(node):
        for child in node:
            if child.tag in (q('p'), q('tbl')):
                yield child
            elif child.tag not in (q('tcPr'), q('trPr')):
                yield from content_nodes(child)

    for table in nodes:
        rows = []
        for row in table.findall(q('tr')):
            cells = []
            for cell in row.findall(q('tc')):
                grid = cell.find(q('tcPr') + '/' + q('gridSpan'))
                merge = cell.find(q('tcPr') + '/' + q('vMerge'))
                content = [dict(span_id=pids[c]) if c.tag == q('p') else dict(table_id=tids[c]) for c in content_nodes(cell)]
                cells.append(dict(content=content, colspan=int(grid.get(q('val'))) if grid is not None else 1,
                                  vmerge=merge.get(q('val'), 'continue') if merge is not None else None))
            def omitted(name):
                node = row.find(q('trPr')+'/'+q(name))
                return int(node.get(q('val'), '0')) if node is not None else 0
            rows.append(dict(cells=cells, header=row.find(q('trPr')+'/'+q('tblHeader')) is not None,
                             before=omitted('gridBefore'), after=omitted('gridAfter')))
        widths = [int(c.get(q('w'), '0')) for c in table.findall(q('tblGrid')+'/'+q('gridCol'))]
        tables.append(dict(id=tids[table], rows=rows, widths=widths, span_ids=[pids[p] for p in table.iter(q('p'))],
                           nested=any(a.tag == q('tbl') for a in table.iterancestors())))
    images = []
    for name in sorted(parts):
        if name.startswith('word/media/'):
            asset(images, Path(name).name, parts[name])
    dependencies = {}
    for r, _ in roots:
        for p in r.iter(q('p')):
            note_ids = []
            for kind in ('footnote', 'endnote'):
                for ref in p.iter(q(kind+'Reference')):
                    content = parts.get('word/'+kind+'s.xml')
                    if content:
                        note_root = xml(content)
                        note = next((n for n in note_root if n.get(q('id')) == ref.get(q('id'))), None)
                        if note is not None:
                            all_ps = list(note_root.iter(q('p')))
                            note_ids.extend(f'{kind}s-p{all_ps.index(n)}' for n in note.iter(q('p')))
            if note_ids:
                dependencies[pids[p]] = note_ids
    return table_context(dict(version=VERSION, source=source, tables=tables, images=images, dependencies=dependencies))


def extract_pdf(path):
    """Retain native ruled tables plus every page for visual reading.

    Borderless or scanned tables remain visible in page images; the batch plan
    must explicitly acknowledge their limitations and map relevant images.
    A page with no native text is never represented by invented placeholder text.
    """
    import pdfplumber
    import pypdfium2 as pdfium
    spans, tables, images, warnings = [], [], [], []

    def span(text, location, sid):
        spans.append(dict(id=sid, text=text, location=location, sha256=hashlib.sha256(text.encode()).hexdigest()))
        return sid

    with pdfplumber.open(path) as pdf, pdfium.PdfDocument(path) as rendered:
        for page_number, page in enumerate(pdf.pages, 1):
            start = len(spans)
            if not (page.extract_text() or '').strip() and page.images:
                # Do not silently classify unread scanned facts as undisclosed.
                # This path consumes native text; the OCR workflow must resolve
                # the page before it can enter an immutable shared plan.
                raise ValueError('WORKPAPER_PDF_OCR_REQUIRED')
            native = page.find_tables()
            boxes = [t.bbox for t in native]
            def outside(obj):
                x, y = (obj.get('x0', 0)+obj.get('x1', 0))/2, (obj.get('top', 0)+obj.get('bottom', 0))/2
                return not any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes)
            # Order paragraphs and complete tables by their original vertical positions.
            blocks = [(line['top'], 'line', line) for line in page.filter(outside).extract_text_lines()]
            blocks += [(t.bbox[1], 'table', t) for t in native]
            for _, kind, block in sorted(blocks, key=lambda x: x[0]):
                if kind == 'line':
                    span(block['text'], f'PDF 第 {page_number} 页', f'pdf-{len(spans)}')
                    continue
                tid, rows, ids = f'table-{len(tables)+1}', [], []
                xs = sorted({c[0] for c in block.cells} | {c[2] for c in block.cells})
                ys = sorted({c[1] for c in block.cells} | {c[3] for c in block.cells})
                for ri, y in enumerate(ys[:-1]):
                    cells, ci = [], 0
                    while ci < len(xs)-1:
                        x = xs[ci]
                        cell = next((c for c in block.cells if abs(c[0]-x)<0.1 and c[1] <= y+0.1 and c[3] > y+0.1), None)
                        if cell is None:
                            raise ValueError('WORKPAPER_PDF_TABLE_GEOMETRY_UNRESOLVED')
                        colspan = min(range(len(xs)), key=lambda j: abs(xs[j]-cell[2]))-ci
                        continuing = cell[1] < y-0.1
                        merged = cell[3] > ys[ri+1]+0.1
                        text = '' if continuing else (page.crop(cell).extract_text() or '')
                        sid = span(text, f'PDF 第 {page_number} 页 / {tid} / 行 {ri+1} / 列 {ci+1}', f'pdf-{len(spans)}')
                        ids.append(sid)
                        cells.append(dict(content=[dict(span_id=sid)], colspan=max(1, colspan), vmerge='continue' if continuing else 'restart' if merged else None))
                        ci += max(1, colspan)
                    rows.append(dict(cells=cells, header=ri == 0, before=0, after=0))
                tables.append(dict(id=tid, rows=rows, widths=[xs[i+1]-xs[i] for i in range(len(xs)-1)], span_ids=ids, nested=False))
            bitmap = rendered[page_number-1].render(scale=1.5)
            try:
                picture = bitmap.to_pil().convert('RGB'); buffer = io.BytesIO(); picture.save(buffer, format='JPEG', quality=85)
                asset(images, f'page-{page_number}.jpg', buffer.getvalue(), page=page_number, span_ids=[s['id'] for s in spans[start:]])
                for j, graphic in enumerate(page.images):
                    # Preserve graphs/organization diagrams as actual visual
                    # data, without embedding a whole source page as a citation.
                    box = (max(0, graphic['x0']*1.5), max(0, graphic['top']*1.5), min(picture.width, graphic['x1']*1.5), min(picture.height, graphic['bottom']*1.5))
                    if box[2] > box[0] and box[3] > box[1]:
                        crop = picture.crop(tuple(int(x) for x in box)); data = io.BytesIO(); crop.save(data, format='PNG')
                        asset(images, f'graphic-{page_number}-{j+1}.png', data.getvalue(), parent_page=page_number)
            finally:
                bitmap.close()
            if len(spans) == start:
                warnings.append(f'PDF 第 {page_number} 页没有原生文字，必须核对整页图像，不得认定未披露。')
            page.close()
    source = dict(version='project-file-text-v1', sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest(), format='pdf', spans=spans,
                  warnings=warnings, coverage='partial' if warnings else 'complete')
    return table_context(dict(version=VERSION, source=source, tables=tables, images=images, dependencies={}))


def extract(path):
    return extract_pdf(path) if Path(path).suffix.lower() == '.pdf' else extract_docx(path)
