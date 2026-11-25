import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from docx import Document
from pypdf import PdfReader, PdfWriter

from bondbuddy_template_preview import render


class TemplatePreviewTests(unittest.TestCase):
    def test_host_renders_redacted_copy_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, destination = root / 'source.docx', root / 'preview.pdf'
            document = Document()
            document.add_paragraph('旧项目秘密发行人名称')
            document.add_paragraph('主承销商核查意见')
            document.save(source)
            original = source.read_bytes()

            def fake_renderer(args, **_):
                redacted = Path(args[-1])
                self.assertNotIn('旧项目秘密发行人名称', '\n'.join(p.text for p in Document(redacted).paragraphs))
                writer = PdfWriter()
                writer.add_blank_page(width=595, height=842)
                with (redacted.parent / 'template.pdf').open('wb') as stream:
                    writer.write(stream)

            with patch('bondbuddy_template_preview.shutil.which', return_value='fake-libreoffice'), \
                 patch('bondbuddy_template_preview.subprocess.run', side_effect=fake_renderer):
                render(source, destination)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(len(PdfReader(destination).pages), 1)

    def test_missing_renderer_has_stable_failure_and_no_output(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source, destination = root / 'source.docx', root / 'preview.pdf'
            document = Document()
            document.add_paragraph('模板')
            document.save(source)
            with patch.dict('os.environ', {'BB_TEMPLATE_LIBREOFFICE': ''}), \
                 patch('bondbuddy_template_preview.shutil.which', return_value=None):
                with self.assertRaisesRegex(RuntimeError, 'TEMPLATE_RENDERER_UNAVAILABLE'):
                    render(source, destination)
            self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
