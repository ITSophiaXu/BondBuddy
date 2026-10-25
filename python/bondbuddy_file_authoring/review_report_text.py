"""Extract a saved Word report in document order for the correction exporter."""
import re
import sys
from pathlib import Path
from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn


def report_text(path):
    doc = Document(path)
    lines = []
    for element in doc.element.body:
        if element.tag == qn('w:p'):
            p = Paragraph(element, doc)
            heading = re.match(r'Heading ([1-6])$', p.style.name or '')
            lines.append(('#' * int(heading[1]) + ' ' if heading else '') + p.text)
        elif element.tag == qn('w:tbl'):
            for row in Table(element, doc).rows:
                lines.append('| ' + ' | '.join(c.text.replace('|', '\\|') for c in row.cells) + ' |')
    return '\n'.join(lines)


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(report_text(Path(sys.argv[1])), encoding='utf8')
