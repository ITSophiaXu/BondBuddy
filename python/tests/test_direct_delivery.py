import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile, ZIP_DEFLATED

from docx import Document
from bondbuddy_file_authoring.check import package, parse_xml, stories
from bondbuddy_file_authoring.direct_delivery import deliver
from bondbuddy_file_authoring.word_patch import Patcher, paragraph_text, q, serialized


class DirectDeliveryTests(unittest.TestCase):
    author = 'BondBuddy-test-author'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.baseline = self.root / 'baseline.docx'
        self.tracked = self.root / 'tracked.docx'
        self.clean = self.root / 'clean.docx'
        doc = Document()
        doc.add_paragraph('任丘市建设投资集团有限公司2024年净资产100万元。')
        doc.add_paragraph('保留的发行条款。')
        doc.save(self.baseline)
        self.parts = package(self.baseline)

    def save_tracked(self):
        with ZipFile(self.tracked, 'w', ZIP_DEFLATED) as archive:
            for name, raw in self.parts.items():
                archive.writestr(name, raw)

    def revise(self):
        root = parse_xml(self.parts['word/document.xml'])
        paragraph = root.find(q('body')).find(q('p'))
        Patcher(root, True, self.author).patch(paragraph, paragraph_text(paragraph),
                                              '任丘市建设投资集团有限公司2025年净资产120万元。')
        self.parts['word/document.xml'] = serialized(root)
        self.save_tracked()

    def checked(self, result_pages):
        with patch('bondbuddy_file_authoring.direct_delivery.shutil.which', return_value='libreoffice'), \
             patch('bondbuddy_file_authoring.direct_delivery.subprocess.run') as command, \
             patch('bondbuddy_file_authoring.direct_delivery.render_pages',
                   side_effect=lambda source, _area, _executable: 10 if source == self.baseline else result_pages):
            command.return_value.stdout = 'LibreOffice 7.4.7.2\n'
            return deliver(self.tracked, self.baseline, self.clean, self.author, 0.7)

    def test_accepts_revision_and_generates_clean_copy(self):
        self.revise()
        report = self.checked(8)
        self.assertEqual(report['status'], 'passed')
        self.assertEqual(report['baseline_pages'], 10)
        self.assertEqual(report['result_pages'], 8)
        self.assertEqual(stories(package(self.tracked), True), stories(package(self.clean)))

    def test_page_loss_returns_mismatch_without_changing_content(self):
        self.revise()
        self.assertEqual(self.checked(6)['status'], 'mismatch')
        self.assertTrue(self.clean.exists())

    def test_untracked_change_cannot_be_delivered(self):
        root = parse_xml(self.parts['word/document.xml'])
        root.find(q('body')).find(q('p')).find('.//' + q('t')).text = '未标修订的修改'
        self.parts['word/document.xml'] = serialized(root)
        self.save_tracked()
        with self.assertRaisesRegex(ValueError, 'WORD_NO_REVISIONS'):
            self.checked(10)


if __name__ == '__main__':
    unittest.main()
