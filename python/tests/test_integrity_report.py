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
            record={'subject_id':'s','site_id':'tax','site_name':'合成测试官网','status':'needs_manual','query':'合成测试企业','checked_at':'2026-10-24T08:00:00Z','reason':'页面要求验证码，待人工补证。','urls':['https://www.chinatax.gov.cn/'],'sources':[],'search_performed':False,'browser':{'scope':'合成查询范围','limitation':'合成测试，仅验证格式'}}
            data={'input':{'project_name':'合成项目','round_id':'r','draft':{'subjects':[subject],'site_ids':['tax'],'notes':''}},'records':[record],'evidence':[],'automatic':[{'subject_id':'s','site_id':'tax','path':str(screenshot),'metadata':{'url':'https://www.chinatax.gov.cn/','captured_at':'2026-10-24T08:00:00Z'}}]}
            target=td/'out.docx';generate(data,target);d=Document(target)
            self.assertEqual(len(d.tables),1);self.assertEqual(len(d.tables[0].columns),2)
            self.assertEqual(d.tables[0].cell(1,1).text,'待人工补证')
            text='\n'.join(p.text for p in d.paragraphs)
            self.assertIn('16:00:00',text);self.assertIn('的签字页',text)
            self.assertIn('承做部门（团队）负责人',text)
            self.assertNotIn('不存在重大违法',text);self.assertNotIn('SHA-256',text)
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
    def test_template_contains_no_retained_customer_content(self):
        with ZipFile(TEMPLATE) as z:
            self.assertFalse(any(n.startswith('word/media/') for n in z.namelist()))
            from lxml import etree as E
            root=E.fromstring(z.read('word/document.xml'))
            text=root.xpath('//*[local-name()="t"]/text()')
            self.assertEqual(set(text),{'{{title}}','{{intro}}','汇总清单','公司名称','{{subject}}','{{site}}','{{result}}','查询记录','{{body}}','{{picture}}','{{signature}}','{{members}}','{{leader}}','{{department}}','{{date}}'})

if __name__=='__main__': unittest.main()
