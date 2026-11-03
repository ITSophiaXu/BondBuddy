"""Synthetic source-to-replay inventory; no financial acceptance is asserted."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from docx import Document
from openpyxl import Workbook
from bondbuddy_file_authoring.fixed_edit import empty_log, load_editor, write_json
from bondbuddy_file_authoring.reverse_audit import inventory, source_rows, write_inventory_report
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
        self.assertEqual(len(result['review_queue']), 1)
        candidate = result['review_queue'][0]
        self.assertEqual(candidate['node_id'], narrative['node_id'])
        self.assertEqual(candidate['text_sha256'], narrative['text_sha256'])
        self.assertEqual(candidate['period_language'], ['报告期'])
        self.assertEqual(candidate['status'], 'needs_review')
        self.assertIn(group, [result['source_groups'][i] for i in candidate['source_group_indices']])
        self.assertFalse(narrative['in_table'])

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
        self.assertEqual(len(result['review_queue']), 1)
        self.assertIn('报告期内', result['occurrences'][result['review_queue'][0]['node_id']]['text'])
        self.assertFalse(any(item['node_id'].startswith('op:additional:') for item in result['review_queue']))

    def test_review_queue_does_not_treat_comment_or_unchanged_value_as_verified(self):
        *_, editor = load_editor(self.input)
        target = next(key for key, (_, node) in editor.nodes.items()
                      if node.tag == q('p') and '报告期内' in ''.join(node.itertext()))
        self.log['operations'] = [{'id': 'explanation', 'kind': 'add_comment', 'node_id': target,
                                  'before': '报告期内，工程应付款余额为17.23万元，仍应逐项回查。',
                                  'text': '已查看来源的说明不能代替核对金额、期间及口径。'}]
        write_json(self.operations, self.log)
        result = inventory(self.input, self.operations)
        self.assertEqual([item['node_id'] for item in result['review_queue']], [target])
        self.assertTrue(result['occurrences'][target]['replay_comments'])
        self.assertEqual(result['review_queue'][0]['status'], 'needs_review')
        self.assertEqual(result['inventory_mode'], 'operations_replay')
        self.assertEqual(result['operations_sha256'], sha(self.operations.read_bytes()))

    def test_review_queue_distinguishes_period_language_from_historical_facts(self):
        document = Document(self.source)
        document.paragraphs[0].text = '最近两年及一期末，工程应付款分别为12.00万元、13.00万元和17.23万元。'
        document.add_paragraph('2023年发生工程应付款12.00万元；该历史金额仍需按来源审核。')
        document.tables[0].cell(0, 0).text = '报告期内工程应付款'
        document.sections[0].header.paragraphs[0].text = '报告期内工程应付款17.23万元'
        document.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        result = inventory(self.input)
        self.assertEqual(result['inventory_mode'], 'baseline_preview')
        self.assertEqual(len(result['review_queue']), 1)
        candidate = result['review_queue'][0]
        self.assertEqual(candidate['period_language'], ['最近两年及一期末'])
        self.assertEqual(candidate['status'], 'needs_review')
        self.assertTrue(any('2023年发生' in r['text'] for r in result['occurrences'].values()))
        self.assertTrue(any(r['part'].startswith('word/header') for r in result['occurrences'].values()))

    def test_unmatched_periodic_amount_stays_in_review_queue(self):
        document = Document(self.source)
        document.paragraphs[0].text = '报告期内，发行人专项经营净额为47.81万元。'
        document.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        result = inventory(self.input)
        candidate = result['review_queue'][0]
        self.assertEqual(candidate['source_group_indices'], [])
        self.assertEqual(candidate['source_match_status'], 'unmatched_requires_source_review')
        self.assertEqual(candidate['status'], 'needs_review')

    def test_display_aliases_keep_original_labels_and_qualified_metrics(self):
        from bondbuddy_file_authoring.reverse_audit import label_candidates, alias_in_text
        label = '其中：减：经营收益（损失以“－”号填列）'
        candidates = label_candidates(label)
        self.assertEqual(candidates[0]['label'], label)
        self.assertEqual(candidates[1]['label'], '经营收益')
        self.assertEqual(candidates[1]['status'], 'ambiguous_needs_review')
        self.assertTrue(alias_in_text('经营收益', '报告期内，发行人经营收益分别为3万元和8万元。'))
        self.assertFalse(alias_in_text('经营收益', '报告期内，发行人联营经营收益为8万元。'))
        self.assertFalse(alias_in_text('经营收益', '报告期内，发行人经营收益率为8%。'))
        self.assertEqual(label_candidates('其中：联营经营收益')[1]['label'], '联营经营收益')
        self.assertEqual(label_candidates('经营收益（联营企业）'), [{'label':'经营收益（联营企业）','transformations':[],'status':'literal_needs_review'}])

    def test_source_alias_candidates_are_not_a_financial_binding(self):
        document = Document(self.source)
        document.paragraphs[0].text = '报告期内，发行人工程应付款余额为17.23万元。'
        document.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        workbook = Workbook()
        sheet = workbook.active
        sheet['A1'] = '合并口径'
        sheet['A8'] = '减：工程应付款（减少以“－”号填列）'
        sheet['D8'] = 876543.21
        workbook.save(self.xlsx)
        self.material['sha256'] = sha(self.xlsx.read_bytes())
        write_json(self.input, self.data)
        result = inventory(self.input)
        group = result['source_groups'][0]
        self.assertEqual(group['label'], sheet['A8'].value)
        self.assertEqual(group['label_candidates'][1]['label'], '工程应付款')
        self.assertTrue(group['candidate_alias_matches'])
        self.assertTrue(all(item['status']=='ambiguous_needs_review' for item in group['candidate_alias_matches']))
        self.assertEqual(result['review_queue'][0]['status'], 'needs_review')
        self.assertNotIn('expected_value', group)

    def test_glossary_table_periods_have_independent_pending_coverage(self):
        document = Document(self.source)
        table = document.add_table(rows=2, cols=3)
        table.cell(0,0).text = '最近三年及一期'
        table.cell(0,1).text = '指'
        table.cell(0,2).text = '2022年度、2023年度、2024年度和2025年1-3月'
        table.cell(1,0).text = '最近三年及一期末'
        table.cell(1,2).text = '2022年末、2023年末、2024年末和2025年3月末'
        document.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        result = inventory(self.input)
        definitions = result['period_definition_occurrences']
        self.assertEqual(len(definitions),2)
        self.assertTrue(all(x['kind']=='row' and not x['changed'] and x['status']=='needs_review' for x in definitions))
        self.assertTrue(all(x['node_id'] in result['occurrences'] for x in definitions))
        self.assertIn('2025年3月末', definitions[1]['definition_text'])

    def test_changed_or_empty_period_definitions_are_not_implicitly_reviewed(self):
        document = Document(self.source)
        document.add_paragraph('报告期：2024年度和2025年1-3月')
        table = document.add_table(rows=1, cols=2)
        table.cell(0,0).text = '本期末'
        document.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        write_json(self.input, self.data)
        self.log = empty_log(self.data, self.source.read_bytes())
        *_, editor = load_editor(self.input)
        target = next(key for key,(_,node) in editor.nodes.items() if node.tag==q('p') and ''.join(node.itertext()).startswith('报告期：'))
        self.log['operations']=[{'id':'synthetic-period-change','kind':'replace_text','node_id':target,'before':'报告期：2024年度和2025年1-3月','after':'报告期：2024年度和2025年1-9月'}]
        write_json(self.operations,self.log)
        definitions = inventory(self.input,self.operations)['period_definition_occurrences']
        self.assertEqual(len(definitions),2)
        self.assertTrue(any(x['changed'] and x['status']=='needs_review' for x in definitions))
        self.assertTrue(any(x['definition_text']=='' and x['status']=='needs_review' for x in definitions))

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

    def test_report_cannot_overwrite_input_or_explicit_or_declared_operations(self):
        (self.root / 'output').mkdir()
        (self.root / 'scratch').mkdir()
        operations = self.root / 'output/operations.json'
        write_json(operations, self.log)
        declared_log = self.root / 'scratch/declared-log.json'
        write_json(declared_log, self.log)
        self.data['operations_path'] = 'scratch/declared-log.json'
        write_json(self.input, self.data)
        for target in (self.input, operations, declared_log):
            with self.subTest(target=target):
                original = target.read_bytes()
                with self.assertRaisesRegex(ValueError, 'REVERSE_AUDIT_REPORT_UNSAFE'):
                    write_inventory_report(self.input, operations, target)
                self.assertEqual(target.read_bytes(), original)

    def test_report_cannot_overwrite_declared_baseline_pdf_or_any_material_role(self):
        (self.root / 'scratch').mkdir()
        for field in ('baseline_path', 'original_pdf_path', 'historical', 'notes', 'financial', 'other'):
            with self.subTest(field=field):
                target = self.root / 'scratch/source.json'
                raw = b'Protected source bytes, even when its declared suffix is invalid.'
                target.write_bytes(raw)
                data = dict(self.data)
                if field.endswith('_path'):
                    data[field] = 'scratch/source.json'
                else:
                    data['materials'] = [*self.data['materials'], {'role': field, 'path': 'scratch/source.json'}]
                write_json(self.input, data)
                with self.assertRaisesRegex(ValueError, 'REVERSE_AUDIT_REPORT_UNSAFE'):
                    write_inventory_report(self.input, None, target)
                self.assertEqual(target.read_bytes(), raw)

    def test_hardlinked_report_and_traversal_are_rejected_without_changing_sources(self):
        (self.root / 'scratch').mkdir()
        hardlink = self.root / 'scratch/linked.json'
        original = self.xlsx.read_bytes()
        os.link(self.xlsx, hardlink)
        for target in (hardlink, self.root / 'scratch/../report.json', self.root.parent / 'outside.json'):
            with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'REVERSE_AUDIT_REPORT_UNSAFE'):
                write_inventory_report(self.input, None, target)
        self.assertEqual(self.xlsx.read_bytes(), original)

    def test_symbolic_report_and_parent_are_rejected(self):
        (self.root / 'scratch').mkdir()
        (self.root / 'output').mkdir()
        if os.name != 'nt':
            link = self.root / 'scratch/link.json'
            link.symlink_to(self.xlsx)
            parent = self.root / 'scratch/linked-parent'
            parent.symlink_to(self.root / 'output', target_is_directory=True)
            for target in (link, parent / 'report.json'):
                with self.subTest(target=target), self.assertRaisesRegex(ValueError, 'REVERSE_AUDIT_REPORT_UNSAFE'):
                    write_inventory_report(self.input, None, target)
        else:
            original = Path.is_symlink
            for blocked in (self.root / 'scratch', self.root / 'scratch/link.json'):
                with patch.object(Path, 'is_symlink', lambda p: p == blocked or original(p)):
                    with self.assertRaisesRegex(ValueError, 'REVERSE_AUDIT_REPORT_UNSAFE'):
                        write_inventory_report(self.input, None, self.root / 'scratch/link.json')

    def test_report_destination_is_rechecked_after_inventory(self):
        from bondbuddy_file_authoring import reverse_audit
        (self.root / 'scratch').mkdir()
        destination = self.root / 'scratch/report.json'
        original_inventory = reverse_audit.inventory
        source_bytes = self.source.read_bytes()
        def link_destination(*args):
            result = original_inventory(*args)
            os.link(self.source, destination)
            return result
        with patch.object(reverse_audit, 'inventory', link_destination):
            with self.assertRaisesRegex(ValueError, 'REVERSE_AUDIT_REPORT_UNSAFE'):
                write_inventory_report(self.input, None, destination)
        self.assertEqual(self.source.read_bytes(), source_bytes)

    def test_cli_normal_scratch_report_preserves_input_and_operations(self):
        (self.root / 'scratch').mkdir()
        (self.root / 'output').mkdir()
        operations = self.root / 'output/operations.json'
        write_json(operations, self.log)
        source_paths = [self.input, self.source, self.xlsx, operations]
        originals = {p: p.read_bytes() for p in source_paths}
        report = self.root / 'scratch/report.json'
        base = [sys.executable, '-m', 'bondbuddy_file_authoring.reverse_audit', '--input', str(self.input),
                '--operations', str(operations), '--report']
        rejected = subprocess.run([*base, str(operations)], capture_output=True, encoding='utf-8', timeout=30)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('REVERSE_AUDIT_REPORT_UNSAFE', rejected.stderr)
        run = subprocess.run([*base, str(report)], capture_output=True, encoding='utf-8', timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['financial_acceptance'], 'not_run')
        self.assertEqual(json.loads(report.read_text(encoding='utf-8'))['status'], 'needs_review')
        self.assertEqual({p: p.read_bytes() for p in source_paths}, originals)


if __name__ == '__main__':
    unittest.main()
