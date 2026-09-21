"""Stable paragraph locations shared by extraction and Word annotation."""
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.oxml.ns import qn


def walk_blocks(parent, prefix=''):
    body = parent.element.body if hasattr(parent, 'element') and hasattr(parent.element, 'body') else parent._tc
    p_index = 0
    t_index = 0
    for child in body:
        if child.tag == qn('w:p'):
            p_index += 1
            yield f'{prefix}P{p_index:04d}', Paragraph(child, parent)
        elif child.tag == qn('w:tbl'):
            t_index += 1
            table = Table(child, parent)
            seen = set()
            for ri, row in enumerate(table.rows, 1):
                for ci, cell in enumerate(row.cells, 1):
                    if cell._tc in seen:
                        continue
                    seen.add(cell._tc)
                    yield from walk_blocks(cell, f'{prefix}T{t_index:03d}R{ri:03d}C{ci:03d}')
