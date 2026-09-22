import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from docx import Document
from docx.oxml.ns import qn
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from pypdf import PdfReader
from docx_locations import walk_blocks


def clean(value):
    return '' if value is None else str(value).strip()


def check_archive(path):
    with zipfile.ZipFile(path) as archive:
        if sum(info.file_size for info in archive.infolist()) > 300 * 1024 * 1024:
            raise ValueError('解压后超过 300MB，未解析。请拆分文件。')


def paragraph_formatting(paragraph, document):
    """Expose stored/effective font evidence without guessing Word's theme rendering."""
    def style_chain(style):
        seen = set()
        while style is not None and style.style_id not in seen:
            seen.add(style.style_id)
            yield style.element.find(qn('w:rPr'))
            style = style.base_style

    defaults = document.styles.element.find(qn('w:docDefaults'))
    default_rpr = defaults.find('.//' + qn('w:rPr')) if defaults is not None else None
    runs = {}
    for run in paragraph.runs:
        if not run.text.strip():
            continue
        layers = [run._r.find(qn('w:rPr')), *style_chain(run.style), *style_chain(paragraph.style), default_rpr]
        values = {}
        for prop, tag, attr in [('latinFont', 'w:rFonts', 'w:ascii'), ('eastAsiaFont', 'w:rFonts', 'w:eastAsia'), ('latinTheme', 'w:rFonts', 'w:asciiTheme'), ('eastAsiaTheme', 'w:rFonts', 'w:eastAsiaTheme'), ('halfPoints', 'w:sz', 'w:val')]:
            for layer in layers:
                node = layer.find(qn(tag)) if layer is not None else None
                value = node.get(qn(attr)) if node is not None else None
                if value is not None:
                    values[prop] = value
                    break
        key = json.dumps(values, sort_keys=True)
        if key not in runs:
            runs[key] = {**values, 'sample': run.text[:100], 'characters': 0}
        runs[key]['characters'] += len(run.text)
    ppr = paragraph._p.find(qn('w:pPr'))
    layout = {}
    for tag in ['w:jc', 'w:spacing', 'w:ind', 'w:keepNext', 'w:pageBreakBefore']:
        node = ppr.find(qn(tag)) if ppr is not None else None
        if node is not None:
            layout[tag.split(':')[1]] = {key.split('}')[-1]: value for key, value in node.attrib.items()}
    return {'style': paragraph.style.name if paragraph.style else '', 'runs': list(runs.values()), 'paragraphOverrides': layout}


def docx_records(path, final_revisions=False):
    check_archive(path)
    document = Document(path)
    records = []
    warnings = []
    if final_revisions:
        for node in list(document.element.iter(qn('w:del'))):
            node.getparent().remove(node)
        for node in list(document.element.iter(qn('w:ins'))):
            parent = node.getparent()
            for child in list(node):
                node.addprevious(child)
            parent.remove(node)
    heading = ''
    table_context = {}
    for locator, paragraph in walk_blocks(document):
        value = paragraph.text
        if not value.strip():
            continue
        if paragraph.style and ('Heading' in paragraph.style.name or '标题' in paragraph.style.name):
            heading = value
        context = heading
        match = re.match(r'(T\d+)(R\d+)', locator)
        if match:
            table = match[1]
            first_rows = table_context.setdefault(table, [])
            if int(match[2][1:]) <= 2:
                first_rows.append(value)
            context += ' | 表头/前两行：' + ' | '.join(first_rows)[:1200]
        records.append({'locator': locator, 'text': value, 'context': context, 'formatting': paragraph_formatting(paragraph, document)})
    for tag, label in [('w:sdt', '内容控件'), ('w:txbxContent', '文本框'), ('w:ins', '未接受的插入修订'), ('w:del', '未接受的删除修订'), ('w:drawing', '图形或图片')]:
        count = len(list(document.element.iter(qn(tag))))
        if count:
            warnings.append(f'含 {count} 处{label}，其文字或图示未保证完整提取，应人工核对。')
    if any(name.startswith(('word/header', 'word/footer', 'word/footnotes', 'word/endnotes')) and name.endswith('.xml') for name in zipfile.ZipFile(path).namelist()):
        warnings.append('页眉、页脚及脚注/尾注未纳入本版自动复核。')
    warnings.append('已读取段落及表格文字的字体、字号和样式信息；主题字体、分页及实际渲染效果仍需核对，不能据此声称已完成版面视觉检查。')
    return records, warnings


def workbook_records(path):
    check_archive(path)
    book = load_workbook(path, read_only=True, data_only=True)
    formulas = load_workbook(path, read_only=True, data_only=False)
    records = []
    warnings = []
    missing = 0
    try:
        for sheet in book.worksheets:
            if sheet.max_row * sheet.max_column > 2_000_000:
                raise ValueError(f'工作表 {sheet.title} 过大，请清理空白格式后重试。')
            header = []
            formula_sheet = formulas[sheet.title]
            for ri, (row, frow) in enumerate(zip(sheet.iter_rows(values_only=True), formula_sheet.iter_rows(values_only=True)), 1):
                values = []
                for ci, value in enumerate(row):
                    if value is None and isinstance(frow[ci], str) and frow[ci].startswith('='):
                        missing += 1
                        values.append(f'{get_column_letter(ci+1)}: [公式结果未缓存：{frow[ci]}]')
                    else:
                        values.append(f'{get_column_letter(ci+1)}: {clean(value)}')
                if any(v is not None for v in row) or any(isinstance(v, str) and v.startswith('=') for v in frow):
                    text = ' | '.join(values)
                    if len(header) < 3:
                        header.append(text)
                    records.append({'locator': f'{sheet.title}!R{ri}', 'text': text, 'context': f'工作表 {sheet.title}；前几行：' + ' / '.join(header)[:1600]})
            if sheet.sheet_state != 'visible':
                warnings.append(f'已读取隐藏工作表：{sheet.title}。')
    finally:
        book.close()
        formulas.close()
    if missing:
        warnings.append(f'{missing} 个公式单元格没有缓存值，未重算；请用 Excel 重算并保存后补传。不能将其视作零。')
    return records, warnings


def pdf_records(path):
    reader = PdfReader(path)
    if reader.is_encrypted:
        raise ValueError('PDF 已加密，请上传解密后的副本。')
    records = []
    blank = []
    for i, page in enumerate(reader.pages, 1):
        value = page.extract_text() or ''
        if value.strip():
            records.append({'locator': f'PDF-P{i:03d}', 'text': value, 'context': f'PDF 第 {i} 页'})
        else:
            blank.append(str(i))
    warnings = [f'共 {len(reader.pages)} 页，以下 {len(blank)} 页未提取到文字（可能为扫描页或空白页）：' + '、'.join(blank)] if blank else []
    if any(page.images for page in reader.pages):
        warnings.append('PDF 中的图片内容未执行 OCR，可能含未覆盖的扫描表格。')
    return records, warnings


def plain_records(path):
    raw = Path(path).read_bytes()
    value = None
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            value = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            pass
    if value is None:
        raise ValueError('无法识别文本编码，请另存为 UTF-8。')
    return [{'locator': f'L{i:05d}', 'text': line, 'context': ''} for i, line in enumerate(value.splitlines(), 1) if line.strip()], []


def extract_document(item, index):
    path = Path(item['path'])
    result = {'id': f'D{index:02d}', 'role': item['role'], 'filename': item['filename'], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    try:
        handlers = {'.docx': docx_records, '.xlsx': workbook_records, '.pdf': pdf_records, '.csv': plain_records, '.txt': plain_records}
        records, warnings = docx_records(path, final_revisions=True) if item['role'] == 'prospectus' and path.suffix.lower() == '.docx' else handlers[path.suffix.lower()](path)
        result.update(records=records, warnings=warnings, parseStatus='partial' if warnings else 'parsed')
        if not records:
            result.update(parseStatus='unreadable', warnings=warnings + ['未提取到可复核文本。'])
    except Exception as exc:
        result.update(records=[], warnings=[f'未能解析：{type(exc).__name__}。请检查文件格式、加密状态或是否损坏。'], parseStatus='unreadable')
    return result


def main():
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    documents = [extract_document(item, index) for index, item in enumerate(manifest['files'], 1)]
    Path(sys.argv[2]).write_text(json.dumps({'documents': documents}, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
