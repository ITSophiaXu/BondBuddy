import base64
import copy
import importlib
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

root = pathlib.Path(os.environ.get('DIAGNOSTICS_ROOT', pathlib.Path(__file__).parent)).resolve()
sys.path.insert(0, str(root))
broker = importlib.import_module('broker')

PARENT = 'a' * 64
CHILD = 'b' * 64
BODY = '{"operations":[{"text":"中文 bearer synthetic-bearer-01234567890"}]}'.encode()
ARGS = ['content', 'result', 'result-id', '--file', 'operations.json', '--reason', 'token_rca']
REF = {'kind': 'result', 'key': 'result-id', 'owner_user_id': 'owner', 'project_id': 'project', 'run_id': 'run', 'attempt_id': 'attempt', 'sha256': PARENT, 'byte_size': 123, 'capture_truncated': False}


def envelope(body=BODY, **changes):
    return json.dumps({'verified_parent_sha256': PARENT, 'verified_child_sha256': CHILD,
                       'verified_child_byte_size': len(body), 'redacted_content_base64': base64.b64encode(body).decode(), **changes}).encode()


class OperationsBrokerTests(unittest.TestCase):
    def setUp(self):
        self.ref = copy.deepcopy(REF)
        self.db = mock.Mock()
        self.db.content_ref.return_value = self.ref
        self.config = {'actors': {'reader': 'reader', 'machine': 'ingest'}, 'state_directory': '/unused'}

    def read(self, raw=None, offset=0, length=262144):
        options = {'kind': 'result', 'id': 'result-id', 'file': 'operations.json', 'offset': offset, 'length': length}
        with mock.patch.object(broker, 'discover', return_value=[{'service': 'api', 'state': 'running', 'stream': 'api-container'}]), \
             mock.patch.object(broker, 'trusted_file', side_effect=lambda p: p), \
             mock.patch.object(broker, 'command', return_value=envelope() if raw is None else raw) as command:
            value = broker.read_content(self.config, options, self.db)
            called = command.call_args
        return value, called

    def test_result_fixed_selector_is_accepted(self):
        options = broker.parse(ARGS)
        self.assertEqual(options['kind'], 'result')
        self.assertEqual(options['file'], 'operations.json')

    def test_other_kinds_and_exec_alias_explicitly_reject_selector(self):
        for args in [['content', 'prompt', 'id'], ['content', 'exec', 'id'], ['exec-log', 'id']]:
            with self.subTest(args=args), self.assertRaisesRegex(ValueError, 'only.*content result'):
                broker.parse(args + ['--file', 'operations.json', '--reason', 'token_rca'])

    def test_arbitrary_file_names_and_path_traversal_rejected(self):
        for selected in ['input.json', 'template-manifest.json', '../operations.json', '/private/operations.json']:
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                broker.parse(['content', 'result', 'id', '--file', selected, '--reason', 'token_rca'])

    def test_reason_and_page_bounds_remain_required(self):
        for args in [['content', 'result', 'id', '--file', 'operations.json'], ARGS + ['--offset', '-1'], ARGS + ['--length', '1048577']]:
            with self.subTest(args=args), self.assertRaises(ValueError): broker.parse(args)

    def test_preserves_parent_child_hashes_and_selected_bytes(self):
        value, called = self.read()
        self.db.content_ref.assert_called_once_with('result', 'result-id')
        self.assertEqual(self.ref, REF, 'must not mutate registered reference')
        passed = json.loads(called.args[0][-1])
        self.assertEqual(passed, {**REF, 'file': 'operations.json'})
        self.assertEqual(value['file'], 'operations.json')
        self.assertEqual(value['verified_parent_sha256'], PARENT)
        self.assertEqual(value['verified_child_sha256'], CHILD)
        self.assertEqual(value['verified_source_sha256'], CHILD)
        self.assertEqual(value['verified_child_byte_size'], len(BODY))
        self.assertNotIn(b'synthetic-bearer', base64.b64decode(value['data']))

    def test_utf8_pagination_reassembles_redacted_bytes(self):
        parts, offset, digest = [], 0, None
        while True:
            value, _ = self.read(offset=offset, length=7)
            parts.append(base64.b64decode(value['data']))
            self.assertEqual(value['verified_source_sha256'], CHILD)
            self.assertEqual(value['verified_parent_sha256'], PARENT)
            if digest is not None: self.assertEqual(value['redacted_sha256'], digest)
            digest = value['redacted_sha256']
            offset = value['next_offset']
            if offset is None: break
        reconstructed = b''.join(parts)
        self.assertIn('中文', reconstructed.decode('utf-8'))
        self.assertEqual(broker.digest(reconstructed), digest)

    def test_malformed_helper_envelope_is_denied(self):
        for raw in [b'not-json', b'{}', envelope(verified_parent_sha256='c'*64), envelope(verified_child_sha256='bad'), envelope(redacted_content_base64='***'), envelope(verified_child_byte_size=1048577), envelope(verified_child_byte_size=0)]:
            with self.subTest(raw=raw[:80]), self.assertRaises(ValueError): self.read(raw)

    def test_only_one_running_api_container_is_allowed(self):
        with mock.patch.object(broker, 'discover', return_value=[]), mock.patch.object(broker, 'command') as command, self.assertRaises(RuntimeError):
            broker.read_content(self.config, {'kind': 'result', 'id': 'result-id', 'file': 'operations.json', 'offset': 0, 'length': 10}, self.db)
        command.assert_not_called()

    def test_audit_failure_prevents_database_or_content_read(self):
        with mock.patch.object(broker, 'audit', side_effect=OSError('audit failed')), mock.patch.object(broker, 'Database') as database, mock.patch.object(broker, 'read_content') as read, self.assertRaises(OSError):
            broker.dispatch(self.config, 'reader', ARGS)
        database.assert_not_called(); read.assert_not_called()

    def test_ingest_identity_cannot_read_and_is_not_audited_as_reader(self):
        with mock.patch.object(broker, 'audit') as audit, mock.patch.object(broker, 'Database') as database, self.assertRaises(ValueError):
            broker.dispatch(self.config, 'machine', ARGS)
        audit.assert_not_called(); database.assert_not_called()

    def test_registered_ref_denial_stops_before_storage(self):
        self.db.content_ref.side_effect = ValueError('Content missing, deleted or purged')
        with mock.patch.object(broker, 'command') as command, self.assertRaises(ValueError):
            broker.read_content(self.config, {'kind': 'result', 'id': 'result-id', 'file': 'operations.json', 'offset': 0, 'length': 10}, self.db)
        command.assert_not_called()

    def test_successful_dispatch_audits_original_selector_before_read(self):
        order = []
        with mock.patch.object(broker, 'audit', side_effect=lambda *args: order.append(('audit', args))), \
             mock.patch.object(broker, 'Database', side_effect=lambda *args: order.append(('database', args)) or self.db), \
             mock.patch.object(broker, 'read_content', return_value={'ok': True}) as read:
            self.assertEqual(broker.dispatch(self.config, 'reader', ARGS), {'ok': True})
        self.assertEqual([x[0] for x in order], ['audit', 'database'])
        self.assertEqual(order[0][1][2], ARGS)
        self.assertEqual(read.call_args.args[1]['file'], 'operations.json')


if __name__ == '__main__':
    unittest.main()
