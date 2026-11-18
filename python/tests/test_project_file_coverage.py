import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document

from bondbuddy_file_authoring import project_files
from bondbuddy_file_authoring.word_patch import xml


class ProjectFileCoverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'source.docx'
        document = Document()
        document.add_paragraph('合成发行人')
        document.save(self.path)
        with ZipFile(self.path) as archive:
            self.parts = {name: archive.read(name) for name in archive.namelist()}
        self.root = xml(self.parts['word/document.xml'])

    def tearDown(self):
        self.tmp.cleanup()

    def snapshot(self, warnings):
        return project_files.inspect(self.path, complete=True, packaged=(self.parts, self.root, warnings))

    def test_pdf_conversion_layout_notice_does_not_reduce_text_coverage(self):
        notice = '原稿为 PDF，已按可提取文字转换为 Word；版式、表格与分页可能不同，请对照原 PDF 核对。'
        result = self.snapshot([notice])
        self.assertEqual(result['coverage'], 'complete')
        self.assertEqual(result['warnings'], [notice])

    def test_existing_revision_normalization_is_advisory(self):
        result = self.snapshot(['原稿既有文字修订按接受后的有效文本作为本次基线，上传原件保持不变。'])
        self.assertEqual(result['coverage'], 'complete')

    def test_blank_pdf_page_still_blocks_complete_coverage(self):
        result = self.snapshot(['【待补充：原 PDF 第 1 页无法提取文字，请提供可检索 PDF 或 Word，并人工核对本页内容。】'])
        self.assertEqual(result['coverage'], 'partial')

    def test_unread_images_and_embedded_content_still_block_coverage(self):
        for warning in (
            '含 5 个图片对象，须阅读其中信息；文字提取不能证明图片已完整覆盖。',
            '含嵌入内容，需要另行读取，尚不能确认全文覆盖。',
            '文件没有可提取的文字，需补充可检索 PDF 或 Word 后重新检查。',
            '未知的新提取警告必须按不完整处理。',
        ):
            with self.subTest(warning=warning):
                self.assertEqual(self.snapshot([warning])['coverage'], 'partial')


if __name__ == '__main__':
    unittest.main()
