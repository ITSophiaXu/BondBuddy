"""Synthetic checks of the release runner's fail-closed aggregation."""
import copy
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('document_test_runner',
    Path(__file__).resolve().parents[2] / 'scripts/run-document-quality-tests.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class DocumentTestRunnerTests(unittest.TestCase):
    def test_schedule_preserves_each_required_module_once(self):
        self.assertCountEqual(runner.scheduled_modules(), runner.MODULES)
        self.assertEqual(len(set(runner.scheduled_modules())), len(runner.MODULES))
        with patch.object(runner, 'MODULES', tuple(m for m in runner.MODULES if m != 'test_fixed_edit')):
            with self.assertRaises(ValueError):
                runner.scheduled_modules()

    def run_case(self, method):
        case = type('SyntheticCase', (unittest.TestCase,), {'test_synthetic': method})
        return runner.run_suite(unittest.defaultTestLoader.loadTestsFromTestCase(case))

    def test_failure_error_skip_and_expected_failure_cannot_pass(self):
        def fail(case):
            case.fail('synthetic failure')

        def error(case):
            raise RuntimeError('synthetic error')

        for method in (fail, error, unittest.skip('synthetic skip')(lambda _: None),
                       unittest.expectedFailure(fail), unittest.expectedFailure(lambda _: None)):
            with self.subTest(method=method):
                self.assertFalse(self.run_case(method)['complete'])

    def test_empty_and_early_stopped_suites_cannot_pass(self):
        self.assertFalse(runner.run_suite(unittest.TestSuite())['complete'])
        class IncompleteSuite(unittest.TestSuite):
            def countTestCases(self):
                return 2
        suite = IncompleteSuite([unittest.FunctionTestCase(lambda: None)])
        self.assertFalse(runner.run_suite(suite)['complete'])

    def test_missing_module_cannot_pass(self):
        self.assertFalse(runner.run_suite(unittest.defaultTestLoader.loadTestsFromName(
            'bondbuddy_missing_synthetic_test_module'))['complete'])
        with self.assertRaises(ValueError):
            runner.run_module('bondbuddy_missing_synthetic_test_module')

    def records(self):
        result = self.run_case(lambda _: None)
        return [{**copy.deepcopy(result), 'module': module} for module in runner.MODULES]

    def test_all_modules_and_actual_render_report_are_required(self):
        records = self.records()
        self.assertFalse(runner.summarize(records)[1])
        records[0]['summary'].update(authorized_render_reports=1, rendered_documents=3)
        summary, complete = runner.summarize(records)
        self.assertTrue(complete)
        self.assertEqual(summary['tests'], len(runner.MODULES))
        for bad in (records[:-1], records + records[:1], list(reversed(records))):
            with self.assertRaises(ValueError):
                runner.summarize(bad)
        records[0]['complete'] = False
        self.assertFalse(runner.summarize(records)[1])

    def test_duplicate_fixed_modules_are_rejected(self):
        records = self.records()
        with patch.object(runner, 'MODULES', (*runner.MODULES, runner.MODULES[0])):
            with self.assertRaises(ValueError):
                runner.summarize(records + records[:1])

    def test_renderer_counts_require_all_three_positive_page_counts(self):
        for pages, expected in (({'baseline': 1, 'clean': 2, 'tracked': 3}, 1),
                                ({'baseline': 1, 'clean': 0, 'tracked': 3}, 0),
                                ({'baseline': 1, 'clean': 2}, 0)):
            import json
            def sample(_):
                print(json.dumps({'acceptance': 'authorized_source_render', 'pages': pages}))
            result = self.run_case(sample)
            self.assertEqual(result['summary']['authorized_render_reports'], expected)
            self.assertEqual(result['summary']['rendered_documents'], expected * 3)


if __name__ == '__main__':
    unittest.main()
