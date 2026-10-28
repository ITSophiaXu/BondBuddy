"""Synthetic issuer data only: full tables, evidence, scope and delivery boundaries."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml import etree

from bondbuddy_workpaper_source import extract
from bondbuddy_workpaper_batch import expanded_facts, validate, render, calculation, column_groups

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT/'knowledge/workpaper-templates/2026-10-27'


def fixture(directory, count=72):
    doc = Document()
    doc.add_paragraph('合成发行人集团成立于2008年，2024年主营业务为交通运营，合并总资产为100万元。')
    doc.add_paragraph('2024年合并子公司明细表')
    doc.add_paragraph('单位：人民币万元')
    table = doc.add_table(rows=2, cols=8)
    table.cell(0, 0).merge(table.cell(1, 0)).text = '主体名称'
    table.cell(0, 1).merge(table.cell(0, 3)).text = '2024年合并财务数据'
    for ci, text in enumerate(['负债', '收入', '成本', '毛利'], 4):
        table.cell(0, ci).text = text
    for ci in range(1, 8):
        table.cell(1, ci).text = ['资产', '净资产', '占比', '负债', '收入', '成本', '毛利'][ci-1]
    for row in table.rows[:2]:
        row._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
    for i in range(count):
        cells = table.add_row().cells
        for cell, text in zip(cells, [f'合成主体{i+1}', str(i+1), '0', '-', '', '100', '90', '10']):
            cell.text = text
    table.add_row().cells[0].text = '合计'
    doc.add_paragraph('注：上表为2024年合并口径，合计不计入子公司明细数量。')
    doc.add_paragraph('资料来源：合成审计报告第12页。')
    doc.add_paragraph('资金来源为经营回款，定价依据为约定费率。')
    doc.add_paragraph('截至2024年末，合成发行人尚未发行境外债券。')
    source_path = Path(directory)/'source.docx'; doc.save(source_path)
    snapshot = extract(source_path)
    entry = dict(id='one', code='1-1', title='重要子公司财务清单', instructions='', kind='file', folder='', sheet='1 尽职调查文件', row=1, path='1-1')
    batch = dict(entries=[entry], issuer_name='合成发行人集团')
    first = snapshot['source']['spans'][0]
    facts = [first['id'], snapshot['tables'][0]['span_ids'][8]]
    facts += [s['id'] for s in snapshot['source']['spans'] if s['text'].startswith('资金来源')]
    item = dict(item_id='one', decision=dict(item_id='one', status='generate', reason='已取得合成发行人的子公司及财务披露数据，可以形成财务清单。', missing_materials=[], citations=[dict(span_id=first['id'], quote=first['text'])]),
                required_evidence='子公司主体及财务数据清单', facts=facts, searched_span_ids=[], narrative=[], calculations=[])
    used = expanded_facts(snapshot, item)
    nonempty = [s['id'] for s in snapshot['source']['spans'] if s['text'].strip()]
    plan = dict(version='workpaper-shared-plan-v1', source_sha256=snapshot['source']['sha256'], reviewed_span_ids=nonempty,
                excluded=[dict(span_ids=[sid for sid in nonempty if sid not in used], reason='境外债券事项不属于本次子公司清单范围；来源定位仅留内部。')], image_reviews=[], items=[item])
    return source_path, snapshot, batch, plan


class SharedBatchTests(unittest.TestCase):
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

    def test_complete_table_tail_totals_merges_blank_dash_zero_units_notes_and_no_sources(self):
        result, doc = self.output()
        self.assertEqual(len(doc.tables[0].rows), 75)
        text = '\n'.join(t.text or '' for t in doc.element.body.iter(qn('w:t')))
        for value in ('合成主体72', '合计', '人民币万元', '上表为2024年合并口径', '原文空白', '资金来源为经营回款', '定价依据'):
            self.assertIn(value, text)
        self.assertIn('0', [t.text for t in doc.element.body.iter(qn('w:t'))])
        self.assertIn('-', [t.text for t in doc.element.body.iter(qn('w:t'))])
        self.assertNotIn('资料来源', text); self.assertNotIn('第12页', text)
        self.assertEqual(len(list(doc.tables[0]._tbl.iter(qn('w:tblHeader')))), 2)
        self.assertEqual(len(list(doc.tables[0]._tbl.iter(qn('w:gridSpan')))), 1)
        self.assertEqual(len(list(doc.tables[0]._tbl.iter(qn('w:vMerge')))), 2)
        self.assertGreater(result['links'], 400)
        self.assertTrue(any(s.page_width > s.page_height for s in doc.sections))
        from bondbuddy_file_authoring.project_files import inspect, validate_links
        proposed = json.loads((self.directory/'render/file-links.json').read_text())['links']
        checked = validate_links(self.source['source'], inspect(self.directory/'render/document.docx'), proposed)
        self.assertEqual(len(checked['links']), len(proposed)); self.assertEqual(checked['unresolved'], [])

    def test_nested_table_not_flattened_or_lost(self):
        doc = Document(self.path)
        cell = doc.tables[0].cell(3, 0)
        nested = cell.add_table(rows=2, cols=2)
        nested.cell(0, 0).text = '嵌套项目'; nested.cell(0, 1).text = '2024年'
        nested.cell(1, 0).text = '嵌套尾行'; nested.cell(1, 1).text = '88'
        doc.save(self.path)
        source = extract(self.path)
        plan = copy.deepcopy(self.plan); plan['source_sha256'] = source['source']['sha256']
        plan['items'][0]['facts'] = [s['id'] for s in source['source']['spans']]
        plan['reviewed_span_ids'] = [s['id'] for s in source['source']['spans'] if s['text'].strip()]; plan['excluded'] = []
        _, result = self.output(source=source, plan=plan)
        self.assertEqual(len(list(result.element.body.iter(qn('w:tbl')))), 2)
        self.assertIn('嵌套尾行', ''.join(result.element.body.itertext()))

    def test_wide_groups_repeat_identity_columns_and_keep_all_values(self):
        table = dict(rows=[dict(cells=[dict(content=[dict(span_id=f'p{i}')], colspan=1, vmerge=None) for i in range(16)], before=0, after=0, header=True)], widths=[1]*16)
        groups = column_groups(table)
        self.assertEqual(len(groups), 3)
        retained = []
        for group in groups:
            cells = group['rows'][0]['cells']
            self.assertEqual([c['content'][0]['span_id'] for c in cells[:2]], ['p0', 'p1'])
            self.assertLessEqual(len(cells), 8)
            retained += [c['content'][0]['span_id'] for c in cells[2:]]
        self.assertEqual(retained, [f'p{i}' for i in range(2, 16)])

    def test_crash_replay_produces_identical_document_and_internal_note_bytes(self):
        self.output()
        before = [(self.directory/'render'/name).read_bytes() for name in ('document.docx', 'preparation-note.docx')]
        self.output()
        after = [(self.directory/'render'/name).read_bytes() for name in ('document.docx', 'preparation-note.docx')]
        self.assertEqual(before, after)

    def test_pdf_native_table_preserves_geometry_and_page_review(self):
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        writer = PdfWriter(); page = writer.add_blank_page(width=600, height=800)
        font = DictionaryObject({NameObject('/Type'):NameObject('/Font'), NameObject('/Subtype'):NameObject('/Type1'), NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        commands = ['BT /F1 12 Tf 50 760 Td (Synthetic 2024 consolidated assets: 100 USD) Tj ET']
        for y in (700, 675, 650, 625): commands.append(f'50 {y} m 350 {y} l S')
        for x in (50, 200, 350): commands.append(f'{x} 625 m {x} 700 l S')
        for x,y,text in ((60,682,'Entity'),(210,682,'2024'),(60,657,'Alpha'),(210,657,'0'),(60,632,'Total'),(210,632,'-')):
            commands.append(f'BT /F1 12 Tf {x} {y} Td ({text}) Tj ET')
        stream = DecodedStreamObject(); stream.set_data('\n'.join(commands).encode()); page[NameObject('/Contents')] = writer._add_object(stream)
        path = self.directory/'source.pdf'; writer.write(path)
        source = extract(path)
        self.assertEqual(len(source['tables']), 1); self.assertEqual(len(source['tables'][0]['rows']), 3)
        self.assertIn('Total', [s['text'] for s in source['source']['spans']]); self.assertIn('0', [s['text'] for s in source['source']['spans']])
        self.assertEqual(source['images'][0]['page'], 1)
        self.assertTrue(source['images'][0]['span_ids'])

    def test_scope_and_complete_reading_are_enforced(self):
        for change, error in ((lambda p: p['items'].append(copy.deepcopy(p['items'][0])), 'SCOPE_MISMATCH'),
                              (lambda p: p['reviewed_span_ids'].pop(), 'FULL_READING_REQUIRED'),
                              (lambda p: p.update(excluded=[]), 'UNMAPPED_DISCLOSURE')):
            plan = copy.deepcopy(self.plan); change(plan)
            with self.assertRaisesRegex(ValueError, error): validate(self.source, self.batch, plan)

    def test_unknown_numbers_placeholders_and_source_labels_are_rejected(self):
        for text, code in [('总资产为999999万元。', 'NUMBER_NOT_DISCLOSED'), ('待补充财务数据。', 'PLACEHOLDER'),
                           ('来源：募集说明书第十章。', 'SOURCE_LABEL')]:
            plan = copy.deepcopy(self.plan)
            plan['items'][0]['narrative'] = [dict(text=text, sources=['p0'])]
            with self.assertRaisesRegex(ValueError, code): validate(self.source, self.batch, plan)

    def test_specific_explanation_keeps_disclosed_facts_without_proving_absence(self):
        plan = copy.deepcopy(self.plan); item = plan['items'][0]
        item['decision'].update(status='external_evidence', reason='已取得子公司名称及财务披露，但募集说明书不能替代各子公司的营业执照原件。', missing_materials=['各子公司有效营业执照复印件'])
        item['searched_span_ids'] = ['p0']
        _, doc = self.output(plan=plan)
        text = ''.join(doc.element.body.itertext())
        self.assertIn('合成主体72', text); self.assertIn('需取得原始证据', text); self.assertIn('各子公司有效营业执照复印件', text)
        item['decision'].update(status='not_applicable', reason='未披露相关资料，所以该事项不适用。')
        with self.assertRaisesRegex(ValueError, 'SILENCE_NOT_NONAPPLICABILITY'): validate(self.source, self.batch, plan)

    def test_calculation_requires_original_values_period_unit_and_scope(self):
        spans = {s['id']: s for s in self.source['source']['spans']}
        calc = dict(label='资产差额', operation='difference', period='2024年', unit='万元', scope='合并', decimals=2,
                    operands=[dict(span_id='p0', value='100', unit='万元', period='2024年', scope='合并', context_span_ids=['p0']),
                              dict(span_id='p0', value='100', unit='万元', period='2024年', scope='合并', context_span_ids=['p0'])])
        self.assertIn('100 − 100 = 0.00万元', calculation(calc, spans))
        calc['operands'][0]['scope'] = '母公司'
        with self.assertRaisesRegex(ValueError, 'CONTEXT_NOT_DISCLOSED'): calculation(calc, spans)

    def test_every_shipped_template_format_xml_parses_without_namespace_rewriting(self):
        for template in json.loads((CATALOG/'catalog.json').read_text(encoding='utf8')):
            for role in template['format']['roles'].values():
                for value in role.values():
                    if value: etree.fromstring(value.encode())

    def test_footnote_dependency_is_included(self):
        from zipfile import ZIP_DEFLATED
        with ZipFile(self.path) as z: parts = {n:z.read(n) for n in z.namelist()}
        root = etree.fromstring(parts['word/document.xml']); p = next(root.iter(qn('w:p')))
        r = OxmlElement('w:r'); note = OxmlElement('w:footnoteReference'); note.set(qn('w:id'), '2'); r.append(note); p.append(r)
        parts['word/document.xml'] = etree.tostring(root)
        parts['word/footnotes.xml'] = '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="2"><w:p><w:r><w:t>附注：总资产包含合并抵销。</w:t></w:r></w:p></w:footnote></w:footnotes>'.encode()
        with ZipFile(self.path, 'w', ZIP_DEFLATED) as z:
            for name, value in parts.items(): z.writestr(name, value)
        source = extract(self.path)
        self.assertIn('footnotes-p0', expanded_facts(source, dict(facts=['p0'])))


if __name__ == '__main__': unittest.main()
