"""Synthetic invariants for source-bound Word edits, not a business acceptance."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.shared import Inches, Pt
from lxml import etree as ET

from bondbuddy_file_authoring.check import package, resolve_revisions
from bondbuddy_file_authoring.fixed_edit import Editor, empty_log, finalize, load_input, write_json
from bondbuddy_file_authoring.format_diff import audit, canonical
from bondbuddy_file_authoring.template_manifest import build_manifest, node_text, sha
from bondbuddy_file_authoring.word_patch import Patcher, paragraph_text, q, serialized, xml


class FixedEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        document = Document()
        document.styles['Normal'].font.name = 'Arial'
        document.add_heading('第一章 发行人概况', level=1)
        p = document.add_paragraph()
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.first_line_indent = Inches(.3)
        p.add_run('截至2024年末净资产').bold = True
        p.add_run('100').italic = True
        p.add_run('万元。')
        document.add_paragraph('保留😀的原始段落。')
        table = document.add_table(rows=2, cols=2)
        table.autofit = False
        table.style = 'Table Grid'
        table.columns[0].width = Inches(2)
        table.columns[1].width = Inches(3)
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2024年度'
        table.cell(1, 0).text = '净资产'
        table.cell(1, 1).text = '100'
        document.sections[0].header.paragraphs[0].text = '原稿页眉'
        document.save(self.source)
        self.data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-test',
                     'revision_date': '2026-10-29T00:00:00.000Z',
                     'baseline_path': 'source.docx', 'baseline_sha256': sha(self.source.read_bytes())}
        self.input = self.root / 'input.json'
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        self.log_path = self.root / 'operations.json'

    def tearDown(self):
        self.temp.cleanup()

    def node(self, text, kind='paragraph'):
        return next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == kind and n['text'] == text)

    def generate(self, operations, **kwargs):
        self.log['operations'] = operations
        write_json(self.log_path, self.log)
        dest = self.root / 'delivered'
        receipt = finalize(self.input, self.log_path, dest, **kwargs)
        return dest, receipt

    def modify_package(self, path, mutate):
        parts = package(path)
        mutate(parts)
        with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
            for name, raw in parts.items():
                archive.writestr(name, raw)

    def test_manifest_has_styles_grid_sections_and_header_anchors(self):
        manifest = build_manifest(self.source)
        self.assertEqual(manifest['baseline_sha256'], self.data['baseline_sha256'])
        self.assertEqual(manifest['offset_unit'], 'unicode_code_points')
        self.assertTrue(manifest['sections'])
        self.assertIn('Normal', manifest['styles'])
        self.assertTrue(any(n['part'].startswith('word/header') for n in manifest['nodes']))
        grid = next(n['grid_ref'] for n in manifest['nodes'] if n['kind'] == 'table')
        self.assertIn('tblGrid', manifest['property_formats'][grid])

    def test_repeated_edits_preserve_mixed_runs_and_untouched_parts(self):
        before = '截至2024年末净资产100万元。'
        node = self.node(before)
        interim = before.replace('100', '120')
        after = interim.replace('2024', '2025')
        output, receipt = self.generate([
            {'id': 'one', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': before, 'after': interim},
            {'id': 'two', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': interim, 'after': after}])
        self.assertEqual(receipt['operation_count'], 2)
        self.assertEqual(receipt['format_status'], 'passed')
        original, tracked = package(self.source), package(output / 'tracked.docx')
        for name in original:
            if name != 'word/document.xml':
                self.assertEqual(original[name], tracked[name], name)
        clean_doc = Document(output / 'clean.docx')
        self.assertEqual(clean_doc.paragraphs[1].text, after)
        self.assertIn('120', ''.join(r.text for r in clean_doc.paragraphs[1].runs if r.italic))
        self.assertEqual(clean_doc.paragraphs[1].paragraph_format.space_after, Pt(8))

    def test_insertions_keep_original_anchors_and_real_structural_revisions(self):
        p = self.node('保留😀的原始段落。')
        row = self.node('净资产\n100', 'row')
        cell = self.node('100', 'cell')
        output, receipt = self.generate([
            {'id': 'para', 'kind': 'insert_paragraph', 'node_id': p['node_id'], 'before': p['text'], 'text': '新增段落'},
            {'id': 'row', 'kind': 'insert_row', 'node_id': row['node_id'], 'before': row['text'], 'values': ['负债', '50']},
            {'id': 'cell', 'kind': 'replace_cell_text', 'node_id': cell['node_id'], 'before': '100', 'after': '120'},
            {'id': 'newtext', 'kind': 'replace_text', 'node_id': 'op:para:paragraph', 'before': '新增段落', 'after': '新增完整段落'}])
        self.assertEqual(receipt['format_status'], 'passed')
        root = xml(package(output / 'tracked.docx')['word/document.xml'])
        self.assertTrue(root.findall('.//' + q('trPr') + '/' + q('ins')))
        self.assertTrue(root.findall('.//' + q('pPr') + '/' + q('rPr') + '/' + q('ins')))
        rejected = resolve_revisions(copy.deepcopy(root), False, only_new=self.data['revision_author'])
        self.assertEqual(canonical(rejected), canonical(xml(package(self.source)['word/document.xml'])))
        clean_doc = Document(output / 'clean.docx')
        self.assertIn('新增完整段落', [p.text for p in clean_doc.paragraphs])
        self.assertEqual(len(clean_doc.tables[0].rows), 3)
        self.assertEqual(clean_doc.tables[0].cell(1, 1).text, '120')

    def empty_numeric_cell(self, *, existing_run=False):
        # A real blank financial cell may carry its only font in the paragraph
        # mark. The document default is deliberately different from that font.
        def mutate(parts):
            root = xml(parts['word/document.xml'])
            p = root.find('.//' + q('tbl')).findall(q('tr'))[1].findall(q('tc'))[1].find(q('p'))
            for child in list(p):
                p.remove(child)
            props = ET.SubElement(p, q('pPr'))
            ET.SubElement(props, q('jc'), {q('val'): 'right'})
            mark = ET.SubElement(props, q('rPr'))
            ET.SubElement(mark, q('rFonts'), {q('ascii'): 'Times New Roman', q('hAnsi'): 'Times New Roman'})
            ET.SubElement(mark, q('sz'), {q('val'): '21'})
            if existing_run:
                run = ET.SubElement(p, q('r'))
                rpr = ET.SubElement(run, q('rPr'))
                ET.SubElement(rpr, q('rFonts'), {q('ascii'): 'Courier New', q('hAnsi'): 'Courier New'})
                ET.SubElement(rpr, q('sz'), {q('val'): '18'})
            parts['word/document.xml'] = serialized(root)
        self.modify_package(self.source, mutate)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())

    def assert_numeric_cell_format(self, output, row, font, size):
        original = package(self.source)
        for variant in ('clean', 'tracked'):
            parts = package(output / (variant + '.docx'))
            root = xml(parts['word/document.xml'])
            cell = root.find('.//' + q('tbl')).findall(q('tr'))[row].findall(q('tc'))[1]
            run = next(r for r in cell.iter(q('r')) if r.find(q('t')) is not None)
            self.assertEqual(run.find(q('rPr') + '/' + q('rFonts')).get(q('ascii')), font)
            self.assertEqual(run.find(q('rPr') + '/' + q('sz')).get(q('val')), size)
            self.assertEqual(parts['word/styles.xml'], original['word/styles.xml'])
            if variant == 'tracked':
                self.assertEqual(canonical(resolve_revisions(copy.deepcopy(root), False)),
                                 canonical(xml(original['word/document.xml'])))

    def test_fill_empty_cell_inherits_paragraph_mark_font_in_both_word_views(self):
        self.empty_numeric_cell()
        cell = self.node('', 'cell')
        output, receipt = self.generate([{'id': 'blank', 'kind': 'replace_cell_text',
                                         'node_id': cell['node_id'], 'before': '', 'after': '0.00'}])
        self.assertEqual(receipt['format_status'], 'passed')
        self.assert_numeric_cell_format(output, 1, 'Times New Roman', '21')

    def test_cloned_row_inherits_empty_cell_paragraph_mark_font(self):
        self.empty_numeric_cell()
        row = self.node('净资产\n', 'row')
        output, receipt = self.generate([{'id': 'row', 'kind': 'insert_row', 'node_id': row['node_id'],
                                         'before': row['text'], 'values': ['负债', '0.00']}])
        self.assertEqual(receipt['format_status'], 'passed')
        self.assert_numeric_cell_format(output, 2, 'Times New Roman', '21')

    def test_empty_existing_run_keeps_its_font_ahead_of_paragraph_mark(self):
        self.empty_numeric_cell(existing_run=True)
        cell = self.node('', 'cell')
        output, receipt = self.generate([{'id': 'blank', 'kind': 'replace_cell_text',
                                         'node_id': cell['node_id'], 'before': '', 'after': '0.00'}])
        self.assertEqual(receipt['format_status'], 'passed')
        self.assert_numeric_cell_format(output, 1, 'Courier New', '18')

    def test_recorded_heading_rewrite_still_requires_structure_review(self):
        node = self.node('第一章 发行人概况')
        output, receipt = self.generate([{'id': 'heading', 'kind': 'replace_text', 'node_id': node['node_id'],
                                         'before': node['text'], 'after': '第二章 发行人基本情况'}])
        report = json.loads((output / 'format-report.json').read_text(encoding='utf-8'))
        self.assertEqual(report['source_structure']['status'], 'changed')
        self.assertEqual([issue['code'] for issue in report['issues']], ['SOURCE_OUTLINE_CHANGED'])
        self.assertEqual(receipt['format_status'], 'failed')
        self.assertTrue((output / 'tracked.docx').is_file(), 'diagnostics do not block delivery')
        self.assertTrue((output / 'clean.docx').is_file())

    def test_new_reporting_column_preserves_comparatives_width_and_rejectable_edits(self):
        table = self.node('项目\n2024年度\n净资产\n100', 'table')
        old_cell = self.node('100', 'cell')
        output, receipt = self.generate([
            {'id': 'period', 'kind': 'insert_column', 'node_id': table['node_id'], 'before': table['text'],
             'column_index': 1, 'position': 'before', 'values': ['2025年度', '120']},
            {'id': 'new_amount', 'kind': 'replace_cell_text', 'node_id': 'op:period:cell:1', 'before': '120', 'after': '125'},
            {'id': 'old_amount', 'kind': 'replace_cell_text', 'node_id': old_cell['node_id'], 'before': '100', 'after': '101'},
            {'id': 'note', 'kind': 'add_comment', 'node_id': 'op:period:cell:1:paragraph', 'before': '125', 'text': '合成测试核对。'}])
        self.assertEqual(receipt['format_status'], 'passed', (output / 'format-report.json').read_text(encoding='utf-8'))
        clean = Document(output / 'clean.docx').tables[0]
        self.assertEqual([[c.text for c in r.cells] for r in clean.rows], [['项目', '2025年度', '2024年度'], ['净资产', '125', '101']])
        before = xml(package(self.source)['word/document.xml'])
        tracked = xml(package(output / 'tracked.docx')['word/document.xml'])
        self.assertEqual(len(tracked.findall('.//' + q('cellIns'))), 2)
        self.assertEqual(len(tracked.findall('.//' + q('tblGridChange'))), 1)
        self.assertEqual(len(tracked.findall('.//' + q('tcPrChange'))), 4)
        old_grid = before.find('.//' + q('tblGrid'))
        new_grid = tracked.find('.//' + q('tblGrid'))
        self.assertEqual(sum(int(c.get(q('w'))) for c in old_grid.findall(q('gridCol'))),
                         sum(int(c.get(q('w'))) for c in new_grid.findall(q('gridCol'))))
        accepted = resolve_revisions(copy.deepcopy(tracked), True)
        self.assertEqual(canonical(accepted), canonical(xml(package(output / 'clean.docx')['word/document.xml'])))
        wrong_author = resolve_revisions(copy.deepcopy(tracked), False, only_new='Someone else')
        self.assertEqual(canonical(wrong_author), canonical(tracked))

    def test_repeated_columns_and_row_insertions_restore_exact_original(self):
        editor = Editor(self.data, self.source)
        table_id = next(k for k, (_, n) in editor.nodes.items() if n.tag == q('tbl'))
        row_id = next(k for k, (_, n) in editor.nodes.items() if n.tag == q('tr') and node_text(n) == '净资产\n100')
        operations = []
        def append(kind, node_id, **values):
            op = {'id': 'step_' + str(len(operations)), 'kind': kind, 'node_id': node_id,
                  'before': node_text(editor.nodes[node_id][1]), **values}
            editor.apply(op)
            operations.append(op)
        append('insert_column', table_id, column_index=1, values=['2025年度', '120'])
        append('insert_row', row_id, values=['负债', '60', '50'])
        append('insert_column', table_id, column_index=1, values=['2026年6月末', '130', '65'])
        append('insert_paragraph', 'op:step_2:cell:1:paragraph', text='合成注释')
        output, receipt = self.generate(operations)
        self.assertEqual(receipt['format_status'], 'passed', (output / 'format-report.json').read_text(encoding='utf-8'))
        final = Document(output / 'clean.docx').tables[0]
        self.assertEqual([[c.text for c in r.cells] for r in final.rows],
                         [['项目', '2026年6月末', '2025年度', '2024年度'], ['净资产', '130\n合成注释', '120', '100'], ['负债', '65', '60', '50']])
        tracked = xml(package(output / 'tracked.docx')['word/document.xml'])
        rejected = resolve_revisions(copy.deepcopy(tracked), False, only_new=self.data['revision_author'])
        self.assertEqual(canonical(rejected), canonical(xml(package(self.source)['word/document.xml'])))
        self.assertFalse(tracked.findall('.//' + q('ins') + '//' + q('ins')))
        self.assertEqual(len(tracked.findall('.//' + q('tblGridChange'))), 1)
        first_bytes = (output / 'tracked.docx').read_bytes()
        second, _ = self.generate(operations)
        self.assertEqual(first_bytes, (second / 'tracked.docx').read_bytes())

    def test_selective_column_rejection_does_not_guess_missing_or_other_author_grid(self):
        table = self.node('项目\n2024年度\n净资产\n100', 'table')
        output, _ = self.generate([{'id': 'period', 'kind': 'insert_column', 'node_id': table['node_id'],
                                  'before': table['text'], 'column_index': 1, 'values': ['2025年度', '120']}])
        for mutation in ['missing_grid', 'mixed_authors']:
            root = xml(package(output / 'tracked.docx')['word/document.xml'])
            if mutation == 'missing_grid':
                change = root.find('.//' + q('tblGridChange'))
                change.getparent().remove(change)
            else:
                root.find('.//' + q('cellIns')).set(q('author'), 'Other author')
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'WORD_REVISION_UNSUPPORTED'):
                resolve_revisions(root, False, only_new=self.data['revision_author'])
            if mutation == 'mixed_authors':
                with self.assertRaisesRegex(ValueError, 'WORD_REVISION_UNSUPPORTED'):
                    resolve_revisions(root, True, only_new=self.data['revision_author'])

    def test_column_values_require_every_row_and_support_multiline_cells(self):
        doc = Document(self.source)
        doc.tables[0].cell(1, 1).add_paragraph('口径说明')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        table = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'table')
        base = {'id': 'period', 'kind': 'insert_column', 'node_id': table['node_id'], 'before': table['text'], 'column_index': 1}
        for values, expected in [(['2025'], 'WORD_EDIT_COLUMN_VALUES_INVALID'), (['2025', '120'], 'WORD_EDIT_COMPLEX_CELL_UNSUPPORTED')]:
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, expected):
                self.generate([{**base, 'values': values}])
        for index in [-1, 2, True, '1']:
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, 'WORD_EDIT_COLUMN_INDEX_INVALID'):
                self.generate([{**base, 'column_index': index, 'values': ['2025', ['120', '新口径']]}])
        output, receipt = self.generate([{**base, 'position': 'after', 'values': ['2025', ['120', '新口径']]}])
        self.assertEqual(receipt['format_status'], 'passed')
        self.assertEqual(Document(output / 'clean.docx').tables[0].cell(1, 2).text, '120\n新口径')

    def test_column_rejects_merges_and_existing_revisions_without_partial_table_changes(self):
        table = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'table')
        for tag in ['gridSpan', 'vMerge', 'tblGridChange', 'fldSimple']:
            editor = Editor(self.data, self.source)
            node = editor.nodes[table['node_id']][1]
            ET.SubElement(node.find('.//' + q('tcPr')), q(tag))
            previous = serialized(node)
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, 'WORD_EDIT_COMPLEX_COLUMN_UNSUPPORTED'):
                editor.apply({'id': 'column', 'kind': 'insert_column', 'node_id': table['node_id'],
                              'before': node_text(node), 'column_index': 1, 'values': ['2025', '120']})
            self.assertEqual(serialized(node), previous)

    def test_wrong_hash_stale_anchor_unknown_fields_and_no_log_are_rejected(self):
        node = self.node('保留😀的原始段落。')
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_ANCHOR_MISMATCH'):
            self.generate([{'id': 'one', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': 'wrong', 'after': 'x'}])
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_OPERATION_INVALID'):
            self.generate([{'id': 'one', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': node['text'], 'after': 'x', 'python': 'bad'}])
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_LOG_REQUIRED'):
            finalize(self.input, self.root / 'missing.json', self.root / 'out')
        self.data['baseline_sha256'] = 'b' * 64
        write_json(self.input, self.data)
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_SOURCE_HASH_MISMATCH'):
            load_input(self.input)

    def test_unsupported_merge_does_not_silently_rebuild(self):
        doc = Document(self.source)
        doc.tables[0].cell(0, 0).merge(doc.tables[0].cell(0, 1))
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        row = self.node('净资产\n100', 'row')
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_COMPLEX_ROW_UNSUPPORTED'):
            self.generate([{'id': 'row', 'kind': 'insert_row', 'node_id': row['node_id'], 'before': row['text'], 'values': ['x', 'y']}])

    def test_style_and_paragraph_drift_reported_without_failing_delivery_command(self):
        self.log['no_changes_reason'] = '合成测试保留原稿，验证独立诊断。'
        output, receipt = self.generate([], skip_report=True)
        self.assertEqual(receipt['format_status'], 'not_run')
        self.assertFalse((output / 'format-report.json').exists())
        def drift(parts):
            root = xml(parts['word/document.xml'])
            props = root.find('.//' + q('spacing'))
            props.set(q('after'), '999')
            parts['word/document.xml'] = serialized(root)
            styles = xml(parts['word/styles.xml'])
            styles.find('.//' + q('rFonts')).set(q('ascii'), 'Changed')
            parts['word/styles.xml'] = serialized(styles)
        self.modify_package(output / 'tracked.docx', drift)
        report = audit(self.source, output / 'tracked.docx', self.data['revision_author'])
        self.assertEqual(report['status'], 'failed')
        self.assertEqual({n['part'] for n in report['issues']}, {'word/document.xml', 'word/styles.xml'})

    def test_old_revisions_kept_in_tracked_clean_accepts_all(self):
        def old_revision(parts):
            root = xml(parts['word/document.xml'])
            p = root.find(q('body')).findall(q('p'))[2]
            run = p.find(q('r'))
            p.remove(run)
            wrapper = ET.SubElement(p, q('ins'), {q('id'): '100', q('author'): 'Prior author'})
            wrapper.append(run)
            parts['word/document.xml'] = serialized(root)
        self.modify_package(self.source, old_revision)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        node = self.node('截至2024年末净资产100万元。')
        output, receipt = self.generate([{'id': 'one', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': node['text'], 'after': node['text'].replace('100', '120')}])
        self.assertEqual(receipt['format_status'], 'passed')
        tracked = xml(package(output / 'tracked.docx')['word/document.xml'])
        self.assertTrue(any(n.get(q('author')) == 'Prior author' for n in tracked.iter(q('ins'))))
        new_ids = [int(n.get(q('id'))) for n in tracked.iter()
                   if n.tag in (q('ins'), q('del')) and n.get(q('author')) == self.data['revision_author']]
        self.assertTrue(new_ids)
        self.assertTrue(all(value > 100 for value in new_ids))
        self.assertEqual(len(new_ids), len(set(new_ids)))
        cleaned = xml(package(output / 'clean.docx')['word/document.xml'])
        self.assertFalse(list(cleaned.iter(q('ins'))))
        old = self.node('保留😀的原始段落。')
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_EXISTING_REVISIONS_UNSUPPORTED'):
            self.generate([{'id': 'two', 'kind': 'replace_text', 'node_id': old['node_id'], 'before': old['text'], 'after': '更改'}])

    def test_replay_diagnostic_catches_drift_in_inserted_text(self):
        p = self.node('保留😀的原始段落。')
        output, _ = self.generate([{'id': 'para', 'kind': 'insert_paragraph', 'node_id': p['node_id'], 'before': p['text'], 'text': '新增段落'}])
        good = audit(self.source, output / 'tracked.docx', self.data['revision_author'], self.input, self.log_path)
        self.assertEqual(good['status'], 'passed', good)
        def drift(parts):
            root = xml(parts['word/document.xml'])
            inserted = next(n for n in root.iter(q('ins')) if n.find(q('r')) is not None)
            props = ET.Element(q('rPr'))
            ET.SubElement(props, q('sz'), {q('val'): '99'})
            inserted.find(q('r')).insert(0, props)
            parts['word/document.xml'] = serialized(root)
        self.modify_package(output / 'tracked.docx', drift)
        report = audit(self.source, output / 'tracked.docx', self.data['revision_author'], self.input, self.log_path)
        self.assertEqual(report['status'], 'failed')
        self.assertIn('RECORDED_EDIT_FORMAT_MISMATCH', [n['code'] for n in report['issues']])

    def test_new_paragraph_inside_new_row_has_stable_replay_locations(self):
        row = self.node('净资产\n100', 'row')
        output, receipt = self.generate([
            {'id': 'a_row', 'kind': 'insert_row', 'node_id': row['node_id'], 'before': row['text'], 'values': ['负债', '50']},
            {'id': 'z_para', 'kind': 'insert_paragraph', 'node_id': 'op:a_row:cell:1:paragraph', 'before': '50', 'text': '金额说明'}])
        self.assertEqual(receipt['format_status'], 'passed')
        self.assertEqual(Document(output / 'clean.docx').tables[0].cell(2, 1).text, '50\n金额说明')
        tracked = xml(package(output / 'tracked.docx')['word/document.xml'])
        self.assertFalse(tracked.findall('.//' + q('ins') + '//' + q('ins')))

    def test_no_changes_requires_explicit_reason_and_does_not_fake_revisions(self):
        with self.assertRaisesRegex(ValueError, 'WORD_EDIT_NO_CHANGES_REASON_REQUIRED'):
            self.generate([])
        self.log['no_changes_reason'] = '本轮核对确认原稿已包含所需更新。'
        output, receipt = self.generate([])
        self.assertTrue(receipt['no_changes'])
        self.assertFalse(list(xml(package(output / 'tracked.docx')['word/document.xml']).iter(q('ins'))))

    def test_add_comment_preserves_source_styles_and_replays_exact_comment(self):
        p = self.node('截至2024年末净资产100万元。')
        after = p['text'].replace('100', '120')
        output, receipt = self.generate([
            {'id': 'replace', 'kind': 'replace_text', 'node_id': p['node_id'], 'before': p['text'], 'after': after},
            {'id': 'comment', 'kind': 'add_comment', 'node_id': p['node_id'], 'before': after, 'text': '请核对本期口径。'}])
        self.assertEqual(receipt['format_status'], 'passed', (output / 'format-report.json').read_text(encoding='utf-8'))
        parts = package(output / 'tracked.docx')
        comments = xml(parts['word/comments.xml'])
        self.assertIn('请核对本期口径。', ''.join(comments.itertext()))
        self.assertEqual(parts['word/styles.xml'], package(self.source)['word/styles.xml'])
        self.assertTrue(xml(parts['word/document.xml']).findall('.//' + q('commentReference')))

    def test_insert_row_with_multiple_paragraphs_preserves_each_style(self):
        doc = Document(self.source)
        doc.tables[0].cell(1, 0).add_paragraph('原注释').paragraph_format.space_after = Pt(3)
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        row = self.node('净资产\n原注释\n100', 'row')
        output, receipt = self.generate([{'id': 'row', 'kind': 'insert_row', 'node_id': row['node_id'],
                                           'before': row['text'], 'values': [['负债', '本期注释'], '50']}])
        self.assertEqual(receipt['format_status'], 'passed')
        cell = Document(output / 'clean.docx').tables[0].cell(2, 0)
        self.assertEqual(cell.text, '负债\n本期注释')
        self.assertEqual(cell.paragraphs[1].paragraph_format.space_after, Pt(3))

    def test_existing_comments_are_retained_and_new_ids_are_distinct(self):
        doc = Document(self.source)
        doc.add_comment(doc.paragraphs[2].runs, text='原有批注', author='原作者')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        p = self.node('保留😀的原始段落。')
        output, receipt = self.generate([{'id': 'new_comment', 'kind': 'add_comment', 'node_id': p['node_id'],
                                           'before': p['text'], 'text': '本轮批注'}])
        self.assertEqual(receipt['format_status'], 'passed')
        comments = list(xml(package(output / 'tracked.docx')['word/comments.xml']))
        self.assertEqual(len(comments), 2)
        self.assertEqual(len({c.get(q('id')) for c in comments}), 2)
        self.assertEqual(comments[0].get(q('author')), '原作者')
        self.assertIn('原有批注', ''.join(comments[0].itertext()))

    def test_recorded_comment_parts_reverted_to_baseline_are_reported(self):
        p = self.node('保留😀的原始段落。')
        operations = [{'id': 'comment', 'kind': 'add_comment', 'node_id': p['node_id'],
                       'before': p['text'], 'text': '本轮批注'}]
        original = package(self.source)
        for part in ['word/_rels/document.xml.rels', '[Content_Types].xml']:
            with self.subTest(part=part):
                output, _ = self.generate(operations)
                self.modify_package(output / 'tracked.docx', lambda parts: parts.update({part: original[part]}))
                report = audit(self.source, output / 'tracked.docx', self.data['revision_author'], self.input, self.log_path)
                self.assertEqual(report['status'], 'failed')
                self.assertIn({'code': 'RECORDED_EDIT_FORMAT_MISMATCH', 'part': part}, report['issues'])

        doc = Document(self.source)
        doc.add_comment(doc.paragraphs[2].runs, text='原有批注', author='原作者')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        p = self.node('保留😀的原始段落。')
        output, _ = self.generate([{'id': 'comment', 'kind': 'add_comment', 'node_id': p['node_id'],
                                   'before': p['text'], 'text': '本轮批注'}])
        original_comments = package(self.source)['word/comments.xml']
        self.modify_package(output / 'tracked.docx', lambda parts: parts.update({'word/comments.xml': original_comments}))
        report = audit(self.source, output / 'tracked.docx', self.data['revision_author'], self.input, self.log_path)
        self.assertEqual(report['status'], 'failed')
        self.assertIn({'code': 'RECORDED_EDIT_FORMAT_MISMATCH', 'part': 'word/comments.xml'}, report['issues'])

    def test_replaying_the_same_log_produces_identical_docx_bytes(self):
        p = self.node('保留😀的原始段落。')
        operations = [
            {'id': 'text', 'kind': 'replace_text', 'node_id': p['node_id'], 'before': p['text'], 'after': '按本轮要求更新。'},
            {'id': 'comment', 'kind': 'add_comment', 'node_id': p['node_id'], 'before': '按本轮要求更新。', 'text': '待核对说明。'}]
        output, first = self.generate(operations)
        original = {name: (output / name).read_bytes() for name in ['tracked.docx', 'clean.docx', 'operations.json']}
        # Cross the ZIP DOS timestamp's two-second resolution, not just two
        # successive calls that might accidentally share the same timestamp.
        time.sleep(2.1)
        second = finalize(self.input, self.log_path, self.root / 'retry')
        for name, raw in original.items():
            self.assertEqual(raw, (self.root / 'retry' / name).read_bytes(), name)
            self.assertEqual(first['files'][name]['sha256'], second['files'][name]['sha256'])

    def test_cli_apply_and_inspect_uses_unicode_text_without_offsets(self):
        node = self.node('保留😀的原始段落。')
        operation = self.root / 'op.json'
        write_json(operation, {'id': 'emoji', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': node['text'], 'after': '保留😀并更新文字。'})
        args = [sys.executable, '-m', 'bondbuddy_file_authoring.fixed_edit']
        applied = subprocess.run(args + ['apply', '--input', str(self.input), '--operations', str(self.log_path), '--operation-file', str(operation)], capture_output=True, encoding='utf-8')
        self.assertEqual(applied.returncode, 0, applied.stderr)
        inspected = subprocess.run(args + ['inspect', '--input', str(self.input), '--operations', str(self.log_path), '--node', node['node_id']], capture_output=True, encoding='utf-8')
        self.assertEqual(inspected.returncode, 0, inspected.stderr)
        self.assertEqual(json.loads(inspected.stdout)['nodes'][0]['text'], '保留😀并更新文字。')

    def test_large_prospectus_replay_finishes_without_repeated_document_scans(self):
        # A long, run-heavy synthetic package exercises the real finalization
        # subprocess and its deadline, not a mock of the XML query implementation.
        parts = package(self.source)
        root = xml(parts['word/document.xml'])
        body = root.find(q('body'))
        template = ET.Element(q('p'))
        for index in range(10):
            run = ET.SubElement(template, q('r'))
            props = ET.SubElement(run, q('rPr'))
            ET.SubElement(props, q('b' if index % 2 else 'i'))
            ET.SubElement(run, q('t')).text = '合成财务披露。'
        for _ in range(8000):
            body.insert(len(body) - 1, copy.deepcopy(template))
        parts['word/document.xml'] = serialized(root)
        with ZipFile(self.source, 'w', ZIP_DEFLATED) as archive:
            for name, raw in parts.items():
                archive.writestr(name, raw)
        raw = self.source.read_bytes()
        self.data['baseline_sha256'] = sha(raw)
        write_json(self.input, self.data)
        editor = Editor(self.data, self.source)
        self.log = empty_log(self.data, raw)
        for key, (_, node) in editor.nodes.items():
            if node.tag == q('p') and paragraph_text(node) == '合成财务披露。' * 10:
                self.log['operations'].append({'id': 'large-' + str(len(self.log['operations'])),
                    'kind': 'replace_text', 'node_id': key, 'before': paragraph_text(node),
                    'after': paragraph_text(node) + '本轮更新。'})
                if len(self.log['operations']) == 600:
                    break
        write_json(self.log_path, self.log)
        output = self.root / 'large-output'
        result = subprocess.run([sys.executable, '-m', 'bondbuddy_file_authoring.fixed_edit',
            'finalize', '--input', str(self.input), '--operations', str(self.log_path),
            '--output-dir', str(output), '--skip-report'], capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['operation_count'], 600)
        tracked_parts = package(output / 'tracked.docx')
        tracked = xml(tracked_parts['word/document.xml'])
        clean = xml(package(output / 'clean.docx')['word/document.xml'])
        self.assertEqual(len(tracked.findall('.//' + q('ins'))), 600)
        self.assertEqual(len(clean.findall('.//' + q('ins'))), 0)
        self.assertEqual(sum(paragraph_text(p).endswith('本轮更新。') for p in clean.iter(q('p'))), 600)
        # Rejecting the new revisions restores every original paragraph and run
        # property; unrelated template parts remain byte-identical.
        self.assertEqual(canonical(resolve_revisions(copy.deepcopy(tracked), False)), canonical(root))
        for name, original in parts.items():
            if name != 'word/document.xml':
                self.assertEqual(tracked_parts[name], original, name)


    def test_empty_annotated_paragraph_uses_mark_font_and_preserves_comment_reference(self):
        p = ET.Element(q('p'))
        mark = ET.SubElement(ET.SubElement(p, q('pPr')), q('rPr'))
        ET.SubElement(mark, q('rFonts'), {q('ascii'): 'Times New Roman', q('hAnsi'): 'Times New Roman'})
        ET.SubElement(mark, q('sz'), {q('val'): '21'})
        reference = ET.SubElement(p, q('r'))
        props = ET.SubElement(reference, q('rPr'))
        ET.SubElement(props, q('rStyle'), {q('val'): 'CommentReference'})
        ET.SubElement(props, q('vertAlign'), {q('val'): 'superscript'})
        ET.SubElement(reference, q('commentReference'), {q('id'): '77'})
        original = copy.deepcopy(p)
        reference_before = canonical(reference)
        Patcher(p, False).patch(p, '', '0.00')
        added = next(run for run in p.findall(q('r')) if run.find(q('t')) is not None)
        self.assertEqual(canonical(added.find(q('rPr'))), canonical(mark))
        self.assertEqual(canonical(reference), reference_before)
        tracked = copy.deepcopy(original)
        Patcher(tracked, True).patch(tracked, '', '0.00')
        self.assertEqual(canonical(resolve_revisions(copy.deepcopy(tracked), False)), canonical(original))
        self.assertEqual(canonical(resolve_revisions(copy.deepcopy(tracked), True)), canonical(p))
        cloned = Editor(self.data, self.source).clone_paragraph(original, '0.00')
        self.assertEqual(canonical(cloned.find(q('r') + '/' + q('rPr'))), canonical(mark))
        self.assertFalse(list(cloned.iter(q('commentReference'))))


class WordQualityPreflightTests(unittest.TestCase):
    """Preflight parity and fail-closed boundaries, using synthetic documents."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'output').mkdir()
        (self.root / 'scratch').mkdir()
        self.source = self.root / 'source.docx'
        self.financial = '截至2025年6月末，合并净资产为100万元，历史比较数据及适用解释继续保留。' * 8
        doc = Document()
        doc.add_heading('第一章 发行人基本情况', level=1)
        doc.add_paragraph('发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 40)
        doc.add_heading('第二章 财务会计信息', level=1)
        doc.add_paragraph(self.financial)
        doc.sections[0].header.paragraphs[0].text = '原稿页眉'
        doc.save(self.source)
        self.input = self.root / 'input.json'
        self.log_path = self.root / 'output/operations.json'
        self.report_path = self.root / 'scratch/preflight.json'
        self.data = {'input_hash': 'b' * 64, 'revision_author': 'BondBuddy-preflight-test',
                     'revision_date': '2026-11-03T00:00:00.000Z', 'update_required': True,
                     'baseline_kind': 'uploaded_source', 'baseline_path': 'source.docx',
                     'baseline_sha256': sha(self.source.read_bytes()), 'operations_path': 'output/operations.json',
                     'output': {'tracked': 'delivered/tracked.docx', 'clean': 'delivered/clean.docx', 'baseline': 'delivered/baseline.docx'}}
        self.log = empty_log(self.data, self.source.read_bytes())
        self.node = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == self.financial)
        self.log['operations'] = [self.operation(self.financial.replace('6月末', '9月末').replace('100', '120'))]
        self.save()

    def tearDown(self):
        self.temp.cleanup()

    def operation(self, after, op_id='update', before=None):
        return {'id': op_id, 'kind': 'replace_text', 'node_id': self.node['node_id'],
                'before': self.financial if before is None else before, 'after': after}

    def save(self):
        write_json(self.input, self.data)
        write_json(self.log_path, self.log)

    def check(self):
        from bondbuddy_file_authoring.preflight import preflight
        return preflight(self.input, self.log_path, self.report_path)

    def require_render_check(self):
        # Real source paragraphs activate the same size gate as a long draft;
        # only the renderer is mocked, never preflight or the quality checker.
        doc = Document(self.source)
        for index in range(100):
            doc.add_paragraph(f'合成预检说明第{index + 1}项，原有实质披露保持完整。')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.log = empty_log(self.data, self.source.read_bytes())
        self.node = next(n for n in build_manifest(self.source)['nodes']
                         if n['kind'] == 'paragraph' and n['text'] == self.financial)
        self.log['operations'] = [self.operation(self.financial.replace('6月末', '9月末').replace('100', '120'))]
        self.save()

    def test_rendering_only_failure_hands_off_current_operations_without_passing(self):
        from bondbuddy_file_authoring.document_size import PageCountError
        self.require_render_check()
        before = {path: path.read_bytes() for path in (self.input, self.source, self.log_path)}
        for reason in ('renderer_missing', 'renderer_failed', 'render_timeout',
                       'render_output_invalid', 'render_pdf_unreadable'):
            with self.subTest(reason=reason), patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                    patch('bondbuddy_file_authoring.document_size.shutil.which',
                          return_value=None if reason == 'renderer_missing' else '/synthetic/libreoffice'), \
                    patch('bondbuddy_file_authoring.document_size.render_pages',
                          side_effect=PageCountError(reason)) as renderer:
                result = self.check()
            self.assertEqual(renderer.call_count, 0 if reason == 'renderer_missing' else 1)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['quality_report']['status'], 'failed')
            self.assertEqual(result['issues'], [{'code': 'WORD_PAGE_COUNT_UNAVAILABLE', 'reason': reason}])
            self.assertEqual(result['quality_report']['issues'], result['issues'])
            self.assertEqual(result['quality_report']['document_size_check']['page_check'],
                             {'status': 'unavailable', 'reason': reason})
            self.assertTrue(result['snapshot_current'])
            self.assertEqual(result['input_hash'], self.data['input_hash'])
            self.assertEqual(result['input_sha256'], sha(before[self.input]))
            self.assertEqual(result['baseline_sha256'], sha(before[self.source]))
            self.assertEqual(result['operations_sha256'], sha(before[self.log_path]))
            self.assertEqual(result['host_handoff'], {
                'action': 'defer_page_rendering_to_host', 'reason': 'rendering_infrastructure_only',
                'operations_sha256': result['operations_sha256'], 'host_validation_required': True,
                'authoring_completion': 'not_verified'})
            for field in ('host_acceptance', 'delivery_registered', 'release_authorized'):
                self.assertFalse(result[field])
            self.assertEqual(json.loads(self.report_path.read_text(encoding='utf-8')), result)
            self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_successful_render_removes_stale_handoff_from_previous_report(self):
        from bondbuddy_file_authoring.document_size import PageCountError
        self.require_render_check()
        with patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice'), \
                patch('bondbuddy_file_authoring.document_size.render_pages',
                      side_effect=PageCountError('render_output_invalid')):
            failed = self.check()
        self.assertIn('host_handoff', failed)
        with patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice'), \
                patch('bondbuddy_file_authoring.document_size.render_pages',
                      side_effect=[{'pages': 60}, {'pages': 60}]) as renderer:
            result = self.check()
        self.assertEqual(renderer.call_count, 2)
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['quality_report']['document_size_check']['page_check']['status'], 'passed')
        self.assertNotIn('host_handoff', result)
        self.assertEqual(json.loads(self.report_path.read_text(encoding='utf-8')), result)

    def test_rendering_and_content_failures_cannot_request_host_handoff(self):
        from bondbuddy_file_authoring.document_size import PageCountError
        self.require_render_check()
        # Expected-source anchors are checked after pagination, so this exercises
        # a genuine mixed report without fabricating quality-checker output.
        self.data['expected_text'] = [{'text': 'Synthetic evidence anchor deliberately absent from the draft.'}]
        self.save()
        with patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice'), \
                patch('bondbuddy_file_authoring.document_size.render_pages',
                      side_effect=PageCountError('render_output_invalid')) as renderer:
            result = self.check()
        self.assertEqual(renderer.call_count, 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual({issue['code'] for issue in result['issues']},
                         {'WORD_PAGE_COUNT_UNAVAILABLE', 'WORD_EXPECTED_FACT_MISMATCH'})
        self.assertEqual(result['quality_report']['issues'], result['issues'])
        self.assertTrue(result['snapshot_current'])
        self.assertNotIn('host_handoff', result)

    def test_log_change_during_rendering_invalidates_handoff_and_overwrites_old_report(self):
        from bondbuddy_file_authoring.document_size import PageCountError
        self.require_render_check()
        with patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice'), \
                patch('bondbuddy_file_authoring.document_size.render_pages',
                      side_effect=PageCountError('render_output_invalid')):
            old = self.check()
        self.assertIn('host_handoff', old)

        def change_log(*args, **kwargs):
            self.log['operations'].append(self.operation('后来追加的合成修改。', 'later', self.log['operations'][0]['after']))
            self.save()
            raise PageCountError('render_output_invalid')

        with patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \
                patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice'), \
                patch('bondbuddy_file_authoring.document_size.render_pages', side_effect=change_log):
            result = self.check()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['snapshot_current'])
        self.assertEqual(result['issues'], [{'code': 'WORD_PREFLIGHT_INPUT_CHANGED'}])
        self.assertEqual(result['quality_report']['issues'],
                         [{'code': 'WORD_PAGE_COUNT_UNAVAILABLE', 'reason': 'render_output_invalid'}])
        self.assertEqual(result['operations_sha256'], old['operations_sha256'])
        self.assertNotEqual(result['operations_sha256'], sha(self.log_path.read_bytes()))
        self.assertNotIn('host_handoff', result)
        self.assertEqual(json.loads(self.report_path.read_text(encoding='utf-8')), result)

    def test_numeric_update_has_identical_host_report_and_no_approval_flags(self):
        from bondbuddy_file_authoring.quality import verify
        result = self.check()
        finalize(self.input, self.log_path, self.root / 'delivered', skip_report=True)
        self.assertEqual(result['quality_report'], verify(self.input))
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['scope'], 'model_preflight_diagnostic_only')
        self.assertFalse(result['host_acceptance'])
        self.assertFalse(result['delivery_registered'])
        self.assertFalse(result['release_authorized'])
        self.assertEqual(result['factual_accuracy'], 'not_verified')
        self.assertEqual(result['visual_review'], 'not_run')
        self.assertNotIn('host_handoff', result)

    def test_whole_manuscript_collapse_is_rejected_identically_by_preflight_and_host(self):
        from bondbuddy_file_authoring.quality import verify
        doc = Document(self.source)
        self.financial *= 4
        doc.paragraphs[3].text = self.financial
        for _ in range(19):
            doc.add_paragraph(self.financial)
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.log = empty_log(self.data, self.source.read_bytes())
        nodes = [n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == self.financial]
        self.assertEqual(len(nodes), 20)
        self.log['operations'] = [{'id': f'condense-{i}', 'kind': 'replace_text', 'node_id': n['node_id'],
                                   'before': n['text'], 'after': '本期财务信息已更新为新的简短说明。'} for i, n in enumerate(nodes)]
        self.save()
        result = self.check()
        finalize(self.input, self.log_path, self.root / 'delivered', skip_report=True)
        self.assertEqual(result['quality_report'], verify(self.input))
        self.assertEqual(result['status'], 'failed')
        self.assertIn('WORD_DOCUMENT_SIZE_REDUCED', {i['code'] for i in result['issues']})
        self.assertEqual(result['quality_report']['metrics']['ratios']['nonempty_paragraphs'], 1)
        self.assertNotIn('host_handoff', result)

    def test_preflight_preserves_locked_files_and_formal_outputs_and_cleans_temporary_area(self):
        paths = [self.input, self.source, self.log_path, self.root / 'output/tracked.docx', self.root / 'output/clean.docx']
        for path in paths[-2:]:
            path.write_bytes(b'Existing formal output must remain unchanged.')
        original = {path: path.read_bytes() for path in paths}
        self.assertEqual(self.check()['status'], 'passed')
        self.assertEqual({path: path.read_bytes() for path in paths}, original)
        self.assertEqual(list((self.root / 'scratch').iterdir()), [self.report_path])

    def test_chapter_loss_has_source_current_text_and_stable_node_locations(self):
        from bondbuddy_file_authoring.quality import verify
        self.log['operations'] = [self.operation('')]
        self.save()
        result = self.check()
        finalize(self.input, self.log_path, self.root / 'delivered', skip_report=True)
        self.assertEqual(result['quality_report'], verify(self.input))
        self.assertEqual(result['status'], 'failed')
        finding = result['diagnostics']['chapter_content'][0]
        self.assertEqual(finding['title'], '第二章财务会计信息')
        self.assertEqual(finding['source']['paragraphs'][1]['text'], self.financial)
        self.assertEqual(finding['current']['paragraphs'][1]['text'], self.log['operations'][0]['after'])
        self.assertEqual(finding['source']['paragraphs'][1]['node_id'], self.node['node_id'])
        self.assertEqual(finding['current']['paragraphs'][1]['node_id'], self.node['node_id'])
        self.assertEqual(finding['operation_ids'], ['update'])

    def test_heading_change_has_both_stable_heading_locations(self):
        heading = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == '第二章 财务会计信息')
        self.log['operations'].append({'id': 'heading', 'kind': 'replace_text', 'node_id': heading['node_id'],
                                      'before': heading['text'], 'after': '第三章 财务会计信息'})
        self.save()
        result = self.check()
        self.assertIn('WORD_SOURCE_OUTLINE_CHANGED', {i['code'] for i in result['issues']})
        change = result['diagnostics']['outline']['headings']['changes'][0]
        self.assertEqual(change['before'][0]['node_id'], heading['node_id'])
        self.assertEqual(change['after'][0]['node_id'], heading['node_id'])
        self.assertEqual(change['before'][0]['recognition'], 'outline')
        self.assertEqual(result['diagnostics']['chapter_content'], [])
        self.assertNotIn('host_handoff', result)

    def test_renamed_section_empty_body_keeps_current_diagnostic_locations(self):
        heading = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == '第二章 财务会计信息')
        self.log['operations'] = [self.operation(''), {'id': 'heading', 'kind': 'replace_text',
                                 'node_id': heading['node_id'], 'before': heading['text'], 'after': '第二章 目标发行人财务信息'}]
        self.save()
        result = self.check()
        self.assertEqual(result['diagnostics']['outline']['status'], 'unchanged')
        finding = result['diagnostics']['chapter_content'][0]
        self.assertFalse(finding['current_key_found'])
        self.assertEqual(finding['current_chapter_key'][0], '第二章目标发行人财务信息')
        self.assertEqual(finding['current']['paragraphs'][1]['node_id'], self.node['node_id'])
        self.assertEqual(finding['current_matching_source_nodes']['paragraphs'][0]['node_id'], heading['node_id'])

    def test_preflight_and_host_accept_rewritten_heading_and_concise_body(self):
        from bondbuddy_file_authoring.quality import verify
        heading = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == '第二章 财务会计信息')
        self.log['operations'] = [self.operation('合成目标主体的本期合并净资产为120万元。'),
                                 {'id': 'heading', 'kind': 'replace_text', 'node_id': heading['node_id'],
                                  'before': heading['text'], 'after': '第二章 目标发行人财务信息'}]
        self.save()
        result = self.check()
        finalize(self.input, self.log_path, self.root / 'delivered', skip_report=True)
        self.assertEqual(result['quality_report'], verify(self.input))
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['diagnostics']['chapter_content'], [])

    def test_table_content_loss_reports_ancestor_cell_operation_and_paragraph_node(self):
        doc = Document(self.source)
        cell_text = '原表格重要财务披露必须逐项保留。' * 40
        doc.add_heading('第三章 财务报表', level=1)
        doc.add_table(rows=1, cols=1).cell(0, 0).text = cell_text
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.log = empty_log(self.data, self.source.read_bytes())
        cell = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'cell' and n['text'] == cell_text)
        self.log['operations'] = [{'id': 'erase-cell', 'kind': 'replace_cell_text', 'node_id': cell['node_id'],
                                   'before': cell_text, 'after': ''}]
        self.save()
        result = self.check()
        self.assertEqual(result['status'], 'failed')
        finding = result['diagnostics']['chapter_content'][0]
        self.assertEqual(finding['operation_ids'], ['erase-cell'])
        self.assertIn(cell['node_id'], finding['source']['paragraphs'][-1]['container_node_ids'])

    def test_old_deleted_paragraph_does_not_shift_stable_diagnostic_identity(self):
        parts = package(self.source)
        root = xml(parts['word/document.xml'])
        removed = ET.Element(q('p'))
        ET.SubElement(ET.SubElement(ET.SubElement(removed, q('pPr')), q('rPr')), q('del'),
                      {q('author'): 'Historic-author', q('id'): '901'})
        ET.SubElement(ET.SubElement(removed, q('r')), q('t')).text = '原稿中已有删除修订的历史段落。'
        root.find(q('body')).insert(0, removed)
        parts['word/document.xml'] = serialized(root)
        with ZipFile(self.source, 'w', ZIP_DEFLATED) as archive:
            for name, raw in parts.items():
                archive.writestr(name, raw)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.log = empty_log(self.data, self.source.read_bytes())
        self.node = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == self.financial)
        self.log['operations'] = [self.operation('')]
        self.save()
        finding = self.check()['diagnostics']['chapter_content'][0]
        self.assertEqual(finding['source']['paragraphs'][1]['paragraph_index'], 3)
        self.assertEqual(finding['current']['paragraphs'][1]['paragraph_index'], 3)
        self.assertEqual(finding['source']['paragraphs'][1]['node_id'], self.node['node_id'])
        self.assertEqual(finding['current']['paragraphs'][1]['node_id'], self.node['node_id'])

    def test_cumulative_replay_reports_final_text_and_new_operations_hash(self):
        first = self.check()
        intermediate = self.log['operations'][0]['after']
        self.log['operations'].append(self.operation('', 'second', intermediate))
        self.save()
        second = self.check()
        self.assertNotEqual(first['operations_sha256'], second['operations_sha256'])
        finding = second['diagnostics']['chapter_content'][0]
        self.assertEqual(finding['current']['paragraphs'][1]['text'], '')
        self.assertEqual(finding['operation_ids'], ['update', 'second'])

    def test_missing_or_empty_log_overwrites_fake_pass_with_failure(self):
        for raw, expected in [(None, 'WORD_EDIT_LOG_REQUIRED'), (b'', 'WORD_EDIT_FILE_INVALID')]:
            with self.subTest(expected=expected):
                write_json(self.report_path, {'status': 'passed', 'host_acceptance': True,
                                             'host_handoff': {'action': 'defer_page_rendering_to_host',
                                                              'operations_sha256': 'f' * 64}})
                if raw is None:
                    self.log_path.unlink()
                else:
                    self.log_path.write_bytes(raw)
                result = self.check()
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['issues'], [{'code': expected}])
                self.assertFalse(json.loads(self.report_path.read_text(encoding='utf-8'))['host_acceptance'])
                self.assertNotIn('host_handoff', result)
                self.assertNotIn('host_handoff', json.loads(self.report_path.read_text(encoding='utf-8')))

    def test_wrong_input_or_baseline_hash_cannot_pass(self):
        for field in ('input_hash', 'baseline_sha256'):
            with self.subTest(field=field):
                original = self.log[field]
                self.log[field] = 'f' * 64
                self.save()
                self.assertEqual(self.check()['issues'], [{'code': 'WORD_EDIT_LOG_INPUT_MISMATCH'}])
                self.log[field] = original
        self.data['baseline_sha256'] = 'f' * 64
        self.save()
        self.assertEqual(self.check()['issues'], [{'code': 'WORD_EDIT_SOURCE_HASH_MISMATCH'}])

    def test_missing_baseline_kind_and_unexplained_empty_log_fail(self):
        kind = self.data.pop('baseline_kind')
        self.save()
        self.assertEqual(self.check()['issues'], [{'code': 'WORD_PREFLIGHT_BASELINE_KIND_INVALID'}])
        self.data['baseline_kind'] = kind
        self.log['operations'] = []
        self.save()
        self.assertEqual(self.check()['issues'], [{'code': 'WORD_EDIT_NO_CHANGES_REASON_REQUIRED'}])

    def test_date_only_update_and_no_changes_use_host_incomplete_update_rule(self):
        for operations in [[], [self.operation(self.financial.replace('6月末', '9月末'))]]:
            with self.subTest(operations=len(operations)):
                self.log['operations'] = operations
                self.log['no_changes_reason'] = 'Synthetic source retained pending evidence.'
                self.save()
                self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', {i['code'] for i in self.check()['issues']})

    def test_derived_paths_ignore_input_output_and_report_spoofing(self):
        self.data.update(operations_path='scratch/fake-passed.json', materials=[{'path': '../other-project'}],
                         output={'tracked': '../outside.docx', 'clean': 'scratch/fake-passed.json'})
        fake = self.root / 'scratch/fake-passed.json'
        fake.write_text('{"status":"passed","release_authorized":true}', encoding='utf-8')
        fake_before = fake.read_bytes()
        self.log['operations'] = [self.operation('')]
        self.save()
        self.assertEqual(self.check()['status'], 'failed')
        self.assertEqual(fake.read_bytes(), fake_before)

    def test_outside_traversal_and_hardlinked_paths_are_rejected(self):
        from bondbuddy_file_authoring.preflight import preflight
        for path in [self.root / 'scratch/../outside.json', self.root.parent / 'outside.json', self.root / 'output/report.json']:
            with self.subTest(path=str(path)), self.assertRaisesRegex(ValueError, 'WORD_PREFLIGHT_PATH_UNSAFE'):
                preflight(self.input, self.log_path, path)
        hardlink = self.root / 'scratch/linked.json'
        os.link(self.log_path, hardlink)
        with self.assertRaisesRegex(ValueError, 'WORD_PREFLIGHT_PATH_UNSAFE'):
            preflight(self.input, self.log_path, hardlink)
        self.assertEqual(preflight(self.input, self.log_path, self.report_path)['issues'], [{'code': 'WORD_PREFLIGHT_PATH_UNSAFE'}])

    def test_detected_symbolic_parent_is_rejected_without_following_it(self):
        from bondbuddy_file_authoring.preflight import preflight
        if os.name != 'nt':
            link = self.root / 'scratch/linked'
            link.symlink_to(self.root / 'output', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'WORD_PREFLIGHT_PATH_UNSAFE'):
                preflight(self.input, self.log_path, link / 'report.json')
        else:
            # Windows may require administrator rights to create symlinks. Test
            # the exact link detector on this platform; Linux uses a real link.
            original = Path.is_symlink
            with patch.object(Path, 'is_symlink', lambda path: path == self.root / 'scratch' or original(path)):
                with self.assertRaisesRegex(ValueError, 'WORD_PREFLIGHT_PATH_UNSAFE'):
                    preflight(self.input, self.log_path, self.report_path)

    def test_log_change_during_check_invalidates_current_preflight(self):
        from bondbuddy_file_authoring import quality
        original = quality.verify
        def change_log(path):
            report = original(path)
            self.log['operations'].append(self.operation('后来追加的修改。', 'later', self.log['operations'][0]['after']))
            self.save()
            return report
        with patch.object(quality, 'verify', change_log):
            result = self.check()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['snapshot_current'])
        self.assertEqual(result['issues'], [{'code': 'WORD_PREFLIGHT_INPUT_CHANGED'}])

    def test_temporary_input_tampering_cannot_turn_replay_into_a_pass(self):
        from bondbuddy_file_authoring import quality
        original = quality.verify
        def tamper(path):
            report = original(path)
            path.write_text('{"status":"passed"}', encoding='utf-8')
            return report
        with patch.object(quality, 'verify', tamper):
            result = self.check()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['snapshot_current'])
        self.assertEqual(result['issues'], [{'code': 'WORD_PREFLIGHT_INPUT_CHANGED'}])

    def test_original_pdf_snapshot_is_bound_and_changes_cannot_pass(self):
        from bondbuddy_file_authoring import quality
        from pypdf import PdfWriter
        original_pdf = self.root / 'source.pdf'
        writer = PdfWriter()
        writer.add_blank_page(width=612, height=792)
        writer.write(original_pdf)
        original_bytes = original_pdf.read_bytes()
        self.data['baseline_kind'] = 'reconstructed_pdf'
        self.data['original_pdf_path'] = 'source.pdf'
        self.save()
        first = self.check()
        self.assertEqual(first['original_pdf_sha256'], sha(original_pdf.read_bytes()))
        self.assertEqual(first['status'], 'failed')
        self.assertIn('WORD_PDF_TEXT_VERIFICATION_UNAVAILABLE', {i['code'] for i in first['issues']})
        self.assertTrue(first['snapshot_current'])
        original = quality.verify
        def change_pdf(path):
            report = original(path)
            original_pdf.write_bytes(original_bytes + b'\n% Changed evidence bytes.\n')
            return report
        with patch.object(quality, 'verify', change_pdf):
            result = self.check()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['snapshot_current'])
        self.assertEqual(result['issues'], [{'code': 'WORD_PREFLIGHT_INPUT_CHANGED'}])

    def test_report_aliases_cannot_overwrite_input_log_or_declared_sources(self):
        from bondbuddy_file_authoring.preflight import preflight
        original_input = self.input.read_bytes()
        with self.assertRaisesRegex(ValueError, 'WORD_PREFLIGHT_PATH_UNSAFE'):
            preflight(self.input, self.log_path, self.input)
        self.assertEqual(self.input.read_bytes(), original_input)
        for field in ('operations', 'baseline_path', 'original_pdf_path'):
            with self.subTest(field=field):
                alias = self.root / 'scratch/alias.json'
                raw = self.source.read_bytes() if field == 'baseline_path' else b'Original protected input bytes.'
                alias.write_bytes(raw)
                log_path = self.log_path
                if field == 'operations':
                    log_path = alias
                else:
                    self.data[field] = 'scratch/alias.json'
                    write_json(self.input, self.data)
                with self.assertRaisesRegex(ValueError, 'WORD_PREFLIGHT_REPORT_INPUT_ALIAS'):
                    preflight(self.input, log_path, alias)
                self.assertEqual(alias.read_bytes(), raw)
                if field != 'operations':
                    self.data.pop(field)
                    if field == 'baseline_path':
                        self.data[field] = 'source.docx'

    def test_cli_formula_failure_only_prints_codes_and_keeps_expressions_in_report(self):
        doc = Document(self.source)
        before = '1.流动比率=流动资产/流动负债'
        after = '1.流动比率=流动资产/（流动负债+长期借款）'
        doc.add_paragraph(before)
        doc.add_paragraph('2.速动比率=（流动资产-存货）/流动负债')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.log = empty_log(self.data, self.source.read_bytes())
        node = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == before)
        self.log['operations'] = [{'id': 'formula', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': before, 'after': after}]
        self.save()
        run = subprocess.run([sys.executable, '-m', 'bondbuddy_file_authoring.fixed_edit', 'preflight',
                              '--input', str(self.input), '--operations', str(self.log_path), '--report', str(self.report_path)],
                             capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(run.returncode, 1, run.stderr)
        summary = json.loads(run.stdout)
        self.assertIn({'code': 'WORD_SOURCE_FORMULA_CHANGED'}, summary['issues'])
        self.assertTrue(all(set(issue) == {'code'} for issue in summary['issues']))
        self.assertNotIn('流动资产', run.stdout)
        report = json.loads(self.report_path.read_text(encoding='utf-8'))
        formula = next(i for i in report['issues'] if i['code'] == 'WORD_SOURCE_FORMULA_CHANGED')
        self.assertIn('流动资产', json.dumps(formula, ensure_ascii=False))
        self.assertNotIn('host_handoff', summary)

    def test_cli_render_handoff_preserves_exit_one_and_keeps_private_diagnostics_in_report(self):
        self.require_render_check()
        diagnostic = 'render_output_invalid: synthetic-private-renderer-stderr-canary'
        program = '''
import os
from unittest.mock import patch
from bondbuddy_file_authoring.document_size import PageCountError
from bondbuddy_file_authoring.fixed_edit import main
with patch.dict(os.environ, {'BONDBUDDY_WORD_LIBREOFFICE': ''}), \\
     patch('bondbuddy_file_authoring.document_size.shutil.which', return_value='/synthetic/libreoffice'), \\
     patch('bondbuddy_file_authoring.document_size.render_pages', side_effect=PageCountError(%r)):
    raise SystemExit(main())
''' % diagnostic
        run = subprocess.run([sys.executable, '-c', program, 'preflight', '--input', str(self.input),
                              '--operations', str(self.log_path), '--report', str(self.report_path)],
                             capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(run.returncode, 1, run.stderr)
        summary = json.loads(run.stdout)
        report = json.loads(self.report_path.read_text(encoding='utf-8'))
        self.assertEqual(summary['status'], 'failed')
        self.assertEqual(summary['report'], str(self.report_path))
        self.assertEqual(summary['issues'], [{'code': 'WORD_PAGE_COUNT_UNAVAILABLE'}])
        self.assertEqual(summary['host_handoff'], report['host_handoff'])
        self.assertEqual(summary['host_handoff']['action'], 'defer_page_rendering_to_host')
        self.assertEqual(summary['host_handoff']['operations_sha256'], sha(self.log_path.read_bytes()))
        self.assertTrue(summary['host_handoff']['host_validation_required'])
        self.assertEqual(summary['host_handoff']['authoring_completion'], 'not_verified')
        self.assertNotIn('quality_report', summary)
        self.assertNotIn('diagnostics', summary)
        for private in (self.financial, diagnostic):
            self.assertNotIn(private, run.stdout)
            self.assertNotIn(private, run.stderr)
        self.assertEqual(json.loads(run.stderr), {'error': 'WORD_PREFLIGHT_REJECTED'})
        self.assertEqual(report['issues'], [{'code': 'WORD_PAGE_COUNT_UNAVAILABLE', 'reason': diagnostic}])

    def test_cli_failure_returns_report_path_without_dumping_private_paragraphs(self):
        self.log['operations'] = [self.operation('')]
        self.save()
        run = subprocess.run([sys.executable, '-m', 'bondbuddy_file_authoring.fixed_edit', 'preflight',
                              '--input', str(self.input), '--operations', str(self.log_path), '--report', str(self.report_path)],
                             capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(run.returncode, 1, run.stderr)
        summary = json.loads(run.stdout)
        self.assertEqual(summary['report'], str(self.report_path))
        self.assertEqual(summary['status'], 'failed')
        self.assertNotIn(self.financial, run.stdout)
        self.assertIn('WORD_PREFLIGHT_REJECTED', run.stderr)
        self.assertTrue(json.loads(self.report_path.read_text(encoding='utf-8'))['diagnostics']['chapter_content'])
        self.assertNotIn('host_handoff', summary)


if __name__ == '__main__':
    unittest.main()
