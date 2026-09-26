"""Verify archived source bytes, provenance and research-view boundaries offline.

Optionally pass --archive-dir to verify the two user-supplied ZIP containers too.
No publication, reviewer identity, model execution or industry acceptance is created.
"""
import argparse
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'knowledge/exchange-bonds'
INTAKE = BASE / 'intake/2026-09-26-archives'


def load(path):
    return json.loads(path.read_text('utf-8'))


def check(condition, message):
    if not condition:
        raise ValueError(message)


def local_bytes(base, relative):
    path = (base / relative).resolve()
    check(path.is_relative_to(base.resolve()), f'Out of scope path: {relative}')
    return path.read_bytes()


def verify_bytes(raw, record):
    check(hashlib.sha256(raw).hexdigest() == record['sha256'], 'Source SHA mismatch')
    if 'bytes' in record:
        check(len(raw) == record['bytes'], 'Source size mismatch')


class Notice(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip = 0
        self.text = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if not self.skip and tag == 'a':
            self.links.extend(v for k, v in attrs if k == 'href' and v)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = max(0, self.skip - 1)

    def handle_data(self, value):
        if not self.skip:
            self.text.append(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-dir', type=Path)
    args = parser.parse_args()
    intake = load(INTAKE / 'catalog.json')
    sources = load(BASE / 'sources.json')
    check(len(intake['entries']) == 31, 'Missing archive member')
    check(len({e['entry_id'] for e in intake['entries']}) == 31, 'Duplicate entry id')
    check(sum(e['disposition'] == 'new_source' for e in intake['entries']) == 1, 'New-source count')
    check(sum(e['disposition'] == 'exact_existing_bytes' for e in intake['entries']) == 30, 'Dedup count')
    check(intake['production_eligible'] is False, 'Intake is not a release')
    for entry in intake['entries']:
        verify_bytes(local_bytes(BASE, entry['original_path']), entry)
        check((BASE / entry['text_path']).is_file(), f'Missing source text: {entry["source_id"]}')
    if args.archive_dir:
        for record in intake['archives']:
            path = args.archive_dir / record['filename']
            verify_bytes(path.read_bytes(), record)
            with ZipFile(path) as archive:
                entries = [e for e in archive.infolist() if not e.is_dir()]
                expected = {e['entry_name']: e for e in intake['entries'] if e['archive'] == record['filename']}
                check(len(entries) == record['file_entries'] == len(expected), 'Archive member count')
                check({e.filename for e in entries} == set(expected), 'Archive member names')
                for entry in entries:
                    name = PurePosixPath(entry.filename)
                    check(not name.is_absolute() and '..' not in name.parts, 'Unsafe ZIP member')
                    verify_bytes(archive.read(entry), expected[entry.filename])

    evidence = load(INTAKE / 'official-evidence.json')
    notice_raw = local_bytes(INTAKE, evidence['notice_path'])
    check(hashlib.sha256(notice_raw).hexdigest() == evidence['notice_sha256'], 'Notice hash')
    check(len(notice_raw) == evidence['notice_bytes'], 'Notice length')
    notice = Notice(); notice.feed(notice_raw.decode('utf-8'))
    visible = ''.join(''.join(notice.text).split())
    for required in ('2026-09-04', '自发布之日起施行', '同时废止', '2023', '986'):
        check(required in visible, f'Missing notice evidence: {required}')
    for attachment in evidence['attachments']:
        check(attachment['linked_url'] in notice.links, 'Attachment is not linked in visible notice')
        check(attachment['url'] == attachment['linked_url'].replace('http://', 'https://', 1),
              'Only HTTPS transport upgrade is allowed for the exact linked attachment')
        verify_bytes(local_bytes(BASE, attachment['original_path']), attachment)
    check(evidence['industry_review'] is None, 'Source retrieval must not invent a review')

    source_map = {s['source_id']: s for s in sources['sources']}
    for sid in ('EX039', 'EX040'):
        verify_bytes(local_bytes(BASE, source_map[sid]['original_path']), source_map[sid])
        check(source_map[sid]['professional_acceptance'] == 'pending', 'Unexpected approval')
    records = load(BASE / 'records/EX039.json')['records']
    text = {r['locator']: r['text'] for r in records}
    for locator, expected in [('P00054', '986'), ('P00085', '中国上市公司协会'), ('P00030', '三十六个月'), ('P00071', '＞2.5')]:
        check(expected in text[locator], f'Lost exact rule boundary: {locator}')
    notes = load(BASE / 'records/EX015.json')['records']
    check(any(r['role'] == 'footnote' for r in notes), 'Investor protection footnotes lost')
    for file in (BASE / 'records').glob('*.json'):
        rows = {r['locator']: r for r in load(file)['records']}
        for locator, row in rows.items():
            for note_id in row.get('note_references', []):
                check(note_id in rows and locator in rows[note_id]['referenced_by'],
                      f'Broken note association: {file.name}:{locator}:{note_id}')
            for paragraph in row.get('referenced_by', []):
                check(paragraph in rows and locator in rows[paragraph]['note_references'],
                      f'Broken paragraph association: {file.name}:{locator}:{paragraph}')

    for item in load(ROOT / 'product-prototype/knowledge/manifest.json'):
        check(not {'EX009', 'EX028'}.intersection(item['sourceIds']), 'Repealed text in current research view')
        if item['scope'].startswith('szse-'):
            check('EX039' in item['sourceIds'], 'New SZSE source missing')
        else:
            check('EX039' not in item['sourceIds'], 'SZSE source leaked into SSE view')
    for scope in ('sse-private', 'sse-public', 'sse-public_all', 'szse-private', 'szse-public', 'szse-public_all'):
        pack = load(BASE / f'drafts/{scope}/rule-pack.json')
        check(not pack['reviews'] and pack['release'] is None, 'Research must not publish')
        check(all(not r['enabled'] and r['enforcement'] == 'research_only' for r in pack['rules']), 'Rule unexpectedly enabled')
        extra = [r for r in pack['rules'] if any(k in r['rule_id'] for k in ('szse-mature-', 'szse-industry-basis'))]
        check(len(extra) == (3 if scope.startswith('szse-') else 0), 'Wrong scope for new candidates')
    print('PASS: 31 members, source/notice hashes, exact clauses/notes, six scope and publication boundaries'
          + ('; original ZIP containers verified' if args.archive_dir else ''))


if __name__ == '__main__':
    main()
