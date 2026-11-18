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
        self.assertEqual(self.text('clean.docx'),'总资产为13.6亿元。\n收入为5亿元。\n相同内容\n相同内容')
        self.assertEqual(s['issues'][1]['missing'],'最新收入附注')
        with ZipFile(self.path/'revision.docx') as z:
            root=xml(z.read('word/document.xml'));self.assertTrue(list(root.iter(q('ins'))));self.assertTrue(list(root.iter(q('del'))));self.assertIn('最新收入附注',z.read('word/comments.xml').decode())
        with ZipFile(self.path/'clean.docx') as z:
            root=xml(z.read('word/document.xml'));self.assertFalse(list(root.iter(q('ins'))));self.assertFalse(list(root.iter(q('commentReference'))));self.assertNotIn('word/comments.xml',z.namelist())
        self.assertEqual(before,self.source.read_bytes())
    def test_rounded_sum_keeps_body_and_explains_in_comment_not_prospectus(self):
        d=Document();d.add_paragraph('期间费用为11.14万元。');d.add_paragraph('总资产为12亿元。');d.save(self.source)
        before=self.source.read_bytes()
        report=issue('期间费用', '期间费用为11.14万元。', '期间费用为11.16万元。').replace(
            '合成财务报表，2026年，资产行', '分项1.13万元、2.24万元、3.34万元、4.45万元，合计11.16万元')
        report+=issue('资产', '总资产为12亿元。', '总资产为13亿元。')
        state=build(self.source,self.request(report),self.path)
        self.assertEqual([i['applied'] for i in state['issues']], [False, True])
        self.assertTrue(state['issues'][0]['uncertain'])
        self.assertIn('累计舍入',state['issues'][0]['limitation'])
        self.assertEqual(self.text('clean.docx'),'期间费用为11.14万元。\n总资产为13亿元。')
        with ZipFile(self.path/'revision.docx') as z:
            self.assertIn('累计舍入',z.read('word/comments.xml').decode())
            self.assertNotIn('累计舍入',z.read('word/document.xml').decode())
        self.assertEqual(before,self.source.read_bytes())
        # A saved legacy snapshot must not re-enable the same bad suggestion.
        state['issues'][0]['uncertain']=False
        request=self.request('');request.update(editor=state,decisions=[
            dict(id=i['id'],decision='suggested',manual_text='') for i in state['issues']])
        repeated=build(self.source,request,self.path)
        self.assertFalse(repeated['issues'][0]['applied'])
        self.assertIn('期间费用为11.14万元',self.text('clean.docx'))
        # An explicit human replacement remains the user's decision.
        request['decisions'][0].update(decision='manual',manual_text='期间费用经人工确认为11.16万元。')
        manual=build(self.source,request,self.path)
        self.assertTrue(manual['issues'][0]['applied'])
        self.assertIn('经人工确认为11.16万元',self.text('clean.docx'))

    def test_manual_export_can_retain_and_edit_without_model(self):
        s=build(self.source,self.request(issue('资产','总资产为12亿元。','总资产为12.6亿元。')),self.path)
        r=self.request('');r.update(editor=s,decisions=[dict(id='R001',decision='original',manual_text='')]);build(self.source,r,self.path);self.assertIn('总资产为12亿元。',self.text('clean.docx'))
        r['decisions'][0].update(decision='manual',manual_text='总资产经人工确认为13亿元。');s2=build(self.source,r,self.path)
        self.assertTrue(s2['issues'][0]['applied']);self.assertIn('经人工确认为13',self.text('clean.docx'))
    def test_four_categories_lead_native_comments_and_revisions_are_reversible(self):
        rows = [
            ('政策要求与重点提示', '合规', '募集资金用途待核实。', '', '仅批注'),
            ('格式与标点', '格式', 'Bond，2026。', 'Bond, 2026.', '直接修改'),
            ('财务数据一致性', '数据一致性', '总资产为12亿元。', '总资产为13亿元。', '直接修改'),
            ('勾稽关系', '勾稽', '合计为3亿元。', '合计为4亿元。', '直接修改'),
        ]
        d=Document()
        for _,_,original,_,_ in rows:d.add_paragraph(original)
        d.save(self.source)
        original_bytes=self.source.read_bytes()
        report=''.join(issue(label+'问题',old,new,mode=mode).replace('复核类别：财务数据一致性','复核类别：'+category)
                       for category,label,old,new,mode in rows)
        s=build(self.source,self.request(report),self.path)
        self.assertEqual([i['category'] for i in s['issues']],[row[1] for row in rows])
        self.assertEqual([i['applied'] for i in s['issues']],[False,True,True,True])
        self.assertEqual(self.text('clean.docx'),'\n'.join(new if mode=='直接修改' else old for _,_,old,new,mode in rows))
        with ZipFile(self.path/'revision.docx') as z:
            comments=list(xml(z.read('word/comments.xml')).iter(q('comment')))
            self.assertEqual(len(comments),4)
            for comment,(_,label,_,_,_) in zip(comments,rows):
                lines=[paragraph_text(p) for p in comment.iter(q('p'))]
                self.assertEqual(lines[0],'问题类别：'+label)
                self.assertTrue(lines[1].startswith('问题：R'))
                self.assertTrue(lines[2].startswith('问题说明：'))
                self.assertTrue(lines[3].startswith('依据：'))
                self.assertTrue(lines[4].startswith('处理：'))
            body=z.read('word/document.xml')
        # Rejecting all current edits restores the submitted text; accepting them
        # yields the edited body while the uncertain compliance text stays intact.
        for accept in (False,True):
            root=xml(body)
            for node in list(root.iter()):
                if node.tag in (q('ins'),q('del')):
                    keep=(node.tag==q('ins'))==accept
                    if keep:
                        for child in list(node):node.addprevious(child)
                    node.getparent().remove(node)
            for node in root.iter(q('delText')):node.tag=q('t')
            actual=[paragraph_text(p) for p in root.iter(q('p'))]
            expected=[new if accept and mode=='直接修改' else old for _,_,old,new,mode in rows]
            self.assertEqual(actual,expected)
        self.assertEqual(self.source.read_bytes(),original_bytes)
    def test_saved_editor_categories_and_unknown_category_remain_explicit(self):
        s=build(self.source,self.request(issue('资产','总资产为12亿元。','总资产为13亿元。')),self.path)
        s['issues'][0]['category']='财务数据一致性'
        r=self.request('');r.update(editor=s,decisions=[dict(id='R001',decision='original',manual_text='')])
        saved=build(self.source,r,self.path)
        self.assertEqual(saved['issues'][0]['category'],'数据一致性')
        self.assertFalse(saved['issues'][0]['applied'])
        with ZipFile(self.path/'revision.docx') as z:
            comment=next(xml(z.read('word/comments.xml')).iter(q('comment')))
            self.assertEqual(paragraph_text(next(comment.iter(q('p')))),'问题类别：数据一致性')
        report=issue('资产','总资产为12亿元。','总资产为13亿元。').replace('- 复核类别：财务数据一致性\n','')
        missing=build(self.source,self.request(report),self.path)
        self.assertEqual(missing['issues'][0]['category'],'类别待确认')
    def test_ambiguous_and_overlapping_are_not_silently_changed(self):
        s=build(self.source,self.request(issue('重复','相同内容','更新')+issue('资产1','总资产为12亿元。','更新1')+issue('资产2','12亿元','13亿元')),self.path)
        self.assertTrue(all(not i['applied'] and i['limitation'] for i in s['issues']))
        self.assertIn('总资产为12亿元。',self.text('clean.docx'))

    def location_document(self, repeated_cell=False, repeated_caption=False):
        d=Document()
        d.add_paragraph('第五节 发行人主要财务情况\t9')  # TOC, not a scope boundary
        d.add_paragraph('第四节 发行人基本情况')
        d.add_paragraph('期间费用为11.12万元。')
        d.add_paragraph('第五节 发行人主要财务情况')
        d.add_paragraph('期间费用为11.12万元。')
        for _ in range(2 if repeated_caption else 1):
            d.add_paragraph('期间费用明细情况')
            d.add_paragraph('单位：万元、%')
            t=d.add_table(rows=2,cols=3)
            for c,v in zip(t.rows[0].cells,['项目','2026年度','2025年度']):c.text=v
            for c,v in zip(t.rows[1].cells,['合计','11.12','11.12' if repeated_cell else '10.00']):c.text=v
        d.add_paragraph('第六节 资信状况')
        d.add_paragraph('期间费用为11.12万元。')
        d.save(self.source)

    def located_issue(self, original='11.12', location='第五节「发行人主要财务情况」—「期间费用明细情况」，合计行2026年度金额列'):
        return issue('期间费用',original,original.replace('11.12','11.11'))+'- 原文位置：'+location+'\n'

    def test_exact_table_caption_disambiguates_numeric_quote_and_preserves_pair(self):
        from bondbuddy_file_authoring.check import package, stories
        self.location_document();before=self.source.read_bytes()
        s=build(self.source,self.request(self.located_issue()),self.path)
        self.assertTrue(s['issues'][0]['applied'])
        self.assertIn('期间费用明细情况',s['issues'][0]['original_location'])
        self.assertEqual(Document(self.path/'clean.docx').tables[0].cell(1,1).text,'11.11')
        self.assertEqual(self.text('clean.docx').count('期间费用为11.12万元。'),3)
        self.assertEqual(stories(package(self.path/'revision.docx'),True),stories(package(self.path/'clean.docx')))
        self.assertEqual(stories(package(self.path/'revision.docx'),False),stories(package(self.path/'baseline.docx')))
        self.assertEqual(before,self.source.read_bytes())
        # A saved snapshot keeps its source-verifiable location for free export.
        r=self.request('');r.update(editor=s,decisions=[dict(id='R001',decision='suggested',manual_text='')])
        exported=build(self.source,r,self.path)
        self.assertEqual(exported['issues'],s['issues'])

    def test_repeated_numeric_cells_or_captions_remain_ambiguous(self):
        for cells,captions in [(True,False),(False,True)]:
            with self.subTest(cells=cells,captions=captions):
                self.location_document(cells,captions)
                s=build(self.source,self.request(self.located_issue()),self.path)
                self.assertFalse(s['issues'][0]['applied']);self.assertIsNone(s['issues'][0]['paragraph_id'])
                self.assertEqual(Document(self.path/'clean.docx').tables[0].cell(1,1).text,'11.12')

    def test_caption_inside_full_width_first_row_is_verified_without_changing_grid(self):
        d=Document();d.add_paragraph('第五节 发行人主要财务情况');d.add_paragraph('期间费用为11.12万元。')
        t=d.add_table(rows=3,cols=3)
        caption=t.cell(0,0).merge(t.cell(0,2));caption.text='期间费用明细情况';caption.add_paragraph('单位：万元、%')
        for c,v in zip(t.rows[1].cells,['项目','2026年度','2025年度']):c.text=v
        for c,v in zip(t.rows[2].cells,['合计','11.12','10.00']):c.text=v
        d.save(self.source)
        s=build(self.source,self.request(self.located_issue()),self.path)
        self.assertTrue(s['issues'][0]['applied'])
        out=Document(self.path/'clean.docx').tables[0]
        self.assertEqual(out.cell(2,1).text,'11.11');self.assertEqual(out.cell(0,0).text,caption.text)
        self.assertEqual(len(out.rows),3);self.assertEqual(out.cell(0,0)._tc.tcPr.gridSpan.val,3)
        # A partial-width / unverified first-row cell is not a trusted caption.
        t.cell(0,0)._tc.tcPr.gridSpan.val=2;d.save(self.source)
        rejected=build(self.source,self.request(self.located_issue()),self.path)
        self.assertFalse(rejected['issues'][0]['applied'])

    def test_wrong_or_missing_location_never_prefers_a_cell_over_prose(self):
        self.location_document()
        for location in ['', '物理第9页', '第四节「发行人基本情况」—「期间费用明细情况」',
                         '第五节「发行人主要财务情况」—「不存在的表格」',
                         '第五节「发行人主要财务情况」—「期间费用明细情况」—「不存在的列」']:
            with self.subTest(location=location):
                s=build(self.source,self.request(self.located_issue(location=location)),self.path)
                self.assertFalse(s['issues'][0]['applied']);self.assertIsNone(s['issues'][0]['paragraph_id'])

    def test_full_section_title_disambiguates_prose_but_old_snapshot_stays_safe(self):
        self.location_document()
        s=build(self.source,self.request(self.located_issue('期间费用为11.12万元。','第五节「发行人主要财务情况」')),self.path)
        self.assertTrue(s['issues'][0]['applied'])
        self.assertEqual(self.text('clean.docx').count('期间费用为11.11万元。'),1)
        self.assertEqual(self.text('clean.docx').count('期间费用为11.12万元。'),2)
        del s['issues'][0]['original_location']
        r=self.request('');r.update(editor=s,decisions=[dict(id='R001',decision='suggested',manual_text='')])
        old=build(self.source,r,self.path)
        self.assertFalse(old['issues'][0]['applied']);self.assertIsNone(old['issues'][0]['paragraph_id'])

    def test_legacy_location_recovery_requires_matching_original_report_and_keeps_decisions(self):
        self.location_document();report=self.located_issue()
        s=build(self.source,self.request(report),self.path)
        del s['issues'][0]['original_location']
        r=self.request('');r.update(editor=s,original_report=report,decisions=[dict(id='R001',decision='suggested',manual_text='')])
        restored=build(self.source,r,self.path)
        self.assertTrue(restored['issues'][0]['applied'])
        self.assertNotIn('original_location',s['issues'][0])
        r['decisions'][0]['decision']='original'
        retained=build(self.source,r,self.path)
        self.assertFalse(retained['issues'][0]['applied'])
        self.assertEqual(Document(self.path/'clean.docx').tables[0].cell(1,1).text,'11.12')
        r['decisions'][0]['decision']='suggested'
        r['original_report']=report.replace('合成财务报表','另一份财务报表')
        mismatch=build(self.source,r,self.path)
        self.assertFalse(mismatch['issues'][0]['applied']);self.assertIsNone(mismatch['issues'][0]['paragraph_id'])

    def test_differential_scope_rejects_missing_extra_duplicate_and_reused_ids_before_export(self):
        selected=[{'id':'R007','original':'总资产为12亿元。','original_location':''},
                  {'id':'R009','original':'收入为5亿元。','original_location':''}]
        a=issue('资产','总资产为12亿元。','总资产为13亿元。')+'- 原问题编号：R007\n'
        b=issue('收入','收入为5亿元。','收入为6亿元。')+'- 原问题编号：R009\n'
        for index,report in enumerate([a,a+b+a,(a+b).replace('R009','R007'),
                (a+b).replace('原问题编号：R007','原问题编号：R001'),
                (a+b).replace('原文披露：总资产为12亿元。','原文披露：相同内容')]):
            with self.subTest(index=index):
                r=self.request(report);r['review_scope']={'finding_ids':['R007','R009'],'targets':selected}
                out=self.path/str(index)
                with self.assertRaisesRegex(ValueError,'REVIEW_DIFFERENTIAL_SCOPE_INVALID'):build(self.source,r,out)
                self.assertFalse((out/'clean.docx').exists());self.assertFalse((out/'editor.json').exists())
        r=self.request(a+b);r['review_scope']={'finding_ids':['R007','R009'],'targets':selected}
        s=build(self.source,r,self.path)
        self.assertEqual([i['source_finding_id'] for i in s['issues']],['R007','R009'])
        self.assertTrue(all(i['applied'] for i in s['issues']))
        self.assertEqual(self.text('clean.docx'),'总资产为13亿元。\n收入为6亿元。\n相同内容\n相同内容')
        # A free export has the same scope guard and retains the user's decisions.
        r.update(editor=s,decisions=[dict(id=i['id'],decision='original',manual_text='') for i in s['issues']])
        exported=build(self.source,r,self.path)
        self.assertTrue(all(not i['applied'] for i in exported['issues']))

    def test_differential_recheck_without_new_evidence_preserves_each_selected_quote(self):
        report=issue('资产待核','总资产为12亿元。','','审计原表','仅批注')+'- 原问题编号：R007\n'
        r=self.request(report);r['review_scope']={'finding_ids':['R007'],'targets':[{'id':'R007','original':'总资产为12亿元。'}]}
        s=build(self.source,r,self.path)
        self.assertFalse(s['issues'][0]['applied']);self.assertEqual(s['issues'][0]['missing'],'审计原表')
        self.assertIn('总资产为12亿元。',self.text('clean.docx'))
    def test_unlocated_findings_do_not_attach_to_first_paragraph(self):
        report=issue('重复','相同内容','更新')+issue('资产','总资产为12亿元。','总资产为13亿元。')
        s=build(self.source,self.request(report),self.path)
        self.assertEqual([i['applied'] for i in s['issues']],[False,True])
        self.assertIsNone(s['issues'][0]['paragraph_id'])
        self.assertTrue(any('1 项发现' in w and 'R001' in w and '未修改正文或添加正文批注' in w for w in s['warnings']))
        with ZipFile(self.path/'revision.docx') as z:
            root=xml(z.read('word/document.xml'))
            comments=list(xml(z.read('word/comments.xml')).iter(q('comment')))
            starts=list(root.iter(q('commentRangeStart')))
            self.assertEqual(len(comments),1)
            self.assertEqual(len(starts),1)
            self.assertEqual(starts[0].get(q('id')),comments[0].get(q('id')))
            self.assertIn('问题：R002', ''.join(comments[0].itertext()))
            self.assertNotIn('问题：R001', ''.join(comments[0].itertext()))
        self.assertIn('总资产为13亿元。',self.text('clean.docx'))
        self.assertEqual(self.text('clean.docx').count('相同内容'),2)

    def test_table_row_and_missing_quote_preserve_findings_without_false_comments(self):
        d=Document();d.add_paragraph('')
        table=d.add_table(rows=1,cols=4)
        for cell,value in zip(table.rows[0].cells,['合成债券A','10,000.00','2024/12/04','5']):cell.text=value
        d.save(self.source)
        before=self.source.read_bytes()
        report=issue('期限','合成债券A | 10,000.00 | 2024/12/04 | 5','合成债券A | 10,000.00 | 2024/12/04 | 3+2')+issue('缺失','不存在的原句','更新')
        s=build(self.source,self.request(report),self.path)
        self.assertEqual(len(s['issues']),2)
        self.assertTrue(all(not i['applied'] and i['paragraph_id'] is None and i['limitation'] for i in s['issues']))
        self.assertTrue(any('2 项发现' in w and 'R001、R002' in w for w in s['warnings']))
        for filename in ['revision.docx','clean.docx']:
            with ZipFile(self.path/filename) as z:
                root=xml(z.read('word/document.xml'))
                for tag in ['commentRangeStart','commentRangeEnd','commentReference','ins','del']:
                    self.assertFalse(list(root.iter(q(tag))))
                self.assertNotIn('word/comments.xml',z.namelist())
            self.assertEqual([c.text for c in Document(self.path/filename).tables[0].rows[0].cells],['合成债券A','10,000.00','2024/12/04','5'])
        self.assertEqual(before,self.source.read_bytes())
        # Re-exporting the immutable legacy snapshot must not recreate cover comments.
        again=self.request('');again.update(editor=s,decisions=[dict(id=i['id'],decision='suggested',manual_text='') for i in s['issues']])
        exported=build(self.source,again,self.path)
        self.assertEqual(exported['issues'],s['issues'])
        with ZipFile(self.path/'revision.docx') as z:
            self.assertNotIn('word/comments.xml',z.namelist())

    def test_unlocated_findings_preserve_existing_human_comments(self):
        d=Document();p=d.add_paragraph('人工批注所在段落。')
        d.add_comment(p.runs,text='原有人工核查意见',author='人工复核人')
        d.save(self.source)
        s=build(self.source,self.request(issue('无法定位','不存在的原句','更新')),self.path)
        self.assertFalse(s['issues'][0]['applied'])
        with ZipFile(self.path/'revision.docx') as z:
            root=xml(z.read('word/document.xml'))
            comments=list(xml(z.read('word/comments.xml')).iter(q('comment')))
            self.assertEqual(len(comments),1)
            self.assertEqual(comments[0].get(q('author')),'人工复核人')
            self.assertEqual(len(list(root.iter(q('commentRangeStart')))),1)
            self.assertNotIn('问题：R001',''.join(comments[0].itertext()))
    def test_hash_and_decisions_are_pinned(self):
        r=self.request(issue('资产','总资产为12亿元。','总资产为13亿元。'));r['pin']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'INPUT_REVISION_CONFLICT'):build(self.source,r,self.path)
    def test_heading_levels_bom_crlf_and_multiline_fields_keep_real_changes(self):
        for heading in ('##', '####', '1.'):
            with self.subTest(heading=heading):
                report=issue('资产','总资产为12亿元。','总资产为13亿元。').replace('###',heading).replace('原文披露：总资产','原文披露：\n> 总资产')
                s=build(self.source,self.request('\ufeff'+report.replace('\n','\r\n')),self.path)
                self.assertEqual(len(s['issues']),1);self.assertTrue(s['issues'][0]['applied'])
                self.assertIn('总资产为13亿元。',self.text('clean.docx'))
    def test_word_report_table_fields_preserve_order_and_evidence(self):
        from bondbuddy_file_authoring.review_report_text import report_text
        report=self.path/'model-report.docx';d=Document();d.add_heading('资产',level=2)
        table=d.add_table(rows=0,cols=2)
        for line in issue('资产','总资产为12亿元。','总资产为13亿元。').splitlines()[1:]:
            key,value=line[2:].split('：',1);a,b=table.add_row().cells;a.text=key;b.text=value
        d.add_heading('覆盖范围',level=2);d.add_paragraph('只核对上述合成资产数据。');d.save(report)
        s=build(self.source,self.request(report_text(report)),self.path)
        self.assertEqual(len(s['issues']),1);self.assertTrue(s['issues'][0]['applied'])
        self.assertEqual(s['issues'][0]['missing'],'')
    def test_noop_is_not_counted_as_applied_and_markup_is_enabled(self):
        s=build(self.source,self.request(issue('资产','总资产为12亿元。','总资产为12亿元。')),self.path)
        self.assertFalse(s['issues'][0]['applied'])
        with ZipFile(self.path/'revision.docx') as z:
            root=xml(z.read('word/document.xml'));self.assertFalse(list(root.iter(q('ins'))))
            settings=xml(z.read('word/settings.xml'))
            self.assertEqual(settings.find(q('revisionView')).get(q('insDel')),'1')
            self.assertEqual(settings.find(q('trackRevisions')).get(q('val')),'1')
    def test_missing_evidence_and_ambiguous_quotes_stay_unmodified_in_alternate_format(self):
        report=issue('资产','总资产为12亿元。','总资产为13亿元。').replace('###','##').replace('核对依据：合成财务报表，2026年，资产行','核对依据：')
        s=build(self.source,self.request(report),self.path)
        self.assertEqual(len(s['issues']),1);self.assertTrue(s['issues'][0]['uncertain']);self.assertFalse(s['issues'][0]['applied'])
    def test_noop_does_not_block_or_count_a_real_edit_in_same_paragraph(self):
        report=issue('保留资产','总资产为12亿元。','总资产为12亿元。')+issue('资产金额','12亿元','13亿元')
        s=build(self.source,self.request(report),self.path)
        self.assertFalse(s['issues'][0]['applied']);self.assertTrue(s['issues'][1]['applied'])
        self.assertIn('总资产为13亿元。',self.text('clean.docx'))
    def test_report_narrative_is_not_appended_to_replacement_or_missing_fields(self):
        report=issue('资产','总资产为12亿元。','总资产为13亿元。').replace('- 缺少材料：无','这是报告说明，不属于替换文本。\n- 缺少材料：无\n\n本轮仅核对合成资产数据。')
        s=build(self.source,self.request(report),self.path)
        self.assertTrue(s['issues'][0]['applied']);self.assertEqual(s['issues'][0]['missing'],'')
        self.assertEqual(s['issues'][0]['replacement'],'总资产为13亿元。')
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
        self.assertEqual(self.text('clean.docx'),'总资产为12亿元。\n收入为5亿元。\n相同内容\n相同内容')

if __name__=='__main__':unittest.main()
