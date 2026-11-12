"""Real LibreOffice pagination, synthetic documents; no business acceptance."""
import os
import tempfile
import unittest
from pathlib import Path

from docx import Document

from bondbuddy_file_authoring.check import package
from bondbuddy_file_authoring.document_size import compare_size


@unittest.skipUnless(os.environ.get('BB_REQUIRE_DOCUMENT_RENDER') == '1'
                     or os.environ.get('BONDBUDDY_RUN_DOCUMENT_SIZE_RENDER') == '1',
                     'requires explicitly enabled real LibreOffice rendering')
class DocumentSizeRenderTests(unittest.TestCase):
    def test_310_to_104_pages_rejected_even_without_character_loss(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, clean = Document(), Document()
            for index in range(310):
                text = 'Synthetic prospectus disclosure about the issuer and its bond. ' * 3
                source.add_paragraph(text).paragraph_format.page_break_before = index != 0
                clean.add_paragraph(text).paragraph_format.page_break_before = index != 0 and index % 3 == 0
            source.save(root / 'source.docx')
            clean.save(root / 'clean.docx')
            result = compare_size(package(root / 'source.docx'), package(root / 'clean.docx'))
            self.assertEqual(result['character_ratio'], 1)
            self.assertEqual(result['page_check']['baseline']['pages'], 310, result)
            self.assertEqual(result['page_check']['clean']['pages'], 104, result)
            self.assertEqual(result['status'], 'failed', result)
            self.assertEqual(result['issues'][0]['metric'], 'rendered_pages')

    def test_long_manuscript_reworded_without_page_collapse_passes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, clean = Document(), Document()
            for index in range(60):
                source.add_paragraph('Source issuer exchange bond disclosure. ' * 20).paragraph_format.page_break_before = index != 0
                clean.add_paragraph('Target issuer interbank note disclosure. ' * 20).paragraph_format.page_break_before = index != 0
            source.save(root / 'source.docx')
            clean.save(root / 'clean.docx')
            result = compare_size(package(root / 'source.docx'), package(root / 'clean.docx'))
            self.assertEqual(result['status'], 'passed', result)
            self.assertEqual(result['page_check']['baseline']['pages'], 60)
            self.assertEqual(result['page_check']['clean']['pages'], 60)


if __name__ == '__main__':
    unittest.main()
