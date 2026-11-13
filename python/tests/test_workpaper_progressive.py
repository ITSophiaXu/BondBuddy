"""Synthetic source facts only; grouping never weakens per-file validation."""
import base64
import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from bondbuddy_workpaper_batch import expanded_facts, validate
from bondbuddy_workpaper_progressive import prepare, RESULT_VERSION
from bondbuddy_workpaper_source import VERSION


def fixture():
    texts = [
        '合成发行人集团成立于2008年，2024年主营业务为交通运营，合并总资产为100万元。',
        '合成主体一，2024年资产为30万元，负债为20万元。',
        '合成主体二，2024年资产为40万元，负债为10万元。',
        '单位：人民币万元；期间：2024年；范围：合并子公司。',
        '注：本表包含合并子公司全部明细，横线与空白不是零。',
        '2024年发行人的募集资金用于轨道交通建设，项目投资合计100万元。',
        '境外债券事项不属于本组所选子公司财务清单及募集资金使用情况。',
    ]
    source = dict(version=VERSION, source=dict(sha256='a' * 64, spans=[dict(id=f'p{i}', text=text) for i, text in enumerate(texts)]),
                  tables=[dict(span_ids=['p1', 'p2'], context_ids=['p3'])], dependencies={'p3': ['p4']}, images=[])
    entries = [dict(id='one', title='子公司财务清单'), dict(id='two', title='募集资金使用情况')]
    batch = dict(entries=entries, issuer_name='合成发行人集团', requirements='保留全部明细与限定条件。')
    def item(entry, facts):
        return dict(item_id=entry['id'], facts=facts, searched_span_ids=[], required_evidence=entry['title'],
                    decision=dict(item_id=entry['id'], status='generate', reason='已取得本项所需的合成披露资料，可据此形成对应清单及分析。',
                                  missing_materials=[], citations=[dict(span_id='p0', quote=texts[0])]),
                    narrative=[], calculations=[])
    plan = dict(version='workpaper-shared-plan-v1', source_sha256=source['source']['sha256'], reviewed_span_ids=[f'p{i}' for i in range(len(texts))],
                excluded=[dict(span_ids=['p6'], reason='境外债券事项不属于本组目录文件范围。')], image_reviews=[],
                items=[item(entries[0], ['p0', 'p1']), item(entries[1], ['p0', 'p5'])])
    return source, batch, plan


class ProgressiveGroupTests(unittest.TestCase):
    def setUp(self):
        self.source, self.batch, self.plan = fixture()

    def test_projection_preserves_full_source_reading_tables_dependencies_and_original_exclusions(self):
        before = copy.deepcopy((self.source, self.batch, self.plan))
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual(result['version'], RESULT_VERSION)
        self.assertEqual(result['status'], 'items')
        self.assertEqual([row['item_id'] for row in result['items']], ['one', 'two'])
        for row in result['items']:
            plan = row['plan']
            self.assertEqual(plan['reviewed_span_ids'], self.plan['reviewed_span_ids'])
            self.assertEqual(plan['excluded'][0], self.plan['excluded'][0])
            validate(self.source, {**self.batch, 'entries': [next(e for e in self.batch['entries'] if e['id'] == row['item_id'])]}, plan)
        self.assertTrue({'p1', 'p2', 'p3', 'p4'} <= expanded_facts(self.source, result['items'][0]['plan']['items'][0]))
        self.assertEqual(result['items'][0]['plan']['excluded'][1]['span_ids'], ['p5'])
        self.assertEqual(result['items'][1]['plan']['excluded'][1]['span_ids'], ['p1', 'p2', 'p3', 'p4'])
        self.assertEqual((self.source, self.batch, self.plan), before, 'host inputs and group plans are immutable')

    def test_one_invented_narrative_does_not_invalidate_the_other_file(self):
        self.plan['items'][0]['narrative'] = [dict(text='合成发行人资产为999999万元。', sources=['p0'])]
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual(result['status'], 'items')
        self.assertEqual(result['items'][0], dict(item_id='one', error='WORKPAPER_NARRATIVE_NUMBER_NOT_DISCLOSED'))
        self.assertIn('plan', result['items'][1])

    def test_bad_calculation_is_local_and_never_accepted_as_an_authored_number(self):
        self.plan['items'][1]['calculations'] = [dict(label='资金差额', operation='difference', period='2024年', unit='万元', scope='合并', decimals=2,
            operands=[dict(span_id='p0', value='99999', unit='万元', period='2024年', scope='合并', context_span_ids=['p0'])])]
        result = prepare(self.source, self.batch, self.plan)
        self.assertIn('plan', result['items'][0])
        self.assertEqual(result['items'][1]['error'], 'WORKPAPER_CALC_NOT_DISCLOSED')

    def test_existing_used_excluded_conflict_is_not_removed_during_projection(self):
        self.plan['excluded'].append(dict(span_ids=['p2'], reason='合成计划故意把已选中表格单元格列为排除项。'))
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual(result['items'][0]['error'], 'WORKPAPER_PLAN_USED_AND_EXCLUDED')
        self.assertIn('plan', result['items'][1])
        self.assertEqual(result['items'][1]['plan']['excluded'][:2], self.plan['excluded'])

    def test_group_scope_incomplete_reading_and_unmapped_disclosure_request_singleton_fallback(self):
        for modify in (
            lambda p: p['reviewed_span_ids'].pop(),
            lambda p: p.update(excluded=[]),
            lambda p: p['items'].append(copy.deepcopy(p['items'][0])),
            lambda p: p['excluded'].append(copy.deepcopy(p['excluded'][0])),
        ):
            with self.subTest(modify=modify):
                plan = copy.deepcopy(self.plan); modify(plan)
                self.assertEqual(prepare(self.source, self.batch, plan), dict(version=RESULT_VERSION, status='fallback', items=[]))

    def test_source_identity_and_unverified_or_corrupt_images_remain_global_blocks(self):
        plan = copy.deepcopy(self.plan); plan['source_sha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'WORKPAPER_PLAN_SOURCE_CHANGED'):
            prepare(self.source, self.batch, plan)
        self.source['images'] = [dict(id='image-1', sha256='c' * 64)]
        self.plan['image_reviews'] = [dict(image_id='image-1', description='合成披露图像尚未可靠读取。', item_ids=['one'], verified=False)]
        with self.assertRaisesRegex(ValueError, 'WORKPAPER_IMAGE_CONTENT_UNVERIFIED'):
            prepare(self.source, self.batch, self.plan)
        self.plan['image_reviews'][0]['verified'] = True
        self.source['images'][0]['data'] = base64.b64encode(b'synthetic image').decode()
        with self.assertRaisesRegex(ValueError, 'WORKPAPER_IMAGE_HASH_MISMATCH'):
            prepare(self.source, self.batch, self.plan)
        self.source['images'][0]['sha256'] = hashlib.sha256(b'synthetic image').hexdigest()
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual(result['items'][0]['plan']['image_reviews'][0]['item_ids'], ['one'])
        self.assertEqual(result['items'][1]['plan']['image_reviews'][0]['item_ids'], [])

    def test_missing_group_picture_reviews_fall_back_without_fabricating_picture_evidence(self):
        self.source['images'] = [dict(id='image-1', sha256='c' * 64)]
        self.assertEqual(prepare(self.source, self.batch, self.plan)['status'], 'fallback')

    def test_pdf_mapping_failure_is_local_to_the_item_using_that_page(self):
        self.source['images'] = [dict(id='image-1', sha256='c' * 64, page=1, span_ids=['p1', 'p2'])]
        self.plan['image_reviews'] = [dict(image_id='image-1', description='合成PDF页面，故意遗漏当前财务清单的映射。', item_ids=[], verified=True)]
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual(result['items'][0]['error'], 'WORKPAPER_PDF_PAGE_NOT_MAPPED')
        self.assertIn('plan', result['items'][1])

    def test_identical_explanation_reasons_remain_rejected_after_splitting(self):
        for item in self.plan['items']:
            item['decision'].update(status='external_evidence', reason='已取得披露事实，但缺少本项对应的独立签章原件。', missing_materials=['2024年度独立签章核查记录'])
            item['searched_span_ids'] = ['p0']
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual([row['error'] for row in result['items']], ['WORKPAPER_DUPLICATE_EXPLANATION'] * 2)

    def test_unknown_fact_is_local_without_erasing_other_item_coverage(self):
        self.plan['items'][0]['facts'].append('invented-span')
        result = prepare(self.source, self.batch, self.plan)
        self.assertEqual(result['items'][0]['error'], 'WORKPAPER_PLAN_UNKNOWN_FACT')
        self.assertIn('plan', result['items'][1])

    def test_cli_writes_only_the_checked_result_and_reports_safe_global_error_codes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(__file__).resolve().parents[2]
            paths = [Path(temporary) / name for name in ('source.json', 'batch.json', 'plan.json', 'result.json')]
            for path, data in zip(paths, (self.source, self.batch, self.plan)):
                path.write_text(json.dumps(data), encoding='utf-8')
            command = [sys.executable, '-B', str(root / 'python/bondbuddy_workpaper_progressive.py'), 'prepare', *map(str, paths)]
            result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, 'PYTHONPATH': str(root / 'python')})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(paths[-1].read_text(encoding='utf-8')), prepare(self.source, self.batch, self.plan))
            self.plan['source_sha256'] = 'b' * 64; paths[2].write_text(json.dumps(self.plan), encoding='utf-8')
            paths[-1].unlink()
            result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, 'PYTHONPATH': str(root / 'python')})
            self.assertEqual(result.returncode, 2)
            self.assertIn('BB_WORKPAPER_ERROR=WORKPAPER_PLAN_SOURCE_CHANGED', result.stderr)
            self.assertFalse(paths[-1].exists())


if __name__ == '__main__':
    unittest.main()
