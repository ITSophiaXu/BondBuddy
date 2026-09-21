"""Import the user-selected library; never edits original material."""
import hashlib
import json
import sys
import zipfile
from pathlib import Path
from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1])
OUT = ROOT / 'knowledge' / 'sources'
OUT.mkdir(parents=True, exist_ok=True)
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
entries = []
for index, path in enumerate(sorted(SOURCE.rglob('*')), 1):
    if not path.is_file() or path.suffix.lower() not in ('.docx', '.md', '.xlsx'):
        continue
    source_id = 'S' + str(len(entries) + 1).zfill(3)
    entry = {'id': source_id, 'path': str(path.relative_to(SOURCE)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    lines = []
    try:
        if path.suffix == '.md':
            lines = path.read_text(encoding='utf-8-sig').splitlines()
        elif path.suffix == '.docx':
            if not zipfile.is_zipfile(path):
                from legacy_word import extract
                text = extract(path)
                lines = [line.strip() for line in text.replace('\x07', '\n').replace('\x0b', '\n').replace('\x0c', '\n').split('\r') if line.strip()]
                entry['format'] = 'legacy-doc-main-story'
                entry['warning'] = '旧版Word按正文故事流提取，未重建排版、批注及修订状态。'
                entry['status'] = 'extracted'
                entry['lines'] = len(lines)
                entry['file'] = source_id + '.md'
                (OUT / entry['file']).write_text('# ' + entry['path'] + '\n\n' + '\n'.join(f'[{source_id}:{i}] {line}' for i, line in enumerate(lines, 1)), encoding='utf-8')
                entries.append(entry)
                continue
            with zipfile.ZipFile(path) as z:
                root = etree.fromstring(z.read('word/document.xml'))
                for p in root.xpath('//w:body//w:p', namespaces=NS):
                    # Include current insertions; exclude deleted and struck-through template text.
                    value = ''.join(p.xpath('.//w:t[not(ancestor::w:del) and not(ancestor::w:r[w:rPr/w:strike[not(@w:val="0")]])]/text()', namespaces=NS))
                    if value.strip():
                        lines.append(value)
                if 'word/comments.xml' in z.namelist():
                    comments = etree.fromstring(z.read('word/comments.xml'))
                    lines.append('【原文批注，仅为意见，不自动视为已确认规则】')
                    for c in comments.xpath('//w:comment', namespaces=NS):
                        lines.append(''.join(c.xpath('.//w:t/text()', namespaces=NS)))
        else:
            from openpyxl import load_workbook
            wb = load_workbook(path, data_only=True, read_only=True)
            for sheet in wb:
                lines.append('工作表 ' + sheet.title)
                for row in sheet.iter_rows(values_only=True):
                    vals = [str(v) for v in row if v is not None]
                    if vals: lines.append(' | '.join(vals))
            wb.close()
        entry['status'] = 'extracted'
        entry['lines'] = len(lines)
        entry['file'] = source_id + '.md'
        (OUT / entry['file']).write_text('# ' + entry['path'] + '\n\n' + '\n'.join(f'[{source_id}:{i}] {line}' for i, line in enumerate(lines, 1)), encoding='utf-8')
    except Exception as exc:
        entry['status'] = 'unreadable'
        entry['reason'] = type(exc).__name__ + ': ' + str(exc)
    entries.append(entry)
(ROOT / 'knowledge' / 'sources.json').write_text(json.dumps({'importedOn': '2026-09-18', 'sources': entries}, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Imported {len(entries)} sources, {sum(e["status"] == "extracted" for e in entries)} readable.')
