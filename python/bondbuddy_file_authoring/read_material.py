"""On-demand original-file reader, also available as a tool inside a Codex task.

No invocation of this module is made during upload. Locations are zero-based
for DOCX body/grid indices, one-based for PDF pages and text lines.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile


class MaterialReader:
    def __init__(self):
        self.cache = {}

    def close(self):
        for value in self.cache.values():
            close = getattr(value, 'close', None)
            if close:
                close()
        self.cache.clear()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def document(self, path):
        path = Path(path)
        key = str(path.resolve())
        if key not in self.cache:
            ext = path.suffix.lower()
            if ext in {'.docx', '.xlsx'}:
                with ZipFile(path) as package:
                    if sum(info.file_size for info in package.infolist()) > 250_000_000:
                        raise ValueError('该 Office 文件展开后超出本次读取资源限制。')
            if ext == '.docx':
                from docx import Document
                value = Document(path)
            elif ext == '.xlsx':
                from openpyxl import load_workbook
                value = load_workbook(path, read_only=True, data_only=True)
            elif ext == '.pdf':
                import pdfplumber
                value = pdfplumber.open(path)
            else:
                raw = path.read_bytes()
                try:
                    value = raw.decode('utf-8-sig')
                except UnicodeDecodeError:
                    value = raw.decode('gb18030')
            self.cache[key] = value
        return self.cache[key]

    def read(self, path, location):
        path = Path(path)
        if not isinstance(location, str) or len(location) > 1000:
            raise ValueError('原文件位置无效。')
        d = self.document(path)
        ext = path.suffix.lower()
        extra = {}
        if ext == '.docx':
            from docx.oxml.ns import qn
            from docx.text.paragraph import Paragraph
            from docx.table import Table
            m = re.fullmatch(r'docx/(p|t)/(\d+)(?:/(\d+)/(\d+))?', location)
            if not m:
                raise ValueError('Word 位置应为 docx/p/正文索引 或 docx/t/正文索引/行/列。')
            index = int(m[2])
            if index >= len(d.element.body):
                raise ValueError('Word 位置不存在。')
            node = d.element.body[index]
            extra['body_index'] = index
            if m[1] == 'p' and m[3] is None and node.tag == qn('w:p'):
                text = Paragraph(node, d).text
                label = f'正文位置 {index + 1}'
                location = f'docx/p/{index}'
            elif m[1] == 't' and m[3] is not None and node.tag == qn('w:tbl'):
                table = Table(node, d)
                row, col = int(m[3]), int(m[4])
                grid, columns = table._cells, table._column_count
                if col >= columns or row * columns + col >= len(grid):
                    raise ValueError('Word 表格位置不存在。')
                cell = grid[row * columns + col]
                # All aliases of a merged cell have a single canonical location.
                first = next(i for i, candidate in enumerate(grid) if candidate._tc is cell._tc)
                row, col = divmod(first, columns)
                text = cell.text
                location = f'docx/t/{index}/{row}/{col}'
                label = f'正文位置 {index + 1} 的表格 · 第 {row + 1} 行 · 第 {col + 1} 列'
                extra.update(row=row, col=col, native_cell=True)
                extra['source_context'] = '表头：' + ' | '.join(c.text for c in grid[:columns]) + '；本行：' + ' | '.join(c.text for c in grid[row*columns:(row+1)*columns])
            else:
                raise ValueError('Word 位置类型与原文件不符。')
        elif ext == '.xlsx':
            from openpyxl.utils.cell import range_boundaries
            m = re.fullmatch(r'xlsx/([^/]+)/([A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?)', location)
            if not m:
                raise ValueError('Excel 位置应为 xlsx/URL编码工作表名/A1:D5。')
            sheet, address = unquote(m[1]), m[2]
            if sheet not in d.sheetnames:
                raise ValueError('工作表不存在。')
            c1, r1, c2, r2 = range_boundaries(address)
            if r2 < r1 or c2 < c1 or (r2-r1+1)*(c2-c1+1) > 400 or r2 > 1048576 or c2 > 16384:
                raise ValueError('单条引用范围应在 400 个单元格以内；可添加多条引用。')
            rows = d[sheet].iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2)
            text = '\n'.join('\t'.join('' if cell.value is None else str(cell.value) for cell in row) for row in rows)
            label = f'{sheet} · {address}'
        elif ext == '.pdf':
            m = re.fullmatch(r'pdf/([1-9]\d*)', location)
            if not m or int(m[1]) > len(d.pages):
                raise ValueError('PDF 页码不存在。')
            page = int(m[1])
            text = d.pages[page - 1].extract_text(x_tolerance=2, y_tolerance=3) or ''
            extra.update(page=page, page_count=len(d.pages))
            label = f'PDF 第 {page} 页'
            if not text.strip():
                raise ValueError('本页为扫描图像；请对照原页人工确认引文。')
        elif ext in {'.txt', '.md', '.csv'}:
            m = re.fullmatch(r'text/([1-9]\d*)-([1-9]\d*)', location)
            if not m:
                raise ValueError('文本位置应为 text/起始行-结束行。')
            start, end = int(m[1]), int(m[2])
            lines = d.splitlines()
            if end < start or end > len(lines) or end-start >= 400:
                raise ValueError('文本引用行号无效。')
            text = '\n'.join(lines[start-1:end])
            label = f'第 {start}—{end} 行'
            extra.update(start_line=start, end_line=end)
        else:
            raise ValueError('该原文件格式暂不支持定位核验。')
        if len(text) > 100_000:
            raise ValueError('单处审阅文字过长，请缩小引用位置。')
        return {'text': text, 'locator': label, 'native_location': location, **extra}

    def outline(self, path):
        path = Path(path)
        d = self.document(path)
        if path.suffix.lower() == '.docx':
            from docx.oxml.ns import qn
            from docx.text.paragraph import Paragraph
            from docx.table import Table
            for index, node in enumerate(d.element.body):
                if node.tag == qn('w:p'):
                    yield {'location': f'docx/p/{index}', 'text': Paragraph(node, d).text}
                elif node.tag == qn('w:tbl'):
                    table = Table(node, d)
                    yield {'location': f'docx/t/{index}/ROW/COL', 'rows': len(table.rows),
                           'columns': table._column_count, 'first_row': [c.text for c in table.rows[0].cells] if table.rows else []}
        elif path.suffix.lower() == '.xlsx':
            from urllib.parse import quote
            for sheet in d:
                yield {'sheet': sheet.title, 'rows': sheet.max_row, 'columns': sheet.max_column,
                       'location_example': f'xlsx/{quote(sheet.title, safe="")}/A1:D8'}
        elif path.suffix.lower() == '.pdf':
            yield {'pages': len(d.pages), 'location_example': 'pdf/1'}
        else:
            yield {'lines': len(d.splitlines()), 'location_example': 'text/1-1'}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file')
    parser.add_argument('location', help='--outline or a location', nargs='?', default='--outline')
    parser.add_argument('--outline', action='store_true')
    args = parser.parse_args()
    with MaterialReader() as reader:
        if args.outline or args.location == '--outline':
            for item in reader.outline(args.file):
                print(json.dumps(item, ensure_ascii=False))
        else:
            print(json.dumps(reader.read(args.file, args.location), ensure_ascii=False))
