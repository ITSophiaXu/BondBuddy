"""Authorized immutable real files through trusted edit -> pair -> quality gates.

No model or professional sign-off is simulated. The June date correction is the
explicitly confirmed correction in DATE-QUESTIONS.md; the prospectus change is a
test-only attached comment. Source bytes are never edited in place.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.quality import verify
from bondbuddy_file_authoring.template_manifest import build_manifest, sha

REPO = Path(__file__).resolve().parents[2]
MANIFEST = REPO / 'tests/samples/2026-09-25/manifest.json'


class AuthorizedAuthoringQualityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION') != '1':
            raise unittest.SkipTest('set BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION=1 to run authorized real DOCX tests')
        cls.manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))

    def source(self, file_id, root):
        entry = next(f for c in self.manifest['cases'] for f in c['files'] if f['file_id'] == file_id)
        original = MANIFEST.parent / entry['path']
        self.assertTrue(original.is_file(), f'Authorized fixture missing: {file_id}')
        raw = original.read_bytes()
        self.assertEqual(len(raw), entry['bytes'])
        self.assertEqual(sha(raw), entry['sha256'])
        (root / 'source.docx').write_bytes(raw)
        return root / 'source.docx', raw

    def generate(self, root, source, operation, expected=None):
        data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-authorized-quality-test',
                'baseline_kind': 'uploaded_source', 'baseline_path': 'source.docx',
                'baseline_sha256': sha(source.read_bytes()), 'operations_path': 'operations.json',
                'output': {'tracked': 'output/tracked.docx', 'clean': 'output/clean.docx', 'baseline': 'output/baseline.docx'},
                'expected_text': expected or []}
        input_path, operations = root / 'input.json', root / 'operations.json'
        write_json(input_path, data)
        log = empty_log(data, source.read_bytes())
        log['operations'] = [operation]
        write_json(operations, log)
        result = finalize(input_path, operations, root / 'output', skip_report=True)
        self.assertEqual(result['operation_count'], 1)
        report = verify(input_path)
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['metrics']['outline_status'], 'unchanged')
        self.assertEqual(report['metrics']['prose_retention'], 1.0)
        self.assertEqual((root / 'output/baseline.docx').read_bytes(), source.read_bytes())
        return report

    def render(self, root):
        if os.environ.get('BB_REQUIRE_DOCUMENT_RENDER') != '1':
            return  # The release gate requires this; local unit runs do not claim visual acceptance.
        renderer = shutil.which('soffice') or shutil.which('libreoffice')
        self.assertIsNotNone(renderer, 'Required document renderer is missing')
        from pypdf import PdfReader
        pages = {}
        for label, source in [('baseline', root / 'source.docx'), ('tracked', root / 'output/tracked.docx'), ('clean', root / 'output/clean.docx')]:
            destination = root / f'render-{label}'
            destination.mkdir()
            profile = (root / f'lo-profile-{label}').as_uri()
            completed = subprocess.run([renderer, '-env:UserInstallation=' + profile, '--headless', '--convert-to', 'pdf',
                                        '--outdir', str(destination), str(source)], capture_output=True, timeout=180, check=False)
            self.assertEqual(completed.returncode, 0, 'Required PDF rendering failed')
            pdf = destination / (source.stem + '.pdf')
            self.assertTrue(pdf.is_file(), 'Renderer did not produce the required PDF')
            pages[label] = len(PdfReader(pdf).pages)
            self.assertGreater(pages[label], 0)
        self.assertGreaterEqual(pages['clean'], pages['baseline'] * .95,
                                'Rendered clean manuscript lost more than 5% of source pages after a local edit')
        print(json.dumps({'acceptance': 'authorized_source_render', 'renderer': 'LibreOffice',
                          'pages': pages, 'visual_review': 'not_run'}, sort_keys=True), flush=True)

    def test_real_prospectus_preserves_full_source_and_template(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, raw = self.source('rq-202506-01', root)
            manifest = build_manifest(source)
            node = next(n for n in manifest['nodes'] if n['kind'] == 'paragraph' and n['text'].strip() and not n['limitations'])
            report = self.generate(root, source, {'id': 'comment', 'kind': 'add_comment', 'node_id': node['node_id'],
                                                'before': node['text'], 'text': '合成测试批注，仅验证全文保留与格式，不是实际业务修改。'})
            self.assertGreater(report['metrics']['baseline']['nonempty_paragraphs'], 1000)
            self.assertEqual(report['metrics']['ratios']['characters'], 1.0)
            self.assertEqual(source.read_bytes(), raw)
            self.render(root)

    def test_confirmed_june_date_correction_keeps_march_and_approval_dates(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, raw = self.source('rq-202506-04', root)
            node = next(n for n in build_manifest(source)['nodes'] if n['kind'] == 'paragraph' and '2025年6月31日' in n['text'])
            self.assertFalse(node['limitations'], 'The fixed edit must support the confirmed date anchor')
            after = node['text'].replace('2025年6月31日', '2025年6月30日')
            self.generate(root, source, {'id': 'confirmed-date', 'kind': 'replace_text', 'node_id': node['node_id'],
                                        'before': node['text'], 'after': after},
                          [{'text': '截止2025年3月31日，本公司将'},
                           {'text': '本公司财务报告于2025年4月20日经总经理办公会批准报出。'},
                           {'text': '2025年6月31日', 'occurrences': 0},
                           {'text': '2025年6月30日', 'occurrences': 1}])
            self.assertEqual(source.read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
