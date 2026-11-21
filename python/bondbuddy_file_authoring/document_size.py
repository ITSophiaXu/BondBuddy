"""Whole-manuscript collapse gate, independent of original prose similarity."""
from __future__ import annotations

import os
import json
import re
import shutil
import signal
import subprocess
import tempfile
import threading
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from .check import STORY, resolve_revisions, package
from .word_patch import paragraph_text, q, serialized, xml

MINIMUM_RATIO = .70
LONG_CHARACTERS = 20_000
LONG_PARAGRAPHS = 100
LONG_PAGES = 50
MINIMUM_PAGE_LOSS = 20
RENDER_TIMEOUT = 90
MAX_PDF_BYTES = 100 * 1024 * 1024


class PageCountError(Exception):
    def __init__(self, reason, diagnostic=None):
        super().__init__(reason)
        self.diagnostic = diagnostic or {}


class _RendererStderr:
    """Continuously drain stderr; retain only a bounded tail, never document text."""
    def __init__(self, stream):
        self.tail = b''
        self.total = 0
        self.thread = None
        if stream is not None:
            self.thread = threading.Thread(target=self._read, args=(stream,), daemon=True)
            self.thread.start()

    def _read(self, stream):
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                self.total += len(chunk)
                self.tail = (self.tail + chunk)[-4096:]
        except (OSError, ValueError):
            pass
        finally:
            stream.close()

    def diagnostic(self, code=None):
        if self.thread is not None:
            self.thread.join(timeout=1)
        text = self.tail.decode('utf-8', errors='replace').lower()
        category = 'unclassified' if self.total else 'empty'
        if '/proc' in text and any(word in text for word in ('denied', 'not found', 'no such', 'failed', 'not mounted')):
            category = 'proc_access_denied'
        elif any(word in text for word in ('permission denied', 'access denied', 'read-only file system')):
            category = 'filesystem_access_denied'
        elif 'error while loading shared libraries' in text:
            category = 'dependency_missing'
        return {'exit_code': code, 'stderr_category': category, 'stderr_bytes': self.total,
                'stderr_truncated': self.total > 4096}


def _terminate_renderer(process):
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL)
        else:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10,
                           creationflags=subprocess.CREATE_NO_WINDOW)
    except ProcessLookupError:
        pass


def footprint(parts):
    root = resolve_revisions(xml(parts['word/document.xml']), True)
    # Count each text node once; headers/footers cannot pad the body metric.
    characters = sum(len(re.sub(r'\s+', '', n.text or '')) for n in root.iter(q('t')))
    paragraphs = sum(bool(paragraph_text(p).strip()) for p in root.iter(q('p')))
    breaks = sum(n.get(q('type')) == 'page' for n in root.iter(q('br')))
    breaks += sum(n.get(q('val'), '1') not in {'0', 'false', 'off'} for n in root.iter(q('pageBreakBefore')))
    drawings = len(list(root.iter(q('drawing')))) + len(list(root.iter(q('pict'))))
    cached_pages = 0
    if 'docProps/app.xml' in parts:
        value = xml(parts['docProps/app.xml']).find('{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}Pages')
        if value is not None and re.fullmatch(r'\d{1,6}', value.text or ''):
            cached_pages = int(value.text)
    return {'characters': characters, 'nonempty_paragraphs': paragraphs, 'explicit_page_breaks': breaks,
            'drawings': drawings, 'cached_pages_hint_only': cached_pages}


def long_source(value):
    # Metadata can only activate more checking, never certify actual page counts.
    # Other triggers cover stale/missing page metadata and image-heavy sources.
    return (value['characters'] >= LONG_CHARACTERS or value['nonempty_paragraphs'] >= LONG_PARAGRAPHS
            or value['explicit_page_breaks'] >= LONG_PAGES - 1 or value['drawings'] >= LONG_PAGES
            or value['cached_pages_hint_only'] >= LONG_PAGES)


def render_pages(parts, root, label, executable):
    source = root / (label + '.docx')
    with ZipFile(source, 'w', ZIP_DEFLATED) as archive:
        for name, raw in parts.items():
            # Compare effective manuscripts, never inflate the baseline/target
            # by rendering deleted text or revision balloons.
            if STORY.fullmatch(name):
                raw = serialized(resolve_revisions(xml(raw), True))
            archive.writestr(name, raw)
    profile = root / (label + '-profile')
    user = profile / 'user'
    user.mkdir(parents=True)
    (user / 'registrymodifications.xcu').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
        '</item></oor:items>', encoding='utf-8')
    command = [executable, '-env:UserInstallation=' + profile.as_uri(), '--headless', '--norestore',
               '--nodefault', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', str(root), str(source)]
    flags = {'start_new_session': True} if os.name == 'posix' else {'creationflags': subprocess.CREATE_NO_WINDOW}
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **flags)
        stderr = _RendererStderr(process.stderr)
        old_handler = None
        # An aborted pre-model probe must not leave a detached native renderer behind.
        if os.name == 'posix' and threading.current_thread() is threading.main_thread():
            def cancel_renderer(signum, frame):
                _terminate_renderer(process)
                process.wait(timeout=10)
                raise PageCountError('render_cancelled')
            old_handler = signal.signal(signal.SIGTERM, cancel_renderer)
        try:
            code = process.wait(timeout=RENDER_TIMEOUT)
        except subprocess.TimeoutExpired:
            _terminate_renderer(process)
            process.wait(timeout=10)
            raise PageCountError('render_timeout', stderr.diagnostic())
        finally:
            if old_handler is not None:
                signal.signal(signal.SIGTERM, old_handler)
    except PageCountError:
        raise
    except (OSError, subprocess.SubprocessError):
        raise PageCountError('renderer_failed')
    pdf = root / (label + '.pdf')
    if code != 0:
        raise PageCountError('renderer_process_failed', stderr.diagnostic(code))
    if not pdf.exists():
        raise PageCountError('render_output_missing', stderr.diagnostic(code))
    if pdf.is_symlink() or not pdf.is_file() or not 0 < pdf.stat().st_size <= MAX_PDF_BYTES:
        raise PageCountError('render_output_invalid')
    try:
        from pypdf import PdfReader
        reader = PdfReader(pdf)
        count = len(reader.pages)
        if reader.is_encrypted or not 0 < count <= 2000:
            raise ValueError('unsupported page count')
        return {'pages': count}
    except Exception:
        raise PageCountError('render_pdf_unreadable')


def probe_renderer(source=None):
    result = {'version': 'word-renderer-capability-v1', 'status': 'unavailable'}
    if source is not None:
        try:
            if not long_source(footprint(package(Path(source)))):
                return {**result, 'status': 'not_required', 'reason': 'short_source'}
        except Exception:
            return {**result, 'reason': 'baseline_invalid'}
    executable = os.environ.get('BONDBUDDY_WORD_LIBREOFFICE') or shutil.which('libreoffice') or shutil.which('soffice')
    if not executable:
        return {**result, 'reason': 'renderer_missing'}
    # A minimal, fixed, single-page OPC package. No source body enters this probe.
    synthetic = {
        '[Content_Types].xml': b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>BondBuddy renderer capability probe</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'}
    try:
        with tempfile.TemporaryDirectory(prefix='bb-renderer-probe-') as name:
            pages = render_pages(synthetic, Path(name).resolve(), 'probe', executable)['pages']
        if pages != 1:
            raise PageCountError('probe_page_count_invalid')
        return {**result, 'status': 'ready', 'renderer': 'LibreOffice', 'pages': pages}
    except PageCountError as exc:
        return {**result, 'reason': str(exc), 'diagnostic': exc.diagnostic}


def compare_size(source, clean, *, already_rejected=False):
    before, after = footprint(source), footprint(clean)
    result = {'version': 'whole-document-size-v1', 'status': 'not_applicable', 'issues': [],
              'baseline': before, 'clean': after, 'minimum_ratio': MINIMUM_RATIO,
              'page_check': {'status': 'not_run'}, 'visual_acceptance': 'not_performed'}
    if not long_source(before):
        result['reason'] = 'short_source'
        return result
    result['character_ratio'] = round(after['characters'] / before['characters'], 6) if before['characters'] else 1.0
    body_reduced = before['characters'] and after['characters'] < before['characters'] * MINIMUM_RATIO
    body_finding = {'code': 'WORD_DOCUMENT_SIZE_REDUCED', 'metric': 'body_characters',
                    'before': before['characters'], 'after': after['characters'], 'minimum_ratio': MINIMUM_RATIO}
    if body_reduced and (before['characters'] >= LONG_CHARACTERS or before['nonempty_paragraphs'] >= LONG_PARAGRAPHS):
        result['issues'].append(body_finding)
    if already_rejected or result['issues']:
        # A known failure cannot become a pass, and does not need expensive
        # rendering merely to add another rejection. No page pass is claimed.
        result.update(status='failed' if result['issues'] else 'not_run', reason='document_already_rejected')
        return result
    executable = os.environ.get('BONDBUDDY_WORD_LIBREOFFICE') or shutil.which('libreoffice') or shutil.which('soffice')
    try:
        if not executable:
            raise PageCountError('renderer_missing')
        with tempfile.TemporaryDirectory(prefix='bb-document-size-') as name:
            root = Path(name).resolve()
            old = render_pages(source, root, 'baseline', executable)
            new = render_pages(clean, root, 'clean', executable)
        result['page_check'] = {'status': 'passed', 'renderer': 'LibreOffice', 'baseline': old, 'clean': new,
                                'ratio': round(new['pages'] / old['pages'], 6),
                                'minimum_source_pages': LONG_PAGES, 'minimum_page_loss': MINIMUM_PAGE_LOSS}
        # A stale cached "300 pages" hint on a short source must not itself
        # activate a text floor. For layout-heavy sources, confirm size here.
        if old['pages'] >= LONG_PAGES and body_reduced:
            result['issues'].append(body_finding)
        if old['pages'] >= LONG_PAGES and old['pages'] - new['pages'] >= MINIMUM_PAGE_LOSS and new['pages'] < old['pages'] * MINIMUM_RATIO:
            result['page_check']['status'] = 'failed'
            result['issues'].append({'code': 'WORD_DOCUMENT_SIZE_REDUCED', 'metric': 'rendered_pages',
                                     'before': old['pages'], 'after': new['pages'], 'minimum_ratio': MINIMUM_RATIO})
    except PageCountError as exc:
        result['page_check'] = {'status': 'unavailable', 'reason': str(exc)}
        if exc.diagnostic:
            result['page_check']['diagnostic'] = exc.diagnostic
        result['issues'].append({'code': 'WORD_PAGE_COUNT_UNAVAILABLE', 'reason': str(exc)})
    result['status'] = 'failed' if result['issues'] else 'passed'
    return result


def main():
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='Probe trusted host Word renderer capability')
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    report = probe_renderer(args.source)
    sys.stdout.write(json.dumps(report, separators=(',', ':')) + '\n')
    return 1 if report['status'] == 'unavailable' else 0


if __name__ == '__main__':
    raise SystemExit(main())
