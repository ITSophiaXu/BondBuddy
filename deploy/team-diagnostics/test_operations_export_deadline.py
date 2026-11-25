"""The selected-file client covers Blob reads, reference lookup and SSH setup."""
import pathlib
import shlex
import subprocess
import tempfile
import unittest
import base64
import hashlib
import json
from unittest import mock
import export as exporter
import broker
import test_export_deadline as existing


class OperationsExportDeadlineTests(unittest.TestCase):
    def test_trailing_end_of_options_keeps_every_page_parseable_and_classified(self):
        body = 'synthetic 中文 content'.encode()
        digest = hashlib.sha256(body).hexdigest()
        queries = [('content exec --reason debug --length 7 parent --', 180),
                   ('content result --file=operations.json --reason debug --length=7 parent --', 90),
                   ('exec-log --reason=debug --length 7 parent --', 180)]
        for query, deadline in queries:
            expected = broker.parse(shlex.split(query))
            def invoke(args, **kwargs):
                self.assertEqual(kwargs['timeout'], deadline)
                options = broker.parse(shlex.split(args[-1]))
                self.assertEqual((options['kind'], options['id'], options['file']),
                                 (expected['kind'], expected['id'], expected['file']))
                offset = options['offset']
                chunk = body[offset:offset+options['length']]
                page = {'offset': offset, 'encoding': 'base64', 'redacted_sha256': digest,
                        'data': base64.b64encode(chunk).decode(),
                        'next_offset': offset+len(chunk) if offset+len(chunk) < len(body) else None}
                return mock.Mock(stdout=json.dumps(page).encode())
            with self.subTest(query=query), tempfile.TemporaryDirectory() as directory, \
                 mock.patch.object(exporter.subprocess, 'run', side_effect=invoke) as run:
                output = pathlib.Path(directory) / 'content.log'
                value = exporter.export('synthetic-target', 'synthetic-config', query, output)
                self.assertTrue(value['complete'])
                self.assertEqual(output.read_bytes(), body)
                self.assertGreater(run.call_count, 1)

    def test_end_of_options_exports_every_page_using_server_accepted_arguments(self):
        body = '{"operations":[{"text":"中文 synthetic"}]}'.encode()
        digest = hashlib.sha256(body).hexdigest()
        queries = ['content --file operations.json --reason token_rca -- result parent',
                   'content --file=operations.json --reason=token_rca -- result parent',
                   'content --reason=exec --length=7 result parent --file=operations.json',
                   'content result --file=operations.json parent --reason=token_rca',
                   'content --reason exec --file=operations.json -- result parent',
                   'content --reason=token_rca -- exec attempt',
                   'content --reason=token_rca exec --length=7 attempt',
                   'exec-log --reason=token_rca -- attempt',
                   'exec-log --length=7 attempt --reason token_rca']
        for query in queries:
            expected = broker.parse(shlex.split(query))
            calls = []
            def invoke(args):
                options = broker.parse(args)
                calls.append(options)
                self.assertEqual((options['kind'], options['id'], options['file']),
                                 (expected['kind'], expected['id'], expected['file']))
                offset = options['offset']
                chunk = body[offset:offset+7]
                return {'offset': offset, 'encoding': 'base64', 'redacted_sha256': digest,
                        'data': base64.b64encode(chunk).decode(),
                        'next_offset': offset+len(chunk) if offset+len(chunk) < len(body) else None}
            with self.subTest(query=query), tempfile.TemporaryDirectory() as directory:
                output = pathlib.Path(directory) / 'content.log'
                value = exporter.export('synthetic-target', 'synthetic-config', query, output, invoke)
                self.assertTrue(value['complete'])
                self.assertEqual(output.read_bytes(), body)
                self.assertGreater(len(calls), 1)

    def test_equals_spelling_cannot_prefill_continuation_before_export(self):
        for query in ['content exec attempt --reason token_rca --offset=0',
                      'content result parent --file=operations.json --reason token_rca --offset=1',
                      'db attempts --cursor=synthetic']:
            with self.subTest(query=query), tempfile.TemporaryDirectory() as directory, \
                 mock.patch.object(exporter.subprocess, 'run') as run:
                output = pathlib.Path(directory) / 'content.log'
                with self.assertRaises(ValueError):
                    exporter.export('synthetic-target', 'synthetic-config', query, output)
                run.assert_not_called()
                self.assertFalse(output.exists())
                self.assertFalse(output.with_name(output.name + '.partial').exists())

    def test_exec_deadline_accepts_end_of_options(self):
        query = 'content --reason token_rca -- exec attempt'
        self.assertEqual(broker.parse(shlex.split(query))['kind'], 'exec')
        self.assertEqual(existing.ExportDeadlineTests().invoke(query)['timeout'], 180)

    def test_operations_deadline_accepts_end_of_options(self):
        query = 'content --file operations.json --reason token_rca -- result result-id'
        parsed = broker.parse(shlex.split(query))
        self.assertEqual((parsed['kind'], parsed['file']), ('result', 'operations.json'))
        self.assertEqual(existing.ExportDeadlineTests().invoke(query)['timeout'], 90)

    def test_scanner_matches_broker_for_accepted_option_permutations(self):
        queries = [
            'content --reason token_rca exec attempt',
            'content --reason=token_rca exec attempt',
            'content exec attempt --length=8 --reason token_rca',
            'content --length 8 --reason token_rca -- exec attempt',
            'content --reason exec result parent --file operations.json',
            'content result parent --file=operations.json --reason token_rca',
            'content --file operations.json --reason=token_rca -- result parent',
            'content --file operations.json --file operations.json --reason token_rca result parent',
            'content --reason token_rca -- result parent',
        ]
        for query in queries:
            with self.subTest(query=query):
                args = shlex.split(query)
                parsed = broker.parse(args)
                self.assertEqual(exporter.content_query_selection(args), (parsed['kind'], parsed['file']))
        # Tokens after -- are positional data even if they look like options.
        self.assertEqual(exporter.content_query_selection(['content', '--', 'result', '--file', 'operations.json']), ('result', None))

    def test_exec_uses_180_seconds_with_accepted_options_before_kind(self):
        for query in ['content --reason token_rca exec attempt',
                      'content --reason=token_rca exec attempt',
                      'content --length 8 exec attempt --reason token_rca']:
            with self.subTest(query=query):
                self.assertEqual(existing.ExportDeadlineTests().invoke(query)['timeout'], 180)

    def test_scanner_recognizes_offset_option_without_allowing_prefilled_exports(self):
        args = ['content', '--offset', '0', '--length', '8', 'exec', 'attempt', '--reason', 'token_rca']
        self.assertEqual(exporter.content_query_selection(args), ('exec', None))
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(exporter.subprocess, 'run') as run:
            output = pathlib.Path(directory) / 'exec.log'
            with self.assertRaises(ValueError):
                exporter.export('synthetic-target', 'synthetic-config', ' '.join(args), output)
            run.assert_not_called()
            self.assertFalse(output.exists())
            self.assertFalse(output.with_name(output.name + '.partial').exists())

    def test_selected_result_deadline_is_90_seconds_for_accepted_option_forms(self):
        queries = ['content result parent --file operations.json --reason debug',
                   'content result parent --reason debug --file=operations.json',
                   'content --file operations.json --reason debug result parent',
                   'content --reason result result parent --file operations.json']
        for query in queries:
            with self.subTest(query=query):
                timeout = existing.ExportDeadlineTests().invoke(query)['timeout']
                self.assertEqual(timeout, 90)
                self.assertGreaterEqual(timeout, 45 + 18 + 15 + 12)

    def test_only_selected_result_changes_nonexec_deadline(self):
        for query in ['content result parent --reason debug',
                      'content prompt parent --file operations.json --reason debug',
                      'content result parent --file input.json --reason debug',
                      'content result parent --file operations.json --file input.json --reason debug']:
            with self.subTest(query=query):
                self.assertEqual(existing.ExportDeadlineTests().invoke(query)['timeout'], 60)

    def test_selected_result_timeout_preserves_partial_without_completion(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(exporter.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic-ssh', 90)) as run:
            output = pathlib.Path(directory) / 'operations.json'
            with self.assertRaises(subprocess.TimeoutExpired):
                exporter.export('synthetic-target', 'synthetic-config', 'content result parent --file operations.json --reason debug', output)
            self.assertEqual(run.call_args.kwargs['timeout'], 90)
            self.assertFalse(output.exists())
            self.assertTrue(output.with_name(output.name + '.partial').exists())


if __name__ == '__main__':
    unittest.main()
