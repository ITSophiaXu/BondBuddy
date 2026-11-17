"""Mandatory release regressions. Missing fixtures, skipped tests and renderer gaps fail."""
import json
import contextlib
import io
import os
import sys
import unittest
import multiprocessing
import time
from concurrent.futures import ProcessPoolExecutor

MODULES = (
    'test_pdf_pages', 'test_bounded_image',
    'test_file_authoring', 'test_reverse_audit_fixed', 'test_period_definition_guard', 'test_fixed_edit', 'test_format_plan', 'test_fixed_edit_authorized', 'test_source_outline',
    'test_document_quality', 'test_document_size', 'test_document_size_render', 'test_authorized_docx_regression', 'test_authorized_authoring_quality',
    'test_correction_rounding', 'test_review_corrections', 'test_document_test_runner',
)

COUNTERS = ('tests', 'passed', 'failures', 'errors', 'skipped', 'expected_failures',
            'unexpected_successes', 'authorized_render_reports', 'rendered_documents')


def run_suite(suite):
    expected = suite.countTestCases()
    captured = io.StringIO()
    details = io.StringIO()
    with contextlib.redirect_stdout(captured):
        result = unittest.TextTestRunner(stream=details, verbosity=2).run(suite)
    render_reports = []
    for line in captured.getvalue().splitlines():
        try:
            record = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(record, dict) and record.get('acceptance') == 'authorized_source_render':
            pages = record.get('pages', {})
            if all(isinstance(pages.get(label), int) and pages[label] > 0 for label in ('baseline', 'clean', 'tracked')):
                render_reports.append(record)
    summary = {
        'tests': result.testsRun,
        'failures': len(result.failures), 'errors': len(result.errors),
        'skipped': len(result.skipped), 'expected_failures': len(result.expectedFailures),
        'unexpected_successes': len(result.unexpectedSuccesses), 'render_required': True,
        'authorized_render_reports': len(render_reports), 'rendered_documents': len(render_reports) * 3,
    }
    summary['passed'] = summary['tests'] - sum(summary[key] for key in ('failures', 'errors', 'skipped', 'expected_failures', 'unexpected_successes'))
    complete = result.wasSuccessful() and expected > 0 and summary['tests'] == expected and summary['passed'] == expected
    return {'summary': summary, 'complete': complete, 'output': captured.getvalue() + details.getvalue()}


def run_module(module):
    # Each process owns its imports, mocks, temporary files and renderer profiles.
    # The caller cannot supply a reduced test list or change the concurrency.
    if module not in MODULES:
        raise ValueError('Unknown required document module')
    started = time.monotonic()
    record = run_suite(unittest.defaultTestLoader.loadTestsFromName(module))
    return {**record, 'module': module, 'seconds': round(time.monotonic() - started, 3)}


def summarize(records):
    if [record['module'] for record in records] != list(MODULES) or len(set(MODULES)) != len(MODULES):
        raise ValueError('Required document module coverage is incomplete or duplicated')
    summary = {key: sum(record['summary'][key] for record in records) for key in COUNTERS}
    summary['render_required'] = True
    complete = (all(record['complete'] for record in records)
                and summary['passed'] == summary['tests']
                and summary['authorized_render_reports'] > 0)
    return summary, complete


def main():
    if os.environ.get('BB_REQUIRE_DOCUMENT_RENDER') != '1':
        raise SystemExit('Release document rendering must be required')
    if os.environ.get('BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION') != '1':
        raise SystemExit('Authorized DOCX regression must be enabled')
    # Keep the gate's existing 600-second group deadline. Independent suites run
    # in at most three processes; no tests, renderer requirements or assertions
    # are removed. A failed/crashed worker cannot yield a passing summary.
    with ProcessPoolExecutor(max_workers=3, mp_context=multiprocessing.get_context('spawn')) as executor:
        records = list(executor.map(run_module, MODULES))
    for record in records:
        print(f"Document module: {record['module']} ({record['seconds']}s)")
        print(record['output'], end='')
    summary, complete = summarize(records)
    print('DOCUMENT_QUALITY_RESULT=' + json.dumps(summary, sort_keys=True))
    return 0 if complete else 1


if __name__ == '__main__':
    sys.exit(main())
