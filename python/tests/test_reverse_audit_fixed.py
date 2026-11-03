"""Synthetic source-to-replay inventory; no financial acceptance is asserted."""
import json
import tempfile
import unittest
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from bondbuddy_file_authoring.fixed_edit import empty_log, load_editor, write_json
from bondbuddy_file_authoring.reverse_audit import inventory, source_rows
from bondbuddy_file_authoring.template_manifest import sha
from bondbuddy_file_authoring.word_patch import q, serialized, xml
from lxml import etree as ET
from zipfile import ZipFile, ZIP_DEFLATED


class ReverseAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        document = Document()
        document.add_paragraph('报告期内，工程应付款余额为17.23万元，仍应逐项回查。')
        document.add_paragraph('其他段落可以修改，不代表上述零操作段落已经核对。')
        document.add_paragraph('当前法定代表人甲某。')
        document.add_table(rows=1, cols=2).rows[0].cells[0].text = '工程应付款'
        document.tables[0].cell(0, 1).text = '17.23'
        document.sections[0].header.paragraphs[0].text = '工程应付款17.23万元'
        self.source = self.root / 'source.docx'
        document.save(self.source)
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = '本期合并报表'
        sheet['A1'] = '编制单位：合成发行人'
        sheet['A2'] = '单位：元'
        sheet['A3'] = '2027年3月31日'
        sheet['A8'] = ' 工 程 应 付 款 '
        sheet['D8'] = 93218.370000009
        sheet['A9'] = '递延补助'
        sheet['D9'] = '=SUM(D8)'
        self.xlsx = self.root / 'facts.xlsx'
        workbook.save(self.xlsx)
        self.material = {'material_id': 'synthetic-facts', 'material_version': 9, 'role': 'financial',
                         'path': 'facts.xlsx', 'sha256': sha(self.xlsx.read_bytes())}
        self.data = {'input_hash': 'b' * 64, 'revision_author': 'BondBuddy-synthetic',
                     'baseline_path': 'source.docx', 'baseline_sha256': sha(self.source.read_bytes()),
                     'materials': [self.material]}
        self.input = self.root / 'input.json'
        self.operations = self.root / 'operations.json'
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())

    def tearDown(self):
        self.temp.cleanup()

    def test_zero_operation_old_narrative_table_and_header_are_actual_matches(self):
        result = inventory(self.input)
        group = next(g for g in result['source_groups'] if g['match_label'] == '工程应付款')
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(group['sheet_state'], 'visible')
        occurrences = [result['occurrences'][key] for key in group['occurrence_ids']]
        self.assertTrue(any(r['kind'] == 'row' for r in occurrences))
        self.assertTrue(any(r['part'].startswith('word/header') for r in occurrences))
        narrative = next(r for r in occurrences if '报告期内' in r['text'])
        self.assertFalse(narrative['changed'])
        self.assertIn('17.23', narrative['numeric_literals'])
        self.assertEqual(narrative['text'], narrative['baseline_text'])
        self.assertNotEqual(group['cells'][0]['decimal'], '17.23')
        self.assertEqual(group['cells'][0]['decimal'], group['cells'][0]['raw_cached'])
        self.assertTrue(all(r['status'] == 'needs_review' for r in occurrences))

    def test_unrelated_change_does_not_hide_old_occurrence_and_insertions_are_scanned(self):
        *_, editor = load_editor(self.input)
        target = next(key for key, (_, node) in editor.nodes.items() if node.tag.endswith('}p') and '其他段落可以修改' in ''.join(node.itertext()))
        self.log['operations'] = [{'id': 'unrelated', 'kind': 'replace_text', 'node_id': target,
                                   'before': '其他段落可以修改，不代表上述零操作段落已经核对。', 'after': '其他段落修改完毕。'},
                                  {'id': 'additional', 'kind': 'insert_paragraph', 'node_id': target,
                                   'before': '其他段落修改完毕。', 'text': '工程应付款为9.321837万元。'}]
        write_json(self.operations, self.log)
        result = inventory(self.input, self.operations)
        group = next(g for g in result['source_groups'] if g['match_label'] == '工程应付款')
        occurrences = [result['occurrences'][key] for key in group['occurrence_ids']]
        self.assertTrue(any('报告期内' in r['text'] and not r['changed'] for r in occurrences))
        self.assertTrue(any(r['node_id'].startswith('op:additional:') and r['changed'] for r in occurrences))
        self.assertTrue(result['identity_occurrences'])
        self.assertEqual(result['identity_occurrences'][0]['status'], 'needs_review')

    def test_formula_without_numeric_cache_is_missing_not_zero(self):
        group = next(g for g in inventory(self.input)['source_groups'] if g['match_label'] == '递延补助')
        self.assertIsNone(group['cells'][0]['decimal'])
        self.assertTrue(group['cells'][0]['needs_confirmation'])
        self.assertEqual(group['occurrence_ids'], [])

    def test_source_hash_changes_are_rejected_before_returning_any_group(self):
        wrong = {**self.material, 'sha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'SOURCE_HASH_MISMATCH'):
            list(source_rows(self.xlsx, wrong))

    def test_explicit_missing_operations_is_rejected_and_baseline_is_labeled(self):
        with self.assertRaisesRegex(ValueError, 'OPERATIONS_REQUIRED'):
            inventory(self.input, self.root / 'wrong-name.json')
        baseline = inventory(self.input)
        self.assertEqual(baseline['inventory_mode'], 'baseline_preview')
        self.assertIsNone(baseline['operations_sha256'])

    def test_comment_only_and_changed_identity_keep_actual_operation_comments(self):
        *_, editor = load_editor(self.input)
        target = next(key for key, (_, node) in editor.nodes.items() if node.tag.endswith('}p') and '当前法定代表人甲某' in ''.join(node.itertext()))
        for changed in (False, True):
            text = '当前法定代表人甲某。'
            operations = []
            if changed:
                operations.append({'id': 'text', 'kind': 'replace_text', 'node_id': target,
                                   'before': text, 'after': '当前法定代表人甲某（原稿登记口径）。'})
                text = '当前法定代表人甲某（原稿登记口径）。'
            operations.append({'id': 'conflict', 'kind': 'add_comment', 'node_id': target, 'before': text,
                               'text': '甲某与乙某来源冲突，请核对登记和任免生效时点，暂保留原稿。'})
            self.log['operations'] = operations
            write_json(self.operations, self.log)
            result = inventory(self.input, self.operations)
            identity = next(r for r in result['identity_occurrences'] if r['node_id'] == target)
            self.assertEqual(identity['changed'], changed)
            self.assertEqual(identity['replay_comments'][0]['source'], 'operations.add_comment')
            self.assertEqual(identity['replay_comments'][0]['operation_ids'], ['conflict'])
            self.assertIn('来源冲突', identity['replay_comments'][0]['text'])
            self.assertEqual(identity['status'], 'needs_review')

    def test_old_structural_deletion_is_excluded_from_actual_accepted_view(self):
        with ZipFile(self.source) as package:
            parts = {name: package.read(name) for name in package.namelist()}
        root = xml(parts['word/document.xml'])
        paragraph = root.find(q('body') + '/' + q('p'))
        props = ET.SubElement(paragraph, q('pPr'))
        run_props = ET.SubElement(props, q('rPr'))
        ET.SubElement(run_props, q('del'), {q('author'): 'Earlier', q('id'): '999'})
        parts['word/document.xml'] = serialized(root)
        with ZipFile(self.source, 'w', ZIP_DEFLATED) as package:
            for name, value in parts.items():
                package.writestr(name, value)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        result = inventory(self.input)
        self.assertTrue(result['excluded_nodes'])
        self.assertFalse(any('报告期内' in r['text'] for r in result['occurrences'].values()))

    def modify_xlsx(self, update):
        with ZipFile(self.xlsx) as package:
            parts = {name: package.read(name) for name in package.namelist()}
        update(parts)
        with ZipFile(self.xlsx, 'w', ZIP_DEFLATED) as package:
            for name, value in parts.items():
                package.writestr(name, value)
        self.material['sha256'] = sha(self.xlsx.read_bytes())
        write_json(self.input, self.data)

    def test_oversized_numeric_cache_is_pending_without_decimal_expansion(self):
        def update(parts):
            root = xml(parts['xl/worksheets/sheet1.xml'])
            cell = next(c for c in root.iter() if c.tag.endswith('}c') and c.get('r') == 'D8')
            next(c for c in cell if c.tag.endswith('}v')).text = '1e1000000000'
            parts['xl/worksheets/sheet1.xml'] = serialized(root)
        self.modify_xlsx(update)
        group = next(g for g in inventory(self.input)['source_groups'] if g['match_label'] == '工程应付款')
        self.assertEqual(group['cells'][0]['raw_cached'], '1e1000000000')
        self.assertIsNone(group['cells'][0]['decimal'])
        self.assertTrue(group['cells'][0]['needs_confirmation'])

    def test_negative_shared_string_index_cannot_select_last_string(self):
        def update(parts):
            parts['xl/sharedStrings.xml'] = b'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>unsafe-last</t></si></sst>'
            root = xml(parts['xl/worksheets/sheet1.xml'])
            cell = next(c for c in root.iter() if c.tag.endswith('}c') and c.get('r') == 'A8')
            cell.set('t', 's')
            for child in list(cell):
                cell.remove(child)
            ET.SubElement(cell, '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v').text = '-1'
            parts['xl/worksheets/sheet1.xml'] = serialized(root)
        self.modify_xlsx(update)
        with self.assertRaisesRegex(ValueError, 'SHARED_STRING_INDEX'):
            inventory(self.input)


if __name__ == '__main__':
    unittest.main()
