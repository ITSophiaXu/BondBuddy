"""Host-only acceptance of a model-authored tracked DOCX and rendered page check."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .check import REV, STORY, clean, package, parse_xml, stories
from bondbuddy_word_delivery.writer import Q


def render_pages(source: Path, area: Path, executable: str) -> int:
    area.mkdir()
    profile = (area / 'profile').as_uri()
    completed = subprocess.run([executable, '-env:UserInstallation=' + profile, '--headless',
                                '--norestore', '--convert-to', 'pdf', '--outdir', str(area), str(source)],
                               capture_output=True, timeout=300, check=False)
    target = area / (source.stem + '.pdf')
    if completed.returncode or not target.is_file() or target.stat().st_size == 0:
        raise RuntimeError('WORD_PAGE_COUNT_UNAVAILABLE')
    from pypdf import PdfReader
    count = len(PdfReader(str(target)).pages)
    if not count:
        raise RuntimeError('WORD_PAGE_COUNT_UNAVAILABLE')
    return count


def deliver(tracked_path: Path, baseline_path: Path, clean_path: Path, author: str, minimum: float):
    tracked, baseline = package(tracked_path), package(baseline_path)
    revisions = [node for name, raw in tracked.items() if STORY.fullmatch(name)
                 for node in parse_xml(raw).iter() if node.tag in REV and node.get(Q('author')) == author]
    if not revisions:
        raise ValueError('WORD_NO_REVISIONS')
    if stories(tracked, False, author) != stories(baseline, True):
        raise ValueError('WORD_REJECT_MISMATCH')
    clean(tracked_path, clean_path)
    accepted = package(clean_path)
    if stories(tracked, True) != stories(accepted) or stories(accepted) == stories(baseline, True):
        raise ValueError('WORD_ACCEPT_MISMATCH')
    executable = shutil.which('libreoffice') or shutil.which('soffice')
    if not executable:
        raise RuntimeError('WORD_PAGE_COUNT_UNAVAILABLE')
    version = subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix='bb-direct-pages-') as name:
        root = Path(name)
        with ThreadPoolExecutor(max_workers=2) as executor:
            original = executor.submit(render_pages, baseline_path, root / 'original', executable)
            result = executor.submit(render_pages, clean_path, root / 'result', executable)
            before, after = original.result(), result.result()
    ratio = after / before
    return {'version': 'direct-docx-page-v1', 'status': 'passed' if ratio >= minimum else 'mismatch',
            'baseline_pages': before, 'result_pages': after, 'ratio': round(ratio, 6),
            'minimum_ratio': minimum, 'libreoffice_version': version}


def main():
    parser = argparse.ArgumentParser()
    for arg in ('tracked', 'baseline', 'clean', 'author'):
        parser.add_argument('--' + arg, required=True)
    parser.add_argument('--minimum-ratio', type=float, required=True)
    args = parser.parse_args()
    if not 0 < args.minimum_ratio <= 1:
        raise ValueError('WORD_PAGE_THRESHOLD_INVALID')
    report = deliver(Path(args.tracked), Path(args.baseline), Path(args.clean), args.author, args.minimum_ratio)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
