from __future__ import annotations

import hashlib
import tempfile
import unittest
import zipfile
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
from bondbuddy_document_parser.parser import _parse_docx
from bondbuddy_word_delivery.writer import Q, add_comments, build, visible


class HistoricalWordWriterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        self.tracked = self.root / 'tracked.docx'
        self.clean = self.root / 'clean.docx'
        doc = Document()
        doc.styles['Normal'].font.name = 'Arial Unicode MS'
        doc.styles['Normal'].element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'Arial Unicode MS')
        doc.add_paragraph('未改动的风险说明。')
        doc.add_paragraph('截至2024年末净资产100万元。')
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2024年度'
        table.cell(1, 0).text = '净资产'
        table.cell(1, 1).text = '100'
        doc.save(self.source)

    def tearDown(self):
        self.temp.cleanup()

    def plan(self):
        records, _, _ = _parse_docx(self.source, {})
        previews = [{'recordId': row['record_id'], 'before': row['literal_quote'], 'after': row['literal_quote'],
                     'locator': row['locator'], 'formatting': row['formatting']} for row in records]
        paragraph = previews[1]
        paragraph['after'] = paragraph['before'].replace('100', '120')
        cell_0 = next(row for row in previews if row['before'] == '2024年度')
        cell_1 = next(row for row in previews if row['before'] == '100')
        return {'source': {'contentHash': hashlib.sha256(self.source.read_bytes()).hexdigest(), 'format': 'docx_effective'},
                'deliverable': False, 'baselineHash': 'a' * 64, 'planHash': 'b' * 64,
                '_delivery_date': '2026-09-25T13:00:00Z', 'textPreview': previews,
                'replacements': [{'recordId': paragraph['recordId'], 'locator': paragraph['locator'],
                                  'start': paragraph['before'].index('100'), 'end': paragraph['before'].index('100') + 3,
                                  'before': '100', 'after': '120'}],
                'columns': [{'table': 1, 'afterColumn': 2, 'requiresPhysicalGridValidation': True,
                             'cells': [{'row': 1, 'anchorRecordId': cell_0['recordId'], 'before': '', 'after': '2025年1-9月'},
                                       {'row': 2, 'anchorRecordId': cell_1['recordId'], 'before': '', 'after': '120'}]}],
                'reviewNotes': [{'recordId': previews[0]['recordId'], 'message': '待人工确认：缺少说明材料'}]}

    def xml(self, path, name='word/document.xml'):
        with zipfile.ZipFile(path) as archive:
            return etree.fromstring(archive.read(name))

    def rewrite_source(self, change):
        with zipfile.ZipFile(self.source) as archive:
            parts = {name: archive.read(name) for name in archive.namelist()}
        root = etree.fromstring(parts['word/document.xml'])
        change(parts, root)
        parts['word/document.xml'] = etree.tostring(root)
        with zipfile.ZipFile(self.source, 'w') as archive:
            for name, data in parts.items():
                archive.writestr(name, data)

    def test_revision_clean_column_comments_and_source_immutable(self):
        original = self.source.read_bytes()
        result = build(self.source, self.plan(), self.tracked, self.clean)
        tracked = self.xml(self.tracked)
        clean = self.xml(self.clean)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(result['replacements'], 1)
        self.assertEqual(len(tracked.findall('.//' + Q('del'))), 1)
        self.assertGreaterEqual(len(tracked.findall('.//' + Q('ins'))), 3)
        self.assertEqual(len(tracked.findall('.//' + Q('cellIns'))), 2)
        self.assertEqual(len(clean.findall('.//' + Q('ins'))), 0)
        self.assertEqual(len(clean.findall('.//' + Q('del'))), 0)
        self.assertEqual(len(clean.findall('.//' + Q('cellIns'))), 0)
        self.assertIn('120万元', visible(clean))
        self.assertEqual(len(clean.findall('.//' + Q('gridCol'))), 3)
        self.assertEqual(len(clean.findall('.//' + Q('commentReference'))), 1)
        self.assertIn('【待人工确认】', visible(clean))
        self.assertEqual(len(self.xml(self.clean, 'word/comments.xml').findall(Q('comment'))), 1)
        second_tracked, second_clean, second_baseline = (self.root / name for name in ('tracked-again.docx', 'clean-again.docx', 'baseline-again.docx'))
        build(self.source, self.plan(), second_tracked, second_clean, second_baseline)
        self.assertEqual(self.tracked.read_bytes(), second_tracked.read_bytes())
        self.assertEqual(self.clean.read_bytes(), second_clean.read_bytes())

    def test_existing_comment_on_changed_paragraph_fails_closed(self):
        def edit(_parts, root):
            paragraph = root.find(Q('body')).findall(Q('p'))[1]
            etree.SubElement(paragraph, Q('commentRangeStart')).set(Q('id'), '0')
            etree.SubElement(paragraph, Q('commentRangeEnd')).set(Q('id'), '0')
            etree.SubElement(etree.SubElement(paragraph, Q('r')), Q('commentReference')).set(Q('id'), '0')
        self.rewrite_source(edit)
        plan = self.plan()
        with self.assertRaisesRegex(ValueError, 'WORD_EDITED_PARAGRAPH_COMPLEX'):
            build(self.source, plan, self.tracked, self.clean)

    def test_old_revisions_become_effective_baseline(self):
        def edit(_parts, root):
            paragraph = root.find(Q('body')).findall(Q('p'))[0]
            deleted = etree.SubElement(paragraph, Q('del'))
            deleted.set(Q('id'), '1')
            etree.SubElement(etree.SubElement(deleted, Q('r')), Q('delText')).text = '旧删除'
            inserted = etree.SubElement(paragraph, Q('ins'))
            inserted.set(Q('id'), '2')
            etree.SubElement(etree.SubElement(inserted, Q('r')), Q('t')).text = '旧新增'
        self.rewrite_source(edit)
        baseline = self.root / 'baseline.docx'
        build(self.source, self.plan(), self.tracked, self.clean, baseline)
        self.assertIn('旧新增', visible(self.xml(baseline)))
        self.assertNotIn('旧删除', visible(self.xml(baseline)))
        self.assertEqual(len(self.xml(baseline).findall('.//' + Q('ins'))), 0)
        self.assertEqual(len(self.xml(self.tracked).findall('.//' + Q('ins'))), 4)
        self.assertEqual(len(self.xml(self.tracked).findall('.//' + Q('del'))), 1)

    def test_existing_comment_remains_and_new_note_gets_separate_id(self):
        def edit(parts, root):
            paragraph = root.find(Q('body')).findall(Q('p'))[0]
            add_comments(parts, root, [{'recordId': 'old', 'message': '原有普通批注'}], {'old': paragraph})
        self.rewrite_source(edit)
        build(self.source, self.plan(), self.tracked, self.clean)
        for path in (self.tracked, self.clean):
            ids = [node.get(Q('id')) for node in self.xml(path).findall('.//' + Q('commentReference'))]
            self.assertEqual(ids, ['0', '1'])
            comments = self.xml(path, 'word/comments.xml')
            self.assertEqual([node.get(Q('id')) for node in comments.findall(Q('comment'))], ['0', '1'])
            self.assertIn('原有普通批注', visible(comments))

    def test_unedited_merged_table_keeps_parser_anchors(self):
        doc = Document(self.source)
        merged = doc.add_table(rows=1, cols=3)
        merged.cell(0, 0).merge(merged.cell(0, 1)).text = '合并标题'
        merged.cell(0, 2).text = '末列'
        doc.save(self.source)
        build(self.source, self.plan(), self.tracked, self.clean)
        self.assertIn('合并标题', visible(self.xml(self.clean)))
        self.assertIn('末列', visible(self.xml(self.clean)))


if __name__ == '__main__':
    unittest.main()
