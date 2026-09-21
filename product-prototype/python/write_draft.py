"""Build a new prospectus draft from validated sections; never copy the peer document."""
import json
import sys
from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt


def write_draft(payload, output):
    data = json.loads(Path(payload).read_text(encoding='utf-8'))
    doc = Document()
    section = doc.sections[0]
    section.top_margin = section.bottom_margin = Inches(.8)
    section.left_margin = section.right_margin = Inches(.85)
    for name in ('Normal', 'Title', 'Heading 1', 'Heading 2', 'Caption'):
        style = doc.styles[name]
        style.font.name = 'Microsoft YaHei'
        style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    doc.styles['Normal'].font.size = Pt(10.5)
    doc.styles['Normal'].paragraph_format.space_after = Pt(7)
    doc.add_paragraph(data['title'], style='Title')
    doc.add_paragraph('募集说明书初稿 · 供项目组审阅')
    doc.add_paragraph('发行人：' + data['issuer'])
    if data.get('periods'):
        doc.add_paragraph('报告期：' + data['periods'])
    doc.add_paragraph('本稿根据已提供项目资料起草。待补充内容在相应章节标明，编制依据见编制说明。')
    for index, item in enumerate(data['sections'], 1):
        doc.add_heading(f"{index}. {item['title']}", level=1)
        for paragraph in item['paragraphs']:
            doc.add_paragraph(paragraph['text'])
        for values in item['tables']:
            if values['title']:
                doc.add_paragraph(values['title'], style='Caption')
            table = doc.add_table(rows=1, cols=len(values['columns']))
            table.style = 'Table Grid'
            repeat = OxmlElement('w:tblHeader')
            table.rows[0]._tr.get_or_add_trPr().append(repeat)
            for cell, text in zip(table.rows[0].cells, values['columns']):
                cell.text = text
            for row in values['rows']:
                for cell, text in zip(table.add_row().cells, row):
                    cell.text = text
        for gap in item['gaps']:
            doc.add_paragraph('【待补充】' + gap)
    doc.save(output)


if __name__ == '__main__':
    write_draft(*sys.argv[1:3])
