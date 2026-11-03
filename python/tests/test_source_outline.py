"""Synthetic outline diagnostics; no model or business-content acceptance."""
import unittest

from bondbuddy_file_authoring.source_outline import compare_financial_formulas, outline, compare_outlines

NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def parts(body, styles=''):
    return {'word/document.xml': f'<w:document xmlns:w="{NS}"><w:body>{body}</w:body></w:document>'.encode(),
            'word/styles.xml': f'<w:styles xmlns:w="{NS}">{styles}</w:styles>'.encode()}


def p(text, props=''):
    return f'<w:p><w:pPr>{props}</w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>'


class SourceOutlineTests(unittest.TestCase):
    def test_consecutive_known_arithmetic_formulas_are_body_content(self):
        debt = '1.全部债务=短期借款+一年内到期的非流动负债+长期借款+应付债券+长期应付款中有息债务'
        note = '（有息债务口径下一年内到期的非流动负债扣除应付利息）'
        source = parts(p('一、财务指标') + p(debt) + p('2.流动比率=流动资产/流动负债'))
        changed = parts(p('一、财务指标') + p(debt + note) + p('2.流动比率=流动资产/流动负债'))
        self.assertEqual([h['text'] for h in outline(source)['headings']], ['一、财务指标'])
        self.assertEqual(compare_outlines(outline(source), outline(changed))['status'], 'unchanged')
        result = compare_financial_formulas(source, changed)
        self.assertEqual((result['status'], result['before_count'], result['after_count']), ('unchanged', 2, 2))
        self.assertEqual(result['factual_accuracy'], 'not_verified')

    def test_parenthesized_formulas_and_arithmetic_grouping_are_recognized(self):
        source = parts(p('（1）速动比率=（流动资产-存货）/流动负债')
                       + p('（2）债务资本比率=全部债务/（全部债务+所有者权益）'))
        self.assertEqual(outline(source)['headings'], [])
        self.assertEqual(compare_financial_formulas(source, source)['before_count'], 2)

    def test_explicit_and_inherited_formula_headings_remain_protected(self):
        for props, styles in [
            ('<w:outlineLvl w:val="1"/>', ''),
            ('<w:pStyle w:val="Heading2"/>', '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'),
            ('<w:pStyle w:val="derived"/>', '<w:style w:styleId="derived"><w:basedOn w:val="base"/></w:style>'
             '<w:style w:styleId="base"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'),
            ('<w:pStyle w:val="derived"/>', '<w:style w:styleId="derived"><w:basedOn w:val="Heading2"/></w:style>'),
        ]:
            with self.subTest(props=props, styles=styles):
                first = '1.全部债务=短期借款+长期借款'
                source = parts(p(first, props) + p('2.流动比率=流动资产/流动负债'), styles)
                changed = parts(p(first + '（口径待确认）', props) + p('2.流动比率=流动资产/流动负债'), styles)
                self.assertEqual(len(outline(source)['headings']), 1)
                self.assertEqual(compare_outlines(outline(source), outline(changed))['status'], 'changed')

    def test_formula_exemption_rejects_isolated_unknown_nonarithmetic_and_broken_sequences(self):
        for texts in [
            ['1.流动比率=流动资产/流动负债'],
            ['1.未知比率=流动资产/流动负债', '2.速动比率=（流动资产-存货）/流动负债'],
            ['1.流动比率=流动资产', '2.速动比率=存货'],
            ['1.流动比率=/', '2.速动比率=存货+'],
            ['1.流动比率=流动资产//流动负债', '2.速动比率=（流动资产-存货/流动负债'],
            ['1.流动比率=流动资产/流动负债', '3.速动比率=（流动资产-存货）/流动负债'],
            ['1.流动比率=流动资产/流动负债', '2.流动比率=流动资产/流动负债'],
            ['一、流动比率=流动资产/流动负债', '二、速动比率=（流动资产-存货）/流动负债'],
            ['1.流动比率=流动资产/流动负债', '', '2.速动比率=（流动资产-存货）/流动负债'],
            ['1、长期偿债能力分析'],
        ]:
            with self.subTest(texts=texts):
                source = parts(''.join(p(text) for text in texts))
                self.assertEqual(len(outline(source)['headings']), sum(bool(t) for t in texts))
                self.assertEqual(compare_financial_formulas(source, source)['before_count'], 0)

    def test_formula_exemption_does_not_apply_inside_wrappers_or_toc(self):
        formulas = p('1.流动比率=流动资产/流动负债') + p('2.速动比率=（流动资产-存货）/流动负债')
        wrapped = parts('<w:sdt><w:sdtContent>' + formulas + '</w:sdtContent></w:sdt>')
        self.assertEqual(len(outline(wrapped)['headings']), 2)
        for body in [
            '<w:tbl><w:tr><w:tc>' + formulas + '</w:tc></w:tr></w:tbl>',
            '<w:p><w:r><w:txbxContent>' + formulas + '</w:txbxContent></w:r></w:p>',
            '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>TOC</w:instrText></w:r></w:p>'
            + formulas + '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
        ]:
            with self.subTest(body=body):
                source = parts(body)
                self.assertEqual(compare_financial_formulas(source, source)['before_count'], 0)

    def test_original_formula_identity_order_and_expression_cannot_disappear(self):
        original = ['1.流动比率=流动资产/流动负债', '2.速动比率=（流动资产-存货）/流动负债',
                    '3.资产负债率=负债总计/资产总计']
        source = parts(p('一、财务指标') + ''.join(p(t) for t in original) + p('二、偿债分析'))
        for changed in [
            original[1:], [], original[::-1],
            [original[0].replace('1.', '4.'), original[1].replace('2.', '5.'), original[2].replace('3.', '6.')],
            [original[0].replace('/', '×'), *original[1:]],
            [original[0].replace('流动资产/', '存货/'), *original[1:]],
            [original[0].replace('/流动负债', '/负债总计'), *original[1:]],
            [original[0] + '+1', *original[1:]],
            [original[0] + '(2)', *original[1:]],
            [original[0] + '（流动资产*2）', *original[1:]],
            [original[0] + '（流动资产^2）', *original[1:]],
            [original[0] + '（口径=另一公式）', *original[1:]],
        ]:
            with self.subTest(changed=changed):
                output = parts(p('一、财务指标') + ''.join(p(t) for t in changed) + p('二、偿债分析'))
                self.assertEqual(compare_financial_formulas(source, output)['status'], 'changed')
        relocated = parts(p('一、财务指标') + p('二、偿债分析') + ''.join(p(t) for t in original))
        self.assertEqual(compare_financial_formulas(source, relocated)['status'], 'changed')

    def test_original_note_cannot_be_rewritten_and_long_appended_note_retains_identity(self):
        first, second = '1.全部债务=短期借款+长期借款', '2.流动比率=流动资产/流动负债'
        source = parts(p(first + '（口径包含原定义）') + p(second))
        changed = parts(p(first + '（口径删除原定义）') + p(second))
        self.assertEqual(compare_financial_formulas(source, changed)['status'], 'changed')
        source = parts(p(first) + p(second))
        changed = parts(p(first + '（口径说明' + '待人工核对' * 20 + '）') + p(second))
        self.assertEqual(compare_financial_formulas(source, changed)['status'], 'unchanged')

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
