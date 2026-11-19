import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from lxml import etree as E
from bondbuddy_file_authoring.workpaper_layout import normalize_workpaper_layout,W

class WorkpaperPaginationTest(unittest.TestCase):
    def package(self,path,body):
        with ZipFile(path,'w') as z:
            z.writestr('word/document.xml','<w:document xmlns:w="'+W[1:-1]+'"><w:body>'+body+'</w:body></w:document>')
            z.writestr('word/styles.xml',b'<unchanged/>')
    def table(self,headers=1,rows=3,floating=False):
        return '<w:tbl>'+('<w:tblPr><w:tblpPr/></w:tblPr>' if floating else '')+''.join('<w:tr>'+('<w:trPr><w:tblHeader/></w:trPr>' if i<headers else '')+'<w:tc><w:p><w:r><w:t>'+str(i)+'</w:t></w:r></w:p></w:tc></w:tr>' for i in range(rows))+'</w:tbl>'
    def test_caption_unit_multiline_header_and_first_data_row_are_a_bounded_chain(self):
        with tempfile.TemporaryDirectory() as d:
            before,out,again=[Path(d)/x for x in ('in.docx','out.docx','again.docx')]
            self.package(before,'<w:p><w:r><w:t>普通正文。</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>现金流量表</w:t></w:r></w:p><w:p><w:r><w:t>单位：万元</w:t></w:r></w:p>'+self.table(2,8))
            r=normalize_workpaper_layout(before,out)
            self.assertEqual(r['changed_paragraphs'],4)
            with ZipFile(before) as a,ZipFile(out) as b:
                self.assertEqual(a.read('word/styles.xml'),b.read('word/styles.xml'))
                x,y=[E.fromstring(z.read('word/document.xml')) for z in (a,b)]
                self.assertEqual(x.xpath('//w:t/text()',namespaces={'w':W[1:-1]}),y.xpath('//w:t/text()',namespaces={'w':W[1:-1]}))
                flags=[p.find('./'+W+'pPr/'+W+'keepNext') is not None for p in y.iter(W+'p')]
                self.assertEqual(flags,[False,True,True,True,True]+[False]*6)
            second=normalize_workpaper_layout(out,again)
            self.assertEqual(second['changed_paragraphs'],0)
            self.assertEqual(out.read_bytes(),again.read_bytes())
    def test_unknown_or_floating_table_shapes_remain_exactly_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            for i,table in enumerate([self.table(0),self.table(3),self.table(floating=True)]):
                a,b=Path(d)/('a'+str(i)),Path(d)/('b'+str(i));self.package(a,table)
                self.assertEqual(normalize_workpaper_layout(a,b)['changed_paragraphs'],0)
                self.assertEqual(a.read_bytes(),b.read_bytes())
    def test_explicit_page_break_stops_caption_chaining(self):
        with tempfile.TemporaryDirectory() as d:
            a,b=Path(d)/'a',Path(d)/'b';self.package(a,'<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:br w:type="page"/><w:t>标题</w:t></w:r></w:p>'+self.table())
            r=normalize_workpaper_layout(a,b);self.assertEqual(r['changed_paragraphs'],1)
            self.assertEqual(r['changes'][0]['kind'],'header')

if __name__=='__main__':unittest.main()
