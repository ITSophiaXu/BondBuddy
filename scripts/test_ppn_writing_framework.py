"""Offline regression for source fidelity, point anchors and snapshot rebuilding."""
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
import json
import unittest
from ppn_template_source import extract, W
from build_ppn_writing_framework import BASE, SOURCE_SHA, render


class PpnWritingTests(unittest.TestCase):
    def test_point_comments_and_cross_paragraph_ranges_are_both_retained(self):
        with TemporaryDirectory() as root:
            path = Path(root) / 'synthetic.docx'
            with ZipFile(path, 'w') as z:
                z.writestr('word/document.xml', f'''<w:document xmlns:w="{W}"><w:body>
                  <w:p><w:r><w:t>合成标题</w:t><w:commentReference w:id="0"/></w:r></w:p>
                  <w:p><w:commentRangeStart w:id="1"/><w:r><w:t>第一段</w:t></w:r></w:p>
                  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>表中段落</w:t></w:r>
                  <w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>
                  </w:p></w:tc></w:tr></w:tbl></w:body></w:document>''')
                z.writestr('word/comments.xml', f'''<w:comments xmlns:w="{W}">
                  <w:comment w:id="0"><w:p><w:r><w:t>单点方法</w:t></w:r></w:p></w:comment>
                  <w:comment w:id="1"><w:p><w:r><w:t>范围方法</w:t></w:r></w:p></w:comment>
                  </w:comments>''')
            data = extract(path)
            self.assertEqual(data['comments'][0]['anchor_kind'], 'point')
            self.assertEqual(data['comments'][0]['references'], ['P00001'])
            self.assertEqual(data['comments'][1]['selected_text'], '第一段表中段落')
            self.assertEqual(data['comments'][1]['start'], 'P00002')
            self.assertEqual(data['comments'][1]['end'], 'P00003')
            self.assertTrue(data['paragraphs'][2]['in_table'])

    def test_pinned_snapshot_preserves_all_comments_and_original_locations(self):
        data = json.loads((BASE / 'curated-source.json').read_text('utf-8'))
        self.assertEqual(data['source']['sha256'], SOURCE_SHA)
        self.assertEqual([c['id'] for c in data['comments']], [str(i) for i in range(108)])
        self.assertEqual(sum(c['anchor_kind'] == 'point' for c in data['comments']), 97)
        self.assertEqual(sum(c['anchor_kind'] == 'range' for c in data['comments']), 11)
        self.assertEqual(data['comments'][97]['references'], ['P01945'])
        self.assertEqual(data['comments'][107]['references'], ['P05610'])
        self.assertEqual(len(data['tables']), 90)
        self.assertEqual(render(data, (BASE / 'method.md').read_text('utf-8')).encode('utf-8'),
                         (BASE / 'writing-framework.md').read_bytes())

    def test_reusable_content_excludes_source_company_facts_and_preserves_formula_basis(self):
        data = json.loads((BASE / 'curated-source.json').read_text('utf-8'))
        payload = json.dumps(data, ensure_ascii=False)
        for value in ['任丘', '沧州', '三峡担保', '光大证券']:
            self.assertNotIn(value, payload)
        self.assertNotRegex(payload, r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
        self.assertNotRegex(payload, r'\b0\d{2,3}-\d{7,8}\b')
        self.assertNotRegex(payload, r'\b91[0-9A-Z]{16}\b')
        tables = {t['id']: t for t in data['tables']}
        self.assertIn('统计来源与期间未明确', tables['T003']['limitation'])
        self.assertEqual(tables['T009']['subfields'], ['直接', '间接'])
        self.assertEqual(tables['T013']['subfields'], ['金额', '占比', '金额', '占比'])
        self.assertIn(['净利润率', '归属于母公司所有者的净利润/营业收入'], tables['T090']['formulas'])
        self.assertIn('资产总计', tables['T026']['row_labels'])
        clause = next(c for c in data['clauses'] if c['locator'] == 'P00212')
        self.assertIn('第十章', clause['text'])
        self.assertNotIn('第十二章', clause['text'])
        self.assertTrue(clause['adapted'])


if __name__ == '__main__':
    unittest.main()
