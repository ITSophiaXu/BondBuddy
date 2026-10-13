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
from bondbuddy_file_authoring.annotate_review import build, plain, findings_from_markdown
from bondbuddy_word_delivery.review import annotate, REVIEW_COMMENT_AUTHOR, SOURCE_COMMENT_AUTHOR, COMMENT_ORIGIN_NOTE
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
                self.assertNotIn('原文位置', body)
                self.assertNotIn('原文披露', body)
        markdown = (self.root / 'report.md').read_text(encoding='utf-8')
        self.assertIn('R001 · 金额不符', markdown)
        self.assertIn('R002 · 口径需核对', markdown)
        self.assertIn('3 处原文批注', markdown)
        self.assertIn('上传版本 V7', markdown)
        self.assertIn('**原文位置：** 第一段', markdown)
        self.assertIn('**原文披露：** 90万元', markdown)
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

    def test_file_delivery_explains_original_and_current_comment_authors(self):
        doc = Document(self.source)
        original = '数据来源：《合成报表.xlsx》，期末余额1,000,000元，换算为100万元。'
        doc.add_comment(doc.paragraphs[0].runs, text=original, author='募集书 Cowork')
        doc.save(self.source)
        before = self.source.read_bytes()
        receipt = self.run_writer(self.issue())
        self.assertEqual(len(receipt['placed']), 1)
        with ZipFile(self.root / 'comments.docx') as z:
            comments = parse_xml(z.read('word/comments.xml'))
            self.assertEqual([c.get(Q('author')) for c in comments], [SOURCE_COMMENT_AUTHOR, REVIEW_COMMENT_AUTHOR])
            self.assertEqual(''.join(comments[0].itertext()), original)
            self.assertIn('R001', ''.join(comments[1].itertext()))
        self.assertEqual(self.source.read_bytes(), before)
        self.assertIn(COMMENT_ORIGIN_NOTE, (self.root / 'report.md').read_text(encoding='utf-8'))
        self.assertIn(COMMENT_ORIGIN_NOTE, '\n'.join(p.text for p in Document(self.root / 'report.docx').paragraphs))

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
        self.assertEqual(notes[1]['/T'], REVIEW_COMMENT_AUTHOR)
        self.assertIn('R001', notes[1]['/Contents'])
        self.assertIn('合成报表金额120万元', notes[1]['/Contents'])
        self.assertNotIn('原文位置', notes[1]['/Contents'])
        self.assertNotIn('原文披露', notes[1]['/Contents'])
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

    def test_location_fields_do_not_leak_but_evidence_and_multiline_advice_survive(self):
        text = '''### 1. 合成发行文件待核
**问题说明：** 原文件：合成募集书.docx；正文位置285；历史文件不能直接用于本次发行。
**原文位置**：合成募集书.docx；正文位置285
正文位置285的附表
**原文披露**：100万元
**核对依据：** 合成函〔2025〕324号第三条；2025年度报表附注第8页，金额120万元。
https://example.test/synthetic-evidence
**差异及影响：** `5 * 3 = 15`，单位为万元。
**修改建议：** 请补充本次发行决议。
核实文件有效期后再修改。
**待确认事项：** 缺少最新有效期证明。
'''
        _, findings = findings_from_markdown(text)
        self.assertEqual(findings[0]['targets'], [{'quote': '100万元', 'location': '合成募集书.docx；正文位置285'}])
        receipt = self.run_writer(text)
        self.assertEqual((len(receipt['placed']), len(receipt['unanchored'])), (1, 0))
        with ZipFile(self.root / 'comments.docx') as z:
            content = ''.join(parse_xml(z.read('word/comments.xml'))[0].itertext())
        for redundant in ['原文件', '正文位置', '原文位置', '原文披露', '合成募集书.docx']:
            self.assertNotIn(redundant, content)
        for substantive in ['历史文件不能直接用于本次发行', '合成函〔2025〕324号第三条',
                            '报表附注第8页', '120万元', '5 * 3 = 15', '请补充本次发行决议',
                            '核实文件有效期后再修改', '缺少最新有效期证明', 'https://example.test/synthetic-evidence']:
            self.assertIn(substantive, content)
        self.assertIn('正文位置285', (self.root / 'report.md').read_text(encoding='utf-8'))

    def test_legacy_inline_source_prefix_keeps_the_issue(self):
        _, findings = findings_from_markdown('### 文件待核\n原文件：合成.docx；正文位置285；请核实文件有效期。\n**原文披露：** 100万元\n')
        self.assertEqual(findings[0]['comment_text'], 'R001 · 文件待核\n请核实文件有效期。')

    def test_xlsx_locators_are_omitted_from_docx_and_pdf_comments_but_retained_in_report(self):
        prefix = '原文件：合成报表.xlsx；工作表《01合并资产负债表》D128、D78；'
        for source, quote in [(self.source, '100万元'), (self.pdf(), '100 million')]:
            text = self.issue(quote).replace('合计需核对', prefix + '合计应为120万元，原文少计20万元。')
            text += '**差异及影响：** 120 - 100 = 20，单位为万元。\n'
            self.run_writer(text, source)
            if source.suffix == '.docx':
                with ZipFile(self.root / 'comments.docx') as z:
                    content = ''.join(parse_xml(z.read('word/comments.xml'))[0].itertext())
            else:
                content = PdfReader(self.root / 'comments.pdf').pages[0]['/Annots'][-1].get_object()['/Contents']
            for redundant in ['原文件', '工作表', 'D128', '合成报表.xlsx']:
                self.assertNotIn(redundant, content)
            self.assertIn('合计应为120万元，原文少计20万元。', content)
            self.assertIn('120 - 100 = 20', content)
            self.assertIn(prefix, (self.root / 'report.md').read_text(encoding='utf-8'))

    def test_pdf_page_hint_still_disambiguates_repeated_quotes(self):
        source = self.pdf()
        writer = PdfWriter()
        writer.append(source)
        writer.append(source)
        writer.write(source)
        text = self.issue('100 million').replace('第一段', '物理第 2 页')
        receipt = self.run_writer(text, source)
        self.assertEqual([(item['finding_id'], item['page']) for item in receipt['placed']], [('R001', 2)])
        notes = [item.get_object() for item in PdfReader(self.root / 'comments.pdf').pages[1]['/Annots']]
        self.assertNotIn('物理第', notes[-1]['/Contents'])


if __name__ == '__main__':
    unittest.main()
