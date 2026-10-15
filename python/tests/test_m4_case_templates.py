import json
from pathlib import Path
import re
import tempfile
import unittest
from zipfile import ZipFile
from hashlib import sha256
from lxml import etree as E
from docx import Document
from bondbuddy_m4_render_template import fill

ROOT=Path(__file__).resolve().parents[2]
BUNDLE=ROOT/'knowledge/material-drafting/2026-10-15'

class CaseTemplateTests(unittest.TestCase):
    def test_all_templates_are_fact_free_and_filling_preserves_package_formatting(self):
        catalog=json.loads((BUNDLE/'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(catalog['templates']),11)
        for entry in catalog['templates']:
            with self.subTest(template=entry['id']),tempfile.TemporaryDirectory() as tmp:
                path=ROOT/entry['template_path']
                self.assertEqual(sha256(path.read_bytes()).hexdigest(),entry['template_sha256'])
                doc=Document(path)
                with ZipFile(path) as z:
                    originals={n:z.read(n) for n in z.namelist()}
                self.assertFalse(any(re.search(r'media|embeddings|comments|customXml|docProps',n) for n in originals))
                visible=''.join(E.fromstring(originals['word/document.xml']).itertext())
                self.assertNotRegex(visible,r'芜湖|徐州|河北铭鉴|中审亚太|莫森泰克|光大证券|周平|王世伟|7\.92|27\.20|国投证券|江苏同凯|天衡会计|沧州|惠滨|任丘|刘秋明|安徽承义|天健会计|新闸路|财富广场')
                values={m:'合成测试填写' for m in re.findall(r'\{\{([^{}]+)\}\}',visible)}
                body=next(k for k in values if k.startswith('内容_'))
                values[body]=['第一段合成正文','第二段合成正文']
                out=Path(tmp)/'filled.docx';fill(path,values,out)
                result=Document(out)
                self.assertEqual(len(result.sections),len(doc.sections))
                self.assertEqual([(s.page_width,s.page_height,s.left_margin,s.right_margin) for s in doc.sections],[(s.page_width,s.page_height,s.left_margin,s.right_margin) for s in result.sections])
                with ZipFile(out) as z:
                    for name,data in originals.items():
                        if name!='word/document.xml':self.assertEqual(z.read(name),data,name)
                    self.assertNotIn('{{',z.read('word/document.xml').decode())
                self.assertIn('第二段合成正文','\n'.join(p.text for p in result.paragraphs))

    def test_unknown_slots_and_overwriting_template_fail(self):
        path=BUNDLE/'templates/nafmii-ppn-recommendation.docx'
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):fill(path,{'invented':'bad'},Path(tmp)/'out.docx')
            with self.assertRaises(ValueError):fill(path,{},path)

    def test_sse_opinion_keeps_its_own_cover_sections_and_landscape_table(self):
        path=BUNDLE/'templates/sse-private-underwriter.docx'
        doc=Document(path)
        paragraphs=[p.text for p in doc.paragraphs if p.text]
        self.assertEqual(paragraphs[:3],['{{主承销商全称}}关于','{{发行人全称}}',
            '{{发行年份}}年面向专业投资者非公开发行公司债券的核查意见'])
        self.assertIn('上海证券交易所：',paragraphs)
        self.assertEqual(len(doc.sections),7)
        self.assertEqual(sum(s.page_width>s.page_height for s in doc.sections),1)
        self.assertEqual(len(doc.tables),22)
        self.assertEqual(len(doc.tables[1].rows),12)
        self.assertEqual(len(doc.tables[-1].rows),10)
        signature=''.join(cell.text for row in doc.tables[-1].rows for cell in row.cells)
        for role in ['法定代表人或授权代表：','债务融资业务负责人：','内核负责人：','项目负责人：']:
            self.assertIn(role,signature)
        for title in ['内核关注的主要问题及解决情况','报告期内更换会计师事务所情况的核查',
                      '公司债券审核及后续过程中发生中止或终止情形的核查']:
            self.assertIn(title,paragraphs)
        terms=[p for p in paragraphs if '{{发行条款_' in p]
        self.assertEqual(len(terms),30)
        self.assertTrue(terms[0].startswith('1、发行主体：'))
        self.assertTrue(terms[-1].startswith('30、税务提示：'))
        for heading in ['第一节 发行人基本情况','第二节 本次公司债券主要发行条款',
                        '第三节 承销商对本次债券发行的核查意见','第四节 主承销商内核程序及内核意见','第五节 主承销商承诺']:
            self.assertIn(heading,paragraphs)

if __name__=='__main__':unittest.main()
