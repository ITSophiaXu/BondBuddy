import base64
import io
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from zipfile import ZipFile

from backend.store import Store
from backend.documents import parse_document, targets, word_export, text_diff
from backend.engine import (add_file, apply_model_result, candidate_targets, fetch_public_url,
                            project_view, publication_changes, review_change, stage_candidates,
                            validate_sources, working_file)
from backend.runner import Runner, SCHEMA, command_for, evidence_for, targets_for_run, write_source_library
from backend.server import create_server
from backend.demo import seed

ROOT = Path(__file__).resolve().parents[1]


def pdf_fixture(blank_page=False):
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    d = canvas.Canvas(buf)
    d.drawString(72, 720, 'Financial report assets 120')
    d.showPage()
    if blank_page:
        d.showPage()
    d.save()
    return buf.getvalue()


class ProjectFixture:
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(self.temp.name)
        self.p = self.store.create('测试', period='2026-06-30')
        self.original = add_file(self.store, self.p, '# 财务会计信息\n截至2026年3月末，总资产为100万元。\n实缴资本为90万元。\n注册资本为【待核对】万元。\n实收资本为80万元。'.encode(), '底稿.md', 'prospectus', 'prospectus')
        self.source = add_file(self.store, self.p, '2026年6月30日合并资产总额为120万元，单位：万元，未经审计。'.encode(), '报表.txt', 'source', 'financial')
        self.ts = targets(self.original)
        self.target = self.ts[1]
        self.ref = {'source_id': self.source['id'], 'segment_id': self.source['segments'][0]['id'], 'quote': '合并资产总额为120万元'}

    def result(self, tid=None, after='截至2026年6月末，总资产为120万元。', sources=None):
        return {'intent': 'update', 'summary': 'test', 'changes': [{'target_id': tid or self.target['id'], 'after': after,
                'needs_review': False, 'issue': '', 'reason': '新报告期', 'sources': [self.ref] if sources is None else sources}], 'assessments': []}

    def apply(self, result):
        apply_model_result(self.p, result, {t['id'] for t in self.ts}, self.p['revision'])
        return next((c for c in self.p['changes'] if c['target_id'] == self.target['id']), None)


class ProjectCase(ProjectFixture, unittest.TestCase):

    def test_candidate_marks_do_not_count_as_completed_changes(self):
        stage_candidates(self.p)
        view = project_view(self.p)
        self.assertEqual(0, view['stats']['changes'])
        self.assertGreater(view['stats']['scan_candidates'], 0)
        self.apply(self.result())
        self.assertEqual(1, project_view(self.p)['stats']['changes'])

    def test_unprocessed_candidates_are_separate_from_human_review(self):
        stage_candidates(self.p)
        view = project_view(self.p)
        self.assertGreater(view['stats']['awaiting_agent'], 0)
        self.assertEqual(1, view['stats']['needs_review'])
        self.assertEqual(1, view['stats']['original_todos'])
        candidate = next(c for c in view['changes'] if c['target_id'] == self.target['id'])
        self.assertEqual('awaiting_agent', candidate['review_stage'])
        self.assertIn('【', candidate['after'])
        self.apply(self.result(sources=[]))
        after = project_view(self.p)
        self.assertEqual(2, after['stats']['needs_review'])
        self.assertEqual(view['stats']['awaiting_agent'] - 1, after['stats']['awaiting_agent'])

    def test_valid_quote_stays_reviewable_not_auto_accepted(self):
        c = self.apply(self.result())
        self.assertEqual('pending', c['status'])
        self.assertTrue(c['sources'][0]['verified'])
        self.assertNotIn('【', c['after'])

    def test_matching_quote_does_not_justify_invented_amount(self):
        c = self.apply(self.result(after='截至2026年6月末，总资产为999万元。'))
        self.assertEqual('needs_review', c['status'])
        self.assertIn('【待确认：999】', c['after'])

    def test_supported_unit_conversion_with_reason(self):
        r = self.result(after='截至2026年6月末，总资产为0.012亿元。')
        r['changes'][0]['reason'] = '单位换算：120万元 ÷ 10000 = 0.012亿元。'
        c = self.apply(r)
        self.assertEqual('pending', c['status'])

    def test_ocr_citation_keeps_source_and_requires_review(self):
        self.source['segments'][0]['ocr'] = True
        c = self.apply(self.result())
        self.assertEqual('needs_review', c['status'])
        self.assertTrue(c['sources'][0]['ocr'])
        self.assertIn('【', c['after'])

    def test_source_invalid_period_forces_review(self):
        self.source['source_checks'] = [{'requires_review': True, 'text': '报告期为无效日期2025年6月31日'}]
        c = self.apply(self.result())
        self.assertEqual('needs_review', c['status'])
        self.assertIn('无效日期', c['reason'])

    def test_unrelated_source_warning_does_not_taint_valid_quote(self):
        self.source['source_checks'] = [{'requires_review': True, 'text': '其他位置日期无效', 'segment_id': 'other'}]
        c = self.apply(self.result())
        self.assertEqual('pending', c['status'])
        self.assertNotIn('其他位置日期无效', c['reason'])

    def test_forged_or_missing_source_always_bracketed(self):
        for refs in ([], [dict(self.ref, quote='资产为999万元')], [dict(self.ref, source_id=self.original['id'])], None):
            r = self.result(sources=refs)
            r['changes'][0]['sources'] = refs
            c = self.apply(r)
            self.assertEqual('needs_review', c['status'])
            self.assertIn('【', c['after'])
            self.assertEqual([], c['sources'])

    def test_unsourced_agent_value_is_not_applied_or_counted_as_change(self):
        c = self.apply(self.result(after='截至2026年6月末，总资产为999万元。', sources=[]))
        self.assertEqual('截至2026年6月末，总资产为999万元。', c['proposal'])
        self.assertNotIn('999', c['after'])
        view = project_view(self.p)
        shown = next(x for x in view['changes'] if x['target_id'] == self.target['id'])
        self.assertEqual('missing_source', shown['review_stage'])
        self.assertEqual(0, view['stats']['changes'])
        self.assertEqual(1, view['stats']['missing_source'])
        exported = word_export(self.original, publication_changes(self.p['changes']), 'final')
        xml = ZipFile(io.BytesIO(exported)).read('word/document.xml').decode()
        self.assertNotIn('999', xml)

    def test_cannot_accept_unresolved_and_versions_are_checked(self):
        c = self.apply(self.result(sources=[]))
        with self.assertRaises(ValueError):
            review_change(self.p, c['id'], 'accept')
        with self.assertRaises(ValueError):
            review_change(self.p, c['id'], 'edit', '正确内容', version=999)

    def test_human_edit_archives_previous_evidence_and_prevents_overwrite(self):
        c = self.apply(self.result())
        review_change(self.p, c['id'], 'edit', '人工确认金额121万元', version=1)
        self.apply(self.result(after='错误覆盖'))
        self.assertEqual('人工确认金额121万元', c['after'])
        self.assertEqual([], c['sources'])
        self.assertTrue(self.p['history'][-1]['before']['sources'])
        full = project_view(self.p, full_history=True)
        self.assertTrue(full['history'][-1]['before']['sources'])

    def test_financial_mode_blocks_registry_capital_but_not_accounting_capital(self):
        self.apply(self.result(tid=self.ts[2]['id'], after='实缴资本为120万元。'))
        self.assertFalse(any(c['target_id'] == self.ts[2]['id'] for c in self.p['changes']))
        self.assertEqual('out_of_scope', self.p['coverage'][self.ts[2]['id']]['decision'])
        self.apply(self.result(tid=self.ts[4]['id'], after='实收资本为120万元。'))
        self.assertTrue(any(c['target_id'] == self.ts[4]['id'] for c in self.p['changes']))

    def test_mixed_paragraph_cannot_smuggle_registry_update(self):
        t = self.target
        t['text'] = self.original['blocks'][1]['text'] = '注册资本为90万元，资产总额为100万元。'
        self.apply(self.result(after='注册资本为120万元，资产总额为120万元。'))
        self.assertFalse(any(c['target_id'] == t['id'] for c in self.p['changes']))
        c = self.apply(self.result(after='注册资本为90万元，资产总额为120万元。'))
        self.assertEqual('pending', c['status'])

    def test_full_mode_accepts_cited_registry_material(self):
        self.p['mode'] = 'full'
        source = add_file(self.store, self.p, '工商公示：截至2026年6月30日，实缴资本为120万元。'.encode(), '工商.txt', 'source', 'registry')
        ref = {'source_id': source['id'], 'segment_id': source['segments'][0]['id'], 'quote': '实缴资本为120万元'}
        self.apply(self.result(tid=self.ts[2]['id'], after='实缴资本为120万元。', sources=[ref]))
        c = next(c for c in self.p['changes'] if c['target_id'] == self.ts[2]['id'])
        self.assertEqual('pending', c['status'])

    def test_original_brackets_inventory_survives_keep_and_rejection(self):
        tid = self.ts[3]['id']
        self.assertTrue(any(c['target_id'] == tid for c in self.p['changes']))
        result = {'changes': [], 'assessments': [{'target_id': tid, 'decision': 'out_of_scope', 'reason': '工商字段'}]}
        self.apply(result)
        c = next(c for c in self.p['changes'] if c['target_id'] == tid)
        review_change(self.p, c['id'], 'reject')
        self.assertEqual('needs_review', c['status'])
        self.assertIn('【', c['after'])

    def test_invalid_change_does_not_hide_valid_assessment(self):
        r = self.result(after=None)
        r['assessments'] = [{'target_id': self.target['id'], 'decision': 'review', 'reason': '缺少资料'}]
        c = self.apply(r)
        self.assertEqual('review', self.p['coverage'][self.target['id']]['decision'])
        self.assertIn('【', c['after'])

    def test_unknown_ids_and_revision_conflicts(self):
        before = len(self.p['changes'])
        self.apply(self.result(tid='invented'))
        self.assertEqual(before, len(self.p['changes']))
        with self.assertRaises(ValueError):
            apply_model_result(self.p, self.result(), {self.target['id']}, 100)

    def test_new_period_column_preserves_historical_columns(self):
        p = self.store.create('年度表')
        f = add_file(self.store, p, '# 财务信息\n|项目|2024年末|2025年末|\n|---|---|---|\n|资产总额|90|100|'.encode(), '底稿.md', 'prospectus', 'prospectus')
        stage_candidates(p)
        stage_candidates(p)
        table = working_file(p)['blocks'][1]
        self.assertEqual(4, len(table['rows'][0]))
        self.assertEqual(['资产总额', '90', '100'], [c['text'] for c in table['rows'][1][:3]])
        additions = [c for c in p['changes'] if ':newperiod:' in c['target_id']]
        self.assertEqual(2, len(additions))
        self.assertTrue(all('【' in c['after'] for c in additions))
        self.assertEqual(3, len(f['blocks'][1]['rows'][0]))

    def test_layout_tasks_are_separate_from_human_review_count(self):
        self.original['layout_tasks'] = [{'target_id': self.target['id'], 'text': '新增报告期列安排'}]
        view = project_view(self.p)
        self.assertEqual(1, view['stats']['needs_review'])
        self.assertEqual(1, view['stats']['layout_tasks'])

    def test_reject_keeps_original_in_export(self):
        c = self.apply(self.result())
        review_change(self.p, c['id'], 'reject')
        xml = ZipFile(io.BytesIO(word_export(self.original, self.p['changes']))).read('word/document.xml').decode()
        self.assertIn('总资产为100万元', xml)
        self.assertNotIn('总资产为120万元', xml)

    def test_word_revision_has_real_redline_and_final_keeps_brackets(self):
        self.apply(self.result(sources=[]))
        revision = word_export(self.original, self.p['changes'], 'revision')
        final = word_export(self.original, self.p['changes'], 'final')
        xr = ZipFile(io.BytesIO(revision)).read('word/document.xml').decode()
        xf = ZipFile(io.BytesIO(final)).read('word/document.xml').decode()
        self.assertIn('<w:ins ', xr)
        self.assertIn('<w:del ', xr)
        self.assertNotIn('<w:del ', xf)
        self.assertIn('【', xf)

    def test_restart_preserves_decisions_and_marks_interrupted_job(self):
        c = self.apply(self.result())
        review_change(self.p, c['id'], 'accept')
        self.p['job']['status'] = 'running'
        self.store.save(self.p)
        p2 = Store(self.temp.name).get(self.p['id'])
        self.assertEqual('interrupted', p2['job']['status'])
        self.assertTrue(any(c['status'] == 'accepted' for c in p2['changes']))


class ParserAndBoundaryTests(unittest.TestCase):
    def test_pdf_blank_columns_do_not_shift_period_or_company(self):
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
        buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=(600,800)); c.setFont('STSong-Light',10)
        c.drawCentredString(325,690,'期末余额'); c.drawCentredString(465,690,'期初余额')
        for x,label in [(290,'合并'),(360,'公司'),(430,'合并'),(500,'公司')]:
            c.drawCentredString(x,670,label)
        c.drawString(70,650,'其他流动资产'); c.drawCentredString(290,650,'83.97'); c.drawCentredString(430,650,'91.18')
        c.save()
        f = parse_document(buf.getvalue(), 'report.pdf', 'f')
        row = next(s for s in f['segments'] if '83.97' in s['text'])
        self.assertIn('期末余额/合并：83.97', row['source_context'])
        self.assertIn('期末余额/公司：空白', row['source_context'])
        self.assertIn('期初余额/合并：91.18', row['source_context'])
        self.assertIn('期初余额/公司：空白', row['source_context'])

    def test_ocr_punctuation_stays_with_amount_and_columns_remain_separate(self):
        from backend.ocr import spatial_lines
        words = [
            {'text':'收入','x':10,'y':10,'width':30,'height':20},
            {'text':'123','x':100,'y':12,'width':30,'height':16},
            {'text':'.','x':131,'y':25,'width':3,'height':3},
            {'text':'45','x':135,'y':12,'width':20,'height':16},
            {'text':'678','x':230,'y':12,'width':30,'height':16},
            {'text':'成本','x':10,'y':40,'width':30,'height':20},
        ]
        self.assertEqual(['收入   123.45   678', '成本'], spatial_lines([{'words':words}]))

    def test_docx_toc_page_numbers_are_not_financial_candidates(self):
        from backend.engine import candidate_targets
        from docx import Document
        d = Document(); d.add_paragraph('第五节 财务会计信息\t80'); d.add_heading('第五节 财务会计信息', 1)
        b = io.BytesIO(); d.save(b)
        f = {'id':'f', **parse_document(b.getvalue(), 'prospectus.docx', 'f')}
        p = {'files':[f], 'original_id':'f', 'mode':'financial'}
        self.assertTrue(f['blocks'][0]['toc_entry'])
        self.assertEqual('paragraph', f['blocks'][0]['type'])
        self.assertEqual([], candidate_targets(p))

    def test_numeric_diff_is_whole_amount_not_digit_fragments(self):
        diff = text_diff('资产832,457.32万元。', '资产862,531.86万元。')
        changed = [d for d in diff if d['type'] != 'equal']
        self.assertEqual([{'type': 'replace', 'old': '832,457.32', 'new': '862,531.86'}], changed)

    def test_docx_merged_cells_locators_and_export(self):
        from docx import Document
        d = Document()
        d.add_heading('财务报表', 1)
        table = d.add_table(rows=3, cols=3)
        table.cell(0, 0).merge(table.cell(0, 1)).text = '合并列'
        table.cell(1, 0).merge(table.cell(2, 0)).text = '合并行'
        table.cell(1, 1).text = '金额'
        table.cell(1, 2).text = '0'
        buf = io.BytesIO()
        d.save(buf)
        f = {'name': 'test.docx', **parse_document(buf.getvalue(), 'test.docx', 'f')}
        ts = targets(f)
        self.assertEqual(len(ts), len({t['id'] for t in ts}))
        self.assertEqual(2, next(t for t in ts if t['text'] == '合并列')['colspan'])
        self.assertEqual(2, next(t for t in ts if t['text'] == '合并行')['rowspan'])
        self.assertTrue(all('表' in t['locator'] for t in ts if t['table']))
        xml = ZipFile(io.BytesIO(word_export(f, [], original_bytes=buf.getvalue()))).read('word/document.xml').decode()
        self.assertEqual(1, xml.count('合并行'))
        self.assertEqual(1, xml.count('合并列'))

    def test_xlsx_zero_is_not_empty_and_carries_context(self):
        from openpyxl import Workbook
        w = Workbook()
        w.active.title = '资产负债表'
        w.active.append(['项目', '2026-06-30', '备注'])
        w.active.append(['其他应收款', 0, None])
        b = io.BytesIO()
        w.save(b)
        f = parse_document(b.getvalue(), 'test.xlsx', 'f')
        zero = next(s for s in f['segments'] if s.get('cell') == 'B2')
        empty = next(s for s in f['segments'] if s.get('cell') == 'C2')
        self.assertEqual('0', zero['text'])
        self.assertEqual('', empty['text'])
        self.assertIn('2026-06-30', zero['source_context'])

    def test_xlsx_preamble_and_multirow_labels_follow_values(self):
        from openpyxl import Workbook
        w = Workbook()
        for row in [['合并资产负债表'], ['编制单位：测试公司', '2025年6月30日', '金额单位：人民币元'], ['项目', '期末余额', '年初余额'], ['资产总额', 1200000, 1000000]]:
            w.active.append(row)
        b = io.BytesIO(); w.save(b)
        f = parse_document(b.getvalue(), 'report.xlsx', 'f')
        s = next(s for s in f['segments'] if s.get('cell') == 'B4')
        for text in ['人民币元', '2025年6月30日', '期末余额', '资产总额']:
            self.assertIn(text, s['source_context'])

    def test_invalid_date_is_recorded_without_rewriting_source(self):
        f = parse_document('期末指2025年6月31日数据。'.encode(), '附注.txt', 'f')
        self.assertEqual('invalid_date', f['source_checks'][0]['kind'])
        self.assertIn('2025年6月31日', f['segments'][0]['text'])

    def test_pdf_real_pages_and_scanned_warning(self):
        f = parse_document(pdf_fixture(blank_page=True), 'test.pdf', 'f')
        self.assertEqual(1, f['segments'][0]['page'])
        self.assertEqual(2, f['page_count'])
        self.assertTrue(any('第 2 页' in w for w in f['warnings']))

    def test_protected_and_unknown_files_are_rejected(self):
        with self.assertRaises(ValueError):
            parse_document(bytes.fromhex('d0cf11e0a1b11ae1'), 'protected.docx', 'f')
        with self.assertRaises(ValueError):
            parse_document(b'example', 'test.exe', 'f')

    def test_private_and_non_https_url_rejected(self):
        for url in ['http://example.com', 'https://user:secret@example.com', 'https://example.com:9000']:
            with self.assertRaises(ValueError):
                fetch_public_url(url)
        with patch('backend.engine.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            with self.assertRaises(ValueError):
                fetch_public_url('https://example.com')

    def test_cli_argv_no_shell_interpolation_or_sandbox_bypass(self):
        with patch.dict(os.environ, {'BOND_CODEX_MODEL': 'model; echo unsafe'}):
            args = command_for('codex.exe', Path('a b'), Path('schema'), Path('result'), False)
        self.assertIn('read-only', args)
        self.assertEqual('model; echo unsafe', args[-2])
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', args)
        self.assertNotIn('--search', args)
        self.assertIn('--search', command_for('codex', '.', 's', 'r', True))

    def test_linux_container_can_select_legacy_landlock_without_disabling_sandbox(self):
        with patch.dict(os.environ, {'BOND_CODEX_LINUX_SANDBOX': 'legacy_landlock'}):
            args = command_for('codex', '.', 's', 'r', False, platform='posix')
        self.assertEqual(['codex', '--enable', 'use_legacy_landlock'], args[:3])
        self.assertIn('read-only', args)
        self.assertNotIn('danger-full-access', args)
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', args)
        with patch.dict(os.environ, {'BOND_CODEX_LINUX_SANDBOX': 'unsupported'}):
            with self.assertRaises(ValueError):
                command_for('codex', '.', 's', 'r', False, platform='posix')

    def test_demo_all_references_resolve_without_duplicate_targets(self):
        with TemporaryDirectory() as tmp:
            store = Store(tmp)
            seed(store)
            p = next(iter(store.projects.values()))
            self.assertEqual(len(p['changes']), len({c['target_id'] for c in p['changes']}))
            for c in p['changes']:
                _, invalid = validate_sources(p, c['sources'])
                self.assertEqual([], invalid)


class RunnerTests(ProjectFixture, unittest.TestCase):

    def test_default_run_only_processes_candidates(self):
        default = targets_for_run(self.p)
        self.assertEqual({t['id'] for t in candidate_targets(self.p)}, {t['id'] for t in default})
        self.assertLess(len(default), len(targets_for_run(self.p, '检查全部位置')))
        self.assertEqual([self.target['id']], [t['id'] for t in targets_for_run(self.p, target_id=self.target['id'])])
        decisions = SCHEMA['properties']['assessments']['items']['properties']['decision']['enum']
        self.assertEqual(['keep', 'out_of_scope'], decisions)

    def test_full_source_library_recovers_evidence_omitted_from_shortlist(self):
        # Large high-scoring bundles exhaust the shortlist before the total.
        self.source['segments'] = [
            {'id':f's{i}', 'text':'资产 '*400, 'locator':f'行 {i}', 'source_context':'2026年6月30日'}
            for i in range(42)
        ] + [{'id':'denominator', 'text':'7823148369.96', 'locator':'合并资产负债表 · D28',
              'source_context':'行名：流动资产合计 / 列名：期末余额 / 2026年6月30日'}] + [
            {'id':f'n{i}', 'text':'一般说明 '*400, 'locator':f'附注行 {i}'} for i in range(13)]
        shortlisted = {s['id'] for b in evidence_for(self.p, [self.target]) for s in b['segments']}
        self.assertNotIn('denominator',shortlisted)
        self.source['stored_path']='private-local-path'
        self.source['original_source_path']='another-private-path'
        self.p['files'].append({'id':'registry','name':'工商.txt','role':'source','category':'registry','segments':[]})
        library=write_source_library(self.p, self.temp.name)
        self.assertEqual([self.source['id']],[f['source_id'] for f in library['files']])
        text=(Path(self.temp.name)/'sources/source-1.jsonl').read_text(encoding='utf-8')
        rows=[json.loads(line) for line in text.splitlines()]
        self.assertEqual(self.source['segments'],[{k:v for k,v in row.items() if k!='source_id'} for row in rows])
        self.assertEqual('denominator',rows[42]['id'])
        self.assertNotIn('private',json.dumps(library))
        self.assertEqual(library,write_source_library(self.p,self.temp.name))
        self.p['mode']='full'
        self.assertEqual(2,len(write_source_library(self.p,self.temp.name)['files']))
    def test_local_permission_error_is_distinct_from_login_failure(self):
        runner, command = self.invoke_fixture('permission')
        with patch('backend.runner.command_for', command):
            with self.assertRaisesRegex(RuntimeError, 'Codex 已登录.*运行权限'):
                runner._invoke(self.p, 'fixture', Path(self.temp.name), [self.target], '', None, 1)
        self.assertIsNotNone(runner.runtime_failure)
        self.assertFalse(runner.execution_verified)

    def test_early_closed_input_preserves_cli_diagnostic(self):
        import subprocess
        original_popen = subprocess.Popen
        class FailedInput:
            def write(self, text):
                raise OSError(22, 'Invalid argument')
            def close(self):
                pass
        def closed_input(*args, **kwargs):
            proc = original_popen(*args, **kwargs)
            proc.stdin.close()
            proc.stdin = FailedInput()
            return proc
        runner, command = self.invoke_fixture('earlyfail')
        with patch('backend.runner.command_for', command), patch('backend.runner.subprocess.Popen', closed_input):
            with self.assertRaisesRegex(RuntimeError, 'Codex 用户目录'):
                runner._invoke(self.p, 'fixture', Path(self.temp.name), [self.target], '', None, 1)

    def invoke_fixture(self, mode, jid='fixture'):
        runner = Runner(self.store, ROOT)
        def fake_command(path, task_dir, schema, out, web):
            return [sys.executable, str(ROOT / 'tests/fixture_cli.py'), mode, str(out)]
        return runner, fake_command

    def test_subprocess_success_fixture(self):
        runner, command = self.invoke_fixture('success')
        with patch('backend.runner.command_for', command):
            result = runner._invoke(self.p, 'fixture', Path(self.temp.name), [self.target], '', None, 1)
        self.assertEqual('SUBPROCESS FIXTURE', result['summary'])
        self.assertEqual({}, runner.processes)

    def test_subprocess_failure_fixture(self):
        runner, command = self.invoke_fixture('fail')
        with patch('backend.runner.command_for', command):
            with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                runner._invoke(self.p, 'fixture', Path(self.temp.name), [self.target], '', None, 1)

    def test_subprocess_timeout_cleans_process(self):
        runner, command = self.invoke_fixture('wait')
        with patch('backend.runner.command_for', command), patch.dict(os.environ, {'BOND_CLI_TIMEOUT': '1'}):
            with self.assertRaises(TimeoutError):
                runner._invoke(self.p, 'fixture', Path(self.temp.name), [self.target], '', None, 1)
        self.assertEqual({}, runner.processes)

    def test_cancel_job_preserves_already_saved_changes(self):
        runner = Runner(self.store, ROOT)
        self.p['job'] = {'id': 'fixture', 'status': 'running'}
        before = len(self.p['changes'])
        runner.cancel(self.p)
        self.assertEqual('cancelled', self.p['job']['status'])
        self.assertEqual(before, len(self.p['changes']))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory()
        with patch('backend.server.cli_status', return_value={'installed': True, 'ready': False, 'message': 'TEST'}):
            cls.server = create_server(0, cls.temp.name, demo=False)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'
        cls.token = cls.server.app.csrf

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def request(self, path, data=None, headers=None, raw=None):
        headers = dict(headers or {})
        if data is not None:
            raw = json.dumps(data).encode()
            headers.setdefault('Content-Type', 'application/json')
        headers.setdefault('X-Bond-Token', self.token)
        req = urllib.request.Request(self.url + path, data=raw, headers=headers)
        try:
            r = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as exc:
            r = exc
        with r:
            body = r.read()
            return r.status, json.loads(body) if 'application/json' in r.headers.get('Content-Type', '') else body

    def test_create_upload_edit_source_export_and_conflict(self):
        status, p = self.request('/api/projects', {'title': 'HTTP 测试', 'mode': 'financial', 'period': '2026-06-30'})
        self.assertEqual(201, status)
        base = '/api/projects/' + p['id']
        status, f = self.request(base + '/files?name=prospectus.md&role=prospectus&category=prospectus', raw='# 财务信息\n资产总额【待补充】'.encode())
        self.assertEqual(201, status)
        _, p = self.request(base)
        self.assertEqual(1, p['stats']['needs_review'])
        tid = p['targets'][1]['id']
        self.assertEqual(200, self.request(base + '/files/' + f['id'])[0])
        self.assertEqual(200, self.request(base + '/files/' + f['id'] + '/raw')[0])
        status, _ = self.request(base + '/edit', {'target_id': tid, 'revision': 0, 'text': '资产总额120万元'})
        self.assertEqual(200, status)
        status, _ = self.request(base + '/edit', {'target_id': tid, 'revision': 0, 'text': '过时内容'})
        self.assertEqual(400, status)
        _, p = self.request(base)
        self.assertEqual(1, p['stats']['accepted'])
        status, export = self.request(base + '/export?view=revision')
        self.assertEqual(200, status)
        self.assertTrue(export.startswith(b'PK'))
        _, audit = self.request(base + '/export?format=json')
        self.assertTrue(any('before' in h for h in audit['history']))

    def test_csrf_host_origin_and_path_containment(self):
        status, health = self.request('/api/health')
        self.assertEqual(200, status)
        self.assertIn('storage', health)
        self.assertGreater(health['storage']['disk_free_bytes'], 0)
        self.assertEqual(403, self.request('/api/projects', {'title': 'bad'}, {'X-Bond-Token': 'bad'})[0])
        self.assertEqual(403, self.request('/api/health', headers={'Host': 'attacker.example'})[0])
        self.assertEqual(403, self.request('/api/health', headers={'Origin': 'https://attacker.example'})[0])
        self.assertEqual(404, self.request('/%2e%2e/backend/server.py')[0])
        self.assertEqual(200, self.request('/')[0])

    def test_cloud_proxy_origin_and_basic_auth(self):
        with TemporaryDirectory() as directory, patch.dict(
            os.environ,
            {
                'BOND_AUTH_USERNAME': 'bond',
                'BOND_AUTH_PASSWORD': 'shared-secret',
                'BOND_ALLOWED_HOSTS': 'bond.example.com',
                'BOND_TRUST_PROXY': '1',
            },
        ), patch('backend.server.cli_status', return_value={'installed': True, 'ready': False, 'message': 'TEST'}):
            server = create_server(0, directory, demo=False)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{server.server_port}/api/health'

            def request(headers):
                req = urllib.request.Request(url, headers=headers)
                try:
                    response = urllib.request.urlopen(req, timeout=15)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    return response.status

            common = {
                'Host': 'bond.example.com',
                'Origin': 'https://bond.example.com',
                'X-Forwarded-Proto': 'https',
            }
            self.assertEqual(401, request(common))
            token = base64.b64encode(b'bond:shared-secret').decode()
            self.assertEqual(200, request({**common, 'Authorization': 'Basic ' + token}))
            self.assertEqual(403, request({**common, 'Origin': 'https://attacker.example', 'Authorization': 'Basic ' + token}))
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_pdf_page_route(self):
        _, p = self.request('/api/projects', {'title': 'PDF TEST'})
        base = '/api/projects/' + p['id']
        status, f = self.request(base + '/files?name=source.pdf&role=source&category=financial', raw=pdf_fixture())
        self.assertEqual(201, status)
        status, image = self.request(base + '/files/' + f['id'] + '/page/1')
        self.assertEqual(200, status)
        self.assertTrue(image.startswith(b'\x89PNG'))
        self.assertEqual(400, self.request(base + '/files/' + f['id'] + '/page/2')[0])

    def test_word_preview_and_export_keep_uploaded_format(self):
        from tests.test_word_fidelity import sample
        raw = sample()
        _, p = self.request('/api/projects', {'title':'Word 格式回归'})
        base = '/api/projects/' + p['id']
        status, f = self.request(base+'/files?name=original.docx&role=prospectus&category=prospectus',raw=raw)
        self.assertEqual(201,status)
        status, preview = self.request(base+'/word-preview?view=final')
        self.assertEqual(200,status)
        self.assertEqual('source-word-styles',preview['format'])
        self.assertIn('font-size:18pt',preview['html'])
        self.assertIn('rowspan="2"',preview['html'])
        status, exported = self.request(base+'/export?view=final')
        self.assertEqual(200,status)
        self.assertEqual(raw,exported)
        status, source_preview = self.request(base+'/files/'+f['id']+'/word-preview')
        self.assertEqual(200,status)
        self.assertIn('历史募集书页眉',source_preview['html'])
        self.assertEqual(400,self.request(base+'/word-preview?view=bad')[0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
