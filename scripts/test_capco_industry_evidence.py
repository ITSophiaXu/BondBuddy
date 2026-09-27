"""Source integrity and lossless code mapping, not issuer/professional approval."""
from copy import deepcopy
from hashlib import sha256
import gzip
import json
from pathlib import Path
import re
import tempfile
import unittest

from build_capco_industry_evidence import (
    DEST, DOCX_SHA, GuidelineParser, artifacts, extract_nodes, read_rows, selector_mapping,
)


class CapcoEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = read_rows(DEST / 'originals/capco-industry-codes.docx')
        cls.nodes = extract_nodes(cls.rows)
        cls.by_code = {n['code']: n for n in cls.nodes}

    def test_complete_hierarchy_keeps_leading_zeroes_and_auxiliary_subsections(self):
        self.assertEqual(len(self.rows), 580)
        self.assertEqual(len(self.nodes), 576)
        self.assertEqual({n['code'] for n in self.nodes if n['level'] == 'division'},
                         {f'{i:02d}' for i in range(1, 92)})
        self.assertEqual(self.by_code['011']['parent_code'], '01')
        self.assertEqual(self.by_code['13']['parent_code'], 'C')
        self.assertEqual(self.by_code['13']['manufacturing_subsection_code'], 'CA')
        self.assertEqual(self.by_code['911']['section_code'], 'S')
        self.assertEqual(self.by_code['91']['manufacturing_subsection_code'], None)
        for n in self.nodes:
            if n['parent_code']:
                self.assertIn(n['parent_code'], self.by_code)

    def test_merged_rows_preserve_each_code_label_description_and_original_paragraph(self):
        expected = {'02': ('林业', 'T01-R014/C3/P1'),
                    '021': ('林木育种和育苗', 'T01-R014/C4/P2'),
                    '022': ('造林和更新', 'T01-R014/C4/P3'),
                    '277': ('卫生材料及医药用品制造', 'T02-R144/C4/P1'),
                    '278': ('药用辅料及包装材料', 'T02-R144/C4/P3')}
        for code, (name, anchor) in expected.items():
            self.assertEqual(self.by_code[code]['name'], name)
            self.assertEqual(self.by_code[code]['source']['code_locator'], anchor)
        self.assertEqual(self.by_code['278']['source']['description_locator'], 'T02-R144/C6/P2')
        self.assertEqual(self.by_code['278']['description'], '指药品用辅料和包装材料等制造')
        self.assertEqual(self.by_code['02']['description'], '')

    def test_every_exported_code_resolves_to_original_cell_not_an_inferred_code(self):
        rows = {r['anchor']: r for r in self.rows}
        for n in self.nodes:
            source = n['source']
            self.assertEqual(source['sha256'], DOCX_SHA)
            anchor, col, para = re.fullmatch(r'(T\d+-R\d+)/C(\d+)/P(\d+)', source['code_locator']).groups()
            original = rows[anchor]['cells'][int(col)-1][int(para)-1].strip()
            self.assertEqual(original, n['code'])

    def test_mapping_requires_division_evidence_and_never_guesses_a_child(self):
        mapping = {n['source_code']: n for n in selector_mapping(self.nodes)}
        for code in ['A', 'C', 'CA', 'S']:
            self.assertIsNone(mapping[code]['selector_code'])
            self.assertEqual(mapping[code]['reason'], 'insufficient_granularity')
        self.assertEqual(mapping['011']['selector_code'], '01')
        self.assertEqual(mapping['13']['selector_code'], '13')
        self.assertEqual(mapping['278']['selector_code'], '27')
        self.assertNotIn('C13', mapping)
        self.assertNotIn('city-infrastructure', mapping)
        self.assertNotIn('bond-business-2026.1', mapping)

    def test_changed_bytes_duplicate_codes_and_orphan_groups_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'changed.docx'
            path.write_bytes((DEST / 'originals/capco-industry-codes.docx').read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'hash changed'):
                read_rows(path)
        duplicate = deepcopy(self.rows)
        duplicate.insert(3, deepcopy(duplicate[2]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            extract_nodes(duplicate)
        missing = [r for r in self.rows if r['anchor'] != 'T01-R004']
        with self.assertRaisesRegex(ValueError, 'matching division'):
            extract_nodes(missing)

    def test_navigation_scripts_and_footer_do_not_become_guideline_evidence(self):
        parser = GuidelineParser()
        parser.feed('<p>navigation</p><div id="zoom"><p>第二条 <b>正文</b></p>'
                    '<script>approved=true</script><style>hidden</style></div><p>footer</p>')
        self.assertEqual(parser.paragraphs, ['第二条 正文'])

    def test_pinned_retrievals_and_generated_files_are_reproducible(self):
        for file in ('retrieval.json', 'followup-retrieval.json', 'revision-search.json'):
            for record in json.loads((DEST / file).read_text(encoding='utf-8-sig')):
                if 'file' in record:
                    data = (DEST / record['file']).read_bytes()
                    self.assertEqual(len(data), record['bytes'])
                    self.assertEqual(sha256(data).hexdigest(), record['sha256'])
                    if record.get('content_encoding') == 'gzip':
                        raw = gzip.decompress(data)
                        self.assertEqual(len(raw), record['response_bytes'])
                        self.assertEqual(sha256(raw).hexdigest(), record['response_sha256'])
        for file, text in artifacts().items():
            self.assertEqual((DEST / file).read_text(encoding='utf8'), text)
        catalog = json.loads((DEST / 'catalog.json').read_text(encoding='utf8'))
        mapping = json.loads((DEST / 'selector-mapping.json').read_text(encoding='utf8'))
        for item in (catalog, mapping):
            self.assertFalse(item['production_eligible'])
            self.assertIsNone(item['industry_review'])
        self.assertEqual(mapping['runtime_binding'], 'not_installed')


if __name__ == '__main__':
    unittest.main()
