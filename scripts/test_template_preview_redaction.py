import unittest
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as E
from template_preview_redaction import sanitize_docx,assert_safe_preview,W,NS

class PreviewRedactionTest(unittest.TestCase):
    def test_unknown_names_values_fields_and_media_never_enter_preview(self):
        parts={
          'word/document.xml':f'''<w:document xmlns:w="{W}" xmlns:r="r"><w:body>
            <w:p><w:r><w:t>甲乙样本企业有限公司</w:t></w:r></w:p>
            <w:p><w:r><w:t>姓名：</w:t></w:r><w:r><w:t>隐私甲</w:t></w:r></w:p>
            <w:p><w:r><w:t>注册地址：某处99号</w:t></w:r></w:p>
            <w:p><w:r><w:t>财务金额 9876543，电话 13800001234</w:t></w:r></w:p>
            <w:p><w:fldSimple w:instr="HYPERLINK https://private.invalid"><w:r><w:t>历史人员乙</w:t></w:r></w:fldSimple></w:p>
            <w:p><w:r><w:drawing><w:t>图片上的签名丙</w:t></w:drawing></w:r></w:p>
            <w:p><w:del w:author="审阅丁"><w:r><w:delText>旧人员名</w:delText></w:r></w:del></w:p>
            <w:tbl><w:tblPr><w:tblW w:w="8400" w:type="dxa"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>职务</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>某企业总经理</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>''',
          'word/header1.xml':f'<w:hdr xmlns:w="{W}"><w:p><w:r><w:t>甲乙样本企业有限公司</w:t></w:r></w:p></w:hdr>',
          'word/footer1.xml':f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:t>编制人隐私甲</w:t></w:r></w:p></w:ftr>',
          'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="image" Target="media/name.png"/><Relationship Id="r2" Type="hyperlink" TargetMode="External" Target="mailto:someone@private.invalid"/></Relationships>',
          'docProps/core.xml':'<root>审阅丁</root>',
          'docProps/custom.xml':'<root>审阅丁</root>',
          '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r2" Type="custom-properties" Target="docProps/custom.xml"/></Relationships>',
          'word/comments.xml':f'<w:comments xmlns:w="{W}"><w:t>旧人员名</w:t></w:comments>',
          'word/media/name.png':'RAW_PRIVATE_IMAGE',
        }
        src=BytesIO()
        with ZipFile(src,'w',ZIP_DEFLATED) as z:
            for name,text in parts.items():z.writestr(name,text)
        raw=src.getvalue();clean,text=sanitize_docx(raw,'核查记录')
        assert_safe_preview(clean,title='核查记录')
        self.assertIn('姓名：【人员信息】',text)
        self.assertIn('注册地址：【本项信息】',text)
        self.assertIn('职务',text)
        with ZipFile(BytesIO(clean)) as z:
            published=''.join(z.read(n).decode() for n in z.namelist())
            for secret in ['甲乙样本企业','隐私甲','99号','9876543','13800001234','历史人员乙','签名丙','审阅丁','旧人员名','private.invalid','RAW_PRIVATE_IMAGE','某企业总经理']:
                self.assertNotIn(secret,published)
            document=E.fromstring(z.read('word/document.xml'))
            self.assertEqual(len(document.findall('.//w:tbl/w:tr/w:tc',NS)),2)
            self.assertEqual(document.find('.//w:tblW',NS).get(f'{{{W}}}w'),'8400')
            self.assertEqual(document.find('.//w:pgSz',NS).get(f'{{{W}}}h'),'16838')
            self.assertNotIn('docProps/custom.xml',z.read('_rels/.rels').decode())
        self.assertEqual(src.getvalue(),raw)

    def test_bare_aliases_and_unknown_person_names_are_replaced_without_ner(self):
        from template_preview_redaction import generic_text
        for value in ['老企业简称','张三','王 小明','987654321','none@example.org','秘密事实\n下一行']:
            self.assertEqual(generic_text(value),'【本项目内容】')
        self.assertEqual(generic_text('核查内容'),'核查内容')

if __name__=='__main__':unittest.main()
