import copy
import io
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path
import hashlib
from zipfile import ZipFile

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Inches, RGBColor
from lxml import etree as ET

from backend.documents import parse_document, word_export, targets
from backend.docx_fidelity import xml, NS, q, paragraph_text
from backend.word_preview import word_preview
from backend.engine import working_file


def sample():
    d = Document()
    d.sections[0].left_margin = Inches(1.37)
    d.sections[0].header.paragraphs[0].text = '历史募集书页眉'
    d.sections[0].footer.paragraphs[0].text = '历史页脚'
    title = d.add_heading('财务会计信息', 2)
    title.runs[0].font.name = '黑体'
    title.runs[0].font.size = Pt(18)
    p = d.add_paragraph()
    p.paragraph_format.first_line_indent = Pt(24)
    p.paragraph_format.space_after = Pt(7)
    p.paragraph_format.line_spacing = Pt(22)
    p.paragraph_format.tab_stops.add_tab_stop(Pt(210))
    p.add_run('截至2026年3月末，资产总额')
    r = p.add_run('1,2'); r.bold = True; r.font.name = 'Arial'; r.font.size = Pt(13)
    r.font.color.rgb = RGBColor.from_string('123456')
    r = p.add_run('00.00'); r.italic = True; r.font.size = Pt(12)
    p.add_run('万元。')
    mark = OxmlElement('w:bookmarkStart'); mark.set(qn('w:id'),'7'); mark.set(qn('w:name'),'original_mark')
    p._p.insert(1, mark)
    mark = OxmlElement('w:bookmarkEnd'); mark.set(qn('w:id'),'7'); p._p.append(mark)
    d.add_paragraph('')
    t = d.add_table(rows=3, cols=3)
    t.autofit = False
    t.columns[0].width = Inches(1.5)
    t.cell(0,0).merge(t.cell(0,1)).text = '原表合并表头'
    t.cell(1,0).merge(t.cell(2,0)).text = '资产总额'
    t.cell(1,1).text = '1,200.00'
    t.cell(1,1).paragraphs[0].runs[0].font.size = Pt(9)
    t.cell(1,1).paragraphs[0].runs[0].font.name = '宋体'
    t.cell(1,1).add_paragraph('单位：万元')
    shd = OxmlElement('w:shd'); shd.set(qn('w:fill'),'AABBCC'); t.cell(1,1)._tc.get_or_add_tcPr().append(shd)
    t.cell(1,2).text = '0'
    t.cell(2,1).text = '100'
    b = io.BytesIO(); d.save(b)
    return b.getvalue()


class WordFidelityTests(unittest.TestCase):
    def setUp(self):
        self.raw = sample()
        self.file = {'id':'f','name':'历史募集书.docx',**parse_document(self.raw,'历史募集书.docx','f')}
        self.prose = next(t for t in targets(self.file) if t['text'].startswith('截至'))
        self.cell = next(t for t in targets(self.file) if t['text']=='1,200.00\n单位：万元')

    def change(self, target, after, **extra):
        return {'target_id':target['id'],'before':target['text'],'after':after,'status':'pending','origin':'agent','needs_review':False,**extra}

    def export(self, changes=(), view='final', file=None):
        return word_export(file or self.file,changes,view,original_bytes=self.raw)

    def test_no_changes_is_identical_original_byte_stream(self):
        for view in ['final','revision']:
            self.assertEqual(self.raw,self.export(view=view))

    def test_only_document_part_changes_in_final_export(self):
        out = self.export([self.change(self.prose,self.prose['text'].replace('1,200.00','1,350.00'))])
        with ZipFile(io.BytesIO(self.raw)) as a, ZipFile(io.BytesIO(out)) as b:
            self.assertEqual(a.namelist(),b.namelist())
            self.assertEqual(['word/document.xml'],[n for n in a.namelist() if a.read(n)!=b.read(n)])
            before, after = xml(a.read('word/document.xml')),xml(b.read('word/document.xml'))
            for xpath in ['//w:pPr','//w:sectPr','//w:tblPr','//w:tblGrid','//w:tcPr','//w:bookmarkStart','//w:bookmarkEnd']:
                self.assertEqual([ET.tostring(n) for n in before.xpath(xpath,namespaces=NS)],[ET.tostring(n) for n in after.xpath(xpath,namespaces=NS)])

    def test_new_amount_inherits_original_amount_run_style(self):
        out = self.export([self.change(self.prose,self.prose['text'].replace('1,200.00','1,350.00'))])
        d = Document(io.BytesIO(out))
        r = next(r for p in d.paragraphs for r in p.runs if r.text=='1,3')
        self.assertEqual('Arial',r.font.name)
        self.assertEqual(13,r.font.size.pt)
        self.assertTrue(r.bold)
        self.assertEqual('123456',str(r.font.color.rgb))
        tail = next(r for p in d.paragraphs for r in p.runs if r.text=='50.00')
        self.assertTrue(tail.italic)
        self.assertEqual(12,tail.font.size.pt)
        self.assertEqual(18,d.paragraphs[0].runs[0].font.size.pt)

    def test_cell_paragraphs_merges_shading_and_widths_preserved(self):
        out = self.export([self.change(self.cell,'1,350.00\n单位：万元')])
        a,b = Document(io.BytesIO(self.raw)),Document(io.BytesIO(out))
        ca,cb = a.tables[0].cell(1,1),b.tables[0].cell(1,1)
        self.assertEqual('1,350.00\n单位：万元',cb.text)
        self.assertEqual(2,len(cb.paragraphs))
        self.assertEqual(ET.tostring(ca._tc.tcPr),ET.tostring(cb._tc.tcPr))
        self.assertEqual(ET.tostring(a.tables[0]._tbl.tblGrid),ET.tostring(b.tables[0]._tbl.tblGrid))
        self.assertEqual('宋体',cb.paragraphs[0].runs[0].font.name)

    def test_revision_accept_and_reject_recover_both_texts(self):
        after = self.prose['text'].replace('3月','6月').replace('1,200.00','1,350.00')
        out = self.export([self.change(self.prose,after)],'revision')
        with ZipFile(io.BytesIO(out)) as z:
            root = xml(z.read('word/document.xml'))
            ids = root.xpath('//w:ins/@w:id | //w:del/@w:id',namespaces=NS)
            self.assertEqual(len(ids),len(set(ids)))
            self.assertTrue(all(int(i)>7 for i in ids))
            self.assertTrue(root.xpath('//w:ins/w:r/w:rPr',namespaces=NS))
            for accept, expected in [(True,after),(False,self.prose['text'])]:
                doc = copy.deepcopy(root)
                for n in doc.xpath('//w:ins | //w:del',namespaces=NS):
                    keep = (n.tag==q('ins')) == accept
                    parent,index=n.getparent(),n.getparent().index(n)
                    if keep:
                        for offset,child in enumerate(n):
                            for text in child.iter(q('delText')):
                                text.tag=q('t')
                            parent.insert(index+offset,child)
                    parent.remove(n)
                p=doc.find(q('body'))[self.prose['body_index']]
                self.assertEqual(expected,paragraph_text(p))

    def test_missing_original_never_falls_back_to_rebuilt_docx(self):
        with self.assertRaisesRegex(ValueError,'缺少历史募集书'):
            word_export(self.file,[])

    def test_stale_source_hash_fails(self):
        with self.assertRaisesRegex(ValueError,'原文件已变化'):
            self.export(file={**self.file,'sha256':'wrong'})

    def test_mismatched_original_text_fails(self):
        f=copy.deepcopy(self.file)
        next(b for b in f['blocks'] if b['id']==self.prose['id'])['text']='wrong'
        with self.assertRaisesRegex(ValueError,'文字与修改位置不一致'):
            self.export([self.change(self.prose,'new')],file=f)

    def test_rejected_change_preserves_original_bytes(self):
        self.assertEqual(self.raw,self.export([self.change(self.prose,'new',status='rejected')]))

    def test_verified_supplied_original_reference_can_recover_missing_cache(self):
        from backend.docx_fidelity import source_bytes
        with TemporaryDirectory() as directory:
            path=Path(directory)/'supplied.docx'
            path.write_bytes(self.raw)
            f={**self.file,'stored_path':str(Path(directory)/'missing.docx'),'original_source_path':str(path),'sha256':hashlib.sha256(self.raw).hexdigest()}
            self.assertEqual(self.raw,source_bytes(f))
            f['sha256']='changed'
            with self.assertRaisesRegex(ValueError,'原文件已变化'):
                source_bytes(f)

    def test_verified_original_recovers_altered_cache_without_rewriting_it(self):
        from backend.docx_fidelity import source_bytes
        with TemporaryDirectory() as directory:
            cached, original = Path(directory)/'cached.docx', Path(directory)/'original.docx'
            cached.write_bytes(b'changed cache')
            original.write_bytes(self.raw)
            f={'stored_path':str(cached),'original_source_path':str(original),'sha256':hashlib.sha256(self.raw).hexdigest()}
            self.assertEqual(self.raw,source_bytes(f))
            self.assertEqual(b'changed cache',cached.read_bytes())
            self.assertEqual(self.raw,original.read_bytes())
            with self.assertRaisesRegex(ValueError,'原文件已变化'):
                source_bytes(f, original_bytes=b'explicit wrong document')
            original.write_bytes(b'changed original too')
            with self.assertRaisesRegex(ValueError,'原文件已变化'):
                source_bytes(f)

    def test_original_fallback_requires_checksum_and_does_not_replace_valid_cache(self):
        from backend.docx_fidelity import source_bytes
        with TemporaryDirectory() as directory:
            cached = Path(directory)/'cached.docx'
            cached.write_bytes(self.raw)
            f={'stored_path':str(cached),'original_source_path':str(Path(directory)/'missing.docx'),'sha256':hashlib.sha256(self.raw).hexdigest()}
            self.assertEqual(self.raw,source_bytes(f))
            f['stored_path'],f['original_source_path']=f['original_source_path'],f['stored_path']
            del f['sha256']
            with self.assertRaises(FileNotFoundError):
                source_bytes(f)

    def test_scan_markers_do_not_become_fake_agent_redlines(self):
        out=self.export([self.change(self.prose,'【待核对：'+self.prose['text']+'】',origin='scan')],'revision')
        with ZipFile(io.BytesIO(out)) as z:
            root=xml(z.read('word/document.xml'))
            self.assertFalse(root.xpath('//w:ins | //w:del',namespaces=NS))
            self.assertIn('【待核对',z.read('word/document.xml').decode())

    def test_removing_cell_paragraph_boundary_fails(self):
        with self.assertRaisesRegex(ValueError,'段落边界'):
            self.export([self.change(self.cell,'1,350.00万元')])

    def test_brackets_preserved_in_both_modes(self):
        for view in ['revision','final']:
            out=self.export([self.change(self.prose,self.prose['text']+'【待确认】')],view)
            with ZipFile(io.BytesIO(out)) as z:
                self.assertIn('【待确认】',z.read('word/document.xml').decode())

    def test_original_style_preview_is_safe_and_keeps_blank_paragraphs(self):
        result=word_preview(self.file,[self.change(self.prose,self.prose['text'].replace('1,200.00','<script>1,350.00</script>'))],'final',self.raw)
        html=result['html']
        for token in ['font-size:18pt','font-size:13pt','font-size:9pt','text-indent:24pt','line-height:22pt','margin-bottom:7pt','padding-left:98.65pt','rowspan="2"','colspan="2"','background-color:#AABBCC','历史募集书页眉','历史页脚','&lt;sc','<br></p>']:
            self.assertIn(token,html)
        self.assertNotIn('<script>',html)
        self.assertIn('doc-'+self.prose['id'],html)

    def test_layout_todo_uses_comment_not_new_column(self):
        f=copy.deepcopy(self.file)
        f['layout_tasks']=[{'target_id':self.cell['id'],'text':'【待确认：新增报告期列安排】'}]
        out=self.export(file=f)
        with ZipFile(io.BytesIO(out)) as z:
            self.assertIn('【待确认：新增报告期列安排】',z.read('word/comments.xml').decode())
            root=xml(z.read('word/document.xml'))
            self.assertTrue(root.xpath('//w:commentRangeStart',namespaces=NS))
        self.assertEqual(3,len(Document(io.BytesIO(out)).tables[0].columns))

    def test_legacy_virtual_column_remains_deferred_without_loss(self):
        p={'files':[self.file],'original_id':'f','period':'2026-06-30','changes':[],
           'extra_columns':[{'table_id':next(b['id'] for b in self.file['blocks'] if b['type']=='table'),
                             'cells':[{'id':'extra','text':'','inserted':True}]}]}
        f=working_file(p)
        self.assertEqual(3,len(next(b for b in f['blocks'] if b['type']=='table')['rows'][0]))
        self.assertEqual(['extra'],f['deferred_target_ids'])
        self.assertEqual(1,len(f['layout_tasks']))
        self.assertEqual('extra',p['extra_columns'][0]['cells'][0]['id'])


if __name__=='__main__':
    unittest.main()
