import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from docx import Document
from bondbuddy_file_authoring.project_files import inspect, source_diff

def snap(texts, table=False):
    return {'spans':[dict(id=f'p{i}',text=t,location=f'表格 1 / 行 {i+1} / 列 1' if table else f'段落{i+1}') for i,t in enumerate(texts)]}

class WorkpaperSourceTests(unittest.TestCase):
    def test_insertion_does_not_invalidate_shifted_old_paragraphs(self):
        changes=source_diff(snap(['甲','乙','丙']),snap(['新增','甲','乙','丙']))
        self.assertEqual(len(changes),1)
        self.assertEqual(changes[0]['before_ids'],[])

    def test_table_period_change_invalidates_all_cells(self):
        changes=source_diff(snap(['2024年','100','200'],True),snap(['2025年','100','200'],True))
        self.assertEqual(changes[0]['before_ids'],['p0','p1','p2'])
        self.assertIn('200',changes[0]['after'])

    def test_deletion_and_identical(self):
        self.assertEqual(source_diff(snap(['a','b']),snap(['a','b'])),[])
        self.assertEqual(source_diff(snap(['a','b']),snap(['a']))[0]['before'],'b')

    def test_complete_read_includes_footnotes_and_last_table_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'synthetic.docx';doc=Document();doc.add_paragraph('合成募集书')
            table=doc.add_table(rows=151, cols=2)
            for i,row in enumerate(table.rows):
                row.cells[0].text=f'合成公司{i}';row.cells[1].text=str(i*100)
            doc.save(path)
            with ZipFile(path) as z: parts={n:z.read(n) for n in z.namelist()}
            parts['word/footnotes.xml']=b'<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>unit footnote</w:t></w:r></w:p></w:footnote></w:footnotes>'
            parts['word/media/image1.png']=b'not rendered in this extraction test'
            with ZipFile(path,'w',ZIP_DEFLATED) as z:
                for n,b in parts.items():z.writestr(n,b)
            result=inspect(path,complete=True)
            text='\n'.join(s['text'] for s in result['spans'])
            self.assertIn('合成公司150',text);self.assertIn('15000',text);self.assertIn('unit footnote',text)
            self.assertEqual(result['coverage'],'partial');self.assertTrue(any('图片' in w for w in result['warnings']))

if __name__=='__main__':unittest.main()
