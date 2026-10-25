import hashlib
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from bondbuddy_file_authoring.review_corrections import build
from bondbuddy_file_authoring.word_patch import xml, q, paragraph_text

def issue(title, original, new, missing='无', mode='直接修改'):
    return f'### {title}\n- 复核类别：财务数据一致性\n- 问题说明：需核对金额\n- 原文披露：{original}\n- 核对依据：合成财务报表，2026年，资产行\n- 处理方式：{mode}\n- 替换文本：{new}\n- 缺少材料：{missing}\n'

class ReviewCorrectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name);self.source=self.path/'original.docx'
        d=Document();d.add_paragraph('总资产为12亿元。');d.add_paragraph('收入为5亿元。');d.add_paragraph('相同内容');d.add_paragraph('相同内容');d.save(self.source)
    def request(self,markdown):
        return dict(pin={'sha256':hashlib.sha256(self.source.read_bytes()).hexdigest()},filename='合成.docx',markdown=markdown)
    def text(self,name):
        with ZipFile(self.path/name) as z:return '\n'.join(paragraph_text(p) for p in xml(z.read('word/document.xml')).iter(q('p')))
    def test_edits_comments_clean_and_source_preserved(self):
        before=self.source.read_bytes();r=self.request(issue('资产','总资产为12亿元。','总资产为13.6亿元。')+issue('收入','收入为5亿元。','收入为6亿元。','最新收入附注','仅批注'))
        s=build(self.source,r,self.path)
        self.assertTrue(s['issues'][0]['applied']);self.assertFalse(s['issues'][1]['applied'])
        self.assertIn('总资产为13.6亿元。',self.text('clean.docx'));self.assertIn('收入为5亿元。',self.text('clean.docx'));self.assertIn('最新收入附注',self.text('clean.docx'))
        with ZipFile(self.path/'revision.docx') as z:
            root=xml(z.read('word/document.xml'));self.assertTrue(list(root.iter(q('ins'))));self.assertTrue(list(root.iter(q('del'))));self.assertIn('最新收入附注',z.read('word/comments.xml').decode())
        with ZipFile(self.path/'clean.docx') as z:
            root=xml(z.read('word/document.xml'));self.assertFalse(list(root.iter(q('ins'))));self.assertFalse(list(root.iter(q('commentReference'))));self.assertNotIn('word/comments.xml',z.namelist())
        self.assertEqual(before,self.source.read_bytes())
    def test_manual_export_can_retain_and_edit_without_model(self):
        s=build(self.source,self.request(issue('资产','总资产为12亿元。','总资产为12.6亿元。')),self.path)
        r=self.request('');r.update(editor=s,decisions=[dict(id='R001',decision='original',manual_text='')]);build(self.source,r,self.path);self.assertIn('总资产为12亿元。',self.text('clean.docx'))
        r['decisions'][0].update(decision='manual',manual_text='总资产经人工确认为13亿元。');s2=build(self.source,r,self.path)
        self.assertTrue(s2['issues'][0]['applied']);self.assertIn('经人工确认为13',self.text('clean.docx'))
    def test_ambiguous_and_overlapping_are_not_silently_changed(self):
        s=build(self.source,self.request(issue('重复','相同内容','更新')+issue('资产1','总资产为12亿元。','更新1')+issue('资产2','12亿元','13亿元')),self.path)
        self.assertTrue(all(not i['applied'] and i['limitation'] for i in s['issues']))
        self.assertIn('总资产为12亿元。',self.text('clean.docx'))
    def test_hash_and_decisions_are_pinned(self):
        r=self.request(issue('资产','总资产为12亿元。','总资产为13亿元。'));r['pin']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'INPUT_REVISION_CONFLICT'):build(self.source,r,self.path)
    def test_minimal_word_without_document_relationships(self):
        from zipfile import ZIP_DEFLATED
        with ZipFile(self.source) as z:parts={n:z.read(n) for n in z.namelist() if n!='word/_rels/document.xml.rels'}
        with ZipFile(self.source,'w',ZIP_DEFLATED) as z:
            for n,data in parts.items():z.writestr(n,data)
        s=build(self.source,self.request(issue('资产','总资产为12亿元。','总资产为13亿元。')),self.path)
        self.assertTrue(s['issues'][0]['applied']);self.assertIn('总资产为13亿元。',self.text('clean.docx'))
    def test_scanned_pdf_conversion_explicit_gap(self):
        from pypdf import PdfWriter
        self.source=self.path/'scan.pdf';w=PdfWriter();w.add_blank_page(612,792);w.write(self.source)
        s=build(self.source,self.request('## 未覆盖\n扫描页无法提取文字'),self.path)
        self.assertEqual(s['source_format'],'pdf');self.assertTrue(any('版式' in w for w in s['warnings']));self.assertIn('无法提取文字',self.text('clean.docx'))
    def test_no_parsable_findings_is_not_a_clean_bill_of_health(self):
        s=build(self.source,self.request('仅完成部分阅读，尚无结构化条目。'),self.path)
        self.assertEqual(s['issues'],[])
        self.assertTrue(any('不能据此认定未发现问题' in w for w in s['warnings']))
        self.assertIn('总资产为12亿元。',self.text('clean.docx'))

if __name__=='__main__':unittest.main()
