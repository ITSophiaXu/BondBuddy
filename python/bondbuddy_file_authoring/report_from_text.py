"""Export the CLI report verbatim to editable Word; no interpretation or content gate."""
import re
import sys
from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Cm


def export_report(source: Path, target: Path):
    text = source.read_text(encoding='utf-8-sig')
    if not text.strip():
        raise ValueError('REPORT_TEXT_EMPTY')
    doc = Document()
    section = doc.sections[0]
    section.top_margin = section.bottom_margin = Cm(2)
    section.left_margin = section.right_margin = Cm(2.2)
    style = doc.styles['Normal']
    style.font.name = 'Arial'
    style.font.size = Pt(10.5)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'Microsoft YaHei')
    language = OxmlElement('w:lang')
    language.set(qn('w:eastAsia'), 'zh-CN')
    style.element.get_or_add_rPr().append(language)
    style.paragraph_format.space_after = Pt(5)
    # Keep every line, including Markdown tables and code; no JSON/schema interpretation.
    for line in text.splitlines():
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '\ufffd', line)
        heading = re.match(r'^(#{1,4})\s+(.+)$', clean)
        if heading:
            doc.add_heading(heading.group(2), min(len(heading.group(1)), 3))
        else:
            doc.add_paragraph(clean)
    footer = section.footer.paragraphs[0]
    footer.alignment = 2
    field = OxmlElement('w:fldSimple')
    field.set(qn('w:instr'), 'PAGE')
    footer._p.append(field)
    doc.save(target)


if __name__ == '__main__':
    export_report(Path(sys.argv[1]), Path(sys.argv[2]))
