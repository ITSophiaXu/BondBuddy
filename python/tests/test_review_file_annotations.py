import hashlib
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from lxml import etree
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Text
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from bondbuddy_file_authoring.annotate_review import build, plain
from bondbuddy_word_delivery.review import annotate
from bondbuddy_word_delivery.writer import Q, parse_xml, document_signature


class FileAnnotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document()
        p = doc.add_paragraph('合计金额100万元。')
        p.runs[0].bold = True
        doc.add_table(rows=1, cols=1).cell(0, 0).text = '期末余额90万元'
        doc.sections[0].header.paragraphs[0].text = '合成页眉'
        doc.sections[0].footer.paragraphs[0].text = '合成页脚'
        doc.save(self.source)

    def run_writer(self, text, source=None):
        source = source or self.source
        return build(source, text, self.root, {'material_id': 'synthetic', 'material_version': 7,
                     'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}, '2026-10-09T00:00:00Z', '合成原稿' + source.suffix)

    def issue(self, quote='100万元', title='金额不符'):
        return f'### 1. {title}\n**问题说明：** 合计需核对\n**原文位置：** 第一段\n**原文披露：** {quote}\n**核对依据：** 合成报表金额120万元\n**修改建议：** 核实并修改差额\n'

    def test_table_multi_location_and_two_findings_share_canonical_comment_text(self):
        text = '# 报告\n## 财务核对\n' + self.issue() + '**原文位置：** 表格\n**原文披露：** 90万元\n' + self.issue(title='口径需核对')
        receipt = self.run_writer(text)
        self.assertEqual((len(receipt['placed']), len(receipt['unanchored'])), (3, 0))
        with ZipFile(self.source) as src, ZipFile(self.root / 'comments.docx') as out:
            self.assertEqual(document_signature(parse_xml(src.read('word/document.xml'))), document_signature(parse_xml(out.read('word/document.xml'))))
            for name in src.namelist():
                if name not in ['word/document.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels']:
                    self.assertEqual(src.read(name), out.read(name), name)
            comments = parse_xml(out.read('word/comments.xml'))
            self.assertEqual(len(comments), 3)
            for comment in comments:
                body = ''.join(comment.itertext())
                self.assertIn('核实并修改差额', body)
                self.assertIn('合成报表金额120万元', body)
        markdown = (self.root / 'report.md').read_text(encoding='utf-8')
        self.assertIn('R001 · 金额不符', markdown)
        self.assertIn('R002 · 口径需核对', markdown)
        self.assertIn('3 处原文批注', markdown)
        self.assertIn('上传版本 V7', markdown)
        self.assertIn('R002', '\n'.join(p.text for p in Document(self.root / 'report.docx').paragraphs))

    def test_existing_comments_revisions_and_missing_quotes_are_preserved(self):
        doc = Document(self.source)
        ins = etree.SubElement(doc.paragraphs[0]._p, Q('ins'))
        ins.set(Q('id'), '19'); ins.set(Q('author'), '原作者')
        etree.SubElement(etree.SubElement(ins, Q('r')), Q('t')).text = '既有修订'
        doc.save(self.source)
        self.run_writer(self.issue())
        self.source.write_bytes((self.root / 'comments.docx').read_bytes())
        receipt = self.run_writer(self.issue() + self.issue('不存在的金额', '缺失定位'))
        self.assertEqual((len(receipt['placed']), len(receipt['unanchored'])), (1, 1))
        with ZipFile(self.root / 'comments.docx') as z:
            self.assertEqual(len(parse_xml(z.read('word/comments.xml'))), 2)
            self.assertEqual(parse_xml(z.read('word/document.xml')).find('.//' + Q('ins')).get(Q('author')), '原作者')
        report = (self.root / 'report.md').read_text(encoding='utf-8')
        self.assertIn('R002 · 第一段 · 不存在的金额', report)
        self.assertIn('未自动添加批注', report)

    def test_ambiguous_quote_and_missing_disclosure_are_not_guessed(self):
        doc = Document(self.source); doc.add_paragraph('100万元'); doc.save(self.source)
        receipt = self.run_writer(self.issue() + '### 缺失事项\n需要补充新的风险披露\n')
        self.assertEqual((len(receipt['placed']), len(receipt['unanchored'])), (0, 2))
        self.assertIn('R002', (self.root / 'report.md').read_text(encoding='utf-8'))

    def test_unstructured_report_explicitly_does_not_claim_zero_findings(self):
        receipt = self.run_writer('原文金额需核对，但这份旧报告没有问题标题。')
        self.assertEqual(receipt['findings'], 0)
        self.assertIn('不能据此认定没有问题', (self.root / 'report.md').read_text(encoding='utf-8'))

    def pdf(self):
        writer = PdfWriter(); page = writer.add_blank_page(width=612, height=792)
        stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 50 700 Td (Amount 100 million) Tj ET')
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        page[NameObject('/Contents')] = writer._add_object(stream)
        writer.add_annotation(0, Text(rect=(20,20,40,40), text='Original note'))
        source = self.root / 'source.pdf'; writer.write(source)
        return source

    def test_pdf_highlight_has_exact_coordinates_content_and_original_annotation(self):
        source = self.pdf()
        receipt = self.run_writer(self.issue('100 million'), source)
        self.assertEqual((len(receipt['placed']), len(receipt['unanchored'])), (1, 0))
        before, after = PdfReader(source), PdfReader(self.root / 'comments.pdf')
        self.assertEqual(before.pages[0].get_contents().get_data(), after.pages[0].get_contents().get_data())
        notes = [a.get_object() for a in after.pages[0]['/Annots']]
        self.assertEqual(len(notes), 2)
        self.assertEqual(notes[0]['/Contents'], 'Original note')
        self.assertEqual(notes[1]['/Subtype'], '/Highlight')
        self.assertIn('R001', notes[1]['/Contents'])
        self.assertIn('合成报表金额120万元', notes[1]['/Contents'])
        rect = notes[1]['/Rect']
        self.assertGreater(float(rect[0]), 50)
        self.assertLess(float(rect[1]), 700)
        self.assertGreater(float(rect[3]), 700)

    def test_pdf_missing_scan_text_and_rotated_page_report_limitations(self):
        source = self.pdf()
        receipt = self.run_writer(self.issue('不存在'), source)
        self.assertEqual(len(receipt['unanchored']), 1)
        writer = PdfWriter(clone_from=source); writer.pages[0].rotate(90); writer.write(source)
        receipt = self.run_writer(self.issue('100 million'), source)
        self.assertEqual(len(receipt['placed']), 0)
        self.assertEqual(len(receipt['unanchored']), 1)

    def test_source_hash_mismatch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'INPUT_REVISION_CONFLICT'):
            build(self.source, self.issue(), self.root, {'sha256': '0'*64}, '2026-10-09', 'synthetic.docx')

    def test_comment_preserves_calculation_operators(self):
        self.assertEqual(plain('**核对依据：** `5 * 3 = 15`'), '核对依据： 5 * 3 = 15')


if __name__ == '__main__':
    unittest.main()
