"""Synthetic component fixture only. No customer documents, model call or Word export."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile

from docx import Document
from docx.oxml import OxmlElement
from bondbuddy_document_parser.parser import parse_request, MEDIA_DOCX

fixture = json.loads(Path(__file__).with_name("input.json").read_text(encoding="utf-8"))
with tempfile.TemporaryDirectory(prefix="bondbuddy-update-") as directory:
    path = Path(directory) / "synthetic.docx"
    document = Document()
    for block in fixture["baseline"]["blocks"][:4]:
        paragraph = document.add_paragraph(block["text"])
        if "--revisions" in sys.argv and block["recordId"] == "p2":
            deletion = OxmlElement("w:del")
            run = OxmlElement("w:r")
            text = OxmlElement("w:delText")
            text.text = "已删除旧数999999"
            run.append(text)
            deletion.append(run)
            paragraph._p.append(deletion)
    table = document.add_table(rows=2, cols=3)
    for block in fixture["baseline"]["blocks"][4:]:
        cell = block["locator"]["path"][0]
        table.cell(cell["row"]-1, cell["column"]-1).text = block["text"]
    document.save(path)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    parsed = parse_request({
        "schema_version": "document-parse-request-v1", "request_id": "synthetic-parse",
        "material": {"material_id": "history-1", "material_version": 1,
                     "media_type": MEDIA_DOCX, "sha256": before, "authorized_local_path": str(path.resolve())},
        "options": {},
    })
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    print(json.dumps(parsed, ensure_ascii=True))
