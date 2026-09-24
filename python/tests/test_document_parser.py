from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from openpyxl import Workbook
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

from bondbuddy_document_parser.parser import (
    MEDIA_CSV,
    MEDIA_DOCX,
    MEDIA_PDF,
    MEDIA_TEXT,
    MEDIA_XLSX,
    parse_request,
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class DocumentParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="bondbuddy-parser-test-")
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def request(self, path: Path, media_type: str, **options):
        return parse_request({
            "schema_version": "document-parse-request-v1",
            "request_id": "parse-synthetic",
            "material": {
                "material_id": "material-synthetic",
                "material_version": 1,
                "media_type": media_type,
                "sha256": digest(path),
                "authorized_local_path": str(path.resolve()),
            },
            "options": options,
        })

    def test_docx_effective_revisions_tables_and_no_fake_page(self):
        path = self.root / "synthetic.docx"
        document = Document()
        paragraph = document.add_paragraph("资产总额")
        deleted = OxmlElement("w:del")
        deleted_run = OxmlElement("w:r")
        deleted_text = OxmlElement("w:delText")
        deleted_text.text = "999万元"
        deleted_run.append(deleted_text)
        deleted.append(deleted_run)
        paragraph._p.append(deleted)
        inserted = OxmlElement("w:ins")
        inserted_run = OxmlElement("w:r")
        inserted_text = OxmlElement("w:t")
        inserted_text.text = "120万元"
        inserted_run.append(inserted_text)
        inserted.append(inserted_run)
        paragraph._p.append(inserted)
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "单位"
        table.cell(0, 1).text = "万元"
        table.cell(1, 0).text = "营业收入"
        table.cell(1, 1).text = "88"
        document.save(path)

        result = self.request(path, MEDIA_DOCX)
        self.assertEqual(result["status"], "needs_confirmation")
        body = "\n".join(record["literal_quote"] for record in result["records"])
        self.assertIn("120万元", body)
        self.assertNotIn("999万元", body)
        self.assertLess(body.index("单位"), body.index("营业收入"))
        self.assertTrue(any(":t001:r001:c001:" in record["locator"]["stable_ref"] for record in result["records"]))
        self.assertTrue(all("page" not in record["locator"] for record in result["records"]))
        self.assertEqual(result["document"]["revision_summary"], {"insertions": 1, "deletions": 1})
        self.assertEqual(digest(path), result["material"]["sha256"])

    def test_pdf_preserves_page_and_source_bbox(self):
        path = self.root / "synthetic.pdf"
        pdf = canvas.Canvas(str(path), pagesize=(300, 300))
        pdf.drawString(50, 250, "Synthetic revenue 123.45")
        pdf.showPage()
        pdf.save()
        result = self.request(path, MEDIA_PDF)
        self.assertEqual(result["status"], "parsed")
        self.assertEqual(result["document"]["page_count"], 1)
        record = result["records"][0]
        self.assertEqual(record["material_id"], "material-synthetic")
        self.assertEqual(record["content_hash"], result["material"]["sha256"])
        self.assertEqual(record["locator_type"], "pdf_bbox")
        self.assertEqual(record["locator"]["page"], 1)
        self.assertEqual(set(record["locator"]["bbox"]), {"x0", "top", "x1", "bottom"})
        self.assertTrue(record["formatting"]["fonts"])
        self.assertTrue(record["formatting"]["word_boxes"])

    def test_pdf_page_limit_fails_without_partial_success(self):
        path = self.root / "two-pages.pdf"
        pdf = canvas.Canvas(str(path), pagesize=(300, 300))
        for value in ("page one", "page two"):
            pdf.drawString(50, 250, value)
            pdf.showPage()
        pdf.save()
        result = self.request(path, MEDIA_PDF, max_pages=1)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["error"]["code"], "MATERIAL_LIMIT_EXCEEDED")

    def test_encrypted_pdf_fails_without_exposing_partial_text(self):
        source = self.root / "plain.pdf"
        encrypted = self.root / "encrypted.pdf"
        pdf = canvas.Canvas(str(source), pagesize=(300, 300))
        pdf.drawString(50, 250, "Secret synthetic amount 123")
        pdf.showPage()
        pdf.save()
        writer = PdfWriter()
        for page in PdfReader(source).pages:
            writer.add_page(page)
        writer.encrypt("synthetic-password")
        with encrypted.open("wb") as stream:
            writer.write(stream)

        result = self.request(encrypted, MEDIA_PDF)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["error"]["code"], "MATERIAL_ENCRYPTED")

    def test_damaged_docx_fails_without_partial_success(self):
        path = self.root / "damaged.docx"
        path.write_bytes(b"PK synthetic but not a valid Office archive")
        result = self.request(path, MEDIA_DOCX)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["records"], [])
        self.assertEqual(result["error"]["code"], "MATERIAL_UNREADABLE")

    def test_xlsx_preserves_cells_units_order_and_unknown_formula(self):
        path = self.root / "synthetic.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.title = "合并报表"
        sheet.append(["项目", "单位", "2025年"])
        sheet.append(["营业收入", "万元", 123.45])
        sheet.append(["合计", "万元", "=C2"])
        sheet.merge_cells("A4:B4")
        sheet["A4"] = "附注"
        book.save(path)
        result = self.request(path, MEDIA_XLSX)
        quotes = [record["literal_quote"] for record in result["records"]]
        self.assertEqual(quotes[:6], ["项目", "单位", "2025年", "营业收入", "万元", "123.45"])
        formula = next(record for record in result["records"] if record["literal_quote"] == "=C2")
        self.assertIn("formula_result_not_cached", formula["uncertainty"])
        self.assertEqual(next(record for record in result["records"] if record["literal_quote"] == "附注")["locator"]["merged_range"], "A4:B4")
        self.assertEqual(result["status"], "needs_confirmation")

    def test_csv_and_text_have_native_positions(self):
        csv_path = self.root / "synthetic.csv"
        csv_path.write_text('项目,金额\n"营业收入","1,234.50"\n', encoding="utf-8")
        csv_result = self.request(csv_path, MEDIA_CSV)
        self.assertEqual([record["literal_quote"] for record in csv_result["records"]], ["项目", "金额", "营业收入", "1,234.50"])
        self.assertEqual(csv_result["records"][-1]["locator"], {"row": 2, "column": 2, "stable_ref": "csv:r000002:c0002"})

        text_path = self.root / "synthetic.txt"
        text_path.write_text("第一行\n\n第三行\n", encoding="utf-8")
        text_result = self.request(text_path, MEDIA_TEXT)
        self.assertEqual([record["locator"]["line"] for record in text_result["records"]], [1, 3])

    def test_hash_mismatch_and_binary_text_fail_closed(self):
        path = self.root / "synthetic.txt"
        path.write_bytes(b"ok")
        payload = {
            "schema_version": "document-parse-request-v1",
            "request_id": "parse-synthetic",
            "material": {
                "material_id": "material-synthetic",
                "material_version": 1,
                "media_type": MEDIA_TEXT,
                "sha256": "0" * 64,
                "authorized_local_path": str(path.resolve()),
            },
            "options": {},
        }
        self.assertEqual(parse_request(payload)["error"]["code"], "MATERIAL_CONTENT_MISMATCH")
        path.write_bytes(b"bad\x00text")
        payload["material"]["sha256"] = digest(path)
        self.assertEqual(parse_request(payload)["error"]["code"], "MATERIAL_CONTENT_MISMATCH")

    def test_cli_emits_one_json_response_and_no_path(self):
        path = self.root / "synthetic.txt"
        path.write_text("synthetic evidence", encoding="utf-8")
        payload = {
            "schema_version": "document-parse-request-v1",
            "request_id": "parse-cli",
            "material": {
                "material_id": "material-cli",
                "material_version": 1,
                "media_type": MEDIA_TEXT,
                "sha256": digest(path),
                "authorized_local_path": str(path.resolve()),
            },
            "options": {},
        }
        completed = subprocess.run(
            [sys.executable, "-m", "bondbuddy_document_parser"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "parsed")
        self.assertNotIn(str(path), completed.stdout)
        self.assertEqual(completed.stderr, "")


if __name__ == "__main__":
    unittest.main()
