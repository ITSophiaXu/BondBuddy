"""Synthetic semantic boundary and host/preflight parity tests; no fact approval."""
import copy
import tempfile
import unittest
from pathlib import Path

from docx import Document

from bondbuddy_file_authoring.check import package
from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.period_definitions import check_definitions
from bondbuddy_file_authoring.preflight import preflight
from bondbuddy_file_authoring.quality import verify
from bondbuddy_file_authoring.template_manifest import sha
from bondbuddy_file_authoring.word_patch import xml


def target(year=2028, month=9):
    import calendar
    periods = [{'start': f'{year - offset}-01-01', 'end': f'{year - offset}-12-31',
                'period_kind': 'annual', 'scope': 'consolidated', 'status': 'user_asserted', 'evidence_refs': []}
               for offset in (2, 1)]
    periods.append({'start': f'{year}-01-01', 'end': f'{year}-{month:02}-{calendar.monthrange(year, month)[1]}',
                    'period_kind': 'interim', 'scope': 'consolidated', 'status': 'user_asserted', 'evidence_refs': []})
    return {'target': {'details': {'target_reporting_periods': periods}}}


class PeriodDefinitionGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def document(self, flow='2026年度、2027年度和2028年1-9月', stock='2026年末、2027年末和2028年9月末', current=True):
        document = Document()
        document.add_heading('释义', level=1)
        if current:
            document.add_paragraph('在本募集说明书中，除非文中另有所指，下列词语具有如下含义：')
        else:
            document.add_paragraph('以下仅引述旧募集书释义，供历史对比。')
        table = document.add_table(rows=2, cols=3)
        table.cell(0, 0).text = '最近两年及一期'
        table.cell(0, 1).text = '指'
        table.cell(0, 2).text = flow
        table.cell(1, 0).text = '最近两年及一期末'
        table.cell(1, 2).text = stock
        document.add_heading('第一节 财务会计信息', level=1)
        document.add_paragraph('历史比较信息继续保留。截至2028年6月末，净资产为432.10万元。')
        return document

    def check(self, document, data=None):
        path = self.root / 'diagnostic.docx'
        document.save(path)
        return check_definitions(data if data is not None else target(), xml(package(path)['word/document.xml']))

    def test_complete_target_conflicts_with_both_stale_glossary_definitions(self):
        result = self.check(self.document(flow='2026年度、2027年度和2028年1-6月', stock='2026年末、2027年末和2028年6月末'))
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(len(result['conflicts']), 2)
        self.assertEqual(result['compared_count'], 2)
        self.assertTrue(all(item['current_scope_explicit'] and item['kind'] == 'row' for item in result['conflicts']))
        self.assertEqual(result['financial_acceptance'], 'not_run')

    def test_correct_definitions_allow_unchanged_historical_june_body_data(self):
        result = self.check(self.document())
        self.assertEqual(result['status'], 'consistent_in_scope')
        self.assertEqual(len(result['definitions']), 2)
        self.assertEqual(result['conflicts'], [])

    def test_other_year_month_and_equivalent_stock_dates_are_not_case_constants(self):
        result = self.check(self.document(flow='2032年度，2033年度及2034年1—3月。',
                                          stock='2032年12月31日、2033年12月末和2034年3月31日'), target(2034, 3))
        self.assertEqual(result['status'], 'consistent_in_scope')

    def test_correct_additional_definition_cannot_hide_original_stale_row(self):
        document = self.document(flow='2026年度、2027年度和2028年1-6月')
        document.add_paragraph('本募集说明书中，报告期指2026年度、2027年度和2028年1-9月')
        result = self.check(document)
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(len(result['conflicts']), 1)
        self.assertEqual(result['compared_count'], 3)

    def test_explicit_standalone_current_definitions_use_same_rule(self):
        document = Document()
        document.add_paragraph('本募集说明书中，报告期指2026年度、2027年度和2028年1-6月')
        document.add_paragraph('在本募集说明书中，报告期末：2026年末、2027年末和2028年9月末')
        result = self.check(document)
        self.assertEqual(len(result['conflicts']), 1)
        self.assertEqual(result['conflicts'][0]['kind'], 'paragraph')
        self.assertEqual(result['compared_count'], 2)

    def test_historical_glossary_and_unscoped_standalone_stay_pending(self):
        document = self.document(flow='2026年度、2027年度和2028年1-6月', current=False)
        document.add_paragraph('报告期：2026年度、2027年度和2028年1-6月')
        result = self.check(document)
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(len(result['definitions']), 3)
        self.assertEqual(result['compared_count'], 0)

    def test_current_glossary_scope_stops_before_following_body_table(self):
        document = self.document()
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = '报告期'
        table.cell(0, 1).text = '2026年度、2027年度和2028年1-6月'
        result = self.check(document)
        self.assertEqual(result['conflicts'], [])
        self.assertEqual(result['definitions'][-1]['reason'], 'current_scope_not_explicit')

    def test_source_periods_cannot_replace_missing_or_pending_locked_target(self):
        for data in ({'source_reporting_periods': target()['target']['details']['target_reporting_periods']},
                     {'target': {'details': {'reporting_cutoff': '2028-09-30'}}}):
            with self.subTest(data=data):
                self.assertFalse(self.check(self.document(), data)['target_resolved'])
        data = target()
        data['target']['details']['target_reporting_periods'][0]['status'] = 'needs_confirmation'
        self.assertFalse(self.check(self.document(), data)['target_resolved'])

    def test_conflicting_scopes_incomplete_dates_and_noncalendar_windows_stay_pending(self):
        data = target()
        variants = []
        conflicting = copy.deepcopy(data)
        other = copy.deepcopy(data['target']['details']['target_reporting_periods'])
        for item in other:
            item['scope'] = 'parent'
        other[-1]['end'] = '2028-06-30'
        conflicting['target']['details']['target_reporting_periods'].extend(other)
        variants.append(conflicting)
        for field, value in [('start', None), ('end', '2028-09-31'), ('start', '2028-04-01')]:
            variant = copy.deepcopy(data)
            variant['target']['details']['target_reporting_periods'][-1][field] = value
            variants.append(variant)
        for variant in variants:
            with self.subTest(variant=variant):
                result = self.check(self.document(), variant)
                self.assertEqual(result['status'], 'needs_review')
                self.assertEqual(result['conflicts'], [])

    def test_unknown_definition_grammar_empty_and_qualified_history_stay_pending(self):
        for text in ('', '2026年度、2027年度和2028年前三季度', '历史口径为2026年度、2027年度和2028年1-6月',
                     '2026年度、2027年度和2028年1-9月（待核）'):
            with self.subTest(text=text):
                result = self.check(self.document(flow=text))
                self.assertEqual(result['definitions'][0]['status'], 'needs_review')
                self.assertEqual(result['conflicts'], [])

    def test_both_scopes_with_identical_complete_windows_are_comparable(self):
        data = target()
        other = copy.deepcopy(data['target']['details']['target_reporting_periods'])
        for item in other:
            item['scope'] = 'parent'
        data['target']['details']['target_reporting_periods'].extend(other)
        self.assertEqual(self.check(self.document(), data)['status'], 'consistent_in_scope')

    def test_host_checker_and_preflight_recompute_identical_conflict(self):
        source = self.root / 'source.docx'
        self.document(flow='2026年度、2027年度和2028年1-6月', stock='2026年末、2027年末和2028年6月末').save(source)
        data = {**target(), 'input_hash': '7' * 64, 'revision_author': 'Synthetic-period-guard',
                'baseline_path': 'source.docx', 'baseline_kind': 'uploaded_source',
                'baseline_sha256': sha(source.read_bytes()), 'operations_path': 'output/operations.json',
                'output': {'baseline': 'output/baseline.docx', 'tracked': 'output/tracked.docx', 'clean': 'output/clean.docx'}}
        input_path = self.root / 'input.json'
        operations_path = self.root / 'output/operations.json'
        operations_path.parent.mkdir()
        write_json(input_path, data)
        log = empty_log(data, source.read_bytes())
        log['no_changes_reason'] = 'Synthetic unchanged glossary conflict for guard testing.'
        write_json(operations_path, log)
        finalize(input_path, operations_path, self.root / 'output', skip_report=True)
        host = verify(input_path)
        preview = preflight(input_path, operations_path, self.root / 'scratch/preflight.json')
        self.assertEqual(host['status'], 'failed', host)
        self.assertEqual(preview['status'], 'failed', preview)
        self.assertIn('WORD_REPORTING_PERIOD_DEFINITION_CONFLICT', [item['code'] for item in host['issues']])
        self.assertEqual(host['period_definition_check'], preview['quality_report']['period_definition_check'])
        self.assertTrue(preview['snapshot_current'])
        self.assertFalse(preview['host_acceptance'])
        self.assertEqual(host['factual_accuracy'], 'not_verified')


if __name__ == '__main__':
    unittest.main()
