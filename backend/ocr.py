"""Offline Windows or Tesseract OCR; OCR evidence always requires review."""
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory


OCR_SLOT = threading.Semaphore(1)


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


def tesseract_lines(tsv):
    groups = {}
    try:
        rows = csv.DictReader(io.StringIO(tsv), delimiter='\t')
        required = {'block_num', 'par_num', 'line_num', 'left', 'top', 'width', 'height', 'text'}
        if not rows.fieldnames or not required.issubset(rows.fieldnames):
            raise ValueError
        for row in rows:
            text = str(row.get('text', '')).strip()
            if not text:
                continue
            key = (row['block_num'], row['par_num'], row['line_num'])
            groups.setdefault(key, {'words': []})['words'].append({
                'text': text,
                'x': int(row['left']),
                'y': int(row['top']),
                'width': int(row['width']),
                'height': int(row['height']),
            })
    except (TypeError, ValueError, KeyError) as exc:
        raise ValueError('扫描页识别结果格式无效。') from exc
    return list(groups.values())


def _render_pdf_page_file(source, number, image_path, metadata_path):
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(str(source)) as pdf:
        page = pdf[number - 1]
        try:
            scale = min(3.5, 2450 / max(page.get_width(), page.get_height()))
            bitmap = page.render(scale=scale)
            try:
                image = bitmap.to_pil()
                try:
                    image.save(image_path)
                    metadata_path.write_text(
                        json.dumps({'page': number, 'width': image.width, 'height': image.height}),
                        encoding='utf-8',
                    )
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()


def render_pdf_page(source, number, root, timeout):
    image_path = root / f'page-{number}.png'
    metadata_path = root / f'page-{number}.json'
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    run = subprocess.run(
        [
            sys.executable,
            '-m',
            'backend.ocr',
            'render-page',
            str(source),
            str(number),
            str(image_path),
            str(metadata_path),
        ],
        capture_output=True,
        timeout=timeout,
        creationflags=flags,
    )
    if run.returncode or not image_path.is_file() or not metadata_path.is_file():
        raise RuntimeError('扫描页图像生成失败。')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    return {**metadata, 'path': image_path}


def recognize_windows_pages(raw, pages, deadline=None, page_timeout=None):
    ps = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if not ps.is_file():
        return {}, '本机没有可用的 Windows OCR 运行环境。'
    deadline = deadline or time.monotonic() + 210
    page_timeout = page_timeout or 45
    failed, result = [], {}
    try:
        with TemporaryDirectory(prefix='bond-ocr-') as tmp:
            root = Path(tmp)
            source = root / 'source.pdf'
            source.write_bytes(raw)
            for index, number in enumerate(pages):
                if time.monotonic() >= deadline:
                    failed.extend(pages[index:])
                    break
                try:
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        failed.extend(pages[index:])
                        break
                    item = render_pdf_page(source, number, root, min(page_timeout, remaining_time))
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        failed.extend(pages[index:])
                        break
                    manifest_path = root / 'manifest.json'
                    manifest_path.write_text(json.dumps([
                        {'page': item['page'], 'path': str(item['path'])}
                    ]), encoding='utf-8')
                    remaining = max(1, min(page_timeout, int(remaining_time)))
                    args = [
                        str(ps), '-NoProfile', '-NonInteractive', '-File',
                        str(Path(__file__).with_name('windows_ocr.ps1')),
                        '-ManifestPath', str(manifest_path),
                    ]
                    run = subprocess.run(
                        args,
                        capture_output=True,
                        text=True,
                        encoding='utf-8',
                        errors='replace',
                        timeout=remaining,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                    if run.returncode:
                        failed.append(number)
                        continue
                    data = json.loads(run.stdout.lstrip('\ufeff'))
                    page = data[0] if isinstance(data, list) else data
                    lines = spatial_lines(page['lines'])
                    text = '\n'.join(lines)
                    if not text.strip():
                        failed.append(number)
                        continue
                    result[number] = {
                        'text': text,
                        'ocr': True,
                        'ocr_engine': 'Windows OCR',
                        'ocr_language': page['language'],
                        'ocr_lines': page['lines'],
                        'image_width': page['width'],
                        'image_height': page['height'],
                    }
                except (OSError, ValueError, RuntimeError, KeyError, IndexError, subprocess.TimeoutExpired):
                    failed.append(number)
                finally:
                    (root / f'page-{number}.png').unlink(missing_ok=True)
                    (root / f'page-{number}.json').unlink(missing_ok=True)
    except (OSError, ValueError, RuntimeError):
        return {}, '扫描页识别暂不可用，请人工查看原页或提供文字版。'
    return result, ('部分扫描页识别未完成，请按未读取页核对原页。' if failed else None)


def recognize_tesseract_pages(raw, pages, deadline=None, page_timeout=None):
    binary = shutil.which('tesseract')
    if not binary:
        return {}, '服务器未安装扫描页识别组件，请提供文字版或已识别的 PDF。'
    language = os.environ.get('BOND_OCR_LANG', 'chi_sim+eng').strip()
    if not re.fullmatch(r'[A-Za-z0-9_+-]{1,80}', language):
        return {}, '扫描页识别语言配置无效，请联系管理员。'
    deadline = deadline or time.monotonic() + 210
    page_timeout = page_timeout or 45
    failed = []
    result = {}
    try:
        with TemporaryDirectory(prefix='bond-ocr-') as tmp:
            root = Path(tmp)
            source = root / 'source.pdf'
            source.write_bytes(raw)
            for index, number in enumerate(pages):
                if time.monotonic() >= deadline:
                    failed.extend(pages[index:])
                    break
                try:
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        failed.extend(pages[index:])
                        break
                    item = render_pdf_page(source, number, root, min(page_timeout, remaining_time))
                    remaining_time = deadline - time.monotonic()
                    if remaining_time <= 0:
                        failed.extend(pages[index:])
                        break
                    remaining = max(1, min(page_timeout, int(remaining_time)))
                    run = subprocess.run(
                        [binary, str(item['path']), 'stdout', '-l', language, '--psm', '6', 'tsv'],
                        capture_output=True,
                        text=True,
                        encoding='utf-8',
                        errors='replace',
                        timeout=remaining,
                    )
                    if run.returncode:
                        failed.append(number)
                        continue
                    lines = tesseract_lines(run.stdout)
                    text = '\n'.join(spatial_lines(lines))
                    if not text.strip():
                        failed.append(number)
                        continue
                    result[number] = {
                        'text': text,
                        'ocr': True,
                        'ocr_engine': 'Tesseract OCR',
                        'ocr_language': language,
                        'ocr_lines': lines,
                        'image_width': item['width'],
                        'image_height': item['height'],
                    }
                except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
                    failed.append(number)
                finally:
                    (root / f'page-{number}.png').unlink(missing_ok=True)
                    (root / f'page-{number}.json').unlink(missing_ok=True)
    except (OSError, ValueError, RuntimeError):
        return {}, '扫描页识别暂不可用，请人工查看原页或提供文字版。'
    return result, ('部分扫描页识别未完成，请按未读取页核对原页。' if failed else None)


def recognize_pdf_pages(raw, pages):
    if not pages:
        return {}, None
    mode = os.environ.get('BOND_OCR', 'auto').strip().lower()
    if mode in {'off', '0', 'false'}:
        return {}, '扫描页识别未启用，请提供文字版或已识别的 PDF。'
    try:
        page_timeout = max(5, min(int(os.environ.get('BOND_OCR_PAGE_TIMEOUT', '45')), 180))
        total_timeout = max(10, min(int(os.environ.get('BOND_OCR_TOTAL_TIMEOUT', '210')), 210))
        page_limit = max(1, min(int(os.environ.get('BOND_OCR_MAX_PAGES', '100')), 700))
    except ValueError:
        return {}, '扫描页识别配置无效，请联系管理员。'
    selected = list(pages[:page_limit])
    skipped = list(pages[page_limit:])
    deadline = time.monotonic() + total_timeout
    if not OCR_SLOT.acquire(timeout=total_timeout):
        return {}, '扫描页识别排队超时，请稍后重试或提供文字版 PDF。'
    try:
        if os.name == 'nt' and mode in {'auto', 'windows', 'on', '1', 'true'}:
            result, warning = recognize_windows_pages(raw, selected, deadline, page_timeout)
        elif os.name != 'nt' and mode in {'auto', 'tesseract', 'on', '1', 'true'}:
            result, warning = recognize_tesseract_pages(raw, selected, deadline, page_timeout)
        else:
            return {}, '当前扫描页识别模式不可用，请提供文字版或已识别的 PDF。'
    finally:
        OCR_SLOT.release()
    if skipped:
        limit_warning = f'扫描页超过自动识别上限，另有 {len(skipped)} 页未处理。'
        warning = (warning + ' ' if warning else '') + limit_warning
    return result, warning


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 5 or args[0] != 'render-page':
        raise SystemExit('usage: python -m backend.ocr render-page PDF PAGE IMAGE METADATA')
    _render_pdf_page_file(Path(args[1]), int(args[2]), Path(args[3]), Path(args[4]))


if __name__ == '__main__':
    main()
