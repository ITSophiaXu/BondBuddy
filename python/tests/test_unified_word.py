"""Synthetic Word checks; these tests do not claim a real supplier or customer acceptance."""
import copy
import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path
from docx import Document
from lxml import etree
from bondbuddy_document_parser.parser import _parse_docx
from bondbuddy_word_delivery.unified import render
from bondbuddy_word_delivery.writer import Q, accept_own_revisions, document_signature


class UnifiedWordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source, self.tracked, self.clean, self.baseline = [self.root / p for p in ['source.docx','tracked.docx','clean.docx','baseline.docx']]

    def tearDown(self):
        self.temp.cleanup()

    def request(self):
        return {'version':'unified-word-request-v1','date':'2026-10-01T00:00:00Z','blocks':[], 'edits':[], 'plan_hash':'a'*64}

    def xml(self, path):
        with zipfile.ZipFile(path) as archive:
            return etree.fromstring(archive.read('word/document.xml'))

    def test_update_has_real_revisions_clean_equivalence_and_preserves_source(self):
        doc=Document();doc.add_heading('测试发行人',0);doc.add_paragraph('2024年度净资产100万元。')
        table=doc.add_table(rows=2, cols=2);table.cell(0,0).text='项目';table.cell(0,1).text='2024年度';table.cell(1,0).text='净资产';table.cell(1,1).text='100'
        doc.save(self.source); original=self.source.read_bytes()
        records,_,_=_parse_docx(self.source,{})
        request=self.request();request.update(source_sha256=hashlib.sha256(original).hexdigest(),media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          records=[{'id':r['record_id'],'text':r['literal_quote'],'locator':r['locator']} for r in records])
        for r in records:
            if '100' in r['literal_quote']:
                request['edits'].append({'record_id':r['record_id'],'after':r['literal_quote'].replace('100','120'),'evidence':['synthetic-report'], 'pending':['核对审计口径']})
        result=render(request,self.source,self.tracked,self.clean,self.baseline)
        self.assertEqual(self.source.read_bytes(),original)
        self.assertEqual(result['replacements'],2)
        self.assertTrue(list(self.xml(self.tracked).iter(Q('ins'))))
        accepted=copy.deepcopy(self.xml(self.tracked));accept_own_revisions(accepted)
        self.assertEqual(document_signature(accepted),document_signature(self.xml(self.clean)))
        self.assertFalse(list(self.xml(self.clean).iter(Q('ins'))))

    def test_first_draft_is_editable_with_no_invented_history(self):
        request=self.request();request['blocks']=[{'kind':'heading','text':'测试募集说明书','rows':[],'evidence':['target'],'pending':[]},
          {'kind':'paragraph','text':'根据已提供材料编制的正文。','rows':[],'evidence':['report'],'pending':['补充评级资料']},
          {'kind':'table','text':'财务数据（万元）','rows':[['项目','2025年度'],['资产','120']],'evidence':['report'],'pending':[]}]
        result=render(request,None,self.tracked,self.clean,self.baseline)
        self.assertEqual(result['baseline_kind'],'none');self.assertIsNone(result['source_sha256'])
        self.assertEqual(self.tracked.read_bytes(),self.clean.read_bytes())
        self.assertFalse(list(self.xml(self.tracked).iter(Q('ins'))))
        self.assertEqual(Document(self.clean).tables[0].cell(1,1).text,'120')

    def test_tampered_source_and_missing_record_fail_closed(self):
        doc=Document();doc.add_paragraph('原文');doc.save(self.source)
        request=self.request();request.update(source_sha256='0'*64,records=[],media_type='application/pdf')
        with self.assertRaisesRegex(ValueError,'WORD_SOURCE_HASH_MISMATCH'):
            render(request,self.source,self.tracked,self.clean,self.baseline)

    def test_new_target_section_and_period_table_have_reversible_real_revisions(self):
        doc=Document();doc.add_paragraph('原有条款保持不变。');doc.save(self.source)
        records,_,_=_parse_docx(self.source,{})
        request=self.request();request.update(source_sha256=hashlib.sha256(self.source.read_bytes()).hexdigest(),
          media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          records=[{'id':r['record_id'],'text':r['literal_quote'],'locator':r['locator']} for r in records],
          additions=[{'after_record_id':records[0]['record_id'],'blocks':[
            {'kind':'heading','text':'新增目标品种披露','rows':[],'evidence':['target'],'pending':[]},
            {'kind':'table','text':'新增期间数据','rows':[['项目','2024','2025'],['资产','100','120']],
             'evidence':['report'],'pending':['本表为合成测试数据']}]}])
        render(request,self.source,self.tracked,self.clean,self.baseline)
        self.assertEqual(Document(self.clean).tables[0].cell(1,2).text,'120')
        accepted=copy.deepcopy(self.xml(self.tracked));accept_own_revisions(accepted)
        self.assertEqual(document_signature(accepted),document_signature(self.xml(self.clean)))
        self.assertTrue(self.xml(self.tracked).find('.//'+Q('trPr')+'/'+Q('ins')) is not None)

    def test_reconstructed_pdf_is_explicit_and_tracked(self):
        self.source.write_bytes(b'%PDF-synthetic-placeholder')
        request=self.request();request.update(source_sha256=hashlib.sha256(self.source.read_bytes()).hexdigest(),media_type='application/pdf',
          records=[{'id':'pdf-1','text':'旧文100万元。','locator':{}}],edits=[{'record_id':'pdf-1','after':'新文120万元。','evidence':['report'],'pending':[]}])
        result=render(request,self.source,self.tracked,self.clean,self.baseline)
        self.assertEqual(result['baseline_kind'],'reconstructed_pdf')
        self.assertEqual(Document(self.clean).paragraphs[0].text,'新文120万元。')
