import unittest
from decimal import Decimal
from unittest.mock import patch

from bondbuddy_file_authoring import direct_financial as financial


class DirectFinancialTests(unittest.TestCase):
    def setUp(self):
        self.data = {'issuer_name': '任丘市建设投资集团有限公司', 'materials': []}
        self.keys = {('consolidated', '2025-06', metric) for metric in financial.REQUIRED}
        self.source = {key: [(Decimal('100'), 'material-1', '合并报表')] for key in self.keys}
        self.target = {key: [Decimal('100')] for key in self.keys}

    def report(self, source=None, target=None, citations=None):
        with patch.object(financial, 'xlsx_facts', return_value=self.source if source is None else source), \
             patch.object(financial, 'docx_facts', return_value=(self.target if target is None else target,
                                                                  citations or {}, [])):
            return financial.verify('unused.docx', self.data)

    def test_pass_requires_every_source_metric(self):
        self.assertEqual(self.report()['status'], 'mismatch')  # 100 != 100 + 100
        target = dict(self.target)
        target[('consolidated', '2025-06', 'liabilities')] = [Decimal('40')]
        target[('consolidated', '2025-06', 'equity')] = [Decimal('60')]
        source = dict(self.source)
        for key in ('liabilities', 'equity'):
            source[('consolidated', '2025-06', key)] = [(target[('consolidated', '2025-06', key)][0], 'material-1', '合并报表')]
        self.assertEqual(self.report(source, target)['status'], 'passed')
        target.pop(('consolidated', '2025-06', 'net_profit'))
        self.assertEqual(self.report(source, target)['status'], 'not_checked')

    def test_deterministic_number_mismatch(self):
        target = dict(self.target)
        target[('consolidated', '2025-06', 'revenue')] = [Decimal('101')]
        report = self.report(target=target)
        self.assertEqual(report['status'], 'mismatch')
        self.assertIn('STATEMENT_VALUE_MISMATCH', {issue['code'] for issue in report['issues']})

    def test_ambiguous_source_is_unchecked(self):
        source = dict(self.source)
        key = ('consolidated', '2025-06', 'revenue')
        source[key] = [(Decimal('100'), 'a', '表一'), (Decimal('101'), 'b', '表二')]
        self.assertIn('ambiguous_consolidated_2025-06_revenue', self.report(source=source)['unchecked'])

    def test_prose_number_excludes_report_date(self):
        sentence = '2025年6月，合并营业收入为1,234.56万元。'
        self.assertEqual(financial.INLINE_NUMBER.findall(financial.PERIOD.sub('', sentence)), ['1,234.56'])
        self.assertEqual(financial.period('2025年1—9月'), '2025-09')

    def test_rounding_interval_is_not_a_deterministic_mismatch(self):
        key = ('consolidated', '2025-06', 'revenue')
        source = dict(self.source)
        target = dict(self.target)
        source[key] = [(*financial.amount('100.00', '万元'), 'material-1', '合并报表')]
        target[key] = [financial.amount('1000001', '元')]
        report = self.report(source=source, target=target)
        self.assertNotIn('STATEMENT_VALUE_MISMATCH', {issue['code'] for issue in report['issues']})
        target[key] = [financial.amount('1000100', '元')]
        report = self.report(source=source, target=target)
        self.assertIn('STATEMENT_VALUE_MISMATCH', {issue['code'] for issue in report['issues']})

    def test_unparsed_financial_source_prevents_pass(self):
        target = dict(self.target)
        source = dict(self.source)
        for key, value in [('liabilities', Decimal('40')), ('equity', Decimal('60'))]:
            target[('consolidated', '2025-06', key)] = [value]
            source[('consolidated', '2025-06', key)] = [(value, 'material-1', '合并报表')]
        self.data['source_unchecked'] = ['financial_source_format_unchecked:notes-1']
        report = self.report(source=source, target=target)
        self.assertEqual(report['status'], 'not_checked')
        self.assertIn('financial_source_format_unchecked:notes-1', report['unchecked'])


if __name__ == '__main__':
    unittest.main()
