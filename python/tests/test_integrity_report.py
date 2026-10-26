import unittest
import tempfile
from pathlib import Path
from zipfile import ZipFile
from PIL import Image
from docx import Document
from bondbuddy_file_authoring.integrity_report import generate, TEMPLATE

class IntegrityReportTest(unittest.TestCase):
    def test_reference_table_whole_image_and_unsigned_signature(self):
        with tempfile.TemporaryDirectory() as td:
            td=Path(td); screenshot=td/'screen.png'
            Image.new('RGB',(1440,1000),'white').save(screenshot)
            subject={'id':'s','name':'合成测试企业','kind':'company','role':'发行人','identifier':'','province':'河北','city':'沧州'}
            record={'subject_id':'s','site_id':'tax','site_name':'合成测试官网','status':'public_matches','query':'合成测试企业','checked_at':'2026-10-24T08:00:00Z','reason':'合成查询返回相关结果，待核实。','urls':['https://www.chinatax.gov.cn/'],'sources':[],'search_performed':True,'browser':{'outcome':'results','scope':'合成查询范围','limitation':'合成测试，仅验证格式'}}
            data={'input':{'project_name':'合成项目','round_id':'r','draft':{'subjects':[subject],'site_ids':['tax'],'notes':''}},'records':[record],'evidence':[],'automatic':[{'subject_id':'s','site_id':'tax','path':str(screenshot),'metadata':{'kind':'result','page':1,'url':'https://www.chinatax.gov.cn/','captured_at':'2026-10-24T08:00:00Z'}}]}
            record['presentation']={'label':'搜索返回一般信息','description':'官网返回申报公告，不属于已确认不利事项。'}
            target=td/'out.docx';generate(data,target);d=Document(target)
            self.assertEqual(len(d.tables),1);self.assertEqual(len(d.tables[0].columns),2)
            self.assertEqual(d.tables[0].cell(1,1).text,'搜索返回一般信息')
            self.assertIn('核查情况：官网返回申报公告，不属于已确认不利事项。','\n'.join(p.text for p in d.paragraphs))
            text='\n'.join(p.text for p in d.paragraphs)
            self.assertIn('16:00:00',text);self.assertIn('的签字页',text)
            self.assertIn('承做部门（团队）负责人',text)
            self.assertNotIn('不存在重大违法',text);self.assertNotIn('SHA-256',text)
            self.assertIn('搜索结果页面 第1页',text)
            self.assertIn('采集日志时间（北京时间）',text)
            with ZipFile(target) as z:
                media=[z.read(n) for n in z.namelist() if n.startswith('word/media/')]
                self.assertEqual(media,[screenshot.read_bytes()])
                self.assertNotIn(b'srcRect',z.read('word/document.xml'))
                with ZipFile(TEMPLATE) as baseline:
                    for n in baseline.namelist():
                        if n in ['word/styles.xml','word/numbering.xml'] or n.startswith(('word/header','word/footer')):
                            # python-docx serialization can normalize namespace declarations but preserves structure.
                            from lxml import etree as E
                            a=E.fromstring(z.read(n));b=E.fromstring(baseline.read(n))
                            self.assertEqual(E.tostring(a,method='c14n'),E.tostring(b,method='c14n'))

    def test_blockers_and_unverified_pages_are_never_result_figures(self):
        with tempfile.TemporaryDirectory() as td:
            subject={'id':'s','name':'合成测试企业','kind':'company'}
            for outcome,kind in [('blocked','blocker'),('failed','blocker'),('unverified','result'),('results','blocker'),('results',None)]:
                with self.subTest(outcome=outcome,kind=kind):
                    record={'subject_id':'s','site_id':'tax','site_name':'测试官网','status':'needs_manual','query':'合成测试企业','checked_at':'2026-10-24T08:00:00Z','reason':'未取得已确认的结果截图。','sources':[],'search_performed':True,'browser':{'outcome':outcome,'scope':'测试','limitation':'测试'}}
                    data={'input':{'project_name':'测试','draft':{'subjects':[subject],'site_ids':['tax']}},'records':[record],'automatic':[{'subject_id':'s','site_id':'tax','path':str(Path(td)/'must-not-open.png'),'metadata':{'kind':kind}}]}
                    target=Path(td)/'out.docx';generate(data,target)
                    text='\n'.join(p.text for p in Document(target).paragraphs)
                    self.assertIn('未取得可确认的搜索结果截图',text)
                    if outcome != 'results': self.assertIn('尝试查询词：',text)
                    with ZipFile(target) as z: self.assertFalse(any(n.startswith('word/media/') for n in z.namelist()))
    def test_template_contains_no_retained_customer_content(self):
        with ZipFile(TEMPLATE) as z:
            self.assertFalse(any(n.startswith('word/media/') for n in z.namelist()))
            from lxml import etree as E
            root=E.fromstring(z.read('word/document.xml'))
            text=root.xpath('//*[local-name()="t"]/text()')
            self.assertEqual(set(text),{'{{title}}','{{intro}}','汇总清单','公司名称','{{subject}}','{{site}}','{{result}}','查询记录','{{body}}','{{picture}}','{{signature}}','{{members}}','{{leader}}','{{department}}','{{date}}'})

    def test_exact_diagnostic_and_adverse_fact_reach_both_summary_and_detail(self):
        with tempfile.TemporaryDirectory() as td:
            labels=['搜索无返回结果','页面空白（加载超时）','网站拒绝访问（HTTP 403 Forbidden）','发现不利记录（企业全称匹配）']
            records=[{'subject_id':'s','site_id':str(i),'site_name':'合成官网'+str(i),'status':'public_matches' if i==3 else 'no_public_results' if i==0 else 'query_failed','reason':'旧概括，待人工补证','query':'合成企业','checked_at':'2026-10-26T00:00:00Z','search_performed':True,'sources':[], 'presentation':{'label':label,'description':'行政处罚：未按规定披露信息；记录显示罚款10万元。' if i==3 else '已记录准确查询原因。'}} for i,label in enumerate(labels)]
            data={'input':{'project_name':'合成测试','draft':{'subjects':[{'id':'s','name':'合成企业','kind':'company'}],'site_ids':[str(i) for i in range(4)]}},'records':records}
            target=Path(td)/'out.docx';generate(data,target);d=Document(target)
            self.assertEqual([row.cells[1].text for row in d.tables[0].rows[1:]],labels)
            text='\n'.join(p.text for p in d.paragraphs)
            for label in labels: self.assertIn('查询状态：'+label,text)
            self.assertIn('记录显示罚款10万元',text);self.assertNotIn('待人工补证',text)

if __name__=='__main__': unittest.main()
