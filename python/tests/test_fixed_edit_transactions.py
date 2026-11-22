"""Synthetic crash/replay/concurrency checks for the fixed editor commit boundary."""
import copy
import hashlib
import json
import os
import subprocess
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from docx import Document
from bondbuddy_file_authoring import fixed_edit as edit
from bondbuddy_file_authoring.template_manifest import build_manifest


def request_hash(value):
    return hashlib.sha256(json.dumps({k: v for k, v in value.items() if k != 'input_hash'},
                                    sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


class FixedEditTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document(); doc.add_paragraph('原始😀正文'); doc.add_paragraph('其他正文'); doc.save(self.source)
        self.input = self.root / 'input.json'
        self.operations = self.root / 'operations.json'
        self.data = {'input_hash': 'a' * 64, 'workspace_id': 'synthetic-workspace',
                     'revision_author': 'BondBuddy-test', 'revision_date': '2026-11-21T00:00:00Z',
                     'baseline_path': 'source.docx', 'baseline_sha256': edit.sha(self.source.read_bytes())}
        edit.write_json(self.input, self.data)
        self.node = build_manifest(self.source)['nodes'][0]['node_id']

    def tearDown(self):
        self.temp.cleanup()

    def request(self, op_id='op_one', version=0, before='原始😀正文', after='已更新😀正文'):
        result = {'version': 'word-edit-request-v2', 'workspace_id': self.data['workspace_id'],
                  'projection_version': version, 'batch_id': 'synthetic-batch', 'op_id': op_id,
                  'node_id': self.node, 'expected_before': before,
                  'operation': {'id': op_id, 'kind': 'replace_text', 'node_id': self.node,
                                'before': before, 'after': after}}
        result['input_hash'] = request_hash(result)
        return result

    def apply(self, request):
        return edit.apply_batch(self.input, self.operations, [request])

    def manifest(self):
        return edit.read_json(str(self.operations) + '.manifest.json')

    def large_table(self):
        doc = Document(); table = doc.add_table(rows=4, cols=2)
        for row_index, row in enumerate(table.rows):
            for column_index, cell in enumerate(row.cells):
                cell.text = ('财务😀项目' * 2000) + str(row_index) + str(column_index)
        doc.save(self.source)
        self.data['baseline_sha256'] = edit.sha(self.source.read_bytes()); edit.write_json(self.input, self.data)
        # Template summaries intentionally truncate; hash anchors bind the authoritative complete node text.
        return edit.describe_nodes(edit.Editor(self.data, self.source).nodes)

    def anchor_request(self, node, kind, **fields):
        anchor = {'sha256': edit.sha(node['text'].encode('utf8'))}
        request = {'version': 'word-edit-request-v2', 'workspace_id': self.data['workspace_id'],
                   'projection_version': 0, 'batch_id': 'synthetic-large-table', 'op_id': 'large_table_op',
                   'node_id': node['node_id'], 'expected_before': anchor,
                   'operation': {'id': 'large_table_op', 'kind': kind, 'node_id': node['node_id'],
                                 'before': anchor, **fields}}
        request['input_hash'] = request_hash(request)
        return request

    def test_hash_anchor_inserts_column_into_large_table_and_canonical_log_replays(self):
        node = next(node for node in self.large_table() if node['kind'] == 'table')
        self.assertGreater(len(node['text']), 18000)
        request = self.anchor_request(node, 'insert_column', column_index=1, position='before',
                                      values=['2026年6月末', '120', '50', '70'])
        receipt = self.apply(request)
        self.assertEqual(self.apply(request), receipt)
        self.assertEqual(request['operation']['before'], request['expected_before'], 'request hash input is immutable')
        *_, log, editor = edit.load_editor(self.input, self.operations)
        self.assertEqual(log['operations'][0]['before'], node['text'], 'only literal current text enters replay log')
        _, table = editor.target(node['node_id'])
        self.assertEqual([len(row.findall(edit.q('tc'))) for row in table.findall(edit.q('tr'))], [3] * 4)
        self.assertEqual(edit.node_text(table.findall(edit.q('tr'))[1].findall(edit.q('tc'))[1]), '120')

    def test_hash_anchor_inserts_row_using_complete_large_row_text(self):
        node = next(node for node in self.large_table() if node['kind'] == 'row')
        self.assertGreater(len(node['text']), 18000)
        request = self.anchor_request(node, 'insert_row', position='after', values=['新披露项目', '2026年120万元'])
        self.apply(request)
        *_, log, editor = edit.load_editor(self.input, self.operations)
        self.assertEqual(log['operations'][0]['before'], node['text'])
        _, row = editor.target('op:large_table_op:row')
        self.assertEqual(edit.node_text(row), '新披露项目\n2026年120万元')

    def test_wrong_malformed_hash_and_stale_projection_never_commit(self):
        node = next(node for node in self.large_table() if node['kind'] == 'table')
        request = self.anchor_request(node, 'insert_column', column_index=1, position='before', values=['h', '1', '2', '3'])
        for anchor, code in [({'sha256': '0' * 64}, 'WORD_EDIT_BEFORE_HASH_MISMATCH'),
                             ({'sha256': 'invalid'}, 'WORD_EDIT_REQUEST_INVALID'),
                             ({'sha256': request['expected_before']['sha256'], 'extra': True}, 'WORD_EDIT_REQUEST_INVALID')]:
            wrong = copy.deepcopy(request); wrong['operation']['before'] = wrong['expected_before'] = anchor
            wrong['input_hash'] = request_hash(wrong)
            with self.assertRaisesRegex(ValueError, code):
                self.apply(wrong)
            self.assertFalse(edit.manifest_path(self.operations).exists())
        self.apply(request); committed = self.manifest()
        stale = copy.deepcopy(request); stale['op_id'] = stale['operation']['id'] = 'stale_table'
        stale['input_hash'] = request_hash(stale)
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_STALE_PROJECTION'):
            self.apply(stale)
        self.assertEqual(self.manifest(), committed)

    def test_exact_replay_returns_original_receipt_without_reapplying(self):
        request = self.request(); first = self.apply(request)
        self.assertEqual(first['version'], 'word-edit-receipt-v2')
        original_manifest = self.manifest()
        self.assertEqual(self.apply(request), first)
        self.assertEqual(self.manifest(), original_manifest)
        self.assertEqual(len(edit.load_log(self.input, self.operations)[3]['operations']), 1)
        self.assertEqual(first['projection_version'], 1)
        for name in ('operations', 'projection', 'receipt'):
            self.assertEqual(edit.sha((self.root / first[name + '_object_path']).read_bytes()), first[name + '_sha256'])

    def test_conflicting_id_and_forged_hash_never_mutate(self):
        request = self.request(); self.apply(request); committed = self.manifest()
        changed = copy.deepcopy(request); changed['operation']['after'] = '另一文本'
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_REQUEST_HASH_MISMATCH'):
            self.apply(changed)
        changed['input_hash'] = request_hash(changed)
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_OP_ID_CONFLICT'):
            self.apply(changed)
        self.assertEqual(self.manifest(), committed)

    def test_stale_version_wrong_workspace_and_before_fail_without_commit(self):
        self.apply(self.request()); committed = self.manifest()
        cases = [('projection_version', 0, 'WORD_EDIT_STALE_PROJECTION'),
                 ('workspace_id', 'other-workspace', 'WORD_EDIT_WORKSPACE_MISMATCH'),
                 ('expected_before', '错误正文', 'WORD_EDIT_REQUEST_INVALID')]
        for key, value, code in cases:
            request = self.request('op_two', 1, '已更新😀正文', '第二次更新')
            request[key] = value; request['input_hash'] = request_hash(request)
            with self.assertRaisesRegex(ValueError, code):
                self.apply(request)
            self.assertEqual(self.manifest(), committed)

    def test_manifest_is_authoritative_when_compatibility_copy_is_stale_or_absent(self):
        receipt = self.apply(self.request())
        edit.write_json(self.operations, edit.empty_log(self.data, self.source.read_bytes()))
        self.assertEqual(len(edit.load_log(self.input, self.operations)[3]['operations']), 1)
        self.operations.unlink()
        out = self.root / 'out'
        result = edit.finalize(self.input, self.operations, out)
        self.assertEqual(result['operation_count'], 1)
        self.assertEqual(Document(out / 'clean.docx').paragraphs[0].text, '已更新😀正文')
        self.assertEqual(self.apply(self.request()), receipt)

    def test_crash_before_manifest_leaves_previous_state_and_retry_applies_once(self):
        self.apply(self.request()); old = self.manifest()
        request = self.request('op_two', 1, '已更新😀正文', '第二次更新')
        original = edit.write_json
        def fail_manifest(path, value):
            if str(path).endswith('.manifest.json'):
                raise OSError('synthetic crash before commit')
            return original(path, value)
        with patch.object(edit, 'write_json', side_effect=fail_manifest):
            with self.assertRaises(OSError): self.apply(request)
        self.assertEqual(self.manifest(), old)
        receipt = self.apply(request)
        self.assertEqual(receipt['projection_version'], 2)
        self.assertEqual(len(edit.load_log(self.input, self.operations)[3]['operations']), 2)

    def test_crash_after_manifest_before_proxy_retries_original_committed_receipt(self):
        request = self.request(); original = edit.write_json
        def fail_proxy(path, value):
            if Path(path) == self.operations:
                raise OSError('synthetic crash after commit')
            return original(path, value)
        with patch.object(edit, 'write_json', side_effect=fail_proxy):
            with self.assertRaises(OSError): self.apply(request)
        self.assertFalse(self.operations.exists())
        receipt = self.apply(request)
        self.assertEqual(receipt['projection_version'], 1)
        self.assertEqual(len(edit.load_log(self.input, self.operations)[3]['operations']), 1)

    def test_object_corruption_and_manifest_path_escape_fail_closed(self):
        self.apply(self.request()); manifest = self.manifest()
        obj = self.root / manifest['operations_object_path']; raw = obj.read_bytes()
        obj.write_bytes(b'{"tampered":true}')
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_OBJECT_HASH_MISMATCH'):
            edit.load_log(self.input, self.operations)
        obj.write_bytes(raw)
        manifest['operations_object_path'] = '../escape.json'
        edit.write_json(str(self.operations) + '.manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_OBJECT_PATH_UNSAFE'):
            edit.load_log(self.input, self.operations)

    def test_legacy_mutation_advances_manifest_and_revert_invalidates_receipt(self):
        request = self.request(); self.apply(request)
        edit.apply_batch(self.input, self.operations, [{'id': 'legacy', 'kind': 'replace_text',
             'node_id': self.node, 'before': '已更新😀正文', 'after': '兼容修改'}])
        self.assertEqual(self.manifest()['projection_version'], 2)
        edit.revert(self.input, self.operations, from_op_id='op_one')
        self.assertEqual(self.manifest()['projection_version'], 3)
        self.assertEqual(edit.load_log(self.input, self.operations)[3]['operations'], [])
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_OP_REVERTED'):
            self.apply(request)

    def test_inspect_pagination_reports_node_units_and_current_version(self):
        self.apply(self.request())
        _, _, raw, _, editor = edit.load_editor(self.input, self.operations)
        page = edit.inspect_page(editor, raw, offset=0, limit=1)
        self.assertEqual(page['offset_unit'], 'node_index')
        self.assertEqual(page['text_offset_unit'], 'unicode_code_points')
        self.assertEqual(page['workspace_id'], self.data['workspace_id'])
        self.assertEqual(page['projection_version'], 1)
        self.assertEqual(page['next_offset'], 1)

    def test_two_processes_same_projection_accept_only_one_new_operation(self):
        files = []
        for i in range(2):
            path = self.root / ('request-%s.json' % i)
            edit.write_json(path, self.request('op_%s' % i, after='进程%s更新' % i)); files.append(path)
        processes = [subprocess.Popen([sys.executable, '-B', '-m', 'bondbuddy_file_authoring.fixed_edit',
                    'apply', '--input', str(self.input), '--operations', str(self.operations),
                    '--operation-file', str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ.copy())
                    for path in files]
        outputs = [p.communicate(timeout=30) for p in processes]
        self.assertEqual(sorted(p.returncode for p in processes), [0, 1])
        self.assertTrue(any(b'WORD_EDIT_STALE_PROJECTION' in err for _, err in outputs))
        self.assertEqual(len(edit.load_log(self.input, self.operations)[3]['operations']), 1)

    def test_preflight_reads_committed_log_and_detects_later_manifest_commit(self):
        from bondbuddy_file_authoring import preflight
        (self.root / 'output').mkdir(); (self.root / 'scratch').mkdir()
        self.operations = self.root / 'output/operations.json'
        self.data['baseline_kind'] = 'uploaded_source'; edit.write_json(self.input, self.data)
        receipt = self.apply(self.request())
        self.operations.unlink()
        report = {'version': preflight.quality.VERSION, 'status': 'passed', 'issues': []}
        with patch.object(preflight.quality, 'verify', return_value=report):
            result = preflight.preflight(self.input, self.operations, self.root / 'scratch/report.json')
        self.assertTrue(result['snapshot_current'])
        self.assertEqual(result['operations_sha256'], receipt['operations_sha256'])
        self.assertEqual(result['operation_count'], 1)
        def commit_during_check(_):
            self.apply(self.request('next', 1, '已更新😀正文', '后续正文'))
            return report
        with patch.object(preflight.quality, 'verify', side_effect=commit_during_check):
            changed = preflight.preflight(self.input, self.operations, self.root / 'scratch/report.json')
        self.assertFalse(changed['snapshot_current'])
        self.assertEqual(changed['issues'], [{'code': 'WORD_PREFLIGHT_INPUT_CHANGED'}])

    def test_reverse_audit_uses_committed_log_with_stale_or_absent_proxy(self):
        from bondbuddy_file_authoring.reverse_audit import inventory
        receipt = self.apply(self.request())
        for absent in (False, True):
            if absent:
                self.operations.unlink()
            else:
                edit.write_json(self.operations, edit.empty_log(self.data, self.source.read_bytes()))
            result = inventory(self.input, self.operations)
            self.assertEqual(result['operations_sha256'], receipt['operations_sha256'])
            self.assertEqual(result['occurrences'][self.node]['text'], '已更新😀正文')

    def test_orphan_gc_is_bounded_and_preserves_current_and_original_receipt_objects(self):
        first_request = self.request(); first = self.apply(first_request)
        self.apply(self.request('next', 1, '已更新😀正文', '后续正文'))
        orphan_ref, _ = edit.write_object(self.operations, {'synthetic': 'unreferenced'})
        gc = edit.gc_objects(self.input, self.operations, limit=200)
        self.assertLessEqual(gc['scanned'], 200)
        self.assertEqual(gc['removed'], 1)
        self.assertFalse((self.root / orphan_ref).exists())
        self.assertEqual(self.apply(first_request), first)
        for name in ('operations', 'projection', 'receipt'):
            self.assertTrue((self.root / first[name + '_object_path']).is_file())
        gc = edit.gc_objects(self.input, self.operations, limit=1)
        self.assertLessEqual(gc['scanned'], 1)

    def test_v2_large_document_commit_keeps_replay_overlay_and_bounded_disk(self):
        doc = Document()
        for index in range(8000):
            doc.add_paragraph('原稿第%s段。' % index)
        doc.save(self.source)
        self.data['baseline_sha256'] = edit.sha(self.source.read_bytes()); edit.write_json(self.input, self.data)
        nodes = [node for node in build_manifest(self.source)['nodes'] if node['kind'] == 'paragraph']
        legacy = [{'id': 'legacy_%s' % index, 'kind': 'replace_text', 'node_id': node['node_id'],
                   'before': node['text'], 'after': node['text'] + ' 已核对更新。'} for index, node in enumerate(nodes[:588])]
        edit.apply_batch(self.input, self.operations, legacy)
        started = time.monotonic()
        for index, node in enumerate(nodes[588:600]):
            self.node = node['node_id']
            request = self.request('v2_%s' % index, index, node['text'], node['text'] + ' 已核对更新。')
            request['batch_id'] = 'large-batch-%s' % index; request['input_hash'] = request_hash(request)
            self.apply(request)
        elapsed = time.monotonic() - started
        manifest = self.manifest()
        projection = edit.read_json(self.root / manifest['projection_object_path'])
        total_bytes = sum(path.stat().st_size for path in (self.root / '.operations.json.objects').iterdir())
        print(json.dumps({'benchmark': '8000_paragraphs_600_cumulative_ops_12_v2_commits',
                          'v2_commit_seconds': round(elapsed, 3), 'immutable_object_bytes': total_bytes}))
        self.assertEqual(projection.get('representation'), 'replay_overlay')
        self.assertNotIn('nodes', projection)
        self.assertLess(total_bytes, 8 * 1024 * 1024)
        self.assertLess(elapsed, 45)
        *_, editor = edit.load_editor(self.input, self.operations)
        self.assertEqual(len(editor.operations), 600)
        self.assertEqual(edit.node_text(editor.nodes[nodes[599]['node_id']][1]), nodes[599]['text'] + ' 已核对更新。')
