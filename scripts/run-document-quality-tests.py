"""Mandatory release regressions. Missing fixtures, skipped tests and renderer gaps fail."""
import json
import contextlib
import io
import os
import sys
import unittest

MODULES = (
    'test_file_authoring', 'test_fixed_edit', 'test_fixed_edit_authorized', 'test_source_outline',
    'test_document_quality', 'test_authorized_docx_regression', 'test_authorized_authoring_quality',
)

if __name__ == '__main__':
    if os.environ.get('BB_REQUIRE_DOCUMENT_RENDER') != '1':
        raise SystemExit('Release document rendering must be required')
    if os.environ.get('BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION') != '1':
        raise SystemExit('Authorized DOCX regression must be enabled')
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromNames(MODULES))
    print(captured.getvalue(), end='')
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
    print('DOCUMENT_QUALITY_RESULT=' + json.dumps(summary, sort_keys=True))
    sys.exit(0 if result.wasSuccessful() and summary['tests'] > 0 and summary['passed'] == summary['tests'] and render_reports else 1)
