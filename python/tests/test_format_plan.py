"""Synthetic layout/style regressions; these do not sign visual/business review."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.style import WD_STYLE_TYPE
from docx.shared import Pt
from lxml import etree as ET

from bondbuddy_file_authoring.check import package, resolve_revisions
from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.format_diff import audit, canonical
from bondbuddy_file_authoring.format_plan import restore_absent_property_shells
from bondbuddy_file_authoring.template_manifest import build_nodes, sha
from bondbuddy_file_authoring.word_patch import paragraph_text, q, serialized, xml


class FormatPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        self.input = self.root / 'input.json'
        self.log_path = self.root / 'operations.json'
        self.author = 'Synthetic-format-review'

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, rows=None, caption=True):
        doc = Document()
        doc.add_paragraph('正文原样保留。')
        if caption:
            doc.add_paragraph('表1-1 合成报表')
            doc.add_paragraph('单位：万元')
        table = doc.add_table(rows=1, cols=3)
        table.style = 'Table Grid'
        for cell, text in zip(table.rows[0].cells, ['项目', '2025年9月末', '2024年末']):
            cell.text = text
        for values in rows or [['明细甲', '', '100.00'], ['明细乙', '200.00', '300.00']]:
            row = table.add_row()
            for index, (cell, text) in enumerate(zip(row.cells, values)):
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if index else WD_ALIGN_PARAGRAPH.LEFT
                run = p.add_run(text)
                run.font.name = 'Times New Roman'
                run.font.size = Pt(10.5)
                run.bold = False
                if index and not text:
                    # Hidden inherited styling is invisible until a later fill.
                    run.bold = True
                    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        doc.save(self.source)
        return doc

    def bind(self):
        raw = self.source.read_bytes()
        self.data = {'input_hash': 'b' * 64, 'baseline_path': 'source.docx',
                     'baseline_sha256': sha(raw), 'revision_author': self.author,
                     'revision_date': '2026-11-03T00:00:00Z'}
        write_json(self.input, self.data)
        self.log = empty_log(self.data, raw)
        self.nodes = build_nodes({'word/document.xml': xml(package(self.source)['word/document.xml'])})

    def node_id(self, row=None, col=None, text=None, tag='p'):
        if row is not None:
            # Locate by source coordinates, independent of the editor's op IDs.
            root = xml(package(self.source)['word/document.xml'])
            node = root.find('.//' + q('tbl')).findall(q('tr'))[row]
            if col is not None:
                node = node.findall(q('tc'))[col].find(q('p'))
            nodes = build_nodes({'word/document.xml': root})
            return next(key for key, (_, value) in nodes.items() if value is node)
        return next(key for key, (_, node) in self.nodes.items()
                    if node.tag == q(tag) and paragraph_text(node) == text)

    def fill(self, value='0.00', row=1, col=1):
        return {'id': 'fill', 'kind': 'replace_text', 'node_id': self.node_id(row, col),
                'before': '', 'after': value}

    def generate(self, operations, output='out'):
        self.log['operations'] = operations
        write_json(self.log_path, self.log)
        out = self.root / output
        receipt = finalize(self.input, self.log_path, out)
        report = json.loads((out / 'format-report.json').read_text(encoding='utf-8'))
        self.assertEqual(receipt['format_status'], 'passed', report)
        plan = json.loads((out / 'format-plan.json').read_text(encoding='utf-8'))
        self.assert_pair(out, plan)
        return out, plan

    def assert_pair(self, out, plan):
        tracked = xml(package(out / 'tracked.docx')['word/document.xml'])
        clean = xml(package(out / 'clean.docx')['word/document.xml'])
        self.assertEqual(canonical(resolve_revisions(copy.deepcopy(tracked), True)), canonical(clean))
        rejected = resolve_revisions(copy.deepcopy(tracked), False, self.author)
        restore_absent_property_shells(rejected, plan, 'word/document.xml')
        self.assertEqual(canonical(rejected), canonical(xml(package(self.source)['word/document.xml'])))

    def paragraph(self, out, row=1, col=1, variant='clean'):
        root = xml(package(out / (variant + '.docx'))['word/document.xml'])
        return root.find('.//' + q('tbl')).findall(q('tr'))[row].findall(q('tc'))[col].find(q('p'))

    def assert_visible_regular(self, p):
        self.assertEqual(p.find(q('pPr') + '/' + q('jc')).get(q('val')), 'right')
        runs = [run for run in p.iter(q('r')) if any(t.text for t in run.findall(q('t')))]
        self.assertTrue(runs)
        for run in runs:
            self.assertEqual(run.find(q('rPr') + '/' + q('b')).get(q('val')), '0')
            self.assertEqual(run.find(q('rPr') + '/' + q('sz')).get(q('val')), '21')
            self.assertEqual(run.find(q('rPr') + '/' + q('rFonts')).get(q('ascii')), 'Times New Roman')

    def rewrite(self, path, change):
        parts = package(path)
        root = xml(parts['word/document.xml'])
        change(root)
        parts['word/document.xml'] = serialized(root)
        with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
            for name, raw in parts.items():
                archive.writestr(name, raw)

    def test_same_row_visible_donor_overrides_invisible_bold_and_left_alignment(self):
        self.fixture(); self.bind()
        out, plan = self.generate([self.fill()])
        self.assertEqual(len(plan['numeric_fonts']), 1)
        self.assertEqual(plan['numeric_fonts'][0]['reference_reason'], 'same_row_visible_period')
        self.assert_visible_regular(self.paragraph(out))
        self.assert_visible_regular(self.paragraph(out, variant='tracked'))

    def test_summary_row_uses_its_own_visible_bold_peer(self):
        doc = self.fixture([['资产总计', '', '900.00'], ['明细乙', '200.00', '300.00']])
        doc.tables[0].cell(1, 2).paragraphs[0].runs[0].bold = True
        doc.save(self.source); self.bind()
        out, plan = self.generate([self.fill('950.00')])
        run = next(r for r in self.paragraph(out).iter(q('r')) if r.find(q('t')) is not None and r.find(q('t')).text)
        self.assertNotEqual(run.find(q('rPr') + '/' + q('b')).get(q('val')), '0')
        self.assertEqual(plan['numeric_fonts'][0]['reference_reason'], 'same_row_visible_period')

    def test_whitespace_and_nbsp_fills_use_visible_donor_and_reject_exact_source(self):
        for index, whitespace in enumerate([' ', '\u00a0', ' \u00a0 ']):
            with self.subTest(whitespace=repr(whitespace)):
                doc = self.fixture()
                doc.tables[0].cell(1, 1).paragraphs[0].runs[0].text = whitespace
                doc.save(self.source); self.bind()
                operation = self.fill()
                operation['before'] = whitespace
                out, plan = self.generate([operation], str(index))
                self.assertEqual(len(plan['numeric_fonts']), 1)
                self.assert_visible_regular(self.paragraph(out))
                rejected = resolve_revisions(xml(package(out / 'tracked.docx')['word/document.xml']), False, self.author)
                restore_absent_property_shells(rejected, plan, 'word/document.xml')
                p = rejected.find('.//' + q('tbl')).findall(q('tr'))[1].findall(q('tc'))[1].find(q('p'))
                self.assertEqual(paragraph_text(p), whitespace)

    def test_empty_row_uses_two_agreeing_visible_detail_rows_in_same_column(self):
        self.fixture([['明细甲', '10.00', '11.00'], ['空白明细', '', ''], ['明细乙', '20.00', '21.00']]); self.bind()
        out, plan = self.generate([self.fill(row=2)])
        self.assertEqual(plan['numeric_fonts'][0]['reference_reason'], 'same_column_two_agreeing_detail_rows')
        self.assertGreaterEqual(len(plan['numeric_fonts'][0]['corroborating_node_ids']), 2)
        self.assert_visible_regular(self.paragraph(out, row=2))

    def test_no_reference_or_boundary_does_not_guess(self):
        cases = [
            [['空白明细', '', '']],
            [['明细甲', '10.00', '11.00'], ['资产合计', '', ''], ['明细乙', '20.00', '21.00']],
            [['明细甲', '10.00', '11.00'], ['一、资产', '', ''], ['空白明细', '', ''], ['二、负债', '', ''], ['明细乙', '20.00', '21.00']],
        ]
        for index, rows in enumerate(cases):
            with self.subTest(index=index):
                self.fixture(rows); self.bind()
                row = next(i + 1 for i, values in enumerate(rows) if values[0] in {'空白明细', '资产合计'})
                out, plan = self.generate([self.fill(row=row)], str(index))
                self.assertEqual(plan['numeric_fonts'], [])
                self.assertEqual(len(plan['numeric_references_unresolved']), 1)
                self.assertEqual(plan['numeric_references_unresolved'][0]['action'], 'preserve_source_format_without_guessing')
                self.assertEqual(self.paragraph(out, row).find(q('pPr') + '/' + q('jc')).get(q('val')), 'left')

    def test_conflicting_same_column_references_do_not_guess(self):
        doc = self.fixture([['明细甲', '10.00', '11.00'], ['空白明细', '', ''], ['明细乙', '20.00', '21.00']])
        doc.tables[0].cell(3, 1).paragraphs[0].runs[0].italic = True
        doc.save(self.source); self.bind()
        _, plan = self.generate([self.fill(row=2)])
        self.assertEqual(plan['numeric_fonts'], [])
        self.assertEqual(plan['numeric_references_unresolved'][0]['reason'], 'same_column_visible_styles_disagree')

    def test_conflicting_same_row_references_do_not_fall_back(self):
        doc = self.fixture()
        table = doc.tables[0]
        table.add_column(Pt(90))
        table.cell(0, 3).text = '2023年末'
        table.cell(1, 3).text = '90.00'
        table.cell(1, 3).paragraphs[0].runs[0].italic = True
        doc.save(self.source); self.bind()
        _, plan = self.generate([self.fill()])
        self.assertEqual(plan['numeric_fonts'], [])
        self.assertEqual(plan['numeric_references_unresolved'][0]['reason'], 'same_row_visible_styles_disagree')

    def test_ascii_hint_language_equivalence_requires_explicit_matching_fonts(self):
        for kind in ['metadata', 'different_font', 'missing_font', 'paragraph_style', 'rtl', 'cs', 'theme',
                     'matching_pstyle', 'run_style', 'table_style', 'default_rtl', 'default_base']:
            with self.subTest(kind=kind):
                doc = self.fixture()
                table = doc.tables[0]
                table.style = None
                table.add_column(Pt(90))
                table.cell(0, 3).text = '2023年末'
                peer = table.cell(1, 2).paragraphs[0]._p
                copied = copy.deepcopy(peer)
                old = table.cell(1, 3).paragraphs[0]._p
                old.getparent().replace(old, copied)
                run = peer.find(q('r'))
                props = run.find(q('rPr'))
                fonts = props.find(q('rFonts'))
                fonts.set(q('hint'), 'eastAsia')
                ET.SubElement(props, q('lang'), {q('bidi'): 'ar'})
                if kind == 'different_font':
                    fonts.set(q('ascii'), 'Courier New'); fonts.set(q('hAnsi'), 'Courier New')
                elif kind == 'missing_font': props.remove(fonts)
                elif kind == 'paragraph_style': table.cell(1, 1).paragraphs[0].style = 'List Paragraph'
                elif kind in {'rtl', 'cs'}: ET.SubElement(props, q(kind))
                elif kind == 'theme': fonts.set(q('asciiTheme'), 'minorHAnsi')
                elif kind == 'matching_pstyle':
                    for c in table.rows[1].cells[1:]: c.paragraphs[0].style = 'List Paragraph'
                elif kind == 'run_style':
                    for c in table.rows[1].cells[2:]:
                        ET.SubElement(c.paragraphs[0]._p.find(q('r')+'/'+q('rPr')),q('rStyle'),{q('val'):'DefaultParagraphFont'})
                elif kind == 'table_style': table.style = 'Table Grid'
                elif kind == 'default_rtl': ET.SubElement(doc.styles['Normal']._element.get_or_add_rPr(), q('rtl'))
                elif kind == 'default_base':
                    inherited = doc.styles.add_style('Synthetic Base', WD_STYLE_TYPE.PARAGRAPH)
                    doc.styles['Normal'].base_style = inherited
                doc.save(self.source); self.bind()
                out, plan = self.generate([self.fill()], kind)
                if kind == 'metadata':
                    self.assertEqual(len(plan['numeric_fonts']), 1)
                    self.assert_visible_regular(self.paragraph(out))
                    inserted = next(r for r in self.paragraph(out).iter(q('r')) if r.find(q('t')) is not None and r.find(q('t')).text)
                    self.assertEqual(inserted.find(q('rPr') + '/' + q('rFonts')).get(q('hint')), 'eastAsia')
                    self.assertEqual(inserted.find(q('rPr') + '/' + q('lang')).get(q('bidi')), 'ar')
                else:
                    self.assertEqual(plan['numeric_fonts'], [])
                    self.assertTrue(plan['numeric_references_unresolved'])

    def test_non_ascii_digits_are_not_projected_or_used_as_numeric_references(self):
        for index, text in enumerate(['١٢.٣٤', '１２.３４']):
            with self.subTest(text=text):
                self.fixture(); self.bind()
                out, plan = self.generate([self.fill(text)], 'target-' + str(index))
                self.assertEqual(plan['numeric_fonts'], [])
                self.assertEqual(paragraph_text(self.paragraph(out)), text)
                self.fixture([['明细甲', '', text]]); self.bind()
                _, plan = self.generate([self.fill()], 'source-' + str(index))
                self.assertEqual(plan['numeric_fonts'], [])
                self.assertTrue(plan['numeric_references_unresolved'])

    def test_pending_text_and_nonempty_original_numbers_are_not_restyled(self):
        self.fixture(); self.bind()
        out, plan = self.generate([self.fill('待核对'), {'id': 'number', 'kind': 'replace_text',
            'node_id': self.node_id(2, 1), 'before': '200.00', 'after': '220.00'}])
        self.assertEqual(plan['numeric_fonts'], [])
        self.assertEqual(plan['numeric_references_unresolved'], [])
        self.assertEqual(paragraph_text(self.paragraph(out)), '待核对')

    def test_caption_unit_headers_and_first_data_are_bound_without_binding_whole_table(self):
        self.fixture(); self.bind()
        out, _ = self.generate([self.fill()])
        root = xml(package(out / 'clean.docx')['word/document.xml'])
        ps = root.find(q('body')).findall(q('p'))
        for p in ps[1:3]:
            self.assertIsNotNone(p.find(q('pPr') + '/' + q('keepNext')))
        rows = root.find('.//' + q('tbl')).findall(q('tr'))
        self.assertIsNotNone(rows[0].find(q('trPr') + '/' + q('tblHeader')))
        for row in rows[:2]:
            self.assertIsNotNone(row.find(q('trPr') + '/' + q('cantSplit')))
        for p in rows[0].iter(q('p')):
            self.assertIsNotNone(p.find(q('pPr') + '/' + q('keepNext')))
        self.assertFalse(any(p.find(q('pPr') + '/' + q('keepNext')) is not None for row in rows[1:] for p in row.iter(q('p'))))

    def test_consecutive_data_header_flags_cleared_only_after_proven_boundary(self):
        doc = self.fixture()
        for row in doc.tables[0].rows:
            ET.SubElement(row._tr.get_or_add_trPr(), q('tblHeader'))
        doc.save(self.source); self.bind()
        out, _ = self.generate([self.fill()])
        rows = xml(package(out / 'clean.docx')['word/document.xml']).find('.//' + q('tbl')).findall(q('tr'))
        self.assertEqual([r.find(q('trPr') + '/' + q('tblHeader')) is not None for r in rows], [True, False, False])

    def test_two_header_rows_remain_repeatable_and_first_data_is_bound(self):
        self.fixture([['', '金额', '比例'], ['明细甲', '', '1.00'], ['明细乙', '2.00', '3.00']]); self.bind()
        out, plan = self.generate([self.fill(row=2)])
        self.assertEqual(plan['tables'][0]['header_rows'], 2)
        rows = xml(package(out / 'clean.docx')['word/document.xml']).find('.//' + q('tbl')).findall(q('tr'))
        self.assertEqual([r.find(q('trPr') + '/' + q('tblHeader')) is not None for r in rows], [True, True, False, False])
        self.assertIsNotNone(rows[2].find(q('trPr') + '/' + q('cantSplit')))

    def test_header_flag_after_unmarked_gap_is_not_reinterpreted(self):
        doc = self.fixture()
        ET.SubElement(doc.tables[0].rows[2]._tr.get_or_add_trPr(), q('tblHeader'))
        doc.save(self.source); self.bind()
        out, _ = self.generate([self.fill()])
        rows = xml(package(out / 'clean.docx')['word/document.xml']).find('.//' + q('tbl')).findall(q('tr'))
        self.assertIsNotNone(rows[2].find(q('trPr') + '/' + q('tblHeader')))

    def test_caption_with_existing_property_revision_is_left_for_review(self):
        self.fixture()
        def existing(root):
            p = root.find(q('body')).findall(q('p'))[1]
            props = ET.Element(q('pPr')); p.insert(0, props)
            marker = ET.SubElement(props, q('pPrChange'), {q('author'): 'Old author', q('id'): '90'})
            ET.SubElement(marker, q('pPr'))
        self.rewrite(self.source, existing); self.bind()
        # Exact old source property history remains in tracked; accepted clean
        # resolves it normally. The plan does not create nested property revisions.
        out, plan = self.generate([self.fill()])
        self.assertEqual(plan['tables'][0]['status'], 'caption_contains_unsupported_content_no_change')
        self.assertFalse(any('keepNext' in entry['after_xml'] for entry in plan['properties']))

    def test_ambiguous_or_merged_headers_are_unchanged(self):
        for kind in ['ambiguous', 'merged']:
            with self.subTest(kind=kind):
                doc = self.fixture()
                if kind == 'ambiguous': doc.tables[0].cell(0, 1).text = '说明'
                else: doc.tables[0].cell(0, 1).merge(doc.tables[0].cell(0, 2))
                for row in doc.tables[0].rows:
                    ET.SubElement(row._tr.get_or_add_trPr(), q('tblHeader'))
                doc.save(self.source); self.bind()
                out, plan = self.generate([{'id': 'body', 'kind': 'replace_text',
                    'node_id': self.node_id(text='正文原样保留。'), 'before': '正文原样保留。', 'after': '正文更新。'}], kind)
                self.assertEqual(plan['properties'], [])
                self.assertEqual(plan['tables'][0]['status'], 'header_boundary_unresolved_no_change')
                self.assertEqual(canonical(xml(package(self.source)['word/document.xml']).find('.//' + q('tbl'))),
                                 canonical(xml(package(out / 'clean.docx')['word/document.xml']).find('.//' + q('tbl'))))

    def test_cloned_rows_and_clones_of_clones_keep_one_structural_insertion(self):
        self.fixture(); self.bind()
        source_row = self.node_id(row=1)
        out, plan = self.generate([
            {'id': 'first', 'kind': 'insert_row', 'node_id': source_row, 'before': '明细甲\n\n100.00', 'values': ['新增甲', '10.00', '100.00']},
            {'id': 'second', 'kind': 'insert_row', 'node_id': 'op:first:row', 'before': '新增甲\n10.00\n100.00', 'values': ['新增乙', '20.00', '100.00']},
        ])
        self.assertEqual(len(plan['numeric_fonts']), 2)
        for row in [2, 3]: self.assert_visible_regular(self.paragraph(out, row=row))
        root = xml(package(out / 'tracked.docx')['word/document.xml'])
        self.assertEqual(len(root.findall('.//' + q('trPr') + '/' + q('ins'))), 2)
        self.assertFalse(root.findall('.//' + q('ins') + '//' + q('ins')))

    def test_first_inserted_data_row_keeps_its_row_marker(self):
        self.fixture(); self.bind()
        out, _ = self.generate([{'id': 'new', 'kind': 'insert_row', 'node_id': self.node_id(row=1),
            'before': '明细甲\n\n100.00', 'position': 'before', 'values': ['首行', '5.00', '6.00']}])
        root = xml(package(out / 'tracked.docx')['word/document.xml'])
        first_data = root.find('.//' + q('tbl')).findall(q('tr'))[1]
        self.assertIsNotNone(first_data.find(q('trPr') + '/' + q('ins')))
        self.assertIsNotNone(first_data.find(q('trPr') + '/' + q('cantSplit')))
        self.assertIsNone(first_data.find(q('trPr') + '/' + q('trPrChange')))

    def test_absent_and_preexisting_empty_property_shells_round_trip_distinctly(self):
        doc = self.fixture()
        doc.paragraphs[2]._p.get_or_add_pPr()
        doc.save(self.source); self.bind()
        out, plan = self.generate([self.fill()])
        entries = [entry for entry in plan['properties'] if entry['node_id'] in {
            self.node_id(text='表1-1 合成报表'), self.node_id(text='单位：万元')}]
        self.assertEqual(sorted(entry['before_present'] for entry in entries), [False, True])
        # Unbound audits cannot trust a supplied format plan or normalize shells.
        self.assertNotEqual(audit(self.source, out / 'tracked.docx', self.author)['status'], 'passed')

    def test_unrelated_property_and_property_history_tampering_fail(self):
        self.fixture(); self.bind()
        for kind in ['unrelated', 'history']:
            with self.subTest(kind=kind):
                out, _ = self.generate([self.fill()], kind)
                def change(root):
                    if kind == 'history':
                        old = root.find('.//' + q('pPrChange') + '/' + q('pPr'))
                        ET.SubElement(old, q('spacing'), {q('after'): '999'})
                    else:
                        p = root.find(q('body')).find(q('p'))
                        props = ET.Element(q('pPr')); p.insert(0, props)
                        ET.SubElement(props, q('spacing'), {q('after'): '999'})
                self.rewrite(out / 'tracked.docx', change)
                write_json(out / 'format-plan.json', {'properties': [], 'status': 'passed'})
                report = audit(self.source, out / 'tracked.docx', self.author, self.input, self.log_path)
                self.assertNotEqual(report['status'], 'passed', report)

    def test_format_plan_and_delivered_bytes_replay_deterministically(self):
        self.fixture(); self.bind()
        first, _ = self.generate([self.fill()], 'one')
        second, _ = self.generate([self.fill()], 'two')
        for name in ['format-plan.json', 'tracked.docx', 'clean.docx']:
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)


if __name__ == '__main__':
    unittest.main()
