"""Read-only prelaunch rendering through the Codex renderer and local WSL LibreOffice.

Run with the bundled Windows Python. No application server or document is changed.
The original is hashed before/after; LibreOffice receives a private copy and no network.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from xml.sax.saxutils import escape
from zipfile import ZipFile

sys.dont_write_bytecode = True
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
REPO = Path(__file__).resolve().parents[2]
WORKSPACE = REPO.parent


def sha(path: Path) -> str:
    with path.open('rb') as stream:
        value = hashlib.file_digest(stream, 'sha256')
    return value.hexdigest()


def wsl_path(path: Path | str) -> str:
    value = Path(path).resolve()
    if not value.drive or len(value.drive) != 2 or value.drive[1] != ':':
        raise ValueError('Only local drive paths can be passed to the WSL renderer')
    return '/mnt/' + value.drive[0].lower() + value.as_posix()[2:]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--renderer', type=Path, required=True, help='Exact skill render_docx.py path')
    parser.add_argument('--output-dir', type=Path, required=True, help='New directory under the private evidence roots')
    parser.add_argument('--distro', default='BondBuddyM3')
    parser.add_argument('--dpi', type=int, default=150)
    args = parser.parse_args()
    bundled = Path(sys.executable).resolve().parent
    if sys.platform != 'win32' or bundled.name != 'python' or bundled.parent.name != 'dependencies':
        raise RuntimeError('Use the Codex workspace dependency loader bundled Windows Python')
    if not 96 <= args.dpi <= 240 or not args.distro or any(c in args.distro for c in '\r\n'):
        raise ValueError('Invalid renderer configuration')
    source, renderer, out = args.input.resolve(), args.renderer.resolve(), args.output_dir.resolve()
    private_local = REPO / '.local' / 'local-prelaunch'
    private_customer = WORKSPACE / 'quality-prelaunch-20261107'
    if not source.is_relative_to(WORKSPACE) or source.suffix.lower() != '.docx' or not source.is_file():
        raise ValueError('Select an existing .docx inside the authorized workspace')
    if not (out.is_relative_to(private_local) or out.is_relative_to(private_customer)):
        raise ValueError('Output must remain in the private prelaunch evidence roots')
    if not source.is_relative_to(private_local) and not out.is_relative_to(private_customer):
        raise ValueError('Customer/source-file render evidence must stay outside the Git checkout')
    if out.exists() or out == source.parent or source.is_symlink():
        raise ValueError('Use a new evidence directory and a regular original document')
    if renderer.name != 'render_docx.py' or not renderer.is_file():
        raise ValueError('The selected documents skill render_docx.py is required')
    poppler = bundled.parent / 'native' / 'poppler' / 'Library' / 'bin'
    if not (poppler / 'pdftoppm.exe').is_file() or not (poppler / 'pdfinfo.exe').is_file():
        raise RuntimeError('Bundled Poppler is missing')
    # Do not silently normalize a broken package during a quality acceptance run.
    with ZipFile(source) as archive:
        if any('\\' in name for name in archive.namelist()):
            raise ValueError('OOXML member paths require repair; retain this as a failed input')
    out.mkdir(parents=True, exist_ok=False)
    original_hash = sha(source)
    receipt = {'schema': 'local-prelaunch-render-v1', 'status': 'running', 'input': str(source),
               'input_sha256_before': original_hash, 'renderer': str(renderer), 'renderer_sha256': sha(renderer),
               'bridge': str(Path(__file__).resolve()), 'bridge_sha256': sha(Path(__file__)),
               'python': sys.executable, 'python_version': sys.version, 'distro': args.distro,
               'dpi': args.dpi, 'network': 'unshare --net', 'ooxml_repairs': False,
               'word_wps_compatibility': 'not_tested', 'visual_inspection': 'pending',
               'started_at': datetime.now(timezone.utc).isoformat(), 'commands': []}
    receipt_path = out / 'render-receipt.json'
    def save():
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    save()
    os.environ['PATH'] = str(poppler) + os.pathsep + os.environ.get('PATH', '')
    try:
        version = subprocess.run(['wsl.exe', '-d', args.distro, '--exec', '/usr/bin/soffice', '--version'],
                                 capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30, check=True)
        receipt['libreoffice_version'] = version.stdout.strip()
        spec = importlib.util.spec_from_file_location('codex_render_docx', renderer)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module._resolve_soffice = lambda: 'local-wsl-libreoffice'

        def bridge(command, env, verbose):
            if command[0] != 'local-wsl-libreoffice':
                raise RuntimeError('Unexpected renderer command')
            profile = Path(env['HOME']).resolve()
            fonts = profile / 'fonts.conf'
            cache = profile / 'fontcache'
            cache.mkdir(exist_ok=True)
            # Only installed Windows fonts; no font copying or system installation.
            fonts.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">'
                             '<fontconfig><dir>/mnt/c/Windows/Fonts</dir><cachedir>' +
                             escape(wsl_path(cache)) + '</cachedir></fontconfig>', encoding='utf-8')
            translated = []
            for value in command[1:]:
                if value.startswith('-env:UserInstallation='):
                    translated.append('-env:UserInstallation=file://' + wsl_path(profile))
                elif Path(value).is_absolute():
                    translated.append(wsl_path(value))
                else:
                    translated.append(value)
            # --exec preserves argv. WSL's plain -- command path can invoke a
            # shell and interpret the font format's pipe or a document filename.
            prefix = ['wsl.exe', '-d', args.distro, '--exec', '/usr/bin/unshare', '--net', '--',
                      '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8',
                      'HOME=' + wsl_path(profile), 'XDG_CONFIG_HOME=' + wsl_path(profile / 'config'),
                      'XDG_CACHE_HOME=' + wsl_path(profile / 'cache'), 'FONTCONFIG_FILE=' + wsl_path(fonts)]
            if 'font_matches' not in receipt:
                receipt['font_matches'] = {}
                for family in ['SimSun', 'Microsoft YaHei', 'Times New Roman', 'Arial']:
                    matched = subprocess.run(prefix + ['/usr/bin/fc-match', '-f', '%{family}|%{file}', family],
                                             capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30, check=True)
                    receipt['font_matches'][family] = matched.stdout.strip()
            actual = prefix + ['/usr/bin/soffice'] + translated
            result = subprocess.run(actual, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)
            receipt['commands'].append({'command': actual, 'exit_code': result.returncode,
                                        'stdout': result.stdout, 'stderr': result.stderr})
            save()
            return result

        module._run_cmd = bridge
        # A separate copy protects the downloaded original even if the converter
        # writes a lock file or changes metadata. The copy is removed by tempfile.
        with tempfile.TemporaryDirectory(prefix='bb-render-input-') as staged:
            copied = Path(staged) / source.name
            shutil.copyfile(source, copied)
            if sha(copied) != original_hash:
                raise RuntimeError('Input copy hash mismatch')
            pages = module.rasterize(str(copied), str(out), args.dpi, verbose=False, emit_pdf=True)
        if not pages:
            raise RuntimeError('Renderer produced no page images; use a shorter output path on Windows and inspect converter evidence')
        receipt['pages'] = [{'path': str(Path(page)), 'sha256': sha(Path(page))} for page in pages]
        receipt['page_count'] = len(pages)
        pdf = out / (source.stem + '.pdf')
        receipt['pdf'] = {'path': str(pdf), 'sha256': sha(pdf)}
        receipt['status'] = 'rendered'
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['error'] = str(error)
        raise
    finally:
        receipt['input_sha256_after'] = sha(source)
        receipt['input_unchanged'] = receipt['input_sha256_after'] == original_hash
        receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
        if not receipt['input_unchanged']:
            receipt['status'] = 'failed'
            receipt['error'] = 'Original input changed during rendering'
        save()
    if not receipt['input_unchanged']:
        raise RuntimeError('Original input changed during rendering')
    print(json.dumps({'status': receipt['status'], 'page_count': receipt['page_count'],
                      'input_unchanged': True, 'receipt': str(receipt_path)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
