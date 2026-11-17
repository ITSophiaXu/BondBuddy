"""Synthetic table/top-level coordinate regression; no model or customer facts."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from docx import Document
from bondbuddy_file_authoring.check import package
from bondbuddy_file_authoring.fixed_edit import Editor, empty_log, finalize, write_json
from bondbuddy_file_authoring.preflight import preflight
from bondbuddy_file_authoring.quality import verify
from bondbuddy_file_authoring.repair_scope import create_scope, apply_answers
from bondbuddy_file_authoring.template_manifest import build_manifest, sha
from bondbuddy_file_authoring.word_patch import paragraph_text, q, xml


class RepairScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'output').mkdir()
        self.source = self.root / 'source.docx'
        doc = Document()
        table = doc.add_table(rows=24, cols=1)
        for i, row in enumerate(table.rows):
            row.cells[0].text = '保留表格数据' + str(i)
        for i, number in enumerate('一二三四五六七'):
            doc.add_heading('第' + number + '章 合成业务' + str(i), 1)
            doc.add_paragraph('原章节正文' + str(i))
        doc.add_heading('第八章 保留业务', 1)
        for i in range(40):
            doc.add_paragraph('无关业务段落' + str(i))
        doc.save(self.source)
        self.data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-synthetic',
                     'revision_date': '2026-11-17T00:00:00.000Z', 'baseline_kind': 'uploaded_source',
                     'baseline_path': 'source.docx', 'baseline_sha256': sha(self.source.read_bytes()),
                     'operations_path': 'output/operations.json',
                     'output': {'tracked': 'delivered/tracked.docx', 'clean': 'delivered/clean.docx', 'baseline': 'delivered/baseline.docx'}}
        self.input, self.ops = self.root / 'input.json', self.root / 'output/operations.json'
        write_json(self.input, self.data)
        nodes = build_manifest(self.source)['nodes']
        self.paragraphs = {n['text']: n['node_id'] for n in nodes if n['kind'] == 'paragraph'}
        self.log = empty_log(self.data, self.source.read_bytes())
        for i in range(7):
            text = '原章节正文' + str(i)
            self.log['operations'].append({'id': 'clear_' + str(i), 'kind': 'replace_text',
                                          'node_id': self.paragraphs[text], 'before': text, 'after': ''})
        write_json(self.ops, self.log)

    def answers(self, scope):
        return {'version': 'word-chapter-repair-answers-v1', 'scope_sha256': scope['scope_sha256'],
                'answers': [{'issue_id': t['issue_id'], 'text': '目标主体本期业务正文' + str(i)}
                            for i, t in enumerate(scope['targets'])]}

    def test_seven_wrong_coordinates_reproduce_but_cannot_authorize_repairs(self):
        source_root = xml(package(self.source)['word/document.xml'])
        xml_paragraphs = list(source_root.iter(q('p')))
        top_level = Document(self.source).paragraphs
        scope = create_scope(self.input, self.ops)
        self.assertEqual(len(scope['targets']), 7)
        for i in range(7):
            index = next(j for j, p in enumerate(xml_paragraphs) if paragraph_text(p) == '原章节正文' + str(i))
            wrong_text = top_level[index].text
            self.assertTrue(wrong_text.startswith('无关业务段落'))
            # Existing ID/before checks accept the incorrectly selected paragraph.
            editor = Editor(self.data, self.source).replay(self.log['operations'])
            editor.apply({'id': 'wrong_' + str(i), 'kind': 'replace_text',
                          'node_id': self.paragraphs[wrong_text], 'before': wrong_text, 'after': '错误补写'})
            forged = copy.deepcopy(scope)
            forged['targets'][i].update(node_id=self.paragraphs[wrong_text], before=wrong_text)
            with self.assertRaisesRegex(ValueError, 'WORD_REPAIR_SNAPSHOT_MISMATCH'):
                apply_answers(self.input, self.ops, forged, self.answers(scope))
        before = self.ops.read_bytes()
        candidate = apply_answers(self.input, self.ops, scope, self.answers(scope))
        self.assertEqual(self.ops.read_bytes(), before)
        write_json(self.ops, candidate)
        finalize(self.input, self.ops, self.root / 'delivered', skip_report=True)
        clean = Document(self.root / 'delivered/clean.docx')
        for i in range(7):
            self.assertEqual(clean.paragraphs[i * 2 + 1].text, '目标主体本期业务正文' + str(i))
        self.assertEqual([p.text for p in clean.paragraphs[14:]], [p.text for p in top_level[14:]])
        self.assertEqual([r.cells[0].text for r in clean.tables[0].rows], [r.cells[0].text for r in Document(self.source).tables[0].rows])
        self.assertEqual(verify(self.input)['status'], 'passed')

    def test_stale_log_or_forged_snapshot_rejected(self):
        scope = create_scope(self.input, self.ops)
        write_json(self.ops, {**self.log, 'operations': self.log['operations'] + [
            {'id': 'unrelated', 'kind': 'replace_text', 'node_id': self.paragraphs['无关业务段落0'],
             'before': '无关业务段落0', 'after': '另一次已保存修改'}]})
        with self.assertRaisesRegex(ValueError, 'SNAPSHOT_MISMATCH'):
            apply_answers(self.input, self.ops, scope, self.answers(scope))

    def test_multiple_lost_paragraphs_in_one_chapter_are_all_repaired_but_original_blanks_are_not(self):
        doc = Document()
        doc.add_heading('第一章 合成业务', 1)
        doc.add_paragraph('原本有内容的一段')
        doc.add_paragraph('')
        doc.add_paragraph('原本有内容的另一段')
        doc.add_heading('第二章 保留业务', 1)
        doc.add_paragraph('无需修改的正文')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        log = empty_log(self.data, self.source.read_bytes())
        for node in build_manifest(self.source)['nodes']:
            if node['kind'] == 'paragraph' and node['text'].startswith('原本有内容'):
                log['operations'].append({'id': 'empty_' + str(len(log['operations'])), 'kind': 'replace_text',
                                          'node_id': node['node_id'], 'before': node['text'], 'after': ''})
        write_json(self.ops, log)
        scope = create_scope(self.input, self.ops)
        self.assertEqual(len(scope['targets']), 2)
        self.assertEqual({t['source_text'] for t in scope['targets']}, {'原本有内容的一段', '原本有内容的另一段'})
        self.assertEqual(len({t['chapter_index'] for t in scope['targets']}), 1)
        candidate = apply_answers(self.input, self.ops, scope, self.answers(scope))
        self.assertEqual(len(candidate['operations']), 4)

    def test_answers_cannot_choose_nodes_skip_duplicate_or_invent_issues(self):
        scope = create_scope(self.input, self.ops)
        for change in ['node', 'foreign', 'duplicate', 'missing', 'blank', 'oversize', 'extra', 'hash', 'control']:
            answer = self.answers(scope)
            if change == 'node': answer['answers'][0]['node_id'] = self.paragraphs['无关业务段落0']
            if change == 'foreign': answer['answers'][0]['issue_id'] = 'another-chapter'
            if change == 'duplicate': answer['answers'][0] = answer['answers'][1]
            if change == 'missing': answer['answers'].pop()
            if change == 'blank': answer['answers'][0]['text'] = '   '
            if change == 'oversize': answer['answers'][0]['text'] = 'x' * 30001
            if change == 'extra': answer['operations'] = []
            if change == 'hash': answer['scope_sha256'] = 'b' * 64
            if change == 'control': answer['answers'][0]['text'] = '\x00'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'WORD_REPAIR_'):
                apply_answers(self.input, self.ops, scope, answer)

    def test_heading_wording_can_change_but_title_cannot_be_a_body_target(self):
        title = '第一章 合成业务0'
        self.log['operations'].append({'id': 'new_issuer_title', 'kind': 'replace_text',
                                      'node_id': self.paragraphs[title], 'before': title, 'after': '第一章 目标主体概况'})
        write_json(self.ops, self.log)
        scope = create_scope(self.input, self.ops)
        self.assertIn('目标主体', scope['targets'][0]['title'])
        self.assertNotEqual(scope['targets'][0]['node_id'], self.paragraphs[title])
        forged = copy.deepcopy(scope)
        forged['targets'][0]['node_id'] = self.paragraphs[title]
        with self.assertRaisesRegex(ValueError, 'SNAPSHOT_MISMATCH'):
            apply_answers(self.input, self.ops, forged, self.answers(scope))

    def test_outline_regression_fails_before_requesting_text(self):
        title = '第一章 合成业务0'
        self.log['operations'].append({'id': 'delete_title', 'kind': 'replace_text',
                                      'node_id': self.paragraphs[title], 'before': title, 'after': ''})
        write_json(self.ops, self.log)
        with self.assertRaisesRegex(ValueError, 'WORD_REPAIR_STRUCTURE_UNSAFE'):
            create_scope(self.input, self.ops)

    def test_preflight_hands_off_empty_bodies_without_a_delivery_receipt(self):
        report = preflight(self.input, self.ops, self.root / 'scratch/preflight.json')
        self.assertEqual(report['next_action'], 'handoff_to_worker')
        self.assertFalse(report['host_acceptance'])
        self.assertEqual(report['status'], 'failed')
        p = report['diagnostics']['chapter_content'][0]['current']['paragraphs'][1]
        self.assertIn('xml_paragraph_index', p)
        self.assertNotIn('paragraph_index', p)


if __name__ == '__main__':
    unittest.main()
