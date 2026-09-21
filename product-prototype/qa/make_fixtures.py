from pathlib import Path
import sys
from docx import Document
from docx.shared import Pt

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
doc=Document()
doc.add_heading('测试发行人募集说明书',0)
p=doc.add_paragraph()
p.add_run('发行人总资产为').bold=True
p.add_run('100').italic=True
p.add_run('万元，负债为40万元。')
t=doc.add_table(rows=2,cols=2)
t.cell(0,0).text='指标';t.cell(0,1).text='金额'
t.cell(1,0).text='总资产';t.cell(1,1).text='100'
doc.add_paragraph('资产为100万元。')
doc.add_paragraph('资产为100万元。')
doc.save(out/'source.docx')
(out/'财务材料.txt').write_text('截至2026年6月30日，发行人总资产120万元，负债40万元。',encoding='utf-8')
print('fixtures ready')
