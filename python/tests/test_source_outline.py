"""Synthetic outline diagnostics; no model or business-content acceptance."""
import unittest

from bondbuddy_file_authoring.source_outline import outline, compare_outlines

NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def parts(body, styles=''):
    return {'word/document.xml': f'<w:document xmlns:w="{NS}"><w:body>{body}</w:body></w:document>'.encode(),
            'word/styles.xml': f'<w:styles xmlns:w="{NS}">{styles}</w:styles>'.encode()}


def p(text, props=''):
    return f'<w:p><w:pPr>{props}</w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>'


class SourceOutlineTests(unittest.TestCase):
    def test_numeric_style_ids_inherit_heading_level(self):
        source = parts(p('财务状况', '<w:pStyle w:val="42"/>'),
                       '<w:style w:styleId="42"><w:basedOn w:val="base"/></w:style>'
                       '<w:style w:styleId="base"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>')
        heading = outline(source)['headings'][0]
        self.assertEqual((heading['text'], heading['level'], heading['recognition']), ('财务状况', 1, 'outline'))

    def test_direct_body_level_overrides_inherited_heading(self):
        source = parts(p('第一章为正文提及', '<w:pStyle w:val="Heading1"/><w:outlineLvl w:val="9"/>'),
                       '<w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>')
        self.assertEqual(outline(source)['headings'], [])

    def test_toc_and_page_changes_do_not_change_body_outline(self):
        toc = '<w:pStyle w:val="TOC1"/>'
        source = parts(p('第一章 发行人\t1', toc) + p('第一章 发行人', '<w:outlineLvl w:val="0"/>'))
        changed = parts(p('第一章 发行人\t25', toc) + p('第一章 发行人', '<w:outlineLvl w:val="0"/>'))
        self.assertEqual(outline(source)['toc'], [{'text': '第一章 发行人'}])
        self.assertEqual(len(outline(source)['headings']), 1)
        self.assertEqual(compare_outlines(outline(source), outline(changed))['status'], 'unchanged')

    def test_multiline_toc_field_is_separate_from_headings(self):
        start = '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText> TOC \\o "1-3" </w:instrText><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
        end = '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
        result = outline(parts(start + p('第一章 发行人\t2') + p('第二章 风险\t3') + end + p('第一章 发行人')))
        self.assertEqual([item['text'] for item in result['toc']], ['第一章 发行人', '第二章 风险'])
        self.assertEqual([item['text'] for item in result['headings']], ['第一章 发行人'])

    def test_financial_updates_and_table_labels_do_not_change_outline(self):
        source = parts(p('第一章 财务状况') + p('净资产100万元。') + '<w:tbl><w:tr><w:tc>' + p('一、净资产') + '</w:tc></w:tr></w:tbl>')
        changed = {key: value.replace('100'.encode(), '120'.encode()).replace('一、净资产'.encode(), '二、净资产'.encode()) for key, value in source.items()}
        self.assertEqual(len(outline(source)['headings']), 1)
        self.assertEqual(compare_outlines(outline(source), outline(changed))['status'], 'unchanged')

    def test_consecutive_basic_information_values_are_not_heading_names(self):
        def body(value):
            return (p('一、发行人基本信息') + p('1、发行人名称：合成发行人')
                    + p('2、法定代表人：' + value) + p('3、设立日期：合成日期'))
        source = outline(parts(body('合成人员甲')))
        changed = outline(parts(body('【待人工确认】')))
        self.assertEqual([item['text'] for item in source['headings']], ['一、发行人基本信息'])
        self.assertEqual(compare_outlines(source, changed)['status'], 'unchanged')

    def test_parenthesized_arabic_basic_information_fields_are_not_headings(self):
        source = parts(p('（1）发行人名称：合成发行人') + p('（2）法定代表人：合成人员甲'))
        self.assertEqual(outline(source)['headings'], [])

    def test_explicit_colon_headings_remain_protected_in_information_blocks(self):
        for props, styles in [
            ('<w:outlineLvl w:val="1"/>', ''),
            ('<w:pStyle w:val="Heading2"/>', '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'),
        ]:
            def body(value):
                return p('1、发行人名称：合成发行人') + p('2、法定代表人：' + value, props)
            source = outline(parts(body('合成人员甲'), styles))
            changed = outline(parts(body('合成人员乙'), styles))
            self.assertEqual(len(source['headings']), 1)
            self.assertEqual(compare_outlines(source, changed)['status'], 'changed')

    def test_unknown_isolated_nonconsecutive_and_chinese_rows_fail_closed(self):
        for body in [
            p('1、未知字段：合成值'),
            p('1、法定代表人：合成人员甲'),
            p('1、发行人名称：合成发行人') + p('3、法定代表人：合成人员甲'),
            p('1、法定代表人：合成人员甲') + p('2、法定代表人：合成人员乙'),
            p('一、发行人名称：合成发行人') + p('二、法定代表人：合成人员甲'),
        ]:
            with self.subTest(body=body):
                self.assertTrue(outline(parts(body))['headings'])

    def test_empty_field_values_and_unknown_colon_titles_are_not_exempted(self):
        source = parts(p('1、发行人名称：合成发行人') + p('2、法定代表人：')
                       + p('3、未知字段：合成值') + p('一、风险因素：财务风险'))
        self.assertEqual(len(outline(source)['headings']), 4)
        changed = {key: value.replace('财务风险'.encode(), '经营风险'.encode()) for key, value in source.items()}
        self.assertEqual(compare_outlines(outline(source), outline(changed))['status'], 'changed')

    def test_heading_order_level_and_numbering_changes_are_reported(self):
        source = parts(p('财务状况', '<w:outlineLvl w:val="0"/><w:numPr><w:numId w:val="1"/></w:numPr>') + p('第一章 发行人'))
        for body in [p('第一章 发行人') + p('财务状况', '<w:outlineLvl w:val="0"/>'),
                     p('财务状况', '<w:outlineLvl w:val="1"/>') + p('第一章 发行人'),
                     p('财务状况', '<w:outlineLvl w:val="0"/><w:numPr><w:numId w:val="2"/></w:numPr>') + p('第一章 发行人')]:
            self.assertEqual(compare_outlines(outline(source), outline(parts(body)))['status'], 'changed')

    def test_accepted_heading_revisions_are_not_hidden(self):
        source = parts(p('第一章 发行人'))
        tracked = parts('<w:p><w:del w:id="1" w:author="test"><w:r><w:delText>第一章 发行人</w:delText></w:r></w:del><w:ins w:id="2" w:author="test"><w:r><w:t>第二章 财务状况</w:t></w:r></w:ins></w:p>')
        result = compare_outlines(outline(source), outline(tracked))
        self.assertEqual(result['status'], 'changed')
        self.assertEqual(result['headings']['changes'][0]['after'][0]['text'], '第二章 财务状况')
        self.assertEqual(result['authorization_review'], 'not_performed')
