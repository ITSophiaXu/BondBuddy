import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as ET
from docx import Document
from bondbuddy_file_authoring.effective_source import effective_source

NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
Q = lambda name: '{' + NS + '}' + name


class M4EffectiveSourceTest(unittest.TestCase):
    def test_accepted_source_keeps_inserted_fact_excludes_deleted_fact_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'source.docx', Path(directory) / 'effective.docx'
            doc = Document()
            doc.add_paragraph('资产120万元，负债60万元。')
            doc.add_table(rows=1, cols=2)
            doc.save(source)
            with ZipFile(source) as archive:
                parts = {i.filename: archive.read(i) for i in archive.infolist()}
            root = ET.fromstring(parts['word/document.xml'])
            paragraph = next(root.iter(Q('p')))
            for child in list(paragraph):
                if child.tag == Q('r'):
                    paragraph.remove(child)
            for kind, value in [('del', '旧负债999万元。'), ('ins', '资产120万元，负债60万元。')]:
                revision = ET.SubElement(paragraph, Q(kind))
                revision.set(Q('id'), '1' if kind == 'del' else '2')
                run = ET.SubElement(revision, Q('r'))
                text = ET.SubElement(run, Q('delText' if kind == 'del' else 't'))
                text.text = value
            parts['word/document.xml'] = ET.tostring(root)
            with ZipFile(source, 'w', ZIP_DEFLATED) as archive:
                for name, value in parts.items():
                    archive.writestr(name, value)
            before = source.read_bytes()
            effective_source(source, output)
            result = Document(output)
            self.assertEqual(result.paragraphs[0].text, '资产120万元，负债60万元。')
            self.assertEqual(len(result.tables), 1)
            self.assertEqual(source.read_bytes(), before)
            with ZipFile(output) as archive:
                effective_xml = archive.read('word/document.xml')
                self.assertNotIn('旧负债'.encode(), effective_xml)

    def test_cannot_overwrite_original(self):
        with self.assertRaisesRegex(ValueError, 'SOURCE_OUTPUT_SAME_PATH'):
            effective_source(Path('original.docx'), Path('original.docx'))
