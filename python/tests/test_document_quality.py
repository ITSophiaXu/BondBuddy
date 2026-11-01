"""Synthetic catastrophic regressions and factual anchors, not expert acceptance."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from lxml import etree as ET

from bondbuddy_file_authoring.check import clean, package, resolve_revisions
from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.quality import verify
from bondbuddy_file_authoring.template_manifest import build_manifest, sha
from bondbuddy_file_authoring.word_patch import q, serialized, xml


class DocumentQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document()
        doc.add_heading('第一章 发行人基本情况', level=1)
        doc.add_paragraph('发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8)
        doc.add_heading('第二章 财务会计信息', level=1)
        doc.add_paragraph('截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8)
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2025年6月末'
        table.cell(1, 0).text = '净资产'
        table.cell(1, 1).text = '100'
        doc.sections[0].header.paragraphs[0].text = '原稿格式页眉'
        doc.save(self.source)
        self.data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-quality-test',
                     'baseline_kind': 'uploaded_source', 'baseline_path': 'source.docx',
                     'baseline_sha256': sha(self.source.read_bytes()),
                     'operations_path': 'operations.json',
                     'output': {'tracked': 'output/tracked.docx', 'clean': 'output/clean.docx', 'baseline': 'output/baseline.docx'}}
        self.input = self.root / 'input.json'
        self.log_path = self.root / 'operations.json'

    def tearDown(self):
        self.temp.cleanup()

    def generate(self, operations=None):
        write_json(self.input, self.data)
        log = empty_log(self.data, self.source.read_bytes())
        log['operations'] = operations or []
        if not operations:
            log['no_changes_reason'] = 'Synthetic preservation test; no content update required.'
        write_json(self.log_path, log)
        finalize(self.input, self.log_path, self.root / 'output', skip_report=True)
        return verify(self.input)

    def node(self, text):
        return next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == text)

    def mutate(self, path, callback):
        parts = package(path)
        callback(parts)
        with ZipFile(path, 'w', ZIP_DEFLATED) as z:
            for name, raw in parts.items():
                z.writestr(name, raw)

    def codes(self, report):
        return {issue['code'] for issue in report['issues']}

    def test_numeric_period_update_keeps_template_and_passes_pair(self):
        text = '截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8
        node = self.node(text)
        after = text.replace('6月末', '9月末').replace('100', '120')
        report = self.generate([{'id': 'financial', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': text, 'after': after}])
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['metrics']['prose_retention'], 1.0)
        self.assertEqual(report['factual_accuracy'], 'not_verified')

    def test_valid_no_changes_and_comment_only_do_not_need_fake_revisions(self):
        self.assertEqual(self.generate()['status'], 'passed')
        node = self.node('第一章 发行人基本情况')
        result = self.generate([{'id': 'comment', 'kind': 'add_comment', 'node_id': node['node_id'],
                                'before': node['text'], 'text': '此处披露范围待核对。'}])
        self.assertEqual(result['status'], 'passed', result)

    def test_tracked_and_clean_equal_text_with_different_styles_is_rejected(self):
        self.generate()
        def mutate(parts):
            styles = xml(parts['word/styles.xml'])
            styles.find('.//' + q('rFonts')).set(q('ascii'), 'Wrong font')
            parts['word/styles.xml'] = serialized(styles)
        self.mutate(self.root / 'output/clean.docx', mutate)
        self.assertIn('WORD_PAIR_RESOURCE_MISMATCH', self.codes(verify(self.input)))

    def test_tampering_both_word_files_cannot_hide_source_format_drift(self):
        self.generate()
        def mutate(parts):
            body = xml(parts['word/document.xml'])
            p = body.find(q('body')).find(q('p'))
            prop = p.find(q('pPr'))
            ET.SubElement(prop, q('spacing'), {q('after'): '9999'})
            parts['word/document.xml'] = serialized(body)
        for name in ('tracked', 'clean'):
            self.mutate(self.root / f'output/{name}.docx', mutate)
        self.assertIn('WORD_SOURCE_FORMAT_CHANGED', self.codes(verify(self.input)))

    def test_direct_authoring_cannot_rewrite_existing_baseline_comments(self):
        node = self.node('第一章 发行人基本情况')
        self.generate([{'id': 'old', 'kind': 'add_comment', 'node_id': node['node_id'],
                        'before': node['text'], 'text': '原稿中必须保留的核对意见。'}])
        self.source.write_bytes((self.root / 'output/clean.docx').read_bytes())
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.data.pop('operations_path')
        self.generate()
        def mutate(parts):
            comments = xml(parts['word/comments.xml'])
            comments.find('.//' + q('t')).text = '擅自替换为已核实。'
            parts['word/comments.xml'] = serialized(comments)
        for name in ('tracked', 'clean'):
            self.mutate(self.root / f'output/{name}.docx', mutate)
        self.assertIn('WORD_BASELINE_COMMENT_CHANGED', self.codes(verify(self.input)))

    def test_104_to_39_pages_with_genuine_deletions_is_rejected(self):
        # Explicit page boundaries model the reported incident without claiming
        # that stored DOCX page metadata is a real renderer's measurement.
        doc = Document()
        for index in range(104):
            paragraph = doc.add_paragraph(f'原始第{index + 1}页的独立完整披露：' + '原稿重要经营财务和历史条款必须完整保留。' * 12)
            paragraph.paragraph_format.page_break_before = index != 0
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.data.pop('operations_path')
        self.generate()
        def delete(parts):
            root = xml(parts['word/document.xml'])
            for p in root.find(q('body')).findall(q('p'))[39:]:
                props = p.find(q('pPr'))
                rprops = ET.SubElement(props, q('rPr'))
                ET.SubElement(rprops, q('del'), {q('id'): '999', q('author'): self.data['revision_author']})
            parts['word/document.xml'] = serialized(root)
        self.mutate(self.root / 'output/tracked.docx', delete)
        clean(self.root / 'output/tracked.docx', self.root / 'output/clean.docx')
        report = verify(self.input)
        self.assertEqual(report['metrics']['baseline']['nonempty_paragraphs'], 104)
        self.assertEqual(report['metrics']['output']['nonempty_paragraphs'], 39)
        self.assertIn('WORD_SOURCE_CONTENT_REDUCED', self.codes(report))
        # A real reject-all restoration alone cannot catch a destructive edit.
        restored = resolve_revisions(xml(package(self.root / 'output/tracked.docx')['word/document.xml']), False, only_new=self.data['revision_author'])
        self.assertEqual(len(restored.find(q('body')).findall(q('p'))), 104)

    def test_padded_rewrite_cannot_pass_by_retaining_character_count(self):
        self.generate()
        def replace(parts):
            root = xml(parts['word/document.xml'])
            ps = root.find(q('body')).findall(q('p'))
            for p in ps:
                for t in p.iter(q('t')):
                    t.text = '无关的新写摘要填充全部内容而丢失原有披露' * 20
            parts['word/document.xml'] = serialized(root)
        for name in ('tracked', 'clean'):
            self.mutate(self.root / f'output/{name}.docx', replace)
        report = verify(self.input)
        self.assertGreater(report['metrics']['ratios']['characters'], 1)
        self.assertIn('WORD_SOURCE_PROSE_LOST', self.codes(report))

    def test_one_chapter_loss_is_detected_even_when_global_length_is_padded(self):
        original = '发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8
        node = self.node(original)
        report = self.generate([{'id': 'wipe', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': original, 'after': ''}])
        self.assertIn('WORD_SOURCE_CHAPTER_CONTENT_LOST', self.codes(report))

    def test_heading_rewrite_is_blocked_even_when_operation_log_is_valid(self):
        node = self.node('第一章 发行人基本情况')
        report = self.generate([{'id': 'rename', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '第一章 新编摘要'}])
        self.assertIn('WORD_SOURCE_OUTLINE_CHANGED', self.codes(report))

    def test_arabic_heading_numbers_cannot_be_normalized_away(self):
        doc = Document(self.source)
        doc.paragraphs[0].text = '1 财务状况'
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node('1 财务状况')
        report = self.generate([{'id': 'renumber', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '2 财务状况'}])
        self.assertIn('WORD_SOURCE_OUTLINE_CHANGED', self.codes(report))

    def test_expected_financial_anchor_catches_wrong_numeric_update(self):
        self.data['expected_text'] = [{'text': '合并口径净资产为120万元', 'occurrences': 8}]
        report = self.generate()
        self.assertIn('WORD_EXPECTED_FACT_MISMATCH', self.codes(report))

    def test_cross_period_update_cannot_succeed_with_no_changes_or_comments_only(self):
        self.data['update_required'] = True
        self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', self.codes(self.generate()))
        node = self.node('第一章 发行人基本情况')
        result = self.generate([{'id': 'comment', 'kind': 'add_comment', 'node_id': node['node_id'],
                                'before': node['text'], 'text': '仅批注不代表财务全文更新完成。'}])
        self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', self.codes(result))

    def test_cross_period_date_relabelling_cannot_impersonate_financial_update(self):
        self.data['update_required'] = True
        text = '截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8
        node = self.node(text)
        result = self.generate([{'id': 'dates-only', 'kind': 'replace_text', 'node_id': node['node_id'],
                                'before': text, 'after': text.replace('6月末', '9月末')}])
        self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', self.codes(result))

    def test_cross_period_date_and_financial_value_update_is_substantive(self):
        self.data['update_required'] = True
        text = '截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8
        node = self.node(text)
        result = self.generate([{'id': 'facts', 'kind': 'replace_text', 'node_id': node['node_id'],
                                'before': text, 'after': text.replace('6月末', '9月末').replace('100', '120')}])
        self.assertEqual(result['status'], 'passed', result)

    def test_host_baseline_hash_and_output_baseline_cannot_be_substituted(self):
        self.generate()
        self.data['baseline_sha256'] = 'b' * 64
        write_json(self.input, self.data)
        self.assertIn('WORD_BASELINE_CHANGED', self.codes(verify(self.input)))

    def make_pdf(self, text):
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(('BT /F1 10 Tf 30 700 Td (' + text + ') Tj ET').encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(stream)
        with (self.root / 'source.pdf').open('wb') as output:
            writer.write(output)

    def test_pdf_reconstruction_must_match_independent_original_text(self):
        text = 'Original disclosure covers business management accounting and material issuer risks. ' * 10
        doc = Document()
        doc.add_paragraph(text)
        doc.save(self.source)
        self.data.update(baseline_kind='reconstructed_pdf', baseline_sha256=sha(self.source.read_bytes()), original_pdf_path='source.pdf')
        self.make_pdf(text)
        self.assertEqual(self.generate()['status'], 'passed')
        # A tiny model-created baseline agrees perfectly with its two outputs,
        # but must not erase the independently available original PDF text.
        doc = Document()
        doc.add_paragraph('Tiny unrelated summary.')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.assertIn('WORD_PDF_SOURCE_CONTENT_LOST', self.codes(self.generate()))

    def test_scanned_pdf_without_independent_ocr_cannot_claim_verified_retention(self):
        self.data.update(baseline_kind='reconstructed_pdf', original_pdf_path='source.pdf')
        self.make_pdf('')
        self.assertIn('WORD_PDF_TEXT_VERIFICATION_UNAVAILABLE', self.codes(self.generate()))

    def test_pdf_reconstruction_cannot_omit_original_pdf(self):
        self.data['baseline_kind'] = 'reconstructed_pdf'
        self.assertIn('WORD_PDF_SOURCE_REQUIRED', self.codes(self.generate()))

    def test_cli_fails_closed_with_machine_readable_report(self):
        self.generate()
        (self.root / 'output/clean.docx').unlink()
        completed = subprocess.run([sys.executable, '-m', 'bondbuddy_file_authoring.quality', '--input', str(self.input)],
                                   capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)['status'], 'failed')
        self.assertEqual(json.loads(completed.stderr)['error'], 'WORD_QUALITY_REJECTED')

    def test_first_draft_only_claims_checks_it_can_execute(self):
        self.generate()
        self.data.update(baseline_kind='none', baseline_path=None)
        write_json(self.input, self.data)
        report = verify(self.input)
        self.assertEqual(report['status'], 'passed', report)
        self.assertTrue(any('No source manuscript' in item for item in report['limitations']))


if __name__ == '__main__':
    unittest.main()
