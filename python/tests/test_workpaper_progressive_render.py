"""Progressive rendering boundaries; the legacy renderer remains byte-compatible."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml import etree
from bondbuddy_workpaper_source import extract
from bondbuddy_workpaper_batch import validate
from bondbuddy_workpaper_progressive_render import render
from test_workpaper_shared_batch import fixture, ROOT, CATALOG


class ProgressiveRenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.directory = Path(self.tmp.name)
        self.path, self.source, self.batch, self.plan = fixture(self.directory)

    def tearDown(self):
        self.tmp.cleanup()

    def output(self, source=None, batch=None, plan=None, template=0):
        item = json.loads((CATALOG/'catalog.json').read_text(encoding='utf8'))[template]
        fmt = self.directory/'format.json'; fmt.write_text(json.dumps(item['format']), encoding='utf8')
        output = self.directory/'render'
        result = render(source or self.source, batch or self.batch, plan or self.plan, 'one', CATALOG/item['filename'], fmt, output)
        return result, Document(output/'document.docx')

    def test_specific_explanation_keeps_disclosed_facts_without_proving_absence(self):
        plan = copy.deepcopy(self.plan); item = plan['items'][0]
        item['decision'].update(status='external_evidence', reason='已取得子公司名称及财务披露，但募集说明书不能替代各子公司的营业执照原件。', missing_materials=['各子公司有效营业执照复印件'])
        item['searched_span_ids'] = ['p0']
        _, doc = self.output(plan=plan)
        text = ''.join(doc.element.body.itertext())
        self.assertIn('合成主体72', text); self.assertIn('需取得原始证据', text); self.assertIn('各子公司有效营业执照复印件', text)
        self.assertIn(item['decision']['reason'], text)
        self.assertIn('尚需取得：各子公司有效营业执照复印件。', text)
        item['decision'].update(status='not_applicable', reason='未披露相关资料，所以该事项不适用。')
        with self.assertRaisesRegex(ValueError, 'SILENCE_NOT_NONAPPLICABILITY'): validate(self.source, self.batch, plan)

    def test_generated_document_keeps_business_limits_but_assessment_stays_internal(self):
        original = Document(self.path)
        limitation = '项目建设尚需取得经营许可后方可投入运营；可用授信不构成债券担保，拟设专项账户不等于已开立。'
        original.add_paragraph(limitation); original.save(self.path)
        source = extract(self.path)
        plan = copy.deepcopy(self.plan); item = plan['items'][0]
        sid = next(s['id'] for s in source['source']['spans'] if s['text'] == limitation)
        item['facts'].append(sid)
        item['narrative'] = [dict(text=limitation, sources=[sid])]
        item['decision'].update(reason='已取得披露事实，足以形成子公司财务清单，生成判断仅供内部核对。',
                                missing_materials=['单体报表原件及签章核验记录'])
        plan['source_sha256'] = source['source']['sha256']
        plan['reviewed_span_ids'] = [s['id'] for s in source['source']['spans'] if s['text'].strip()]
        preserved = copy.deepcopy(plan)
        _, doc = self.output(source=source, plan=plan)
        text = '\n'.join(p.text for p in doc.paragraphs)
        self.assertNotIn('成果范围：', text)
        self.assertNotIn(item['decision']['reason'], text)
        self.assertNotIn(item['decision']['missing_materials'][0], text)
        self.assertIn('资金来源为经营回款，定价依据为约定费率。', text)
        self.assertIn(limitation, text)  # No broad stripping of 尚需取得 or negative qualifications.
        self.assertIn('合成主体72', ''.join(doc.element.body.itertext()))
        audit = json.loads((self.directory/'render/internal-audit.json').read_text(encoding='utf8'))
        self.assertEqual(audit['decision'], item['decision'])
        note = Document(self.directory/'render/preparation-note.docx')
        self.assertIn(item['decision']['reason'], '\n'.join(p.text for p in note.paragraphs))
        self.assertEqual(plan, preserved)

    def test_body_widow_control_overrides_only_template_pagination_flag(self):
        template = json.loads((CATALOG/'catalog.json').read_text(encoding='utf8'))[0]
        fmt = copy.deepcopy(template['format'])
        role = fmt['roles']['body']; properties = etree.fromstring(role['pPr'].encode())
        widow = properties.find(qn('w:widowControl'))
        if widow is None:
            widow = OxmlElement('w:widowControl'); properties.append(widow)
        widow.set(qn('w:val'), '0')
        role['pPr'] = etree.tostring(properties, encoding='unicode')
        path = self.directory/'widow-format.json'; path.write_text(json.dumps(fmt), encoding='utf8')
        target = self.directory/'widow-output'
        render(self.source, self.batch, self.plan, 'one', CATALOG/template['filename'], path, target)
        document = Document(target/'document.docx')
        paragraphs = [p for p in document.paragraphs[1:] if p.text]
        self.assertTrue(paragraphs)
        self.assertTrue(all(p.paragraph_format.widow_control is True for p in paragraphs))
        def signature(node):
            return (node.tag, tuple(sorted(node.attrib.items())), node.text or '',
                    tuple(signature(child) for child in node if child.tag != qn('w:widowControl')))
        self.assertEqual(signature(paragraphs[0]._p.pPr), signature(properties))
        if role.get('rPr'):
            self.assertEqual(signature(paragraphs[0].runs[0]._r.rPr), signature(etree.fromstring(role['rPr'].encode())))

    def test_legacy_helper_bytes_and_runtime_identity_input_stay_unchanged(self):
        legacy = ROOT/'python/bondbuddy_workpaper_batch.py'
        # Existing checkouts use Git LF or Windows autocrlf. Both exact baseline
        # byte sequences predate this change; no delivery logic may be edited.
        self.assertIn(hashlib.sha256(legacy.read_bytes()).hexdigest(), {
            '6bba7bab9f9235dfb73c5946a26755cf94c1cd8145abd141b80610e5621811df',
            'cc2a59507b1ceebd4beb708ae16b4d5992e171e18f73a06d60676f85efa92341'})
