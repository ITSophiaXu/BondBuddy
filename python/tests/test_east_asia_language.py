import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

from bondbuddy_file_authoring.report_from_text import export_report
from bondbuddy_word_delivery.unified import document


def normal_rpr_language(doc):
    props = doc.styles['Normal'].element.rPr
    language = props.find(qn('w:lang')) if props is not None else None
    return language.get(qn('w:eastAsia')) if language is not None else None


class EastAsiaLanguageTests(unittest.TestCase):
    def test_unified_writer_binds_both_east_asian_font_and_language(self):
        doc = document('2026-11-18T00:00:00Z')
        props = doc.styles['Normal'].element.rPr
        self.assertEqual(props.rFonts.get(qn('w:eastAsia')), '宋体')
        self.assertEqual(normal_rpr_language(doc), 'zh-CN')

    def test_report_writer_binds_both_east_asian_font_and_language(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'report.txt'
            target = Path(directory) / 'report.docx'
            source.write_text('发行人编制说明\n合成测试段落。\n', encoding='utf-8')
            export_report(source, target)
            doc = Document(target)
            props = doc.styles['Normal'].element.rPr
            self.assertEqual(props.rFonts.get(qn('w:eastAsia')), 'Microsoft YaHei')
            self.assertEqual(normal_rpr_language(doc), 'zh-CN')


if __name__ == '__main__':
    unittest.main()
