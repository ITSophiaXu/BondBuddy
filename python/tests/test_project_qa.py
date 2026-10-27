import hashlib
import json
import tempfile
import unittest
import shutil
import subprocess
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from bondbuddy_file_authoring.project_qa import prepare, fill, evidence
from bondbuddy_file_authoring.project_files import inspect


def fixtures(directory):
    doc = Document()
    doc.add_heading('项目问答问题清单 合成测试', 0)
    doc.add_paragraph('本文件仅用于工程验证，不是真实发行人材料。')
    doc.add_paragraph('问题一：请说明本期募集资金用途。')
    doc.add_paragraph('请结合发行规模核对用途金额。')
    table = doc.add_table(rows=1, cols=1)
    table.cell(0, 0).text = '问题二：请说明非经营性往来占款的回收安排。'
    prop = table.rows[0]._tr.get_or_add_trPr()
    height = OxmlElement('w:trHeight'); height.set(qn('w:val'), '200'); height.set(qn('w:hRule'), 'exact'); prop.append(height)
    doc.sections[0].footer.paragraphs[0].text = '合成测试 原始页脚保留'
    source = directory / 'synthetic-questions.docx'; doc.save(source)
    facts = Document(); facts.add_heading('项目材料 合成测试', 0)
    facts.add_paragraph('本期发行规模为人民币 5 亿元，募集资金全部用于偿还有息债务。')
    facts.save(directory / 'synthetic-materials.docx')
    return source


def pdf_fixture(path, pages):
    # Small real text/blank PDF pages without adding a test or runtime dependency.
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'']
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    kids = []
    for text in pages:
        page_id = len(objects) + 1
        kids.append(f'{page_id} 0 R')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {page_id+1} 0 R >>'.encode())
        stream = f'BT /F1 12 Tf 50 700 Td ({text}) Tj ET'.encode()
        objects.append(f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'\nendstream')
    objects[1] = f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count {len(kids)} >>'.encode()
    data = b'%PDF-1.4\n'; offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(data)
    data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    data += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()
    path.write_bytes(data)


class ProjectQaTests(unittest.TestCase):
    def test_pdf_questions_generate_word_and_keep_unreadable_page_warning(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root/'questions.pdf'
            pdf_fixture(source, ['1. What evidence supports repayment?', ''])
            original = source.read_bytes()
            prepared, meta = root/'prepared.docx', root/'prepared.json'
            prepare(source, prepared, meta)
            parsed = json.loads(meta.read_text(encoding='utf8'))
            self.assertEqual(len(parsed['questions']), 1)
            self.assertEqual(parsed['questions'][0]['question'], '1. What evidence supports repayment?')
            self.assertTrue(any('PDF' in w and 'Word' in w for w in parsed['warnings']))
            self.assertTrue(any('第 2 页无法提取文字' in w for w in parsed['warnings']))
            answer = dict(question_id=parsed['questions'][0]['id'], status='missing', answer='缺少偿债依据。',
                          missing_materials=['请补充偿债资金安排及回款凭证。'], citations=[], case_ids=[], approach='')
            output = root/'answered.docx'
            fill(prepared, dict(source_sha256=hashlib.sha256(prepared.read_bytes()).hexdigest(),
                                questions=parsed['questions'], answers=[answer], evidence=[], cases=[], warnings=parsed['warnings']), output)
            text = '\n'.join(p.text for p in Document(output).paragraphs)
            self.assertIn('What evidence supports repayment?', text)
            self.assertIn('请补充偿债资金安排及回款凭证。', text)
            self.assertIn('第 2 页无法提取文字', text)
            self.assertEqual(source.read_bytes(), original)

    def test_scanned_pdf_does_not_invent_questions(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td); source = root/'scan.pdf'
            pdf_fixture(source, ['', ''])
            prepare(source, root/'prepared.docx', root/'prepared.json')
            parsed = json.loads((root/'prepared.json').read_text(encoding='utf8'))
            self.assertEqual(parsed['questions'], [])
            self.assertTrue(any('第 1 页无法提取文字' in w for w in parsed['warnings']))

    @unittest.skipUnless(shutil.which('libreoffice'), 'LibreOffice is required for legacy DOC conversion')
    def test_legacy_doc_conversion_keeps_questions(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);source=fixtures(root)
            subprocess.run(['libreoffice','-env:UserInstallation='+ (root/'lo-profile').as_uri(),'--headless','--convert-to','doc','--outdir',td,str(source)],check=True,capture_output=True,timeout=90)
            prepare(source.with_suffix('.doc'),root/'prepared.docx',root/'parsed.json')
            data=json.loads((root/'parsed.json').read_text(encoding='utf8'))
            self.assertEqual(len(data['questions']),3)
            self.assertTrue(any('DOCX' in w for w in data['warnings']))

    def test_preserves_original_tables_footer_and_places_missing_list_beside_question(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);source=fixtures(root);prepared=root/'prepared.docx';meta=root/'parsed.json'
            prepare(source,prepared,meta);parsed=json.loads(meta.read_text(encoding='utf8'))
            qs=parsed['questions'];self.assertEqual(len(qs),3)
            qs=[dict(qs[0],end=qs[1]['end'],question=qs[0]['question']+'\n'+qs[1]['question']),qs[2]]
            facts=inspect(root/'synthetic-materials.docx')
            answer={'question_id':qs[0]['id'],'answer':'本期募集资金 5 亿元用于偿还有息债务，金额与发行规模一致。','status':'draft','missing_materials':[],
                    'citations':[{'asset_index':0,'span_id':'p1','quote':facts['spans'][1]['text']}],'case_ids':[],'approach':'按用途核对金额。'}
            missing={'question_id':qs[1]['id'],'answer':'缺少回款证据，暂无法判断回收安排可行性。','status':'missing','missing_materials':['往来占款明细、回款计划与最新回款凭证。'],'citations':[],'case_ids':[],'approach':'先核对形成原因，再评估回收依据。'}
            req={'source_sha256':hashlib.sha256(prepared.read_bytes()).hexdigest(),'questions':qs,'answers':[answer,missing],'evidence':[{'filename':'合成材料.docx','snapshot':facts}],'cases':[]}
            output=root/'filled.docx';fill(prepared,req,output)
            with ZipFile(source) as a,ZipFile(output) as b:
                self.assertEqual(a.read('word/footer1.xml'),b.read('word/footer1.xml'))
                self.assertEqual(a.read('word/styles.xml'),b.read('word/styles.xml'))
                xml=b.read('word/document.xml').decode();self.assertIn('往来占款明细',xml);self.assertNotIn('w:hRule="exact"',xml)
            result=Document(output);self.assertEqual(len(result.tables),1);self.assertIn('待补材料',result.tables[0].cell(0,0).text)
            self.assertEqual(hashlib.sha256(prepared.read_bytes()).hexdigest(),req['source_sha256'])
            req['questions'][0]['question']='伪造定位';self.assertRaises(ValueError,fill,prepared,req,root/'invalid.docx')

    def test_spreadsheet_evidence_keeps_sheet_and_row_locations(self):
        from openpyxl import Workbook
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);book=Workbook();sheet=book.active;sheet.title='偿债安排';sheet.append(['用途','金额']);sheet.append(['偿还债务',50000]);book.save(root/'facts.xlsx')
            evidence(root/'facts.xlsx',root/'facts.json');data=json.loads((root/'facts.json').read_text(encoding='utf8'))
            self.assertEqual(data['format'],'xlsx');self.assertEqual(data['spans'][1]['location'],'偿债安排 第 2 行');self.assertIn('50000',data['spans'][1]['text'])
            self.assertEqual(data['coverage'],'partial')


if __name__=='__main__':
    unittest.main()
