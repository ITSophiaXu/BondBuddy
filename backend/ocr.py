"""Offline Windows OCR of source PDF pages; OCR evidence always requires review."""
import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory


def spatial_lines(ocr_lines):
    """Keep punctuation with its visual row and preserve gaps between columns."""
    words = [w for line in ocr_lines for w in line['words']]
    rows = []
    for word in sorted(words, key=lambda w: (w['y'], w['x'])):
        top, bottom = word['y'], word['y'] + word['height']
        candidates = [r for r in rows[-4:]
                      if min(bottom, r['bottom']) - max(top, r['top']) > min(word['height'], r['height']) * .4]
        row = min(candidates, key=lambda r: abs(bottom - r['bottom'])) if candidates else None
        if row is None:
            row = {'top': top, 'bottom': bottom, 'height': word['height'], 'words': []}
            rows.append(row)
        if word['height'] > row['height']:
            row.update(top=top, bottom=bottom, height=word['height'])
        row['words'].append(word)
    lines = []
    for row in rows:
        text, previous = '', None
        for word in sorted(row['words'], key=lambda w: w['x']):
            if previous:
                gap = word['x'] - previous['x'] - previous['width']
                text += '   ' if gap > row['height'] else (' ' if gap > row['height'] * .35 else '')
            text += word['text']
            previous = word
        lines.append(text)
    return lines


def recognize_pdf_pages(raw, pages):
    if not pages:
        return {}, None
    if os.name != 'nt' or os.environ.get('BOND_OCR', '').lower() in {'off', '0', 'false'}:
        return {}, '本机未启用扫描页识别，请提供文字版或已识别的 PDF。'
    ps = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if not ps.is_file():
        return {}, '本机没有可用的 Windows OCR 运行环境。'
    try:
        import pypdfium2 as pdfium
        with TemporaryDirectory(prefix='bond-ocr-') as tmp:
            root = Path(tmp)
            manifest = []
            with pdfium.PdfDocument(raw) as pdf:
                for number in pages:
                    page = pdf[number - 1]
                    try:
                        scale = min(3.5, 2450 / max(page.get_width(), page.get_height()))
                        bitmap = page.render(scale=scale)
                        try:
                            path = root / f'page-{number}.png'
                            bitmap.to_pil().save(path)
                        finally:
                            bitmap.close()
                        manifest.append({'page': number, 'path': str(path)})
                    finally:
                        page.close()
            manifest_path = root / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            args = [str(ps), '-NoProfile', '-NonInteractive', '-File', str(Path(__file__).with_name('windows_ocr.ps1')),
                    '-ManifestPath', str(manifest_path)]
            run = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', errors='replace',
                                 timeout=max(40, min(len(pages) * 8, 240)), creationflags=subprocess.CREATE_NO_WINDOW)
            if run.returncode:
                return {}, '扫描页识别未完成，需人工查看原页或提供文字版。'
            data = json.loads(run.stdout.lstrip('\ufeff'))
            if isinstance(data, dict):
                data = [data]
            result = {}
            for page in data:
                lines = spatial_lines(page['lines'])
                result[int(page['page'])] = {'text': '\n'.join(lines), 'ocr': True, 'ocr_engine': 'Windows OCR',
                                              'ocr_language': page['language'], 'ocr_lines': page['lines'],
                                              'image_width': page['width'], 'image_height': page['height']}
            return result, None
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return {}, '扫描页识别暂不可用，请人工查看原页或提供文字版。'
