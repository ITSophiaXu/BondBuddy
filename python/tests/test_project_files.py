import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from bondbuddy_file_authoring.project_files import inspect, patch, validate_links, table_layout
from bondbuddy_file_authoring.word_patch import xml, q


class ProjectFilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / 'source.docx'
        d = Document()
        d.add_heading('发行安排', 1)
        d.add_paragraph('本次发行规模为10亿元。')
        table = d.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '2024年度'
        table.cell(0, 1).text = '10亿元'
        table.cell(1, 0).text = '2025年度'
        table.cell(1, 1).text = '10亿元'
        d.save(self.path)
        self.snapshot = inspect(self.path)

    def edit(self, span='p1'):
        return dict(id='f1', target_span_id=span, original='10亿元', replacement='12亿元',
                    reason='按本期发行规模更新', source_quote='本次发行规模为12亿元。', source_location='发行安排 / 段落 2')

    def request(self, edits):
        return dict(target_sha256=self.snapshot['sha256'], source_filename='募集说明书V2.docx', edits=edits)

    def test_exact_paragraph_does_not_replace_same_amount_in_other_periods(self):
        out = self.root / 'out'
        patch(self.path, self.request([self.edit()]), out)
        after = inspect(out / 'clean.docx')
        self.assertEqual(after['spans'][1]['text'], '本次发行规模为12亿元。')
        self.assertEqual(sum(s['text'] == '10亿元' for s in after['spans']), 2)
        with ZipFile(out / 'revision.docx') as z:
            root = xml(z.read('word/document.xml'))
            self.assertTrue(list(root.iter(q('ins'))))
            self.assertTrue(list(root.iter(q('del'))))
            self.assertIn('募集说明书V2.docx', z.read('word/comments.xml').decode())
        with ZipFile(out / 'clean.docx') as z:
            self.assertNotIn('word/comments.xml', z.namelist())
            self.assertEqual(len(list(xml(z.read('word/document.xml')).iter(q('tbl')))), 1)

    def test_hash_tampering_and_overlapping_edits_rejected(self):
        bad = self.request([self.edit()])
        bad['target_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'INPUT_REVISION_CONFLICT'):
            patch(self.path, bad, self.root / 'bad')
        other = {**self.edit(), 'id': 'f2', 'replacement': '13亿元'}
        with self.assertRaisesRegex(ValueError, 'FILE_EDITS_OVERLAP'):
            patch(self.path, self.request([self.edit(), other]), self.root / 'overlap')

    def test_uncertain_findings_are_comments_without_text_changes(self):
        request = self.request([self.edit()])
        request['manual_findings'] = [dict(target_span_id='p2', original='2024年度',
            reason='缺少2024年审计报告，请补充。', source_quote='')]
        output = self.root / 'comments'
        patch(self.path, request, output)
        self.assertEqual(inspect(output / 'clean.docx')['spans'][2]['text'], '2024年度')
        with ZipFile(output / 'revision.docx') as z:
            comments = z.read('word/comments.xml').decode()
            self.assertIn('需人工确认（原文未修改）', comments)
            self.assertIn('缺少2024年审计报告', comments)

    def test_source_links_must_match_both_pinned_texts(self):
        link = dict(source_span_id='p1', source_quote='本次发行规模为10亿元。', target_span_id='p1', target_quote='10亿元')
        result = validate_links(self.snapshot, self.snapshot, [link, {**link, 'source_quote': '不存在的依据'}])
        self.assertEqual(len(result['links']), 1)
        self.assertEqual(result['links'][0]['source_sha256'], self.snapshot['sha256'])
        self.assertEqual(len(result['unresolved']), 1)

    def test_table_locations_distinguish_rows(self):
        amounts = [s for s in self.snapshot['spans'] if s['text'] == '10亿元']
        self.assertNotEqual(amounts[0]['location'], amounts[1]['location'])
        self.assertIn('行 2', amounts[1]['location'])



    def full_width_document(self):
        d = Document()
        d.add_paragraph('财务情况分析。' * 20)
        t = d.add_table(rows=3, cols=2)
        cell = t.cell(0, 0).merge(t.cell(0, 1))
        cell.text = '报告期关联往来明细'
        cell.add_paragraph('单位：万元')
        t.cell(1, 0).text = '年度'
        t.cell(1, 1).text = '金额'
        t.cell(2, 0).text = '2025'
        t.cell(2, 1).text = '100'
        return d, t, cell

    def test_private_full_width_layout_preserves_the_versioned_text_snapshot(self):
        d, _, _ = self.full_width_document()
        d.save(self.path)
        before = inspect(self.path, complete=True)
        proof = table_layout(self.path)
        expected = [s['id'] for s in before['spans'] if s['text'] in ('报告期关联往来明细', '单位：万元')]
        self.assertEqual(len(expected), 2)
        self.assertEqual(proof['full_width_span_ids'], expected)
        self.assertEqual(proof['sha256'], before['sha256'])
        self.assertEqual(inspect(self.path, complete=True), before)
        self.assertTrue(all(set(s) == {'id', 'text', 'location', 'sha256'} for s in before['spans']))

    def test_ordinary_and_effectively_single_column_tables_never_get_a_layout_exception(self):
        self.assertEqual(table_layout(self.path)['full_width_span_ids'], [])
        for all_merged in (False, True):
            d = Document()
            t = d.add_table(rows=2, cols=2 if all_merged else 1)
            for i, row in enumerate(t.rows):
                cell = row.cells[0].merge(row.cells[1]) if all_merged else row.cells[0]
                cell.text = f'数据第{i + 1}行100万元'
            d.save(self.path)
            self.assertEqual(table_layout(self.path)['full_width_span_ids'], [])

    def test_ambiguous_or_nontext_full_width_rows_stay_on_the_strict_cell_path(self):
        from docx.oxml import OxmlElement
        for case in ('vertical', 'offset', 'missing_grid', 'wrong_span', 'nested', 'drawing'):
            with self.subTest(case=case):
                d, table, cell = self.full_width_document()
                if case == 'vertical':
                    node = OxmlElement('w:vMerge'); node.set(q('val'), 'restart')
                    cell._tc.get_or_add_tcPr().append(node)
                elif case == 'offset':
                    node = OxmlElement('w:gridBefore'); node.set(q('val'), '1')
                    cell._tc.getparent().get_or_add_trPr().append(node)
                elif case == 'missing_grid':
                    table._tbl.remove(table._tbl.find(q('tblGrid')))
                elif case == 'wrong_span':
                    cell._tc.get_or_add_tcPr().find(q('gridSpan')).set(q('val'), '3')
                elif case == 'nested':
                    cell.add_table(rows=1, cols=1).cell(0, 0).text = '嵌套明细'
                else:
                    cell.paragraphs[0].add_run()._r.append(OxmlElement('w:drawing'))
                d.save(self.path)
                self.assertEqual(table_layout(self.path)['full_width_span_ids'], [])


if __name__ == '__main__':
    unittest.main()
