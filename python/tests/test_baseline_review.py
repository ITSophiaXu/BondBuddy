"""Real DOCX operations with synthetic text; no model or customer data."""
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile, ZIP_DEFLATED

from docx import Document
from lxml import etree as ET
from bondbuddy_file_authoring.baseline_review import audit_pair, review_workspace
from bondbuddy_file_authoring.check import package, parse_xml
from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.template_manifest import build_manifest, sha
from bondbuddy_word_delivery.writer import Q


class BaselineReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document()
        doc.add_heading('第一章 发行人概况', 1)
        doc.add_paragraph('保留完整的历史业务说明和所有适用原文。')
        doc.add_paragraph('截至2024年末，净资产100万元。')
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2024年末'
        table.cell(1, 0).text = '净资产'
        table.cell(1, 1).text = '100'
        doc.sections[0].header.paragraphs[0].text = '原稿页眉'
        doc.save(self.source)
        self.data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-review-test',
                     'revision_date': '2026-10-31T00:00:00Z', 'baseline_path': 'source.docx',
                     'baseline_sha256': sha(self.source.read_bytes()), 'baseline_kind': 'uploaded_source',
                     'format_tools': {'version': 'controlled-docx-v1'}}
        self.input = self.root / 'input.json'
        self.log = self.root / 'output/operations.json'
        self.log.parent.mkdir()
        write_json(self.input, self.data)
        node = next(n for n in build_manifest(self.source)['nodes'] if n['text'] == '截至2024年末，净资产100万元。')
        log = empty_log(self.data, self.source.read_bytes())
        log['operations'] = [{'id': 'update', 'kind': 'replace_text', 'node_id': node['node_id'],
                              'before': node['text'], 'after': '截至2025年末，净资产120万元。'}]
        write_json(self.log, log)
        self.dest = self.root / 'result'
        finalize(self.input, self.log, self.dest, skip_report=True)

    def audit(self, baseline=None, clean=None):
        return audit_pair(baseline or self.source, self.dest / 'tracked.docx', clean or self.dest / 'clean.docx',
                          self.data['revision_author'])

    def test_real_tracked_update_restores_source_and_reuses_untouched_text(self):
        report = self.audit()
        self.assertEqual(report['status'], 'passed', report)
        self.assertTrue(all(report['checks'].values()))
        body = next(s for s in report['text_inventory'] if s['part'] == 'word/document.xml')
        self.assertEqual(body['source_text_not_reused'], 1)
        self.assertEqual(body['new_or_changed_text'], 1)
        self.assertEqual(body['exact_text_reused'], body['source_paragraphs'] - 1)
        self.assertEqual(report['content_review'], 'not_performed')

    def test_clean_copy_of_old_source_is_detected(self):
        report = self.audit(clean=self.source)
        self.assertEqual(report['status'], 'failed')
        self.assertIn('WORD_ACCEPT_MISMATCH', [x['code'] for x in report['issues']])

    def test_new_blank_document_cannot_replace_original_baseline(self):
        replacement = self.root / 'model-baseline.docx'
        doc = Document()
        doc.add_paragraph('模型自行重建的正文')
        doc.save(replacement)
        self.assertFalse(self.audit(baseline=replacement)['checks']['reject_current_restores_original'])

    def test_clean_with_revision_marks_is_detected(self):
        report = self.audit(clean=self.dest / 'tracked.docx')
        self.assertIn('WORD_CLEAN_HAS_REVISIONS', [x['code'] for x in report['issues']])

    def test_untracked_header_change_is_detected(self):
        path = self.dest / 'tracked.docx'
        parts = package(path)
        part = next(p for p in parts if p.startswith('word/header'))
        parts[part] = parts[part].replace('原稿页眉'.encode(), '错误页眉'.encode())
        with ZipFile(path, 'w', ZIP_DEFLATED) as z:
            for name, raw in parts.items(): z.writestr(name, raw)
        self.assertFalse(self.audit()['checks']['reject_current_restores_original'])

    def test_model_baseline_output_is_not_trusted(self):
        (self.root / 'output/baseline.docx').write_bytes(b'fake baseline')
        report = review_workspace(self.input)
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['sha256']['baseline'], self.data['baseline_sha256'])

    def test_direct_mode_checks_output_against_pinned_original_without_operations(self):
        self.data.pop('format_tools')
        self.data['output'] = {'tracked': 'result/tracked.docx', 'clean': 'result/clean.docx'}
        write_json(self.input, self.data)
        self.assertEqual(review_workspace(self.input)['status'], 'passed')
        self.data['baseline_sha256'] = 'b' * 64
        write_json(self.input, self.data)
        with self.assertRaisesRegex(ValueError, 'WORD_BASELINE_CHANGED'): review_workspace(self.input)

    def test_unreadable_package_is_not_a_pass(self):
        broken = self.root / 'broken.docx'
        broken.write_bytes(b'not a zip')
        self.assertEqual(self.audit(clean=broken)['status'], 'unsupported')

    def test_non_docx_source_is_not_claimed_verified(self):
        for kind in ('none', 'reconstructed_pdf'):
            self.data['baseline_kind'] = kind
            write_json(self.input, self.data)
            self.assertEqual(review_workspace(self.input)['status'], 'unsupported')

    def test_existing_revisions_remain_history_when_rejecting_this_update(self):
        parts = package(self.source)
        root = parse_xml(parts['word/document.xml'])
        paragraph = root.find(Q('body')).findall(Q('p'))[1]
        run = paragraph.find(Q('r'))
        paragraph.remove(run)
        ET.SubElement(paragraph, Q('ins'), {Q('id'): '100', Q('author'): 'Previous reviewer'}).append(run)
        parts['word/document.xml'] = ET.tostring(root, encoding='UTF-8', xml_declaration=True)
        with ZipFile(self.source, 'w', ZIP_DEFLATED) as z:
            for name, raw in parts.items(): z.writestr(name, raw)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        log = json.loads(self.log.read_text(encoding='utf-8'))
        log['baseline_sha256'] = self.data['baseline_sha256']
        write_json(self.log, log)
        finalize(self.input, self.log, self.dest, skip_report=True)
        self.assertEqual(self.audit()['status'], 'passed', self.audit())


if __name__ == '__main__':
    unittest.main()
