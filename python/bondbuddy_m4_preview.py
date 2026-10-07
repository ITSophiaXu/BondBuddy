"""Bounded preview of the actual delivered Word, including native table cells."""
import sys
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

LIMIT = 150_000


def preview(source: Path):
    with ZipFile(source) as archive:
        if sum(item.file_size for item in archive.infolist()) > 250_000_000:
            raise ValueError("PREVIEW_RESOURCE_LIMIT")
    document = Document(source)
    lines, count = [], 0
    for index, node in enumerate(document.element.body):
        if node.tag == qn("w:p"):
            block = Paragraph(node, document).text
        elif node.tag == qn("w:tbl"):
            table = Table(node, document)
            block = "\n".join(" | ".join(cell.text for cell in row.cells) for row in table.rows)
        else:
            continue
        if not block.strip():
            continue
        line = f"[正文位置 {index + 1}]\n{block}"
        if count + len(line) > LIMIT:
            lines.append("[预览达到长度上限；完整内容请下载本准确版本 Word。]")
            break
        lines.append(line)
        count += len(line)
    return "\n\n".join(lines)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(preview(Path(sys.argv[1])))
