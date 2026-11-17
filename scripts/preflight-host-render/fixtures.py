"""Synthetic manuscripts only; no customer data or provider requests."""
import json
import sys
from pathlib import Path

from docx import Document

from bondbuddy_file_authoring.fixed_edit import empty_log, write_json
from bondbuddy_file_authoring.template_manifest import build_manifest, sha

root = Path(sys.argv[1])
root.mkdir(exist_ok=True)
source, collapsed = Document(), Document()
for index in range(60):
    text = f'Synthetic disclosure {index + 1}. ' + 'Source issuer exchange bond disclosure. ' * 20
    source.add_paragraph(text).paragraph_format.page_break_before = index != 0
    collapsed.add_paragraph(text).paragraph_format.page_break_before = index != 0 and index % 3 == 0
source.save(root / 'source.docx')
collapsed.save(root / 'page-collapse.docx')
raw = (root / 'source.docx').read_bytes()
nodes = [n for n in build_manifest(root / 'source.docx')['nodes'] if n['kind'] == 'paragraph']
for name in ('good', 'mixed', 'body-collapse'):
    case = root / name
    case.mkdir()
    (case / 'output').mkdir()
    (case / 'scratch').mkdir()
    (case / 'source.docx').write_bytes(raw)
    data = {'input_hash': 'b' * 64, 'revision_author': 'BondBuddy-synthetic-handoff',
            'revision_date': '2026-11-14T00:00:00.000Z', 'update_required': True,
            'baseline_kind': 'uploaded_source', 'baseline_path': 'source.docx',
            'baseline_sha256': sha(raw), 'operations_path': 'output/operations.json',
            'output': {'tracked': 'output/tracked.docx', 'clean': 'output/clean.docx',
                       'baseline': 'output/baseline.docx'}}
    if name == 'mixed':
        data['expected_text'] = [{'text': 'Synthetic anchor deliberately missing from this manuscript.'}]
    log = empty_log(data, raw)
    log['operations'] = [{'id': f'update-{index}', 'kind': 'replace_text', 'node_id': n['node_id'],
                          'before': n['text'], 'after': 'Short synthetic disclosure.' if name == 'body-collapse'
                          else n['text'].replace('Source issuer', 'Target issuer')}
                         for index, n in enumerate(nodes)]
    write_json(case / 'input.json', data)
    write_json(case / 'output/operations.json', log)
    if name == 'good':
        write_json(case / 'intermediate-operations.json', {**log, 'operations': log['operations'][:30]})
    (case / 'input.json').chmod(0o444)
    (case / 'source.docx').chmod(0o444)
print(json.dumps({'scope': 'synthetic', 'cases': ['good', 'mixed', 'body-collapse'],
                  'source_sha256': sha(raw), 'source_explicit_pages': 60}))
