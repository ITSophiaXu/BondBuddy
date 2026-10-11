import tempfile
import unittest
import zipfile
from pathlib import Path
from docx import Document
from lxml import etree
from bondbuddy_word_delivery.review import annotate, write_report, strip_comment_location_prefix, is_source_only_comment, _remove_comment_references
from bondbuddy_word_delivery.writer import Q, W, parse_xml, document_signature


class ReviewWordTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document()
        p = doc.add_paragraph()
        p.add_run('合计').bold = True
        p.add_run('金额为100万元。')
        doc.add_table(rows=1, cols=1).cell(0, 0).text = '期末余额90万元'
        doc.save(self.source)

    def report(self, quote='100万元', locator='docx:p0001'):
        target = {'material_id': 'source', 'material_version': 1, 'material_sha256': 'a'*64, 'quote': quote, 'locator': {'stable_ref': locator}}
        return {'report_id': 'synthetic-report', 'run_id': 'synthetic-run', 'version': 1, 'input_revision': 1, 'scope': {'mode': 'full_review', 'finding_ids': []},
                'source_material': {'material_id': 'source', 'material_version': 1, 'sha256': 'a'*64}, 'created_at': '2026-10-02T00:00:00Z', 'coverage': [], 'limitations': [],
                'findings': [{'finding_id': 'F001', 'dimension': 'financial', 'severity': 'P1', 'title': '合计不一致', 'description': '核对合计与原表', 'conclusion': 'error', 'check_status': 'rechecked',
                              'origin_report_id': 'synthetic-report', 'target_refs': [target], 'evidence_refs': [], 'limitations': []}]}

    def xml(self, path, name='word/document.xml'):
        with zipfile.ZipFile(path) as z:
            return parse_xml(z.read(name))

    def test_native_comment_is_precisely_anchored_without_changing_text_or_bold(self):
        out = self.root / 'comments.docx'
        placed, missing = annotate(self.source, out, self.report())
        self.assertEqual(len(placed), 1)
        self.assertEqual(missing, [])
        before, after = self.xml(self.source), self.xml(out)
        self.assertEqual(document_signature(before), document_signature(after))
        para = after.find('.//' + Q('p'))
        selected, on = '', False
        for node in para:
            if node.tag == Q('commentRangeStart'):
                on = True
            elif node.tag == Q('commentRangeEnd'):
                on = False
            elif on:
                selected += ''.join(n.text or '' for n in node.iter(Q('t')))
        self.assertEqual(selected, '100万元')
        self.assertIsNotNone(para.find('.//' + Q('b')))
        comment = self.xml(out, 'word/comments.xml')[0]
        self.assertEqual(comment.get(Q('author')), 'BondBuddy')
        self.assertEqual(comment.get(Q('date')), '2026-10-02T00:00:00Z')

    def test_existing_comments_and_two_findings_same_location_survive_reopen(self):
        first, second = self.root / 'first.docx', self.root / 'second.docx'
        annotate(self.source, first, self.report())
        report = self.report()
        duplicate = {**report['findings'][0], 'finding_id': 'F002'}
        report['findings'].append(duplicate)
        placed, missing = annotate(first, second, report)
        self.assertEqual((len(placed), len(missing)), (2, 0))
        comments = self.xml(second, 'word/comments.xml')
        self.assertEqual(len(comments), 3)
        self.assertEqual(len({c.get(Q('id')) for c in comments}), 3)
        self.assertEqual(document_signature(self.xml(first)), document_signature(self.xml(second)))
        self.assertIn('100万元', Document(second).paragraphs[0].text)

    def test_old_bondbuddy_prefix_is_trimmed_only_in_the_review_copy(self):
        doc = Document(self.source)
        prefix = '原文件：合成募集书.docx；正文位置285；'
        substance = '合成函〔2025〕324号为历史文件；请核实本次发行的有效期。'
        generated = doc.add_comment(doc.paragraphs[0].runs, author='BondBuddy-1c736c8976a1')
        generated.paragraphs[0].add_run(prefix[:15]).bold = True
        generated.paragraphs[0].add_run(prefix[15:] + substance).italic = True
        doc.add_comment(doc.paragraphs[0].runs, text=prefix + substance, author='人工复核人')
        doc.save(self.source)
        before = self.source.read_bytes()
        before_comments = self.xml(self.source, 'word/comments.xml')
        out = self.root / 'trimmed.docx'
        annotate(self.source, out, self.report())
        comments = self.xml(out, 'word/comments.xml')
        self.assertEqual(''.join(comments[0].itertext()), substance)
        self.assertEqual(dict(comments[0].attrib), dict(before_comments[0].attrib))
        self.assertIsNotNone(comments[0].find('.//' + Q('i')))
        self.assertEqual(etree.tostring(comments[1]), etree.tostring(before_comments[1]))
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(document_signature(self.xml(self.source)), document_signature(self.xml(out)))

    def test_prefix_cleanup_does_not_remove_substantive_locations(self):
        for text in ['根据合成报表第8页，金额应为120万元。', '正文位置285存在重复披露，请删除重复内容。',
                     '合成函〔2025〕324号第3条要求补证。']:
            self.assertEqual(strip_comment_location_prefix(text), text)
        self.assertEqual(strip_comment_location_prefix('原文件：合成.docx；正文位置285；'), '')
        self.assertEqual(strip_comment_location_prefix('正文位置 8 的表格 · 第 2 行 · 第 3 列；金额应为120万元。'), '金额应为120万元。')
        self.assertEqual(strip_comment_location_prefix('[正文位置 285]\n请补证。'), '请补证。')

    def spreadsheet_note(self):
        return ('原文件：合成报表20250930-1.14.xlsx；工作表《01合并资产负债表》D128、D78；'
                '合成建设投资集团有限公司；2025年9月30日期末；合并口径；人民币元；计算：资产负债率=负债÷资产×100%。 '
                '原文件：合成报表20250930-1.14.xlsx；工作表《02合并利润表》D44；'
                '合成建设投资集团有限公司；2025年1—9月累计；合并口径；人民币元；计算：原值除以10,000，披露为万元、四舍五入保留两位。 ')

    def test_spreadsheet_pdf_and_repeated_location_prefixes_keep_the_problem(self):
        substance = '资产负债率应为60%，原文50%；按负债60÷资产100×100%计算，请更正。'
        for prefix in [
            '原文件：合成报表.xlsx；工作表《01合并资产负债表》D128、D78；',
            '原文件: 合成报表.XLSM; 工作表 "资产表" · 单元格 $D$78:$D$128; ',
            '原文件：合成报表.xls；工作表《利润表》D44；原文件：合成.docx；正文位置285；',
            '原文件：合成.pdf；物理第 8 页；',
        ]:
            with self.subTest(prefix=prefix):
                self.assertEqual(strip_comment_location_prefix(prefix + substance), substance)
        self.assertEqual(strip_comment_location_prefix('工作表《利润表》D44的金额有误，应为120万元。'),
                         '工作表《利润表》D44的金额有误，应为120万元。')

    def test_source_only_classifier_does_not_drop_findings_or_computational_evidence(self):
        self.assertTrue(is_source_only_comment(self.spreadsheet_note() * 2))
        for text in [self.spreadsheet_note() + '但本次口径不一致，请核实。',
                     self.spreadsheet_note().replace('资产负债率=负债÷资产×100%', '原文50%，复算60%，差异10个百分点'),
                     '计算：资产负债率=负债÷资产×100%。',
                     '原文件：合成.xlsx；工作表《资产表》D78；金额应为120万元。']:
            self.assertFalse(is_source_only_comment(text), text)

    def test_source_only_generated_notes_are_removed_with_anchors_but_human_notes_survive(self):
        doc = Document(self.source)
        note = self.spreadsheet_note() * 2
        generated = doc.add_comment(doc.paragraphs[0].runs, author='BondBuddy-1c736c8976a1')
        generated.paragraphs[0].add_run(note[:40]).bold = True
        generated.paragraphs[0].add_run(note[40:]).italic = True
        human = doc.add_comment(doc.paragraphs[0].runs, text=note, author='人工复核人')
        locator = '原文件：合成.xlsx；工作表《资产表》D78；'
        substantive = doc.add_comment(doc.paragraphs[0].runs, text=locator + '金额应为120万元，请更正。', author='BondBuddy')
        generated_id, human_id, substantive_id = map(str, [generated.comment_id, human.comment_id, substantive.comment_id])
        doc.save(self.source)
        before = self.source.read_bytes()
        out = self.root / 'source-notes-removed.docx'
        placed, missing = annotate(self.source, out, self.report())
        self.assertEqual((len(placed), len(missing)), (1, 0))
        comments = {c.get(Q('id')): c for c in self.xml(out, 'word/comments.xml')}
        self.assertNotIn(generated_id, comments)
        self.assertEqual(''.join(comments[human_id].itertext()), note)
        self.assertEqual(''.join(comments[substantive_id].itertext()), '金额应为120万元，请更正。')
        for node in self.xml(out).iter():
            if node.tag in (Q('commentRangeStart'), Q('commentRangeEnd'), Q('commentReference')):
                self.assertIn(node.get(Q('id')), comments)
        self.assertEqual(len(comments), 3)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(document_signature(self.xml(self.source)), document_signature(self.xml(out)))
        self.assertEqual(len(Document(out).comments), 3)

    def test_removed_note_cleans_modern_metadata_and_header_anchors_without_deleting_reply(self):
        w14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
        removed = etree.Element(Q('comment')); removed.set(Q('id'), '7')
        etree.SubElement(removed, Q('p')).set('{' + w14 + '}paraId', '000000A1')
        root = self.xml(self.source)
        header = etree.Element(Q('hdr'), nsmap={'w': W})
        paragraph = etree.SubElement(header, Q('p'))
        etree.SubElement(paragraph, Q('r')).append(etree.Element(Q('t')))
        paragraph[0][0].text = '原页眉'
        for kind in ('commentRangeStart', 'commentRangeEnd', 'commentReference'):
            etree.SubElement(paragraph, Q(kind)).set(Q('id'), '7')
            etree.SubElement(paragraph, Q(kind)).set(Q('id'), '8')
        parts = {'word/document.xml': etree.tostring(root), 'word/header1.xml': etree.tostring(header),
                 'word/commentsExtended.xml': b'<commentsEx xmlns="urn:test"><commentEx paraId="000000A1"/><commentEx paraId="000000A2" paraIdParent="000000A1"/></commentsEx>',
                 'word/commentsIds.xml': b'<commentsIds xmlns="urn:test"><commentId paraId="000000A1" durableId="000000B1"/><commentId paraId="000000A2" durableId="000000B2"/></commentsIds>',
                 'word/commentsExtensible.xml': b'<commentsExtensible xmlns="urn:test"><commentExtensible durableId="000000B1"/><commentExtensible durableId="000000B2"/></commentsExtensible>'}
        _remove_comment_references(parts, root, [removed], [])
        header = parse_xml(parts['word/header1.xml'])
        self.assertEqual(''.join(header.itertext()), '原页眉')
        self.assertEqual([n.get(Q('id')) for n in header.iter() if n.get(Q('id'))], ['8'] * 3)
        for name in ('word/commentsExtended.xml', 'word/commentsIds.xml', 'word/commentsExtensible.xml'):
            entries = parse_xml(parts[name])
            self.assertEqual(len(entries), 1)
            self.assertNotIn('paraIdParent', entries[0].attrib)
            self.assertNotIn('000000A1', parts[name].decode())
            self.assertNotIn('000000B1', parts[name].decode())

    def test_human_reply_inherits_removed_source_notes_anchor(self):
        para_attr = '{http://schemas.microsoft.com/office/word/2010/wordml}paraId'
        removed = etree.Element(Q('comment')); removed.set(Q('id'), '7')
        etree.SubElement(removed, Q('p')).set(para_attr, '000000A1')
        replies = []
        for identity, para_id in [('8', '000000A2'), ('9', '000000A3')]:
            reply = etree.Element(Q('comment')); reply.set(Q('id'), identity)
            etree.SubElement(reply, Q('p')).set(para_attr, para_id)
            replies.append(reply)
        root = self.xml(self.source)
        paragraph = root.find('.//' + Q('p'))
        for kind in ('commentRangeStart', 'commentRangeEnd', 'commentReference'):
            etree.SubElement(paragraph, Q(kind)).set(Q('id'), '7')
        parts = {'word/document.xml': etree.tostring(root),
                 'word/commentsExtended.xml': b'<commentsEx xmlns="urn:test"><commentEx paraId="000000A1"/><commentEx paraId="000000A2" paraIdParent="000000A1"/><commentEx paraId="000000A3" paraIdParent="000000A1"/></commentsEx>'}
        _remove_comment_references(parts, root, [removed], replies)
        self.assertEqual([n.get(Q('id')) for n in paragraph if n.get(Q('id'))], ['8'] * 3)
        metadata = parse_xml(parts['word/commentsExtended.xml'])
        self.assertNotIn('paraIdParent', metadata[0].attrib)
        self.assertEqual(metadata[1].get('paraIdParent'), '000000A2')

    def test_structured_evidence_location_stays_in_report_not_comment(self):
        report = self.report()
        report['findings'][0]['evidence_refs'] = [{'material_id': 'synthetic-evidence', 'material_version': 7,
            'locator': {'stable_ref': 'docx:p0285'}, 'quote': '2025年末资产合计120万元。'}]
        comments, summary = self.root / 'comments.docx', self.root / 'report.docx'
        annotate(self.source, comments, report)
        write_report(summary, report, [])
        text = ''.join(self.xml(comments, 'word/comments.xml')[0].itertext())
        self.assertIn('2025年末资产合计120万元', text)
        self.assertNotIn('第 285 段', text)
        self.assertNotIn('synthetic-evidence', text)
        self.assertIn('第 285 段', '\n'.join(p.text for p in Document(summary).paragraphs))

    def test_table_cell_anchor_and_multiple_original_positions(self):
        report = self.report()
        report['findings'][0]['target_refs'].append(self.report('90万元', 'docx:t001:r001:c001:p0001')['findings'][0]['target_refs'][0])
        placed, missing = annotate(self.source, self.root / 'table.docx', report)
        self.assertEqual((len(placed), len(missing)), (2, 0))

    def test_moved_deleted_or_ambiguous_quote_stays_in_report(self):
        for quote, locator in [('不存在', 'docx:p0001'), ('100万元', 'docx:p0099')]:
            report = self.report(quote, locator)
            placed, missing = annotate(self.source, self.root / 'missing.docx', report)
            self.assertEqual(len(placed), 0)
            self.assertEqual(len(missing), 1)
            path = self.root / 'report.docx'
            write_report(path, report, missing)
            self.assertIn('F001', '\n'.join(p.text for p in Document(path).paragraphs))

    def test_existing_revisions_are_preserved_and_complex_boundary_is_not_guessed(self):
        doc = Document()
        p = doc.add_paragraph()
        ins = etree.SubElement(p._p, Q('ins'))
        ins.set(Q('id'), '17'); ins.set(Q('author'), 'Original')
        etree.SubElement(etree.SubElement(ins, Q('r')), Q('t')).text = '100万元'
        doc.save(self.source)
        out = self.root / 'revision.docx'
        placed, missing = annotate(self.source, out, self.report('100万元'))
        self.assertEqual((len(placed), len(missing)), (1, 0))
        self.assertEqual(self.xml(out).find('.//' + Q('ins')).get(Q('author')), 'Original')
        placed, missing = annotate(self.source, out, self.report('100'))
        self.assertEqual((len(placed), len(missing)), (0, 1))
        self.assertEqual(missing[0]['reason'], 'complex_run_boundary')

    def test_report_uses_readable_scope_conclusion_and_location_labels(self):
        path = self.root / 'readable-report.docx'
        write_report(path, self.report(), [])
        text = '\n'.join(p.text for p in Document(path).paragraphs)
        for expected in ['复核范围：完整复核', '执行编号：synthetic-run', '财务核对 1 项', '结论：存在差错', '本轮核对', '材料 source', '第 1 段']:
            self.assertIn(expected, text)
        for internal in ['source_material', 'stable_ref', '"scope"', 'rechecked', '结论：error', 'docx:p0001', '未覆盖与定位限制']:
            self.assertNotIn(internal, text)

    def test_unanchored_report_preserves_readable_reasons_and_locations(self):
        path = self.root / 'unanchored-report.docx'
        write_report(path, self.report(), [
            {'finding_id': 'F001', 'locator': {'stable_ref': 'docx:p0099'}, 'reason': 'source_anchor_missing'},
            {'finding_id': 'F002', 'locator': {'stable_ref': 'docx:t001:r002:c003:p0001'}, 'reason': 'complex_run_boundary'},
            {'reason': 'PDF 输入保留原页定位，不生成原 Word 批注。'},
        ])
        text = '\n'.join(p.text for p in Document(path).paragraphs)
        for expected in ['未覆盖与定位限制', '问题 F001 · 第 99 段', '当前源稿中未找到指定位置',
                         '表格 1 / 第 2 行 / 第 3 列 / 第 1 段', '跨越既有修订或复杂格式', 'PDF 输入保留原页定位']:
            self.assertIn(expected, text)
        for internal in ['"reason"', '"locator"', 'source_anchor_missing', 'complex_run_boundary']:
            self.assertNotIn(internal, text)


if __name__ == '__main__':
    unittest.main()
