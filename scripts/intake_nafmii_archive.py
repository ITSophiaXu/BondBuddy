"""Offline, byte-preserving intake of the user-authorized NAFMII archive.

Usage: python scripts/intake_nafmii_archive.py <zip>
No documents are executed. Word temporary lock files are excluded.
"""
from pathlib import Path, PurePosixPath
from zipfile import ZipFile, is_zipfile
from xml.etree import ElementTree as ET
import hashlib
import json
import sys
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'knowledge/nafmii'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def extract(path):
    records = []
    pending = []
    if is_zipfile(path) and 'word/document.xml' in ZipFile(path).namelist():
        with ZipFile(path) as z:
            tree = ET.fromstring(z.read('word/document.xml'))
            for i, p in enumerate(tree.findall('.//w:p', NS), 1):
                value = ''.join(t.text or '' for t in p.findall('.//w:t', NS)).strip()
                if value:
                    rec = {'locator': f'P{i:05d}', 'role': 'body', 'text': value}
                    n = p.find('w:pPr/w:numPr', NS)
                    if n is not None:
                        rec['numbering_xml'] = ET.tostring(n, encoding='unicode')
                    records.append(rec)
            for part, tag in [('footnotes', 'footnote'), ('endnotes', 'endnote'), ('comments', 'comment')]:
                if f'word/{part}.xml' not in z.namelist():
                    continue
                for note in ET.fromstring(z.read(f'word/{part}.xml')).findall(f'w:{tag}', NS):
                    if note.get('{'+NS['w']+'}type') in ('separator', 'continuationSeparator'):
                        continue
                    value = '\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', NS)) for p in note.findall('.//w:p', NS))
                    records.append({'locator': f'{tag.upper()}-{note.get("{"+NS["w"]+"}id")}', 'role': tag, 'text': value})
        status = 'ooxml_text_extracted'
    elif path.suffix == '.pdf':
        for i, page in enumerate(PdfReader(path).pages, 1):
            value = page.extract_text() or ''
            records.append({'locator': f'PAGE{i:03d}', 'role': 'body', 'text': value})
            if len(value.strip()) < 60:
                pending.append(f'PAGE{i:03d}')
        status = 'pdf_text_extracted' if not pending else 'pdf_visual_or_ocr_required'
    else:
        status = 'legacy_doc_conversion_required'
    return records, status, pending

def main():
    archive = Path(sys.argv[1])
    if digest(archive.read_bytes()) != 'ce4b55cb30035392df94c5b5032146012bb173898bc7a3f77a6b90178c0c01a2':
        raise ValueError('Different archive: create a new intake version; do not overwrite the 2026-09-27 snapshot')
    entries, sources, hashes = [], [], {}
    with ZipFile(archive) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if not info.flag_bits & 0x800:
                try:
                    name = name.encode('cp437').decode('gb18030')
                except UnicodeEncodeError:
                    pass  # Host runtime already decoded a Unicode ZIP name.
            rel = PurePosixPath(name.replace('\\', '/'))
            if rel.is_absolute() or '..' in rel.parts or ':' in name or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f'Unsafe archive member: {name}')
            raw = z.read(info)
            h = digest(raw)
            entry = {'archive_path': name, 'bytes': len(raw), 'sha256': h}
            if rel.name.startswith('~$'):
                entry['disposition'] = 'excluded_office_lock_file'
                entries.append(entry)
                continue
            if h in hashes:
                entry.update(disposition='byte_duplicate', source_id=hashes[h])
                entries.append(entry)
                continue
            sid = f'NA{len(sources)+1:03d}'
            dest = BASE / 'originals' / f'{sid}{rel.suffix.lower()}'
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists() and dest.read_bytes() != raw:
                raise ValueError(f'Refusing to overwrite changed original: {dest}')
            dest.write_bytes(raw)
            records, status, pending = extract(dest)
            src = {'source_id': sid, 'title': rel.stem, 'original_path': str(dest.relative_to(BASE)).replace('\\', '/'),
                   'sha256': h, 'bytes': len(raw), 'archive_path': name, 'parse_status': status,
                   'visual_or_ocr_required': pending, 'record_count': len(records),
                   'source_basis': 'user_supplied_archive', 'official_url': None, 'published_on': None, 'effective_from': None,
                   'document_kind': 'unclassified', 'current_status': 'unreviewed'}
            write_json(BASE / 'records' / f'{sid}.json', {'source_id': sid, 'original_sha256': h, 'extraction_status': status, 'records': records})
            sources.append(src)
            hashes[h] = sid
            entry.update(disposition='new_original', source_id=sid)
            entries.append(entry)
    write_json(BASE / 'intake.json', {'schema_version': 'nafmii-intake-v1', 'archive_name': archive.name, 'archive_sha256': digest(archive.read_bytes()),
        'received_on': '2026-09-27', 'authorization': 'User supplied this archive for repository knowledge curation and related issues; not commercial prospectus-reference authorization.', 'entries': entries})
    write_json(BASE / 'sources.json', {'schema_version': 'nafmii-source-catalog-v1', 'sources': sources})
    for s in sources:
        print(s['source_id'], s['parse_status'], s['record_count'], s['title'])
    print(f'{len(entries)} entries; {len(sources)} unique originals')

if __name__ == '__main__':
    main()
