"""Model-facing recovery aids for fixed Word edits: located errors, find/replace,
partial apply, revert/reset and bounded inspect. Host protocol stays unchanged."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document

from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.template_manifest import build_manifest, sha


class FixedEditRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        document = Document()
        document.add_heading('第一章 发行人概况', level=1)
        document.add_paragraph('截至2024年末，发行人净资产为100万元，营业收入为80万元。')
        document.add_paragraph('参考企业有限公司为参考企业有限公司的子公司。')
        document.add_paragraph('保留的原始段落。')
        table = document.add_table(rows=2, cols=2)
        table.style = 'Table Grid'
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2024年度'
        table.cell(1, 0).text = '净资产'
        table.cell(1, 1).text = '100'
        document.save(self.source)
        self.data = {'input_hash': 'b' * 64, 'revision_author': 'BondBuddy-test',
                     'revision_date': '2026-11-21T00:00:00.000Z',
                     'baseline_path': 'source.docx', 'baseline_sha256': sha(self.source.read_bytes())}
        self.input = self.root / 'input.json'
        write_json(self.input, self.data)
        self.log_path = self.root / 'operations.json'
        self.op_file = self.root / 'op.json'

    def tearDown(self):
        self.temp.cleanup()

    def node(self, text, kind='paragraph'):
        return next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == kind and n['text'] == text)

    def cli(self, *args, ops=None):
        if ops is not None:
            write_json(self.op_file, ops)
        command = [sys.executable, '-m', 'bondbuddy_file_authoring.fixed_edit', args[0],
                   '--input', str(self.input), '--operations', str(self.log_path), *args[1:]]
        if ops is not None:
            command += ['--operation-file', str(self.op_file)]
        return subprocess.run(command, capture_output=True, encoding='utf-8', timeout=60)

    def saved(self):
        return json.loads(self.log_path.read_text(encoding='utf-8'))['operations']

    def test_anchor_mismatch_names_operation_and_current_text(self):
        node = self.node('截至2024年末，发行人净资产为100万元，营业收入为80万元。')
        good = {'id': 'ok', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': node['text'],
                'after': node['text'].replace('100', '120')}
        # Second op still copies the original text although op 1 already changed it.
        stale = {'id': 'stale', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': node['text'],
                 'after': node['text'].replace('80', '90')}
        result = self.cli('apply', ops=[good, stale])
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stderr)
        self.assertEqual(report['error'], 'WORD_EDIT_ANCHOR_MISMATCH')
        detail = report['detail']
        self.assertEqual(detail['unit_index'], 1)
        self.assertEqual(detail['operation_id'], 'stale')
        self.assertIn('120', detail['current_text'])
        self.assertEqual(detail['current_text'][detail['first_difference_at']:][:2], '20')
        self.assertFalse(self.log_path.exists())  # default mode stays all-or-nothing

    def test_unknown_node_reports_the_node_id(self):
        result = self.cli('apply', ops={'id': 'x', 'kind': 'replace_text', 'node_id': 'word/document.xml#paragraph:99:bad',
                                        'before': 'a', 'after': 'b'})
        report = json.loads(result.stderr)
        self.assertEqual(report['error'], 'WORD_EDIT_NODE_NOT_FOUND')
        self.assertEqual(report['detail']['node_id'], 'word/document.xml#paragraph:99:bad')

    def test_find_replace_is_stored_as_canonical_before_after(self):
        node = self.node('截至2024年末，发行人净资产为100万元，营业收入为80万元。')
        cell = self.node('100', 'cell')
        ops = [{'id': 'f1', 'kind': 'replace_text', 'node_id': node['node_id'], 'find': '100万元', 'replace': '120万元'},
               {'id': 'f2', 'kind': 'replace_text', 'node_id': node['node_id'], 'find': '2024年末', 'replace': '2025年末'},
               {'id': 'f3', 'kind': 'replace_cell_text', 'node_id': cell['node_id'], 'find': '100', 'replace': '120'}]
        result = self.cli('apply', ops=ops)
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = self.saved()
        self.assertEqual(saved[1]['before'], '截至2024年末，发行人净资产为120万元，营业收入为80万元。')
        self.assertEqual(saved[1]['after'], '截至2025年末，发行人净资产为120万元，营业收入为80万元。')
        self.assertTrue(all('find' not in op and 'replace' not in op for op in saved))
        output = self.root / 'out'
        finalize(self.input, self.log_path, output, skip_report=True)
        clean = Document(output / 'clean.docx')
        self.assertIn('截至2025年末，发行人净资产为120万元，营业收入为80万元。', [p.text for p in clean.paragraphs])
        self.assertEqual(clean.tables[0].cell(1, 1).text, '120')

    def test_find_must_be_unique_and_present(self):
        node = self.node('参考企业有限公司为参考企业有限公司的子公司。')
        ambiguous = self.cli('apply', ops={'id': 'a', 'kind': 'replace_text', 'node_id': node['node_id'],
                                           'find': '参考企业有限公司', 'replace': '目标公司'})
        report = json.loads(ambiguous.stderr)
        self.assertEqual(report['error'], 'WORD_EDIT_FIND_AMBIGUOUS')
        self.assertEqual(report['detail']['occurrence_count'], 2)
        missing = self.cli('apply', ops={'id': 'm', 'kind': 'replace_text', 'node_id': node['node_id'],
                                         'find': '不存在的文字', 'replace': 'x'})
        self.assertEqual(json.loads(missing.stderr)['error'], 'WORD_EDIT_FIND_NOT_FOUND')
        mixed = self.cli('apply', ops={'id': 'b', 'kind': 'replace_text', 'node_id': node['node_id'],
                                       'before': node['text'], 'find': '为', 'replace': '是'})
        self.assertEqual(json.loads(mixed.stderr)['error'], 'WORD_EDIT_FIND_REPLACE_INVALID')
        self.assertFalse(self.log_path.exists())

    def test_anchor_only_kinds_may_omit_before(self):
        node = self.node('保留的原始段落。')
        result = self.cli('apply', ops=[{'id': 'c1', 'kind': 'add_comment', 'node_id': node['node_id'], 'text': '请核对。'},
                                        {'id': 'p1', 'kind': 'insert_paragraph', 'node_id': node['node_id'], 'text': '新增段落。'}])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([op['before'] for op in self.saved()], ['保留的原始段落。'] * 2)
        # A modifying kind still needs before or find.
        bad = self.cli('apply', ops={'id': 'r1', 'kind': 'replace_text', 'node_id': node['node_id'], 'after': 'x'})
        self.assertEqual(json.loads(bad.stderr)['error'], 'WORD_EDIT_OPERATION_INVALID')

    def test_partial_apply_keeps_good_units_and_atomic_groups(self):
        first = self.node('截至2024年末，发行人净资产为100万元，营业收入为80万元。')
        keep = self.node('保留的原始段落。')
        good = {'id': 'g1', 'kind': 'replace_text', 'node_id': keep['node_id'], 'find': '原始', 'replace': '更新'}
        # Group: first op is valid but second fails, so neither may be saved.
        group = [{'id': 'grp1', 'kind': 'replace_text', 'node_id': first['node_id'], 'find': '100', 'replace': '120'},
                 {'id': 'grp2', 'kind': 'replace_text', 'node_id': first['node_id'], 'find': '不存在', 'replace': 'x'}]
        later = {'id': 'g2', 'kind': 'replace_text', 'node_id': first['node_id'], 'find': '80万元', 'replace': '90万元'}
        result = self.cli('apply', '--partial', ops=[good, group, later])
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(json.loads(result.stderr), {'error': 'WORD_EDIT_PARTIAL_APPLY'})
        report = json.loads(result.stdout)
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(report['rejected_units'][0]['unit_index'], 1)
        self.assertEqual(report['rejected_units'][0]['operation_ids'], ['grp1', 'grp2'])
        self.assertEqual(report['rejected_units'][0]['error'], 'WORD_EDIT_FIND_NOT_FOUND')
        self.assertEqual([op['id'] for op in self.saved()], ['g1', 'g2'])
        # g2 was resolved against the rebuilt document, not the half-applied group.
        self.assertEqual(self.saved()[1]['before'], first['text'])
        # Retrying the corrected group with the same ids succeeds.
        group[1] = {'id': 'grp2', 'kind': 'replace_text', 'node_id': first['node_id'], 'find': '2024', 'replace': '2025'}
        retry = self.cli('apply', '--partial', ops=[group])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(json.loads(retry.stdout)['status'], 'applied')

    def test_nested_groups_require_partial_mode(self):
        keep = self.node('保留的原始段落。')
        result = self.cli('apply', ops=[[{'id': 'x', 'kind': 'replace_text', 'node_id': keep['node_id'],
                                          'find': '原始', 'replace': '新'}]])
        self.assertEqual(json.loads(result.stderr)['error'], 'WORD_EDIT_OPERATION_INVALID')

    def test_revert_and_reset_rewrite_the_log_without_deleting_files(self):
        node = self.node('截至2024年末，发行人净资产为100万元，营业收入为80万元。')
        keep = self.node('保留的原始段落。')
        ops = [{'id': 'a', 'kind': 'replace_text', 'node_id': keep['node_id'], 'find': '原始', 'replace': '更新'},
               {'id': 'b', 'kind': 'replace_text', 'node_id': node['node_id'], 'find': '100', 'replace': '120'},
               {'id': 'c', 'kind': 'replace_text', 'node_id': node['node_id'], 'find': '80', 'replace': '90'}]
        self.assertEqual(self.cli('apply', ops=ops).returncode, 0)
        # c's before contains b's result, so dropping only b must be refused.
        conflict = self.cli('revert', '--op-id', 'b')
        report = json.loads(conflict.stderr)
        self.assertEqual(report['error'], 'WORD_EDIT_REVERT_CONFLICT')
        self.assertEqual(report['detail']['blocking_operation_id'], 'c')
        self.assertEqual([op['id'] for op in self.saved()], ['a', 'b', 'c'])
        dropped = self.cli('revert', '--from-op-id', 'b')
        self.assertEqual(dropped.returncode, 0, dropped.stderr)
        self.assertEqual(json.loads(dropped.stdout)['removed_operation_ids'], ['b', 'c'])
        self.assertEqual([op['id'] for op in self.saved()], ['a'])
        missing = self.cli('revert', '--op-id', 'zzz')
        self.assertEqual(json.loads(missing.stderr)['error'], 'WORD_EDIT_REVERT_TARGET_NOT_FOUND')
        refused = self.cli('reset')
        self.assertEqual(json.loads(refused.stderr)['error'], 'WORD_EDIT_ARGUMENT_REQUIRED')
        cleared = self.cli('reset', '--confirm-reset')
        self.assertEqual(cleared.returncode, 0, cleared.stderr)
        self.assertEqual(self.saved(), [])
        self.assertEqual(json.loads(self.log_path.read_text())['baseline_sha256'], self.data['baseline_sha256'])

    def test_inspect_find_kind_and_size_budget(self):
        found = self.cli('inspect', '--find', '净资产为', '--kind', 'paragraph')
        self.assertEqual(found.returncode, 0, found.stderr)
        page = json.loads(found.stdout)
        self.assertEqual(page['total'], 1)
        self.assertIsNone(page['next_offset'])
        self.assertIn('净资产为100万元', page['nodes'][0]['text'])
        cells = json.loads(self.cli('inspect', '--kind', 'cell').stdout)
        self.assertEqual(cells['total'], 4)
        budget = json.loads(self.cli('inspect', '--limit', '200', '--max-chars', '1000').stdout)
        self.assertTrue(budget['truncated_by_size'])
        self.assertLess(len(budget['nodes']), budget['total'])
        self.assertEqual(budget['next_offset'], len(budget['nodes']))
        bad = self.cli('inspect', '--limit', '500')
        report = json.loads(bad.stderr)
        self.assertEqual(report['error'], 'WORD_EDIT_PAGE_INVALID')
        self.assertEqual(report['detail']['max_limit'], 200)

    def test_host_commands_keep_one_key_error_protocol(self):
        # The worker accepts only a one-key {"error": ...} object from host commands.
        self.data['baseline_sha256'] = 'c' * 64
        write_json(self.input, self.data)
        result = subprocess.run([sys.executable, '-m', 'bondbuddy_file_authoring.fixed_edit', 'prepare',
                                 '--input', str(self.input), '--manifest', str(self.root / 'm.json')],
                                capture_output=True, encoding='utf-8', timeout=60)
        self.assertEqual(json.loads(result.stderr), {'error': 'WORD_EDIT_SOURCE_HASH_MISMATCH'})


if __name__ == '__main__':
    unittest.main()
