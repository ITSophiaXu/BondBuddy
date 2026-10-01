"""Verify checked-in authorized sample bytes; no services or model calls."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile


def main():
    root = Path(__file__).resolve().parent
    manifests = sorted(root.glob('*/manifest.json'))
    if not manifests:
        raise ValueError('No sample manifests found')
    listed = set()
    identifiers = set()
    total_files = 0
    total_bytes = 0
    for manifest_path in manifests:
        batch = manifest_path.parent
        data = json.loads(manifest_path.read_text(encoding='utf-8'))
        if data['manifest_version'] != 1:
            raise ValueError(f'Unsupported manifest: {manifest_path}')
        files = [file for case in data['cases'] for file in case['files']]
        if len(files) != data['file_count']:
            raise ValueError(f'File count mismatch: {manifest_path}')
        batch_bytes = 0
        for file in files:
            path = (batch / file['path']).resolve()
            if not path.is_relative_to(batch) or path in listed:
                raise ValueError(f'Unsafe or duplicate path: {file["path"]}')
            if file['file_id'] in identifiers:
                raise ValueError(f'Duplicate file ID: {file["file_id"]}')
            listed.add(path)
            identifiers.add(file['file_id'])
            raw = path.read_bytes()
            if path.name != file['original_filename']:
                raise ValueError(f'Original filename mismatch: {file["file_id"]}')
            if len(raw) != file['bytes'] or hashlib.sha256(raw).hexdigest() != file['sha256']:
                raise ValueError(f'Byte/hash mismatch: {file["file_id"]}')
            if path.suffix in {'.docx', '.xlsx'}:
                with ZipFile(path) as archive:
                    if archive.testzip() is not None:
                        raise ValueError(f'Damaged Office package: {file["file_id"]}')
                    required = 'word/document.xml' if path.suffix == '.docx' else 'xl/workbook.xml'
                    if required not in archive.namelist():
                        raise ValueError(f'Unexpected Office format: {file["file_id"]}')
            elif path.suffix == '.pdf' and not raw.startswith(b'%PDF-'):
                raise ValueError(f'Unexpected PDF format: {file["file_id"]}')
            batch_bytes += len(raw)
        if batch_bytes != data['total_bytes']:
            raise ValueError(f'Batch byte count mismatch: {manifest_path}')
        total_files += len(files)
        total_bytes += batch_bytes
        print(f'{batch.name}: {len(files)} originals verified; {batch_bytes:,} bytes')
    actual = {p.resolve() for p in root.rglob('*') if p.is_file() and p.suffix.lower() in {'.docx', '.xlsx', '.pdf'}}
    if actual != listed:
        raise ValueError('Sample files and manifests differ; inspect unlisted or missing originals')
    print(f'PASS: {len(manifests)} batches, {total_files} originals, {total_bytes:,} bytes')


if __name__ == '__main__':
    main()
