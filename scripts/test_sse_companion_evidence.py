"""Pinned source/exception regression; not project eligibility or professional approval."""
from hashlib import sha256
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from build_sse_companion_evidence import (
    DEST, EXPECTED, Paragraphs, articles, build, compact, verified_bytes,
)

GENERATED = (
    'sources/csrc-industry-2024.md', 'sources/sse-suitability-2023.md',
    'sources/company-law-2023.md', 'suitability-articles.json',
    'company-law-articles.json', 'industry-table-rows.json',
    'industry-codes.json', 'industry-comparison.json',
)


def read(name):
    return json.loads((DEST / name).read_text(encoding='utf-8'))


def article_text(filename, number):
    item = next(a for a in read(filename) if a['number'] == number)
    return '\n'.join(p['text'] for p in item['paragraphs'])


class CompanionEvidenceTests(unittest.TestCase):
    def test_source_manifest_matches_original_bytes_and_not_a_release(self):
        manifest = read('retrieval.json')
        self.assertFalse(manifest['production_eligible'])
        self.assertIsNone(manifest['professional_review'])
        self.assertEqual({a['path'] for a in manifest['assets']}, EXPECTED.keys())
        for asset in manifest['assets']:
            data = verified_bytes(DEST / asset['path'], EXPECTED[asset['path']])
            self.assertEqual(len(data), asset['bytes'])
            self.assertEqual(sha256(data).hexdigest(), asset['sha256'])
            self.assertEqual(asset['status'], 200)

    def test_all_articles_keep_continuations_and_original_anchors(self):
        for name, view, count in (
            ('suitability-articles.json', 'sources/sse-suitability-2023.md', 30),
            ('company-law-articles.json', 'sources/company-law-2023.md', 266),
        ):
            values = read(name)
            self.assertEqual([a['number'] for a in values], list(range(1, count + 1)))
            text = (DEST / view).read_text(encoding='utf-8')
            previous = 0
            for a in values:
                self.assertIn(f'<a id="{a["anchor"]}"></a>', text)
                self.assertTrue(a['paragraphs'])
                for p in a['paragraphs']:
                    self.assertGreater(p['paragraph'], previous)
                    previous = p['paragraph']
                    self.assertIn(f'<a id="p{p["paragraph"]:04}"></a>', text)
                    self.assertIn(p['text'], text)

    def test_suitability_institution_restriction_and_exceptions_are_not_lost(self):
        name = 'suitability-articles.json'
        a6 = article_text(name, 6)
        for fragment in ('同时符合下列条件的法人或者其他组织', '2000万元', '1000万元', '2年以上'):
            self.assertIn(fragment, a6)
        a8 = article_text(name, 8)
        for fragment in ('仅限专业投资者中的机构投资者', '另有规定的除外', '持股比例超过5%',
                         '该发行人发行的债券', '切实防范利益冲突'):
            self.assertIn(fragment, a8)
        self.assertIn('不得另行买入', article_text(name, 10))
        self.assertIn('自该情形披露之日起', article_text(name, 11))
        self.assertIn('至少每两年', article_text(name, 21))

    def test_company_type_public_scope_and_transition_survive_extraction(self):
        name = 'company-law-articles.json'
        self.assertIn('股东会可以授权董事会', article_text(name, 59))
        self.assertIn('不设监事会或者监事', article_text(name, 69))
        self.assertIn('经全体股东一致同意', article_text(name, 83))
        self.assertIn('三名以上', article_text(name, 121))
        self.assertNotIn('三名以上', article_text(name, 69))
        self.assertIn('自缓刑考验期满之日起未逾二年', article_text(name, 178))
        for number in (204, 205):
            self.assertIn('公开发行公司债券的', article_text(name, number))
        self.assertIn('具体实施办法由国务院规定', article_text(name, 266))
        self.assertNotIn('免责声明', article_text(name, 266))

    def test_pdf_replacement_refers_to_2004_and_preserves_page_anchors(self):
        text = (DEST / 'sources/csrc-industry-2024.md').read_text(encoding='utf-8')
        for page in range(1, 49):
            self.assertIn(f'<a id="page{page:03}"></a>', text)
        preface = text.split('<a id="page004"></a>')[1].split('<a id="page005"></a>')[0]
        self.assertIn('本文件代替JR/T0020—2004', compact(preface))
        self.assertNotIn('代替中国上市公司协会', compact(preface))

    def test_every_industry_node_resolves_to_original_table_cells(self):
        nodes = read('industry-codes.json')
        rows = {r['anchor']: r['cells'] for r in read('industry-table-rows.json')}
        by_code = {n['code']: n for n in nodes}
        self.assertEqual(len(nodes), 576)
        self.assertEqual(len(by_code), 576)
        self.assertEqual({n['code'] for n in nodes if n['level'] == 'division'},
                         {f'{i:02}' for i in range(1, 92)})
        self.assertEqual(by_code['011']['parent_code'], '01')
        self.assertEqual(by_code['13']['parent_code'], 'C')
        self.assertEqual(by_code['911']['parent_code'], '91')
        for n in nodes:
            cells = rows[n['anchor']]
            self.assertIn(n['code'], [compact(v) for v in cells[:4]])
            self.assertEqual(n['name'], compact(cells[4]))
            self.assertEqual(n['description'], compact(cells[5]))
            if n['parent_code']:
                self.assertIn(n['parent_code'], by_code)

    def test_comparison_preserves_twelve_text_differences_not_legal_equivalence(self):
        comparison = read('industry-comparison.json')
        self.assertTrue(comparison['code_sets_equal'])
        for flag in ('production_eligible', 'legal_equivalence_established', 'replaces_capco_2023_established'):
            self.assertFalse(comparison[flag])
        self.assertIsNone(comparison['professional_review'])
        differences = comparison['differences']
        self.assertEqual({d['code'] for d in differences},
                         {'B', '175', '194', '213', '219', '387', '51', '533', '633', '643', '651', '684'})
        fields = [v['field'] for d in differences for v in d['differences']]
        self.assertEqual(fields.count('name'), 1)
        self.assertEqual(fields.count('description'), 11)
        self.assertNotIn('level', fields)
        self.assertNotIn('parent_code', fields)
        self.assertNotEqual(compact('羽毛(绒)'), compact('羽毛（绒）'))

    def test_changed_source_or_missing_duplicate_article_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'changed.docx'
            path.write_bytes((DEST / 'originals/sse-suitability-2023.docx').read_bytes() + b'x')
            with self.assertRaisesRegex(ValueError, 'Source changed'):
                verified_bytes(path, EXPECTED['originals/sse-suitability-2023.docx'])
        for paragraphs in (['第一条 a', '第三条 b'], ['第一条 a', '第一条 b']):
            with self.assertRaisesRegex(ValueError, 'Missing/duplicate article'):
                articles(paragraphs, 2)
        with self.assertRaisesRegex(ValueError, 'Incomplete article count'):
            articles(['第一条 a'], 2)

    def test_scripts_styles_and_chapter_headings_are_not_article_body(self):
        parser = Paragraphs()
        parser.feed('<p>第一条 <b>正文</b><script>approved=true</script><style>hidden</style></p>'
                    '<p>第二章 下一章</p><p>第二条 后文</p>')
        parsed = articles(parser.paragraphs, 2)
        self.assertEqual(parsed[0]['paragraphs'], [{'paragraph': 1, 'text': '第一条 正文'}])
        self.assertEqual(parsed[1]['paragraphs'], [{'paragraph': 3, 'text': '第二条 后文'}])

    def test_offline_rebuild_is_byte_for_byte_reproducible(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp)
            for rel in EXPECTED:
                (dest / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(DEST / rel, dest / rel)
            self.assertEqual(build(dest), {'suitability_articles': 30, 'company_law_articles': 266,
                                          'industry_codes': 576})
            for rel in GENERATED:
                self.assertEqual((dest / rel).read_bytes(), (DEST / rel).read_bytes(), rel)


if __name__ == '__main__':
    unittest.main()
