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

    def revision_request(self, media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'):
        if media_type == 'application/pdf':
            self.source.write_bytes(b'%PDF-synthetic-revision-baseline')
            records = [{'id': 'source/p1', 'text': '原文100万元。', 'locator': {'page': 1}}]
        else:
            doc = Document(); doc.add_paragraph('原文100万元。'); doc.add_paragraph('未选条款保留。'); doc.save(self.source)
            parsed, _, _ = _parse_docx(self.source, {})
            records = [{'id': 'source/' + r['record_id'], 'text': r['literal_quote'], 'locator': r['locator']} for r in parsed]
        source_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        raw_id = records[0]['id'].split('/', 1)[1]
        handling = {'version': 'review-revision-handling-v1', 'source_report': {'report_id': 'report-1', 'sha256': 'b' * 64},
                    'accepted_plan': {'plan_id': 'accepted-plan-1', 'version': 1, 'sha256': 'c' * 64},
                    'source_material': {'material_id': 'source', 'material_version': 1, 'sha256': source_hash},
                    'review_passed': False, 'limitations': [], 'items': [
                        {'finding_id': 'F-1', 'report_id': 'report-1', 'status': 'modified', 'reason': '依据已锁定的合成证据修订。',
                         'locations': [{'record_id': raw_id, 'locator': records[0]['locator']}], 'evidence_refs': ['audit/a1'], 'review_passed': False},
                        {'finding_id': 'F-2', 'report_id': 'report-1', 'status': 'not_modified', 'reason': '用户明确排除本项。',
                         'locations': [], 'evidence_refs': [], 'review_passed': False}]}
        request = self.request()
        request.update(source_sha256=source_hash, media_type=media_type, records=records,
                       edits=[{'record_id': records[0]['id'], 'after': '修订文120万元。', 'evidence': ['audit/a1'], 'pending': []}],
                       revision_handling=handling, revision_allowed_record_ids=[records[0]['id']])
        return request

    def test_report_driven_revision_keeps_original_and_independent_handling_with_dual_word(self):
        request = self.revision_request(); original = self.source.read_bytes(); handling = copy.deepcopy(request['revision_handling'])
        result = render(request, self.source, self.tracked, self.clean, self.baseline)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(result['revision_handling'], handling)
        self.assertFalse(result['review_passed'])
        self.assertEqual(Document(self.clean).paragraphs[0].text, '修订文120万元。')
        self.assertEqual(Document(self.clean).paragraphs[1].text, '未选条款保留。')
        self.assertTrue(list(self.xml(self.tracked).iter(Q('ins'))))
        accepted = copy.deepcopy(self.xml(self.tracked)); accept_own_revisions(accepted)
        self.assertEqual(document_signature(accepted), document_signature(self.xml(self.clean)))

    def test_report_revision_preserves_explicit_pdf_reconstruction_baseline(self):
        request = self.revision_request('application/pdf'); original = self.source.read_bytes()
        result = render(request, self.source, self.tracked, self.clean, self.baseline)
        self.assertEqual(result['baseline_kind'], 'reconstructed_pdf')
        self.assertEqual(result['source_sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(result['revision_handling']['review_passed'])

    def test_report_revision_rejects_scope_expansion_and_fabricated_review_pass(self):
        for change in ('scope', 'passed', 'handling', 'empty', 'baseline'):
            request = self.revision_request()
            if change == 'scope':
                request['edits'][0]['record_id'] = request['records'][1]['id']
            elif change == 'passed':
                request['revision_handling']['items'][0]['review_passed'] = True
            elif change == 'handling':
                request['revision_handling']['items'][0]['status'] = 'not_modified'
            elif change == 'empty':
                request['edits'] = []
            else:
                request['revision_handling']['source_material']['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'WORD_REVISION_SCOPE_MISMATCH'):
                render(request, self.source, self.tracked, self.clean, self.baseline)


class UnifiedWordV2Tests(unittest.TestCase):
    """Direct projection rendering checks, independent of real model acceptance."""
    setUp = UnifiedWordTests.setUp
    tearDown = UnifiedWordTests.tearDown
    request = UnifiedWordTests.request
    xml = UnifiedWordTests.xml

    def block(self, block_id, kind, text='', rows=None, **fields):
        return {'block_id': block_id, 'order': 0, 'kind': kind, 'text': text,
                'rows': rows or [], 'evidence': ['synthetic-context'], 'pending': [],
                'heading_level': 1 if kind == 'heading' else None,
                'style_key': {'heading': 'heading', 'paragraph': 'body', 'table': 'table'}[kind],
                'table_id': block_id if kind == 'table' else None,
                'row_order': 0 if kind == 'table' else None, **fields}

    def v2_request(self, blocks):
        return {**self.request(), 'version': 'unified-word-request-v2', 'blocks': blocks,
                'source_sha256': None, 'media_type': None, 'records': [], 'additions': []}

    def test_v2_heading_styles_evidence_pending_and_editable_first_draft(self):
        blocks = [self.block('h1', 'heading', '第一章', heading_level=1),
                  self.block('h3', 'heading', '三级标题', heading_level=3),
                  self.block('body', 'paragraph', '可编辑正文', pending=['核对口径']),
                  self.block('caption', 'paragraph', '图表说明', style_key='caption')]
        result = render(self.v2_request(blocks), None, self.tracked, self.clean, self.baseline)
        doc = Document(self.clean)
        self.assertEqual([p.style.name for p in doc.paragraphs[:2]], ['Heading 1', 'Heading 3'])
        self.assertEqual(doc.paragraphs[2].style.name, 'Normal')
        self.assertEqual(doc.paragraphs[-1].style.name, 'Caption')
        self.assertIn('【待人工确认】核对口径', [p.text for p in doc.paragraphs])
        self.assertEqual(result['writer_version'], 'bondbuddy-unified-word-2.0.0')
        self.assertEqual(result['block_audit'][2]['evidence'], ['synthetic-context'])
        self.assertEqual(result['pending_review'][0]['record_id'], 'body')
        self.assertEqual(self.tracked.read_bytes(), self.clean.read_bytes())
        self.assertFalse(list(self.xml(self.tracked).iter(Q('ins'))))
        self.assertFalse(list(self.xml(self.tracked).iter(Q('del'))))

    def test_v2_contiguous_table_chunks_merge_header_and_keep_each_chunks_audit(self):
        blocks = [self.block('t1', 'table', '财务表', [['项目', '金额'], ['资产', '100']], table_id='financial'),
                  self.block('t2', 'table', '财务表', [['项目', '金额'], ['负债', '50']],
                             table_id='financial', row_order=1, pending=['核对负债'])]
        result = render(self.v2_request(blocks), None, self.tracked, self.clean, self.baseline)
        doc = Document(self.clean)
        self.assertEqual(len(doc.tables), 1)
        self.assertEqual([[c.text for c in row.cells] for row in doc.tables[0].rows],
                         [['项目', '金额'], ['资产', '100'], ['负债', '50']])
        self.assertEqual(len(result['block_audit']), 2)
        self.assertEqual(result['pending_review'][0]['record_id'], 't2')

    def test_v2_invalid_heading_styles_duplicate_ids_and_source_scope_fail_closed(self):
        for key, value in [('heading_level', 0), ('heading_level', 10), ('style_key', 'arbitraryOOXML')]:
            block = self.block('h1', 'heading', '标题'); block[key] = value
            request = self.v2_request([block, self.block('p1', 'paragraph', '正文')])
            with self.assertRaisesRegex(ValueError, 'WORD_PROJECTION_INVALID'):
                render(request, None, self.tracked, self.clean, self.baseline)
        block = self.block('p1', 'paragraph', '正文')
        with self.assertRaisesRegex(ValueError, 'WORD_PROJECTION_INVALID'):
            render(self.v2_request([block, block]), None, self.tracked, self.clean, self.baseline)
        request = self.v2_request([block]); request['edits'] = [{'record_id': 'unlocked'}]
        with self.assertRaisesRegex(ValueError, 'WORD_PROJECTION_SOURCE_SCOPE_INVALID'):
            render(request, None, self.tracked, self.clean, self.baseline)

    def test_v2_table_gap_overlap_header_mismatch_and_nonadjacent_reuse_fail_closed(self):
        first = self.block('t1', 'table', '表', [['项目', '金额'], ['资产', '100']], table_id='financial')
        for key, value in [('row_order', 0), ('row_order', 2), ('rows', [['项目', '值'], ['负债', '50']])]:
            second = self.block('t2', 'table', '表', [['项目', '金额'], ['负债', '50']], table_id='financial', row_order=1)
            second[key] = value
            with self.assertRaisesRegex(ValueError, 'WORD_TABLE_CONTINUATION_INVALID'):
                render(self.v2_request([first, second]), None, self.tracked, self.clean, self.baseline)
        second = self.block('t2', 'table', '表', [['项目', '金额'], ['负债', '50']], table_id='financial', row_order=1)
        with self.assertRaisesRegex(ValueError, 'WORD_TABLE_CONTINUATION_INVALID'):
            render(self.v2_request([first, self.block('p1', 'paragraph', '正文'), second]), None,
                   self.tracked, self.clean, self.baseline)
        first['chapter_id'] = 'chapter-one'; second['chapter_id'] = 'chapter-two'
        with self.assertRaisesRegex(ValueError, 'WORD_TABLE_CONTINUATION_INVALID'):
            render(self.v2_request([first, second]), None, self.tracked, self.clean, self.baseline)

    def test_v2_pdf_reconstruction_uses_all_projection_blocks_and_keeps_real_source_baseline(self):
        self.source.write_bytes(b'%PDF-1.4 synthetic source bytes; host parser records are pinned')
        original = self.source.read_bytes()
        blocks = [self.block('chapter', 'heading', '更新后的完整章节', heading_level=2),
                  self.block('body', 'paragraph', '新的完整正文120万元。'),
                  self.block('table', 'table', '完整财务表', [['项目', '金额'], ['资产', '120']])]
        request = self.v2_request(blocks)
        request.update(source_sha256=hashlib.sha256(original).hexdigest(), media_type='application/pdf',
                       records=[{'id': 'source/p1', 'text': '原PDF正文100万元。', 'locator': {'page': 1}}])
        result = render(request, self.source, self.tracked, self.clean, self.baseline)
        self.assertEqual(result['writer_version'], 'bondbuddy-unified-word-2.0.0')
        self.assertEqual(result['baseline_kind'], 'reconstructed_pdf')
        self.assertEqual(result['source_sha256'], request['source_sha256'])
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(Document(self.clean).paragraphs[0].style.name, 'Heading 2')
        self.assertIn('新的完整正文120万元。', [p.text for p in Document(self.clean).paragraphs])
        self.assertEqual(Document(self.clean).tables[0].cell(1, 1).text, '120')
        self.assertEqual(Document(self.baseline).paragraphs[0].text, '原PDF正文100万元。')
        self.assertEqual(result['effective_baseline_sha256'], hashlib.sha256(self.baseline.read_bytes()).hexdigest())
        self.assertEqual(self.tracked.read_bytes(), self.clean.read_bytes())
        self.assertFalse(list(self.xml(self.tracked).iter(Q('ins'))))
        request['source_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'WORD_SOURCE_HASH_MISMATCH'):
            render(request, self.source, self.tracked, self.clean, self.baseline)
