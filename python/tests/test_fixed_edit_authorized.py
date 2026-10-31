"""Opt-in format replay against authorized DOCX originals with synthetic edits.

No model call, no upload, no changes to the sample originals. This establishes
structural preservation only; it is not an issuer/content or Word/WPS acceptance.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from bondbuddy_file_authoring.check import package
from bondbuddy_file_authoring.baseline_review import audit_pair
from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.template_manifest import build_manifest, sha


class AuthorizedFixedEditTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION') == '1',
                         'opt in to authorized DOCX format regression')
    def test_four_prospectuses_keep_their_templates_with_synthetic_text_edits(self):
        source_root = Path(__file__).resolve().parents[2] / 'tests/samples/2026-09-25'
        manifest = json.loads((source_root / 'manifest.json').read_text(encoding='utf-8'))
        entries = [item for case in manifest['cases'] for item in case['files'] if item['upload_role'] == 'historical']
        self.assertEqual(len(entries), 4)
        for entry in entries:
            with self.subTest(file_id=entry['file_id']), tempfile.TemporaryDirectory() as temp:
                original = source_root / entry['path']
                raw = original.read_bytes()
                self.assertEqual(sha(raw), entry['sha256'])
                root = Path(temp)
                source = root / 'source.docx'
                source.write_bytes(raw)
                data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-format-regression',
                        'baseline_path': 'source.docx', 'baseline_sha256': entry['sha256']}
                input_path, log_path = root / 'input.json', root / 'operations.json'
                write_json(input_path, data)
                template = build_manifest(source)
                self.assertLess(len(json.dumps(template, ensure_ascii=False).encode('utf-8')), 32 * 1024 * 1024,
                                'template manifest must fit the worker JSON bound')
                candidate = next(n for n in template['nodes'] if n['kind'] == 'paragraph'
                                 and n['part'] == 'word/document.xml' and not n['limitations'] and 10 < len(n['text']) < 150)
                log = empty_log(data, raw)
                log['operations'] = [{'id': 'synthetic', 'kind': 'replace_text', 'node_id': candidate['node_id'],
                                      'before': candidate['text'], 'after': candidate['text'] + '（格式回归测试）',
                                      'reason': 'Synthetic test edit; not an issuer disclosure.'}]
                write_json(log_path, log)
                output = root / 'output'
                receipt = finalize(input_path, log_path, output)
                self.assertEqual(receipt['format_status'], 'passed',
                                 (output / 'format-report.json').read_text(encoding='utf-8'))
                pair = audit_pair(source, output / 'tracked.docx', output / 'clean.docx', data['revision_author'])
                self.assertEqual(pair['status'], 'passed', pair)
                baseline, tracked = package(source), package(output / 'tracked.docx')
                for part in baseline:
                    if part != 'word/document.xml':
                        self.assertEqual(baseline[part], tracked[part], part)
                self.assertEqual(sha(original.read_bytes()), entry['sha256'])


if __name__ == '__main__':
    unittest.main()
