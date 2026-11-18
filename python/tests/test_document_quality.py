"""Synthetic catastrophic regressions and factual anchors, not expert acceptance."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from docx import Document
from lxml import etree as ET

from bondbuddy_file_authoring.check import clean, package, resolve_revisions
from bondbuddy_file_authoring.fixed_edit import empty_log, finalize, write_json
from bondbuddy_file_authoring.quality import verify
from bondbuddy_file_authoring.template_manifest import build_manifest, sha
from bondbuddy_file_authoring.word_patch import Patcher, paragraph_text, q, serialized, xml


class DocumentQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.docx'
        doc = Document()
        doc.add_heading('第一章 发行人基本情况', level=1)
        doc.add_paragraph('发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8)
        doc.add_heading('第二章 财务会计信息', level=1)
        doc.add_paragraph('截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8)
        table = doc.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '项目'
        table.cell(0, 1).text = '2025年6月末'
        table.cell(1, 0).text = '净资产'
        table.cell(1, 1).text = '100'
        doc.sections[0].header.paragraphs[0].text = '原稿格式页眉'
        doc.save(self.source)
        self.data = {'input_hash': 'a' * 64, 'revision_author': 'BondBuddy-quality-test',
                     'baseline_kind': 'uploaded_source', 'baseline_path': 'source.docx',
                     'baseline_sha256': sha(self.source.read_bytes()),
                     'operations_path': 'operations.json',
                     'output': {'tracked': 'output/tracked.docx', 'clean': 'output/clean.docx', 'baseline': 'output/baseline.docx'}}
        self.input = self.root / 'input.json'
        self.log_path = self.root / 'operations.json'

    def tearDown(self):
        self.temp.cleanup()

    def generate(self, operations=None):
        write_json(self.input, self.data)
        log = empty_log(self.data, self.source.read_bytes())
        log['operations'] = operations or []
        if not operations:
            log['no_changes_reason'] = 'Synthetic preservation test; no content update required.'
        write_json(self.log_path, log)
        finalize(self.input, self.log_path, self.root / 'output', skip_report=True)
        return verify(self.input)

    def node(self, text):
        return next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and n['text'] == text)

    def mutate(self, path, callback):
        parts = package(path)
        callback(parts)
        with ZipFile(path, 'w', ZIP_DEFLATED) as z:
            for name, raw in parts.items():
                z.writestr(name, raw)

    def codes(self, report):
        return {issue['code'] for issue in report['issues']}

    def test_numeric_period_update_keeps_template_and_passes_pair(self):
        text = '截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8
        node = self.node(text)
        after = text.replace('6月末', '9月末').replace('100', '120')
        report = self.generate([{'id': 'financial', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': text, 'after': after}])
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['metrics']['prose_retention'], 1.0)
        self.assertEqual(report['factual_accuracy'], 'not_verified')

    def test_valid_no_changes_and_comment_only_do_not_need_fake_revisions(self):
        self.assertEqual(self.generate()['status'], 'passed')
        node = self.node('第一章 发行人基本情况')
        result = self.generate([{'id': 'comment', 'kind': 'add_comment', 'node_id': node['node_id'],
                                'before': node['text'], 'text': '此处披露范围待核对。'}])
        self.assertEqual(result['status'], 'passed', result)

    def test_cross_issuer_market_and_product_rewrite_preserves_template(self):
        doc = Document()
        doc.add_heading('合成母公司2025年非公开发行公司债券', level=1)
        doc.add_paragraph('本公司债券拟在上交所挂牌转让，投资者人数不得超过二百人。' * 8)
        doc.add_heading('第一章 合成母公司业务概况', level=1)
        doc.add_paragraph('母公司负责集团股权投资及产业园区基础设施开发建设。' * 8)
        doc.add_heading('第二章 流动性风险', level=1)
        doc.add_paragraph('上交所挂牌交易的活跃程度及投资者人数限制影响债券流动性。' * 8)
        doc.add_table(rows=1, cols=1).cell(0, 0).text = '公司债券交易安排'
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        replacements = [
            '合成子公司2026年中期票据', '本期中期票据在银行间市场交易流通。',
            '第一章 合成子公司业务概况', '发行人提供城市运营服务，收入来源为公共设施运营。',
            '第二章 流动性风险', '银行间市场交易活跃程度变化可能影响本期票据流动性。',
        ]
        operations = [{'id': f'update-{i}', 'kind': 'replace_text', 'node_id': self.node(p.text)['node_id'],
                       'before': p.text, 'after': text} for i, (p, text) in enumerate(zip(doc.paragraphs, replacements))
                      if p.text != text]
        cell = next(n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'cell')
        operations.append({'id': 'market-cell', 'kind': 'replace_cell_text', 'node_id': cell['node_id'],
                           'before': cell['text'], 'after': '中期票据流通安排'})
        report = self.generate(operations)
        self.assertEqual(report['status'], 'passed', report)
        self.assertLess(report['metrics']['prose_retention'], .1)
        self.assertLess(report['metrics']['ratios']['characters'], .25)
        self.assertEqual(report['metrics']['outline_status'], 'unchanged')
        self.assertEqual(report['metrics']['ratios']['nonempty_paragraphs'], 1)
        # This is mechanical template acceptance, not financial/legal acceptance.
        self.assertEqual(report['factual_accuracy'], 'not_verified')
        self.assertEqual(report['visual_review'], 'not_run')

    def test_concise_local_rewrite_does_not_require_padding_or_old_phrases(self):
        old = '发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8
        report = self.generate([{'id': 'concise', 'kind': 'replace_text', 'node_id': self.node(old)['node_id'],
                                 'before': old, 'after': '发行人主营城市公共设施运营。'}])
        self.assertEqual(report['status'], 'passed', report)

    def test_legacy_direct_authoring_uses_same_flexible_policy_and_keeps_real_revisions(self):
        self.data.pop('operations_path')
        write_json(self.input, self.data)
        old = '发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8
        # Legacy callers do not have a trusted format plan. Build their real
        # tracked edit directly, rather than dropping the log from fixed_edit.
        parts = package(self.source)
        root = xml(parts['word/document.xml'])
        paragraph = next(p for p in root.iter(q('p')) if paragraph_text(p) == old)
        Patcher(root, True, self.data['revision_author']).patch(paragraph, old, '发行人主营城市公共设施运营。')
        parts['word/document.xml'] = serialized(root)
        output = self.root / 'output'
        output.mkdir()
        with ZipFile(output / 'tracked.docx', 'w', ZIP_DEFLATED) as archive:
            for name, raw in parts.items():
                archive.writestr(name, raw)
        clean(output / 'tracked.docx', output / 'clean.docx')
        (output / 'baseline.docx').write_bytes(self.source.read_bytes())
        self.assertTrue(list(root.iter(q('ins'))))
        self.assertTrue(list(root.iter(q('del'))))
        report = verify(self.input)
        self.assertEqual(report['status'], 'passed', report)

    def test_fixed_format_plan_cannot_be_trusted_without_its_operations_log(self):
        self.data.pop('operations_path')
        old = '发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8
        report = self.generate([{'id': 'concise', 'kind': 'replace_text', 'node_id': self.node(old)['node_id'],
                                 'before': old, 'after': '发行人主营城市公共设施运营。'}])
        self.assertIn('WORD_REJECT_OR_FORMAT_MISMATCH', self.codes(report))

    def test_erased_short_section_is_rejected_without_a_minimum_character_threshold(self):
        doc = Document(self.source)
        doc.add_heading('第三章 交易安排', level=1)
        doc.add_paragraph('本期票据在银行间市场交易流通。')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node(doc.paragraphs[-1].text)
        report = self.generate([{'id': 'erase-short', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '  '}])
        self.assertIn('WORD_SOURCE_CHAPTER_CONTENT_LOST', self.codes(report))

    def test_erased_table_is_rejected_even_with_other_chapter_body(self):
        cells = [n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'cell']
        report = self.generate([{'id': f'erase-{i}', 'kind': 'replace_cell_text', 'node_id': n['node_id'],
                                 'before': n['text'], 'after': ''} for i, n in enumerate(cells)])
        self.assertIn('WORD_SOURCE_TABLE_CONTENT_LOST', self.codes(report))

    def test_missing_renumbered_and_reordered_chapters_are_rejected(self):
        first, second = '第一章 发行人基本情况', '第二章 财务会计信息'
        for titles in [('', second), ('第三章 发行人基本情况', second), (second, first)]:
            with self.subTest(titles=titles):
                report = self.generate([{'id': f'heading-{i}', 'kind': 'replace_text',
                                         'node_id': self.node(old)['node_id'], 'before': old, 'after': new}
                                        for i, (old, new) in enumerate(zip((first, second), titles)) if old != new])
                self.assertIn('WORD_SOURCE_OUTLINE_CHANGED', self.codes(report))

    def test_tracked_and_clean_equal_text_with_different_styles_is_rejected(self):
        self.generate()
        def mutate(parts):
            styles = xml(parts['word/styles.xml'])
            styles.find('.//' + q('rFonts')).set(q('ascii'), 'Wrong font')
            parts['word/styles.xml'] = serialized(styles)
        self.mutate(self.root / 'output/clean.docx', mutate)
        self.assertIn('WORD_PAIR_RESOURCE_MISMATCH', self.codes(verify(self.input)))

    def test_tampering_both_word_files_cannot_hide_source_format_drift(self):
        self.generate()
        def mutate(parts):
            body = xml(parts['word/document.xml'])
            p = body.find(q('body')).find(q('p'))
            prop = p.find(q('pPr'))
            ET.SubElement(prop, q('spacing'), {q('after'): '9999'})
            parts['word/document.xml'] = serialized(body)
        for name in ('tracked', 'clean'):
            self.mutate(self.root / f'output/{name}.docx', mutate)
        self.assertIn('WORD_SOURCE_FORMAT_CHANGED', self.codes(verify(self.input)))

    def test_direct_authoring_cannot_rewrite_existing_baseline_comments(self):
        node = self.node('第一章 发行人基本情况')
        self.generate([{'id': 'old', 'kind': 'add_comment', 'node_id': node['node_id'],
                        'before': node['text'], 'text': '原稿中必须保留的核对意见。'}])
        self.source.write_bytes((self.root / 'output/clean.docx').read_bytes())
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.data.pop('operations_path')
        self.generate()
        def mutate(parts):
            comments = xml(parts['word/comments.xml'])
            comments.find('.//' + q('t')).text = '擅自替换为已核实。'
            parts['word/comments.xml'] = serialized(comments)
        for name in ('tracked', 'clean'):
            self.mutate(self.root / f'output/{name}.docx', mutate)
        self.assertIn('WORD_BASELINE_COMMENT_CHANGED', self.codes(verify(self.input)))

    def test_104_to_39_pages_with_genuine_deletions_is_rejected(self):
        # Explicit page boundaries model the reported incident without claiming
        # that stored DOCX page metadata is a real renderer's measurement.
        doc = Document()
        for index in range(104):
            paragraph = doc.add_paragraph(f'原始第{index + 1}页的独立完整披露：' + '原稿重要经营财务和历史条款必须完整保留。' * 12)
            paragraph.paragraph_format.page_break_before = index != 0
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.data.pop('operations_path')
        self.generate()
        def delete(parts):
            root = xml(parts['word/document.xml'])
            for p in root.find(q('body')).findall(q('p'))[39:]:
                props = p.find(q('pPr'))
                rprops = ET.SubElement(props, q('rPr'))
                ET.SubElement(rprops, q('del'), {q('id'): '999', q('author'): self.data['revision_author']})
            parts['word/document.xml'] = serialized(root)
        self.mutate(self.root / 'output/tracked.docx', delete)
        clean(self.root / 'output/tracked.docx', self.root / 'output/clean.docx')
        report = verify(self.input)
        self.assertEqual(report['metrics']['baseline']['nonempty_paragraphs'], 104)
        self.assertEqual(report['metrics']['output']['nonempty_paragraphs'], 39)
        self.assertIn('WORD_SOURCE_CONTENT_REDUCED', self.codes(report))
        # A real reject-all restoration alone cannot catch a destructive edit.
        restored = resolve_revisions(xml(package(self.root / 'output/tracked.docx')['word/document.xml']), False, only_new=self.data['revision_author'])
        self.assertEqual(len(restored.find(q('body')).findall(q('p'))), 104)

    def test_long_manuscript_cannot_keep_all_paragraphs_but_shrink_every_body_to_a_summary(self):
        doc = Document()
        doc.add_heading('第一章 发行人基本情况', level=1)
        for index in range(310):
            doc.add_paragraph(f'第{index + 1}项业务披露：' + '本期发行人业务、经营及财务情况需要完整说明。' * 20)
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        nodes = [n for n in build_manifest(self.source)['nodes'] if n['kind'] == 'paragraph' and '项业务披露：' in n['text']]
        self.data['document_size_check'] = {'status': 'passed', 'page_count': 310, 'enabled': False}
        report = self.generate([{'id': f'condense-{i}', 'kind': 'replace_text', 'node_id': n['node_id'],
                                 'before': n['text'], 'after': f'第{i + 1}项业务说明已更新。'} for i, n in enumerate(nodes)])
        self.assertEqual(report['metrics']['ratios']['nonempty_paragraphs'], 1)
        self.assertEqual(report['metrics']['outline_status'], 'unchanged')
        self.assertEqual(report['status'], 'failed')
        finding = next(i for i in report['issues'] if i['code'] == 'WORD_DOCUMENT_SIZE_REDUCED')
        self.assertEqual(finding['metric'], 'body_characters')
        self.assertLess(report['document_size_check']['character_ratio'], .1)

    def test_unrecorded_rewrite_cannot_pass_by_retaining_character_count(self):
        self.generate()
        def replace(parts):
            root = xml(parts['word/document.xml'])
            ps = root.find(q('body')).findall(q('p'))
            for p in ps:
                for t in p.iter(q('t')):
                    t.text = '无关的新写摘要填充全部内容而丢失原有披露' * 20
            parts['word/document.xml'] = serialized(root)
        for name in ('tracked', 'clean'):
            self.mutate(self.root / f'output/{name}.docx', replace)
        report = verify(self.input)
        self.assertGreater(report['metrics']['ratios']['characters'], 1)
        self.assertIn('WORD_SOURCE_FORMAT_CHANGED', self.codes(report))

    def test_one_chapter_loss_is_detected_even_when_global_length_is_padded(self):
        original = '发行人保持原有经营管理制度，主营基础设施项目投资和建设。' * 8
        node = self.node(original)
        report = self.generate([{'id': 'wipe', 'kind': 'replace_text', 'node_id': node['node_id'], 'before': original, 'after': ''}])
        self.assertIn('WORD_SOURCE_CHAPTER_CONTENT_LOST', self.codes(report))

    def test_heading_wording_can_change_in_recorded_operations(self):
        node = self.node('第一章 发行人基本情况')
        report = self.generate([{'id': 'rename', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '第一章 目标发行人基本情况'}])
        self.assertEqual(report['status'], 'passed', report)

    def test_basic_information_value_update_keeps_true_heading_sequence(self):
        doc = Document(self.source)
        for text in ['1、发行人名称：合成发行人', '2、法定代表人：合成人员甲', '3、设立日期：合成日期']:
            doc.add_paragraph(text)
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node('2、法定代表人：合成人员甲')
        report = self.generate([{'id': 'basic-information', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '2、法定代表人：【待人工确认】'}])
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['metrics']['outline_status'], 'unchanged')
        self.assertEqual(report['factual_accuracy'], 'not_verified')

    def test_unstyled_colon_title_wording_can_change(self):
        doc = Document(self.source)
        doc.add_paragraph('一、风险因素：财务风险')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node('一、风险因素：财务风险')
        report = self.generate([{'id': 'rename-colon-heading', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '一、风险因素：经营风险'}])
        self.assertEqual(report['status'], 'passed', report)

    def test_formula_note_update_passes_without_approving_its_financial_meaning(self):
        doc = Document(self.source)
        formula = '1.全部债务=短期借款+长期借款'
        doc.add_paragraph(formula)
        doc.add_paragraph('2.流动比率=流动资产/流动负债')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node(formula)
        report = self.generate([{'id': 'formula-note', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': formula, 'after': formula + '（有息债务口径待人工确认）'}])
        self.assertEqual(report['status'], 'passed', report)
        self.assertEqual(report['metrics']['outline_status'], 'unchanged')
        self.assertEqual(report['metrics']['formula_status'], 'unchanged')
        self.assertEqual(report['factual_accuracy'], 'not_verified')

    def test_valid_edit_log_cannot_hide_deleted_reordered_renumbered_or_rewritten_formulas(self):
        doc = Document(self.source)
        formulas = ['1.流动比率=流动资产/流动负债', '2.速动比率=（流动资产-存货）/流动负债',
                    '3.资产负债率=负债总计/资产总计']
        for formula in formulas:
            doc.add_paragraph(formula)
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        for after in [
            ['', '', ''],
            ['1.速动比率=（流动资产-存货）/流动负债', '2.流动比率=流动资产/流动负债', formulas[2]],
            [f.replace(f'{i + 1}.', f'{i + 4}.', 1) for i, f in enumerate(formulas)],
            [formulas[0].replace('/流动负债', '/负债总计'), *formulas[1:]],
            [formulas[0].replace('流动资产/', '存货/'), *formulas[1:]],
            [formulas[0].replace('/', '×'), *formulas[1:]],
            [formulas[0] + '（流动资产*2）', *formulas[1:]],
        ]:
            with self.subTest(after=after):
                operations = [{'id': f'formula-{i}', 'kind': 'replace_text', 'node_id': self.node(old)['node_id'],
                               'before': old, 'after': new}
                              for i, (old, new) in enumerate(zip(formulas, after)) if old != new]
                report = self.generate(operations)
                self.assertIn('WORD_SOURCE_FORMULA_CHANGED', self.codes(report))
                self.assertGreater(report['metrics']['prose_retention'], .65)

    def test_formula_exemption_keeps_real_heading_chapter_content_loss_blocked(self):
        doc = Document(self.source)
        doc.add_paragraph('1.流动比率=流动资产/流动负债')
        doc.add_paragraph('2.速动比率=（流动资产-存货）/流动负债')
        doc.add_paragraph('2、长期偿债能力分析')
        original = ('发行人通过调整借款到期分布，减少集中兑付压力，并维持原有融资渠道。'
                    '历史年度的偿债指标与经营活动情况共同解释长期资金安排。') * 3
        doc.add_paragraph(original)
        doc.add_paragraph('（五）盈利能力分析')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node(original)
        report = self.generate([{'id': 'rewrite-analysis', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': original, 'after': ''}])
        self.assertEqual(report['metrics']['outline_status'], 'unchanged')
        self.assertEqual(report['metrics']['formula_status'], 'unchanged')
        problem = next(i for i in report['issues'] if i['code'] == 'WORD_SOURCE_CHAPTER_CONTENT_LOST')
        self.assertEqual(problem['chapters'][0]['reason'], 'empty_body')

    def test_arabic_heading_numbers_cannot_be_normalized_away(self):
        doc = Document(self.source)
        doc.paragraphs[0].text = '1 财务状况'
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        node = self.node('1 财务状况')
        report = self.generate([{'id': 'renumber', 'kind': 'replace_text', 'node_id': node['node_id'],
                                 'before': node['text'], 'after': '2 财务状况'}])
        self.assertIn('WORD_SOURCE_OUTLINE_CHANGED', self.codes(report))

    def test_expected_financial_anchor_catches_wrong_numeric_update(self):
        self.data['expected_text'] = [{'text': '合并口径净资产为120万元', 'occurrences': 8}]
        report = self.generate()
        self.assertIn('WORD_EXPECTED_FACT_MISMATCH', self.codes(report))

    def test_cross_period_update_cannot_succeed_with_no_changes_or_comments_only(self):
        self.data['update_required'] = True
        self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', self.codes(self.generate()))
        node = self.node('第一章 发行人基本情况')
        result = self.generate([{'id': 'comment', 'kind': 'add_comment', 'node_id': node['node_id'],
                                'before': node['text'], 'text': '仅批注不代表财务全文更新完成。'}])
        self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', self.codes(result))

    def test_cross_period_date_relabelling_cannot_impersonate_financial_update(self):
        self.data['update_required'] = True
        text = '截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8
        node = self.node(text)
        result = self.generate([{'id': 'dates-only', 'kind': 'replace_text', 'node_id': node['node_id'],
                                'before': text, 'after': text.replace('6月末', '9月末')}])
        self.assertIn('WORD_REPORTING_UPDATE_INCOMPLETE', self.codes(result))

    def test_cross_period_date_and_financial_value_update_is_substantive(self):
        self.data['update_required'] = True
        text = '截至2025年6月末，合并口径净资产为100万元；历史比较期信息继续保留。' * 8
        node = self.node(text)
        result = self.generate([{'id': 'facts', 'kind': 'replace_text', 'node_id': node['node_id'],
                                'before': text, 'after': text.replace('6月末', '9月末').replace('100', '120')}])
        self.assertEqual(result['status'], 'passed', result)

    def test_host_baseline_hash_and_output_baseline_cannot_be_substituted(self):
        self.generate()
        self.data['baseline_sha256'] = 'b' * 64
        write_json(self.input, self.data)
        self.assertIn('WORD_BASELINE_CHANGED', self.codes(verify(self.input)))

    def make_pdf(self, text):
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                                 NameObject('/BaseFont'): NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(('BT /F1 10 Tf 30 700 Td (' + text + ') Tj ET').encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(stream)
        with (self.root / 'source.pdf').open('wb') as output:
            writer.write(output)

    def test_pdf_reconstruction_must_match_independent_original_text(self):
        text = 'Original disclosure covers business management accounting and material issuer risks. ' * 10
        doc = Document()
        doc.add_paragraph(text)
        doc.save(self.source)
        self.data.update(baseline_kind='reconstructed_pdf', baseline_sha256=sha(self.source.read_bytes()), original_pdf_path='source.pdf')
        self.make_pdf(text)
        self.assertEqual(self.generate()['status'], 'passed')
        # Once the PDF has been faithfully reconstructed, a concise cross-product
        # update is permitted just like an editable DOCX reference.
        node = self.node(text)
        rewritten = self.generate([{'id': 'pdf-update', 'kind': 'replace_text', 'node_id': node['node_id'],
                                    'before': text, 'after': 'Updated issuer and interbank note disclosure.'}])
        self.assertEqual(rewritten['status'], 'passed', rewritten)
        self.assertLess(rewritten['metrics']['pdf']['clean']['prose_retention'], .65)
        # A tiny model-created baseline agrees perfectly with its two outputs,
        # but must not erase the independently available original PDF text.
        doc = Document()
        doc.add_paragraph('Tiny unrelated summary.')
        doc.save(self.source)
        self.data['baseline_sha256'] = sha(self.source.read_bytes())
        self.assertIn('WORD_PDF_SOURCE_CONTENT_LOST', self.codes(self.generate()))

    def test_scanned_pdf_without_independent_ocr_cannot_claim_verified_retention(self):
        self.data.update(baseline_kind='reconstructed_pdf', original_pdf_path='source.pdf')
        self.make_pdf('')
        self.assertIn('WORD_PDF_TEXT_VERIFICATION_UNAVAILABLE', self.codes(self.generate()))

    def test_pdf_reconstruction_cannot_omit_original_pdf(self):
        self.data['baseline_kind'] = 'reconstructed_pdf'
        self.assertIn('WORD_PDF_SOURCE_REQUIRED', self.codes(self.generate()))

    def test_cli_fails_closed_with_machine_readable_report(self):
        self.generate()
        (self.root / 'output/clean.docx').unlink()
        completed = subprocess.run([sys.executable, '-m', 'bondbuddy_file_authoring.quality', '--input', str(self.input)],
                                   capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(json.loads(completed.stdout)['status'], 'failed')
        self.assertEqual(json.loads(completed.stderr)['error'], 'WORD_QUALITY_REJECTED')

    def test_first_draft_only_claims_checks_it_can_execute(self):
        self.generate()
        self.data.update(baseline_kind='none', baseline_path=None)
        write_json(self.input, self.data)
        report = verify(self.input)
        self.assertEqual(report['status'], 'passed', report)
        self.assertTrue(any('No source manuscript' in item for item in report['limitations']))


if __name__ == '__main__':
    unittest.main()
