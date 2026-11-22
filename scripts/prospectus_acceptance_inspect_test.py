"""Synthetic reader exercises, including an authorized template-layout fixture.

No test represents a real generation, human review, or release acceptance.
"""
import copy
import hashlib
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from prospectus_acceptance_inspect import Reader, compact, metric_ok, period_ok, EXTENDED, STOCK, extended_lists, FinancialSources, SOURCE_BINDINGS, POLICY, RATIO_METRIC
from bondbuddy_file_authoring.word_patch import leaves, paragraph_text, serialized, xml


class FinancialFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bb-synthetic-caption-reader-')
        self.path = str(Path(self.temp.name) / 'synthetic.docx')

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def cell(table, row, cell):
        return f'word/document.xml#table={table},row={row},cell={cell}'

    @staticmethod
    def p(number):
        return f'word/document.xml//w:p[{number}]'

    def locator(self, *, table=1, row=2, amount_cell=2, period_row=1, period_cell=2, caption=1):
        return {'locator': self.cell(table, row, amount_cell),
                'period_anchor': {'locator': self.cell(table, period_row, period_cell), 'quote': '2025年9月末'},
                'metric_anchor': {'locator': self.cell(table, row, 1), 'quote': '资产总计'},
                'scope_anchor': {'locator': self.p(caption), 'quote': '表5-1 发行人合并资产负债表'}}

    def save(self, doc):
        doc.save(self.path)

    def read(self, spec, *, scope='consolidated', metric='total_assets', value='100.00'):
        return Reader().output_value(self.path, spec, {'scope': scope, 'metric': metric, 'output': {'value': value}})

    def rejected(self, spec, **kwargs):
        with self.assertRaises((ValueError, KeyError, IndexError)):
            self.read(spec, **kwargs)

    def simple(self, title='表5-1 发行人合并资产负债表'):
        doc = Document()
        doc.add_paragraph(title)
        doc.add_paragraph('单位：万元')
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2025年9月末'
        table.cell(1, 0).text = '资产总计'
        table.cell(1, 1).text = '100.00'
        self.save(doc)
        return doc, table

class FinancialGeometry(FinancialFixture):
    def test_adjacent_caption_binding(self):
        doc, _ = self.simple()
        spec = self.locator()
        self.read(spec)
        partial = copy.deepcopy(spec)
        partial['scope_anchor']['quote'] = '合并'
        self.rejected(partial)
        for title in ('表5-1 母公司资产负债表', '表5-1 合并及母公司资产负债表',
                      '表5-1 备考合并资产负债表', '表5-1 发行后合并资产负债表', '表5-1 合并利润表',
                      '表5-1 子公司甲合并资产负债表', '表5-1 甲集团合并资产负债表',
                      '表5-1 发行人和甲集团合并资产负债表', '表5-1 发行人和甲公司合并资产负债表',
                      '表5-1 发行人子公司合并资产负债表', '表5-10 最近两年及一期行人合并报表口径主要财务指标'):
            self.simple(title)
            spec['scope_anchor']['quote'] = title
            self.rejected(spec)
        # A nearby correct title cannot authorize a different table beyond it.
        doc, _ = self.simple()
        other = doc.add_table(rows=2, cols=2)
        other.cell(0, 1).text = '2025年9月末'
        other.cell(1, 0).text = '资产总计'
        other.cell(1, 1).text = '100.00'
        self.save(doc)
        self.rejected(self.locator(table=2))
        # Neither an intervening paragraph nor a conflicting caption is transparent.
        doc, table = self.simple()
        note = doc.add_paragraph('本段另行说明母公司口径')
        table._tbl.addprevious(note._p)
        self.save(doc)
        self.rejected(self.locator())
        # A genuinely omitted leading grid cell changes the physical index.
        doc, table = self.simple()
        header = table._tbl.findall(qn('w:tr'))[0]
        header.remove(header.findall(qn('w:tc'))[0])
        before = OxmlElement('w:gridBefore')
        before.set(qn('w:val'), '1')
        header.get_or_add_trPr().append(before)
        self.save(doc)
        self.read(self.locator(period_cell=1))

    def test_lower_competing_scope_overrides_an_earlier_scope_row(self):
        doc = Document()
        table = doc.add_table(rows=4, cols=2)
        for r, values in enumerate((('合并', ''), ('母公司', ''), ('项目', '2025年9月末'), ('资产总计', '100.00'))):
            for c, value in enumerate(values):
                table.cell(r, c).text = value
        self.save(doc)
        spec = self.locator(row=4, period_row=3)
        spec['scope_anchor'] = {'locator': self.cell(1, 1, 1), 'quote': '合并'}
        self.rejected(spec)
        table.cell(1, 0).text = ''
        self.save(doc)
        self.read(spec)
        doc, table = self.simple()
        title = doc.add_paragraph('表5-2 母公司资产负债表')
        table._tbl.addprevious(title._p)
        self.save(doc)
        self.rejected(self.locator())

    def test_gridspan_subcolumns_and_overridden_headers(self):
        doc = Document()
        doc.add_paragraph('表5-1 发行人合并资产负债表')
        table = doc.add_table(rows=3, cols=5)
        table.cell(0, 1).merge(table.cell(0, 2)).text = '2025年9月末'
        table.cell(0, 3).merge(table.cell(0, 4)).text = '2024年末'
        for i, value in enumerate(('项目', '金额', '比例', '金额', '比例')):
            table.cell(1, i).text = value
        for i, value in enumerate(('资产总计', '100.00', '100.00', '100.00', '100.00')):
            table.cell(2, i).text = value
        self.save(doc)
        self.read(self.locator(row=3))
        self.rejected(self.locator(row=3, amount_cell=3))  # percentage under same merged period
        self.rejected(self.locator(row=3, amount_cell=4))  # equal historical value
        wrong = self.locator(row=3, amount_cell=4, period_cell=3)
        wrong['period_anchor']['quote'] = '2024年末'
        self.rejected(wrong)
        # Even citing the older header's target substring cannot hide two periods.
        table.cell(0, 1).text = '2025年9月末/2024年末'
        self.save(doc)
        self.rejected(self.locator(row=3))
        # A later (wrong) period in the same column overrides a higher valid one.
        table.cell(0, 1).text = '2025年9月末'
        table.cell(1, 1).text = '2025年6月末'
        self.save(doc)
        self.rejected(self.locator(row=3))
        # Do not silently duplicate a vertical merged amount or infer its label.
        doc, table = self.simple()
        merge = OxmlElement('w:vMerge')
        merge.set(qn('w:val'), 'restart')
        table.cell(1, 1)._tc.get_or_add_tcPr().append(merge)
        self.save(doc)
        self.rejected(self.locator())
        # An invalid/overlapping logical grid cannot fall back to physical columns.
        doc, table = self.simple()
        span = OxmlElement('w:gridSpan')
        span.set(qn('w:val'), '2')
        table.cell(1, 1)._tc.get_or_add_tcPr().append(span)
        self.save(doc)
        self.rejected(self.locator())

    def test_section_scope_is_structured_bounded_and_explicit(self):
        def make(*, boundary=False, conflict=False, switch=None, intro_after_note=False, caption_text='表5-11 发行人资产结构情况'):
            doc = Document()
            doc.add_heading('五、管理层讨论与分析', 2)
            if intro_after_note:
                doc.add_paragraph('先行无口径说明。')
            intro = doc.add_paragraph('发行人管理层结合公司的合并财务报表进行了如下分析：')
            doc.add_heading('（一）资产分析', 3)
            if boundary:
                doc.add_heading('六、其他财务事项', 2)
            if conflict:
                # Unstyled but explicit competing scope still terminates inheritance.
                doc.add_paragraph('（二）母公司财务报表分析')
            if switch:
                doc.add_paragraph('以下列示母公司' + switch + '：')
            caption = doc.add_paragraph(caption_text)
            table = doc.add_table(rows=2, cols=2)
            table.cell(0, 1).text = '2025年9月末'
            table.cell(1, 0).text = '资产总计'
            table.cell(1, 1).text = '100.00'
            self.save(doc)
            paragraphs = list(doc._element.iter(qn('w:p')))
            index = lambda p: self.p(paragraphs.index(p._p) + 1)
            spec = self.locator()
            spec['scope_anchor'] = {'locator': index(intro), 'quote': intro.text}
            spec['scope_section_anchor'] = {'locator': self.p(1), 'quote': '五、管理层讨论与分析'}
            spec['table_caption'] = {'locator': index(caption), 'quote': caption.text}
            return spec
        self.read(make())
        self.rejected(make(boundary=True))
        self.rejected(make(conflict=True))
        for switch in ('资产负债表', '利润表', '现金流量表'):
            self.rejected(make(switch=switch))
        self.rejected(make(intro_after_note=True))
        for caption in ('表5-11 子公司甲资产结构情况', '表5-11 甲集团资产结构情况', '表5-11 发行人和甲公司资产结构情况'):
            self.rejected(make(caption_text=caption))
        spec = make()
        del spec['scope_section_anchor']
        self.rejected(spec)
        spec = make()
        spec['table_caption'] = spec['scope_section_anchor']
        self.rejected(spec)


class FinancialLabels(unittest.TestCase):
    def test_metric_labels_cannot_be_subtotals_or_attributions(self):
        for value in ('资产总计', '总资产', '资产合计'):
            self.assertTrue(metric_ok(value, 'total_assets', cell=True))
        for value in ('流动资产合计', '非流动资产合计', '其他资产合计', '净资产总计'):
            self.assertFalse(metric_ok(value, 'total_assets', cell=True), value)
        for value in ('流动负债合计', '非流动负债合计'):
            self.assertFalse(metric_ok(value, 'total_liabilities', cell=True), value)
        for value in ('归属于母公司所有者权益合计', '少数股东权益', '负债和所有者权益总计'):
            self.assertFalse(metric_ok(value, 'net_assets', cell=True), value)
        for value in ('归属于母公司所有者的净利润', '持续经营净利润', '终止经营净利润'):
            self.assertFalse(metric_ok(value, 'net_profit', cell=True), value)
        self.assertTrue(metric_ok('五、净利润（净亏损“-”填列）', 'net_profit', cell=True))
        for value in ('非流动资产合计', '流动资产合计'):
            self.assertFalse(metric_ok('2025年9月末' + value + '100万元', 'total_assets'))
        self.assertFalse(metric_ok('2025年9月末净资产总计100万元', 'total_assets'))
        self.assertFalse(metric_ok('2025年9月末净资产收益率100万元', 'net_assets'))
        self.assertFalse(metric_ok('2025年1-9月归属于母公司所有者的净利润100万元', 'net_profit'))

    def test_combined_periods_are_explicit_and_consistent(self):
        for metric in ('total_assets', 'net_profit'):
            for value in ('2025年1-9月/9月末', '2025年1-9月／2025年9月30日'):
                self.assertTrue(period_ok(value, metric, cell=True))
            for value in ('2025年1-9月/6月末', '2025年1-9月/2024年9月末',
                          '2025年1-6月/9月末', '2025年1-9月/末', '2025年1-9月/9月末/2024年末'):
                self.assertFalse(period_ok(value, metric, cell=True), value)
        self.assertFalse(period_ok('2025年9月末', 'net_profit', cell=True))
        self.assertFalse(period_ok('2025年1-9月', 'total_assets', cell=True))


class NarrativeLists(FinancialFixture):
    def example(self, quote, *, metric='net_profit', value='13.00', defined=False, context=False,
                boundary=False, no_term=False, fake_glossary=False, period_redefinition=False):
        doc = Document()
        glossary = doc.add_heading('释义', 1)
        if fake_glossary:
            glossary.style = doc.styles['Normal']
        doc.add_paragraph('在本募集说明书中，除非文中另有所指，下列词语具有如下含义：')
        table = doc.add_table(rows=2, cols=3)
        table.cell(0, 0).text = '最近两年及一期'
        table.cell(0, 1).text = '指'
        table.cell(0, 2).text = '2023年度、2024年度和2025年1-9月'
        table.cell(1, 0).text = '最近两年及一期末'
        table.cell(1, 2).text = '2023年末、2024年末和2025年9月末'
        section = doc.add_heading('五、管理层讨论与分析', 2)
        intro = doc.add_paragraph('发行人管理层结合公司' + ('' if no_term else '最近两年及一期的') + '合并财务报表进行了如下分析：')
        if boundary:
            doc.add_heading('六、其他财务事项', 2)
        if period_redefinition:
            doc.add_paragraph('本节报告期为2023年度、2024年度和2025年1-6月。')
        paragraph = doc.add_paragraph(quote)
        self.save(doc)
        paragraphs = list(doc._element.iter(qn('w:p')))
        anchor = lambda p: {'locator': self.p(paragraphs.index(p._p) + 1), 'quote': p.text}
        spec = {'locator': anchor(paragraph)['locator'], 'quote': quote, 'narrative_list': True,
                'start': quote.rindex(value), 'end': quote.rindex(value) + len(value), 'scope_anchor': anchor(intro)}
        if defined:
            r = 2 if metric in STOCK else 1
            spec['reporting_period_definition'] = {'section_anchor': anchor(glossary),
                'term_anchor': {'locator': self.cell(1, r, 1), 'quote': table.cell(r - 1, 0).text},
                'definition_anchor': {'locator': self.cell(1, r, 3), 'quote': table.cell(r - 1, 2).text}}
        if context:
            spec['period_context'] = {'section_anchor': anchor(section), 'introduction_anchor': anchor(intro)}
        return spec

    def check(self, spec, *, metric='net_profit', value='13.00'):
        return Reader().output_value(self.path, spec, {'scope': 'consolidated', 'metric': metric,
            'output': {'value': value, 'unit': 'CNY_10K', 'decimal_places': 2}})

    def invalid(self, spec, **kwargs):
        with self.assertRaises((ValueError, KeyError, IndexError)):
            self.check(spec, **kwargs)

    def test_explicit_list_selects_target_by_period_not_equal_historical_value(self):
        quote = '2023年度、2024年度和2025年1-9月，发行人净利润分别为13.00万元、2.00万元和13.00万元。'
        spec = self.example(quote)
        self.check(spec)
        wrong = copy.deepcopy(spec)
        wrong['start'] = quote.index('13.00')
        wrong['end'] = wrong['start'] + len('13.00')
        self.invalid(wrong)
        wrong = copy.deepcopy(spec)
        del wrong['narrative_list']
        self.invalid(wrong)
        for bad in (
            quote.replace('2023年度、2024年度', '2024年度、2023年度'),
            quote.replace('2024年度', '2025年1-9月'),
            quote.replace('2025年1-9月', '2025年1-6月'),
            quote.replace('13.00万元、2.00万元和', '2.00万元和'),
            quote.replace('、2.00万元和', '、2.00万元、3.00万元和'),
            quote.replace('2.00万元', '2.00亿元'),
            quote.replace('2.00万元', '2.0万元'),
            quote.replace('发行人净利润', '归属于母公司所有者的净利润'),
            quote.replace('发行人净利润', '子公司净利润'),
            quote.replace('发行人净利润', '担保人净利润'),
            quote.replace('发行人净利润', '发行人备考净利润'),
            quote + '营业收入为1.00万元。',
        ):
            self.invalid(self.example(bad))

    def test_glossary_term_requires_actual_section_row_and_target_definition(self):
        quote = '最近两年及一期末，发行人资产总额分别为1.00万元、2.00万元及13.00万元。'
        spec = self.example(quote, metric='total_assets', defined=True)
        self.check(spec, metric='total_assets')
        self.invalid(self.example(quote, metric='total_assets'), metric='total_assets')
        self.invalid(self.example(quote, metric='total_assets', defined=True, fake_glossary=True), metric='total_assets')
        spec = self.example(quote, metric='total_assets', defined=True)
        spec['reporting_period_definition']['term_anchor'] = {'locator': self.cell(1, 1, 1), 'quote': '最近两年及一期'}
        self.invalid(spec, metric='total_assets')
        spec = self.example(quote, metric='total_assets', defined=True)
        spec['reporting_period_definition']['definition_anchor'] = {'locator': self.cell(1, 1, 3), 'quote': '2023年度、2024年度和2025年1-9月'}
        self.invalid(spec, metric='total_assets')
        spec = self.example(quote, metric='total_assets', defined=True)
        spec['reporting_period_definition']['definition_anchor'] = spec['scope_anchor']
        self.invalid(spec, metric='total_assets')

    def test_actual_clause_boundaries_prevent_cropped_period_or_amount_lists(self):
        actual = '2022年度、2023年度、2024年度和2025年1-9月，发行人净利润分别为1.00万元、2.00万元、13.00万元和99.00万元。'
        spec = self.example(actual)
        spec['quote'] = actual[actual.index('2023年度'):actual.index('13.00万元') + len('13.00万元')]
        spec['start'] = spec['quote'].index('13.00')
        spec['end'] = spec['start'] + len('13.00')
        self.invalid(spec)
        actual = '2023年度、2024年度和2025年1-9月，发行人净利润分别为1.00万元、2.00万元、13.00万元和99.00万元。'
        spec = self.example(actual)
        spec['quote'] = actual[:actual.index('13.00万元') + len('13.00万元')]
        spec['start'] = spec['quote'].index('13.00')
        spec['end'] = spec['start'] + len('13.00')
        self.invalid(spec)
        quote = '2023年度、2024年度和2025年1-9月，发行人净利润分别为1.00万元、2.00万元和13.00万元。'
        for prefix in ('本段采用母公司口径。', '以下分析子公司甲。', '以下数据为备考数据。'):
            spec = self.example(prefix + quote)
            spec['quote'] = quote
            spec['start'], spec['end'] = quote.rindex('13.00'), quote.rindex('13.00') + len('13.00')
            self.invalid(spec)

    def test_report_period_needs_bounded_section_intro_referencing_defined_term(self):
        quote = '报告期内，发行人净利润分别为1.00万元、2.00万元及13.00万元；'
        spec = self.example(quote, defined=True, context=True)
        self.check(spec)
        for flags in ({'defined': True}, {'defined': True, 'context': True, 'boundary': True},
                      {'defined': True, 'context': True, 'no_term': True},
                      {'defined': True, 'context': True, 'period_redefinition': True}):
            self.invalid(self.example(quote, **flags))
        spec = self.example(quote, defined=True, context=True)
        spec['period_context']['section_anchor'] = spec['scope_anchor']
        self.invalid(spec)

    def test_complete_actual_default_scope_clause_cannot_be_carved_or_duplicated(self):
        quote = '2023年度、2024年度和2025年1-9月，发行人净利润分别为1.00万元、2.00万元和13.00万元。'
        spec = self.example(quote)
        default = '本募集说明书其他章节中若无特殊说明，则财务数据及财务指标均为合并口径。'
        doc = Document(self.path)
        p = doc.add_paragraph('本节先结合母公司财务报表。' + default)
        self.save(doc)
        spec['scope_anchor'] = {'locator': self.p(list(doc._element.iter(qn('w:p'))).index(p._p) + 1), 'quote': default}
        self.check(spec)
        spec['scope_anchor']['quote'] = '合并'
        self.invalid(spec)
        spec['scope_anchor']['quote'] = default
        doc.add_paragraph(default)
        self.save(doc)
        self.invalid(spec)


class AuthorizedTemplateLayout(unittest.TestCase):
    def test_rq_caption_section_grid_and_split_flow_headers(self):
        root = Path(__file__).resolve().parents[1]
        folder = root / 'tests/samples/2026-09-25'
        manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
        case = next(c for c in manifest['cases'] if c['case_id'] == 'rq-202509')
        material = next(f for f in case['files'] if f['file_id'] == 'rq-202509-01')
        source = folder / material['path']
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), material['sha256'])
        with tempfile.TemporaryDirectory(prefix='bb-synthetic-rq-layout-only-') as directory:
            path = str(Path(directory) / 'synthetic-header-layout-only.docx')
            # Fixed synthetic period edits exercise layout; financial content stays historical.
            with ZipFile(source) as before, ZipFile(path, 'w') as after:
                for entry in before.infolist():
                    raw = before.read(entry.filename)
                    if entry.filename == 'word/document.xml':
                        document = xml(raw)
                        for paragraph in document.iter(qn('w:p')):
                            if compact(paragraph_text(paragraph)) in ('2025年6月末', '2025年1-6月', '2025年1-6月/6月末'):
                                for text in paragraph.iter(qn('w:t')):
                                    text.text = (text.text or '').replace('6', '9')
                            else:
                                text = paragraph_text(paragraph)
                                positions = [m.start() + m[0].rindex('6') for m in re.finditer(r'2025\s*年\s*(?:1\s*[-—–至]\s*)?6\s*月', text)]
                                for leaf, _, start, end in leaves(paragraph):
                                    if leaf.tag == qn('w:t'):
                                        value = list(leaf.text or '')
                                        for position in positions:
                                            if start <= position < end:
                                                value[position - start] = '9'
                                        leaf.text = ''.join(value)
                        raw = serialized(document)
                    after.writestr(entry, raw)
            reader = Reader(source=source, issuer=case['issuer'])
            verified = []
            checked_specs = []
            p = lambda n: f'word/document.xml//w:p[{n}]'
            cell = lambda t, r, c: f'word/document.xml#table={t},row={r},cell={c}'
            def anchor(locator):
                return {'locator': locator, 'quote': reader.node(path, locator)['text']}
            cases = [
                (44, 26, 2, 1, 2, 3019, 'total_assets', 'consolidated'),
                (44, 48, 2, 1, 2, 3019, 'total_liabilities', 'consolidated'),
                (44, 59, 2, 1, 2, 3019, 'net_assets', 'consolidated'),
                (45, 25, 2, 1, 2, 3262, 'net_profit', 'consolidated'),
                (46, 12, 2, 1, 2, 3413, 'operating_cash_flow', 'consolidated'),
                (47, 24, 2, 1, 2, 3581, 'total_assets', 'parent'),
                (47, 43, 2, 1, 2, 3581, 'total_liabilities', 'parent'),
                (47, 50, 2, 1, 2, 3581, 'net_assets', 'parent'),
                (48, 24, 2, 1, 2, 3788, 'net_profit', 'parent'),
                (49, 12, 2, 1, 2, 3899, 'operating_cash_flow', 'parent'),
                (54, 2, 2, 1, 2, 0, 'total_assets', 'consolidated'),
                (54, 3, 2, 1, 2, 0, 'total_liabilities', 'consolidated'),
                (54, 5, 2, 1, 2, 0, 'net_assets', 'consolidated'),
                (54, 9, 2, 6, 2, 0, 'net_profit', 'consolidated'),
                (54, 10, 2, 6, 2, 0, 'operating_cash_flow', 'consolidated'),
                (55, 5, 2, 1, 2, 0, 'total_assets', 'consolidated'),
                (79, 5, 2, 1, 2, 0, 'total_liabilities', 'consolidated'),
                (98, 15, 2, 1, 2, 0, 'net_profit', 'consolidated'),
                (45, 22, 2, 1, 2, 3262, 'nonoperating_expenses', 'consolidated'),
                (48, 21, 2, 1, 2, 3788, 'nonoperating_expenses', 'parent'),
                (44,45,2,1,2,3019,'deferred_income','consolidated'),
                (45,7,2,1,2,3262,'sales_expenses','consolidated'),
                (45,8,2,1,2,3262,'administrative_expenses','consolidated'),
                (45,10,2,1,2,3262,'finance_expenses','consolidated'),
                (45,14,2,1,2,3262,'investment_income','consolidated'),
                (45,30,2,1,2,3262,'profit_attributable_to_parent','consolidated'),
                (44,42,2,1,2,3019,'bonds_payable','consolidated'),
                (47,38,2,1,2,3581,'bonds_payable','parent'),
            ]
            for t, r, c, pr, pc, caption_number, metric, scope in cases:
                with self.subTest(table=t, row=r, metric=metric):
                    location = cell(t, r, c)
                    amount = reader.node(path, location)
                    spec = {'locator': location, 'metric_anchor': anchor(cell(t, r, 1)),
                            'period_anchor': anchor(cell(t, pr, pc))}
                    caption = reader.caption(amount['table'])
                    if t == 54:
                        caption_number = list(amount['root'].iter(qn('w:p'))).index(caption) + 1
                    if caption_number:
                        spec['scope_anchor'] = anchor(p(caption_number))
                    else:
                        spec['scope_anchor'] = anchor(p(4780))
                        spec['scope_section_anchor'] = anchor(p(4779))
                        caption_number = list(amount['root'].iter(qn('w:p'))).index(caption) + 1
                        spec['table_caption'] = anchor(p(caption_number))
                    row = {'scope': scope, 'metric': metric,
                           'output': {'value': amount['text'].replace(',', '').strip(), 'unit': 'CNY_10K'}}
                    identity = reader.output_value(path, spec, row)
                    verified.append({'scope': scope, 'metric': metric, 'kind': 'table', 'identity': identity})
                    checked_specs.append((copy.deepcopy(verified[-1]), copy.deepcopy(spec), copy.deepcopy(row)))
                    if t == 54 and metric == 'total_assets':
                        # The misspelled source caption is not a generic alias:
                        # a changed source, unknown issuer or another table fails.
                        for unbound in (Reader(source=path, issuer=case['issuer']), Reader(source=source, issuer='Other issuer')):
                            with self.assertRaises(ValueError):
                                unbound.output_value(path, spec, row)
                        with self.assertRaises(ValueError):
                            reader.issuer_scope(spec['scope_anchor']['quote'], {'table_index': 54, 'story': 'word/header1.xml'})
                    wrong = copy.deepcopy(spec)
                    wrong['scope_anchor'] = anchor(p(3581 if scope == 'consolidated' else 3019))
                    with self.assertRaises(ValueError):
                        reader.output_value(path, wrong, row)
                    if t == 54 and metric == 'net_profit':
                        wrong = copy.deepcopy(spec)
                        wrong['period_anchor'] = anchor(cell(t, 1, 2))
                        with self.assertRaises(ValueError):
                            reader.output_value(path, wrong, row)
                    if t == 55:
                        for column in (3, 4, 6):
                            wrong = copy.deepcopy(spec)
                            wrong['locator'] = cell(t, r, column)
                            different = copy.deepcopy(row)
                            different['output']['value'] = reader.node(path, wrong['locator'])['text'].replace(',', '')
                            with self.assertRaises(ValueError):
                                reader.output_value(path, wrong, different)
            for paragraph_number, metric in ((46, 'operating_cash_flow'), (285, 'operating_cash_flow'),
                    (4816, 'total_assets'), (6865, 'total_liabilities'), (7967, 'net_profit'), (8017, 'operating_cash_flow'),
                    (7931, 'nonoperating_expenses'), (7605,'deferred_income'), (7838,'sales_expenses'),
                    (7840,'administrative_expenses'), (7842,'finance_expenses'), (7870,'investment_income'),
                    (7967,'profit_attributable_to_parent'), (7403,'bonds_payable')):
                with self.subTest(paragraph=paragraph_number, metric=metric):
                    location = p(paragraph_number)
                    text = reader.node(path, location)['text']
                    if paragraph_number in (46, 285):
                        start = text.index('2023年度')
                        finish = text.index('万元。', start) + len('万元。')
                        quote = text[start:finish]
                        scope = {'locator': p(44), 'quote': '本募集说明书其他章节中若无特殊说明，则财务数据及财务指标均为合并口径。'}
                    else:
                        quote = extended_lists(text, metric)[0]['quote'] if metric in EXTENDED else text if paragraph_number == 7931 else text[:text.index('；') + 1] if paragraph_number == 7967 else text[:text.index('。') + 1]
                        scope = anchor(p(4780))
                    selected = list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*万元', quote))[-1]
                    spec = {'locator': location, 'quote': quote, 'narrative_list': True,
                        'start': selected.start(1), 'end': selected.end(1), 'scope_anchor': scope}
                    if paragraph_number not in (46, 285):
                        r = 29 if metric in STOCK else 28
                        spec['reporting_period_definition'] = {'section_anchor': anchor(p(164)),
                            'term_anchor': anchor(cell(2, r, 1)), 'definition_anchor': anchor(cell(2, r, 3))}
                    if paragraph_number in (7931, 7967) or metric in EXTENDED and metric not in STOCK:
                        spec['period_context'] = {'section_anchor': anchor(p(4779)), 'introduction_anchor': anchor(p(4780))}
                    row = {'scope': 'consolidated', 'metric': metric,
                        'output': {'value': selected[1].replace(',', ''), 'unit': 'CNY_10K', 'decimal_places': 2}}
                    identity = reader.output_value(path, spec, row)
                    verified.append({'scope': 'consolidated', 'metric': metric, 'kind': 'narrative_list', 'identity': identity})
                    checked_specs.append((copy.deepcopy(verified[-1]), copy.deepcopy(spec), copy.deepcopy(row)))
                    if metric == 'bonds_payable':
                        ratio_spec, ratio_row = copy.deepcopy(spec), copy.deepcopy(row)
                        ratio_spec.pop('narrative_list'); ratio_spec['narrative_ratio'] = True
                        percentage = list(re.finditer(r'([0-9.]+)%', quote))[-1]
                        ratio_spec['start'], ratio_spec['end'] = percentage.span(1)
                        ratio_row['metric'] = RATIO_METRIC
                        ratio_row['output'].update(value=percentage[1], unit='PERCENT')
                        ratio_identity = reader.output_value(path, ratio_spec, ratio_row)
                        verified.append({'scope':'consolidated','metric':RATIO_METRIC,'kind':'narrative_ratio','identity':ratio_identity})
                        checked_specs.append((copy.deepcopy(verified[-1]),ratio_spec,ratio_row))
                    if paragraph_number == 7931:
                        self.assertTrue(quote.endswith('，明细如下：'))
                        wrong = copy.deepcopy(spec)
                        wrong['quote'] = quote.removesuffix('，明细如下：')
                        with self.assertRaisesRegex(ValueError, 'complete_actual_clause_boundaries_required'):
                            reader.output_value(path, wrong, row)
                    # The target amount cannot be replaced by an equal historical span.
                    wrong = copy.deepcopy(spec)
                    earlier = list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*万元', quote))[0]
                    wrong['start'], wrong['end'] = earlier.span(1)
                    with self.assertRaises(ValueError):
                        reader.output_value(path, wrong, row)
            # Fixed roles are independent of operator counts. All tables can be
            # correct while a stale profitability paragraph is simply omitted.
            self.assertEqual(len(verified), 43)
            coverage = reader.occurrence_coverage(path, verified)
            self.assertEqual(coverage['status'], 'passed', coverage)
            missing = [v for v in verified if v['identity'][0] != p(7967)]
            self.assertEqual(sum(v['kind'] == 'table' for v in missing), 28)
            coverage = reader.occurrence_coverage(path, missing)
            self.assertEqual(coverage['status'], 'failed')
            self.assertIn({'role': 'narrative:7967:consolidated:net_profit',
                           'code': 'required_occurrence_not_independently_checked'}, coverage['failures'])
            repeated = missing + [copy.deepcopy(missing[-1]) for _ in range(43-len(missing))]
            self.assertEqual(len(repeated), 43)
            self.assertEqual(reader.occurrence_coverage(path, repeated)['status'], 'failed')
            self.assertEqual(Reader(source=path, issuer=case['issuer']).occurrence_coverage(path, verified)['status'], 'failed')
            expense_missing = [v for v in verified if v['identity'][0] != p(7931)]
            coverage = reader.occurrence_coverage(path, expense_missing)
            self.assertEqual(coverage['status'], 'failed')
            self.assertIn({'role': 'narrative:7931:consolidated:nonoperating_expenses',
                           'code': 'required_occurrence_not_independently_checked'}, coverage['failures'])

            # A retained stale list with unsupported language cannot disappear
            # while an inserted correct-shaped copy supplies every identity.
            # Revalidate all shifted locations through the real amount reader.
            for name, old, new in (('connector', '分别为', '分别是'),
                    ('period', '报告期内', '此前期内'), ('no-connector', '分别为', '数额为'),
                    ('shared-unit', '分别为', '分别是')):
                with self.subTest(retained_stale_variant=name):
                    with ZipFile(path) as archive:
                        mutant_parts = {entry: archive.read(entry) for entry in archive.namelist()}
                    mutant_document = xml(mutant_parts['word/document.xml'])
                    target = list(mutant_document.iter(qn('w:p')))[7966]
                    fresh = copy.deepcopy(target)
                    original_text = paragraph_text(target)
                    identity = next(v['identity'] for v in verified if v['identity'][0] == p(7967))
                    changed = original_text.replace(old, new, 1)
                    digit = next(i for i in range(identity[1], identity[2]) if changed[i].isdigit())
                    changed = changed[:digit] + ('1' if changed[digit] != '1' else '2') + changed[digit + 1:]
                    if name == 'shared-unit':
                        changed = changed.replace('万元', '', 2)
                    text_leaves = [leaf for leaf, _, _, _ in leaves(target) if leaf.tag == qn('w:t')]
                    for index, leaf in enumerate(text_leaves):
                        leaf.text = changed if index == 0 else ''
                    target.addnext(fresh)
                    mutant_parts['word/document.xml'] = serialized(mutant_document)
                    mutant_path = str(Path(directory) / f'synthetic-retained-stale-{name}.docx')
                    with ZipFile(mutant_path, 'w') as archive:
                        for entry, raw in mutant_parts.items():
                            archive.writestr(entry, raw)
                    checked = []
                    mutant_reader = Reader(source=source, issuer=case['issuer'])
                    def relocate(spec):
                        for key, value in list(spec.items()):
                            if isinstance(value, dict):
                                relocate(value)
                            elif key == 'locator':
                                match = re.fullmatch(r'word/document.xml//w:p\[([0-9]+)\]', value)
                                if match and int(match[1]) >= 7967:
                                    spec[key] = p(int(match[1]) + 1)
                    for record, original_spec, row in checked_specs:
                        spec = copy.deepcopy(original_spec)
                        relocate(spec)
                        checked.append({**record, 'identity': mutant_reader.output_value(mutant_path, spec, row)})
                    self.assertEqual(len(checked), 43)
                    coverage = mutant_reader.occurrence_coverage(mutant_path, checked)
                    self.assertEqual(coverage['status'], 'failed')
                    self.assertIn({'role': 'narrative:7967:consolidated:net_profit',
                                   'code': 'unsupported_occurrence_clause'}, coverage['failures'])

            old_period_path = str(Path(directory) / 'synthetic-old-period-role.docx')
            with ZipFile(path) as archive:
                old_period_parts = {name: archive.read(name) for name in archive.namelist()}
            old_period_document = xml(old_period_parts['word/document.xml'])
            header = list(old_period_document.iter(qn('w:tbl')))[43].findall(qn('w:tr'))[0].findall(qn('w:tc'))[1]
            for text in header.iter(qn('w:t')):
                text.text = (text.text or '').replace('9', '6')
            old_period_parts['word/document.xml'] = serialized(old_period_document)
            with ZipFile(old_period_path, 'w') as archive:
                for name, raw in old_period_parts.items():
                    archive.writestr(name, raw)
            coverage = Reader(source=source, issuer=case['issuer']).occurrence_coverage(old_period_path, verified)
            self.assertEqual(coverage['status'], 'failed')
            self.assertIn({'role': 'table:44:consolidated:total_assets',
                           'code': 'ambiguous_or_missing_occurrence'}, coverage['failures'])

            # Body paragraph and table-row insertion shift real locators. The
            # source-role matcher must still find the same 43 actual values.
            shifted_path = str(Path(directory) / 'synthetic-inserted-positions.docx')
            with ZipFile(path) as archive:
                parts = {name: archive.read(name) for name in archive.namelist()}
            document = xml(parts['word/document.xml'])
            body = document.find(qn('w:body'))
            note = OxmlElement('w:p')
            run, text = OxmlElement('w:r'), OxmlElement('w:t')
            text.text = 'Synthetic inserted body paragraph for locator-shift regression.'
            run.append(text)
            note.append(run)
            body.insert(0, note)
            table = list(document.iter(qn('w:tbl')))[43]
            target_row = table.findall(qn('w:tr'))[19]
            inserted = copy.deepcopy(table.findall(qn('w:tr'))[1])
            for i, tc in enumerate(inserted.findall(qn('w:tc'))):
                for child in list(tc):
                    if child.tag != qn('w:tcPr'):
                        tc.remove(child)
                paragraph = OxmlElement('w:p')
                if i == 0:
                    run, text = OxmlElement('w:r'), OxmlElement('w:t')
                    text.text = 'Synthetic inserted non-metric row'
                    run.append(text)
                    paragraph.append(run)
                tc.append(paragraph)
            inserted_paragraphs = len(list(inserted.iter(qn('w:p'))))
            target_row.addprevious(inserted)
            parts['word/document.xml'] = serialized(document)
            with ZipFile(shifted_path, 'w') as archive:
                for name, raw in parts.items():
                    archive.writestr(name, raw)
            shifted = copy.deepcopy(verified)
            for record in shifted:
                identity = list(record['identity'])
                if record['kind'] == 'table':
                    match = re.fullmatch(r'word/document.xml#table=44,row=([0-9]+),cell=([0-9]+)', identity[0])
                    if match and int(match[1]) >= 20:
                        identity[0] = cell(44, int(match[1]) + 1, int(match[2]))
                else:
                    original = int(re.search(r'\[([0-9]+)\]', identity[0])[1])
                    identity[0] = p(original + 1 + (inserted_paragraphs if original > 285 else 0))
                record['identity'] = tuple(identity)
            shifted_reader = Reader(source=source, issuer=case['issuer'])
            coverage = shifted_reader.occurrence_coverage(shifted_path, shifted)
            self.assertEqual(coverage['status'], 'passed', coverage)

            # Duplicating the same semantic paragraph cannot become a second
            # role or let the operator choose whichever occurrence is correct.
            ambiguous_path = str(Path(directory) / 'synthetic-ambiguous-role.docx')
            paragraph_number = int(re.search(r'\[([0-9]+)\]', next(v['identity'][0] for v in shifted
                if v['kind'] == 'narrative_list' and v['metric'] == 'net_profit'))[1])
            target = list(document.iter(qn('w:p')))[paragraph_number - 1]
            target.addnext(copy.deepcopy(target))
            parts['word/document.xml'] = serialized(document)
            with ZipFile(ambiguous_path, 'w') as archive:
                for name, raw in parts.items():
                    archive.writestr(name, raw)
            coverage = Reader(source=source, issuer=case['issuer']).occurrence_coverage(ambiguous_path, shifted)
            self.assertEqual(coverage['status'], 'failed')
            self.assertIn({'role': 'narrative:7967:consolidated:net_profit',
                           'code': 'ambiguous_or_missing_occurrence'}, coverage['failures'])
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), material['sha256'])


from prospectus_extended_financial_test import FinancialSourceBindings, ExpandedAmountRegression

if __name__ == '__main__':
    unittest.main()
