import tempfile
import unittest
import zipfile
from pathlib import Path
from docx import Document
from lxml import etree
from bondbuddy_word_delivery.review import annotate, write_report
from bondbuddy_word_delivery.writer import Q, W, parse_xml, document_signature


class ReviewWordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document()
        p = doc.add_paragraph()
        p.add_run('合计').bold = True
        p.add_run('金额为100万元。')
        doc.add_table(rows=1, cols=1).cell(0, 0).text = '期末余额90万元'
        doc.save(self.source)

    def report(self, quote='100万元', locator='docx:p0001'):
        target = {'material_id': 'source', 'material_version': 1, 'material_sha256': 'a'*64, 'quote': quote, 'locator': {'stable_ref': locator}}
        return {'report_id': 'synthetic-report', 'run_id': 'synthetic-run', 'version': 1, 'input_revision': 1, 'scope': {'mode': 'full_review', 'finding_ids': []},
                'source_material': {'material_id': 'source', 'material_version': 1, 'sha256': 'a'*64}, 'created_at': '2026-10-02T00:00:00Z', 'coverage': [], 'limitations': [],
                'findings': [{'finding_id': 'F001', 'dimension': 'financial', 'severity': 'P1', 'title': '合计不一致', 'description': '核对合计与原表', 'conclusion': 'error', 'check_status': 'rechecked',
                              'origin_report_id': 'synthetic-report', 'target_refs': [target], 'evidence_refs': [], 'limitations': []}]}

    def xml(self, path, name='word/document.xml'):
        with zipfile.ZipFile(path) as z:
            return parse_xml(z.read(name))

    def test_native_comment_is_precisely_anchored_without_changing_text_or_bold(self):
        out = self.root / 'comments.docx'
        placed, missing = annotate(self.source, out, self.report())
        self.assertEqual(len(placed), 1)
        self.assertEqual(missing, [])
        before, after = self.xml(self.source), self.xml(out)
        self.assertEqual(document_signature(before), document_signature(after))
        para = after.find('.//' + Q('p'))
        selected, on = '', False
        for node in para:
            if node.tag == Q('commentRangeStart'):
                on = True
            elif node.tag == Q('commentRangeEnd'):
                on = False
            elif on:
                selected += ''.join(n.text or '' for n in node.iter(Q('t')))
        self.assertEqual(selected, '100万元')
        self.assertIsNotNone(para.find('.//' + Q('b')))
        comment = self.xml(out, 'word/comments.xml')[0]
        self.assertEqual(comment.get(Q('author')), 'BondBuddy')
        self.assertEqual(comment.get(Q('date')), '2026-10-02T00:00:00Z')

    def test_existing_comments_and_two_findings_same_location_survive_reopen(self):
        first, second = self.root / 'first.docx', self.root / 'second.docx'
        annotate(self.source, first, self.report())
        report = self.report()
        duplicate = {**report['findings'][0], 'finding_id': 'F002'}
        report['findings'].append(duplicate)
        placed, missing = annotate(first, second, report)
        self.assertEqual((len(placed), len(missing)), (2, 0))
        comments = self.xml(second, 'word/comments.xml')
        self.assertEqual(len(comments), 3)
        self.assertEqual(len({c.get(Q('id')) for c in comments}), 3)
        self.assertEqual(document_signature(self.xml(first)), document_signature(self.xml(second)))
        self.assertIn('100万元', Document(second).paragraphs[0].text)

    def test_table_cell_anchor_and_multiple_original_positions(self):
        report = self.report()
        report['findings'][0]['target_refs'].append(self.report('90万元', 'docx:t001:r001:c001:p0001')['findings'][0]['target_refs'][0])
        placed, missing = annotate(self.source, self.root / 'table.docx', report)
        self.assertEqual((len(placed), len(missing)), (2, 0))

    def test_moved_deleted_or_ambiguous_quote_stays_in_report(self):
        for quote, locator in [('不存在', 'docx:p0001'), ('100万元', 'docx:p0099')]:
            report = self.report(quote, locator)
            placed, missing = annotate(self.source, self.root / 'missing.docx', report)
            self.assertEqual(len(placed), 0)
            self.assertEqual(len(missing), 1)
            path = self.root / 'report.docx'
            write_report(path, report, missing)
            self.assertIn('F001', '\n'.join(p.text for p in Document(path).paragraphs))

    def test_existing_revisions_are_preserved_and_complex_boundary_is_not_guessed(self):
        doc = Document()
        p = doc.add_paragraph()
        ins = etree.SubElement(p._p, Q('ins'))
        ins.set(Q('id'), '17'); ins.set(Q('author'), 'Original')
        etree.SubElement(etree.SubElement(ins, Q('r')), Q('t')).text = '100万元'
        doc.save(self.source)
        out = self.root / 'revision.docx'
        placed, missing = annotate(self.source, out, self.report('100万元'))
        self.assertEqual((len(placed), len(missing)), (1, 0))
        self.assertEqual(self.xml(out).find('.//' + Q('ins')).get(Q('author')), 'Original')
        placed, missing = annotate(self.source, out, self.report('100'))
        self.assertEqual((len(placed), len(missing)), (0, 1))
        self.assertEqual(missing[0]['reason'], 'complex_run_boundary')

    def test_report_uses_readable_scope_conclusion_and_location_labels(self):
        path = self.root / 'readable-report.docx'
        write_report(path, self.report(), [])
        text = '\n'.join(p.text for p in Document(path).paragraphs)
        for expected in ['复核范围：完整复核', '执行编号：synthetic-run', '财务核对 1 项', '结论：存在差错', '本轮核对', '材料 source', '第 1 段']:
            self.assertIn(expected, text)
        for internal in ['source_material', 'stable_ref', '"scope"', 'rechecked', '结论：error', 'docx:p0001', '未覆盖与定位限制']:
            self.assertNotIn(internal, text)

    def test_unanchored_report_preserves_readable_reasons_and_locations(self):
        path = self.root / 'unanchored-report.docx'
        write_report(path, self.report(), [
            {'finding_id': 'F001', 'locator': {'stable_ref': 'docx:p0099'}, 'reason': 'source_anchor_missing'},
            {'finding_id': 'F002', 'locator': {'stable_ref': 'docx:t001:r002:c003:p0001'}, 'reason': 'complex_run_boundary'},
            {'reason': 'PDF 输入保留原页定位，不生成原 Word 批注。'},
        ])
        text = '\n'.join(p.text for p in Document(path).paragraphs)
        for expected in ['未覆盖与定位限制', '问题 F001 · 第 99 段', '当前源稿中未找到指定位置',
                         '表格 1 / 第 2 行 / 第 3 列 / 第 1 段', '跨越既有修订或复杂格式', 'PDF 输入保留原页定位']:
            self.assertIn(expected, text)
        for internal in ['"reason"', '"locator"', 'source_anchor_missing', 'complex_run_boundary']:
            self.assertNotIn(internal, text)


if __name__ == '__main__':
    unittest.main()
