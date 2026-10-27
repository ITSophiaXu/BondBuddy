"""Validate shipped format-only templates; no customer originals are test fixtures."""
import hashlib
import json
import re
import unittest
from pathlib import Path
from zipfile import ZipFile
from posixpath import normpath, join
from lxml import etree as E

ROOT=Path(__file__).resolve().parents[2]/'knowledge/workpaper-templates/2026-10-27'
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

class TemplateTests(unittest.TestCase):
    def test_all_shipped_templates_are_neutral_valid_packages(self):
        catalogue=json.loads((ROOT/'catalog.json').read_text(encoding='utf8'))
        self.assertEqual(len(catalogue),147)
        self.assertEqual(len({t['family'] for t in catalogue}),7)
        for item in catalogue:
            path=ROOT/item['filename']
            with self.subTest(template=item['id']):
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),item['sha256'])
                with ZipFile(path) as z:
                    self.assertIsNone(z.testzip())
                    self.assertFalse(any(n.startswith(('docProps/','word/media/','word/embeddings/')) for n in z.namelist()))
                    for name in z.namelist():
                        root=E.fromstring(z.read(name))
                        for text in root.iter(W+'t'):
                            self.assertRegex(text.text or '',r'^(?:\[\[内容\d+\]\]|1)?$')
                        for node in root.iter():
                            local=E.QName(node).localname
                            self.assertNotIn(local,('drawing','pict','object','docVars','mailMerge','attachedTemplate','dataBinding'))
                            if local=='Relationship':
                                self.assertNotEqual(node.get('TargetMode'),'External')
                                base='' if name=='_rels/.rels' else 'word'
                                self.assertIn(normpath(join(base,node.get('Target',''))).lstrip('/'),z.namelist())
                            if local=='instrText':self.assertIn((node.text or '').strip(),('','PAGE'))
                            if local=='fldSimple':self.assertIn(node.get(W+'instr','').strip(),('','PAGE'))
                            for value in node.attrib.values():
                                self.assertNotRegex(value,r'中捷|农场|渤海|https?://(?!(?:schemas\.|www\.w3\.org|purl\.org|www\.microsoft\.com))')

if __name__=='__main__':unittest.main()
