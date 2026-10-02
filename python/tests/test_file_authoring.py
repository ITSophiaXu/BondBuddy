import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from docx import Document
from bondbuddy_file_authoring.check import check, clean, package, parse_xml
from bondbuddy_file_authoring.word_patch import Patcher, q, paragraph_text, serialized

class FileAuthoringTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/'output').mkdir();(self.root/'materials').mkdir()
        doc=Document();doc.add_paragraph('原企业2024年净资产100万元。');doc.add_paragraph('固定历史条款保留。')
        table=doc.add_table(rows=1,cols=2);table.cell(0,0).text='年度';table.cell(0,1).text='2024'
        doc.sections[0].header.paragraphs[0].text='原企业历史稿'
        doc.save(self.root/'materials/source.docx')
        self.data={'input_hash':'a'*64,'revision_author':'BondBuddy-aaaaaaaaaaaa','baseline_path':'materials/source.docx','baseline_kind':'uploaded_source',
            'output':{'tracked':'output/tracked.docx','clean':'output/clean.docx','baseline':'output/baseline.docx','delivery':'output/delivery.md'}}
        self.input=self.root/'input.json';self.input.write_text(json.dumps(self.data),encoding='utf-8')
        (self.root/'output/baseline.docx').write_bytes((self.root/'materials/source.docx').read_bytes())
        (self.root/'output/delivery.md').write_text('实际更新净资产。未进行页面视觉检查。',encoding='utf-8')
        self.make_tracked()
    def tearDown(self):self.temp.cleanup()
    def make_tracked(self,untracked=False):
        parts=package(self.root/'materials/source.docx');root=parse_xml(parts['word/document.xml']);p=root.find(q('body')).find(q('p'))
        if untracked:p.find('.//'+q('t')).text='未标记改动'
        else:Patcher(root,True,self.data['revision_author']).patch(p,paragraph_text(p),'目标企业2025年净资产120万元。')
        parts['word/document.xml']=serialized(root)
        with ZipFile(self.root/'output/tracked.docx','w',ZIP_DEFLATED) as z:
            for name,raw in parts.items():z.writestr(name,raw)
        clean(self.root/'output/tracked.docx',self.root/'output/clean.docx')
    def test_real_revisions_and_clean_pair(self):
        result=check(self.input);self.assertGreater(result['replacements'],0);self.assertEqual(result['baseline_kind'],'uploaded_source')
    def test_untracked_changes_rejected(self):
        self.make_tracked(True)
        with self.assertRaisesRegex(ValueError,'WORD_NO_REVISIONS'):check(self.input)
    def test_tampered_clean_rejected(self):
        (self.root/'output/clean.docx').write_bytes((self.root/'materials/source.docx').read_bytes())
        with self.assertRaisesRegex(ValueError,'WORD_ACCEPT_MISMATCH'):check(self.input)
    def test_reject_must_restore_baseline(self):
        parts=package(self.root/'output/tracked.docx');root=parse_xml(parts['word/document.xml']);root.find(q('body')).findall(q('p'))[1].find('.//'+q('t')).text='不带修订的损坏'
        parts['word/document.xml']=serialized(root)
        with ZipFile(self.root/'output/tracked.docx','w',ZIP_DEFLATED) as z:
            for name,raw in parts.items():z.writestr(name,raw)
        clean(self.root/'output/tracked.docx',self.root/'output/clean.docx')
        with self.assertRaisesRegex(ValueError,'WORD_REJECT_MISMATCH'):check(self.input)
    def test_original_baseline_cannot_be_replaced(self):
        (self.root/'output/baseline.docx').write_bytes((self.root/'output/clean.docx').read_bytes())
        with self.assertRaisesRegex(ValueError,'WORD_BASELINE_CHANGED'):check(self.input)
    def test_first_draft_has_no_fake_history(self):
        self.data.update(baseline_kind='none',baseline_path=None);self.input.write_text(json.dumps(self.data),encoding='utf-8')
        raw=(self.root/'output/clean.docx').read_bytes()
        for name in ['tracked','baseline']:(self.root/f'output/{name}.docx').write_bytes(raw)
        self.assertEqual(check(self.input)['replacements'],0)
    def test_revision_cannot_be_presented_as_first_draft(self):
        self.data.update(baseline_kind='none',baseline_path=None);self.input.write_text(json.dumps(self.data),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'WORD_FALSE_BASELINE'):check(self.input)

if __name__=='__main__':unittest.main()
