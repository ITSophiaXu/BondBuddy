"""Synthetic invariants for source-bound Word edits, not a business acceptance."""
import copy
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.shared import Inches, Pt
from lxml import etree as ET

from bondbuddy_file_authoring.check import package, resolve_revisions
from bondbuddy_file_authoring.fixed_edit import Editor, empty_log, finalize, load_input, write_json
from bondbuddy_file_authoring.format_diff import audit, canonical
from bondbuddy_file_authoring.template_manifest import build_manifest, node_text, sha
from bondbuddy_file_authoring.word_patch import paragraph_text, q, serialized, xml


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


if __name__ == '__main__':
    unittest.main()
