from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from openpyxl import Workbook
import pdfplumber
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

from bondbuddy_document_parser.parser import (
    MEDIA_CSV,
    MEDIA_DOCX,
    MEDIA_PDF,
    MEDIA_TEXT,
    MEDIA_XLSX,
    parse_request,
    stream_parse_request,
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class EventSink:
    """Consumes protocol lines as they are written, retaining only small test observations."""

    def __init__(self) -> None:
        self.pending = ""
        self.events: list[dict] = []
        self.records: list[dict] = []

    def write(self, value: str) -> None:
        self.pending += value
        while "\n" in self.pending:
            line, self.pending = self.pending.split("\n", 1)
            if not line:
                continue
            event = json.loads(line)
            self.events.append({"type": event["type"], **({key: event[key] for key in ("record_count", "has_uncertainty", "response")} if event["type"] == "end" else {}),
                                **({"response": event["response"]} if event["type"] == "failure" else {})})
            if event["type"] == "record":
                self.records.append(event["record"])


class DocumentParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="bondbuddy-parser-test-")
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def request(self, path: Path, media_type: str, **options):
        return parse_request(self.request_payload(path, media_type, **options))

    def request_payload(self, path: Path, media_type: str, **options):
        return {
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
        }

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
        amount = next(record for record in result["records"] if record["literal_quote"] == "88")
        self.assertEqual(amount["locator"]["path"], [
            {"table": 1, "row": 2, "column": 2}, {"paragraph": 1},
        ])
        self.assertEqual(Document(path).tables[0].cell(1, 1).text, amount["literal_quote"])
        self.assertEqual(result["document"]["revision_summary"], {"insertions": 1, "deletions": 1})
        self.assertEqual(digest(path), result["material"]["sha256"])

    def test_docx_table_cells_are_not_lost_to_reused_object_ids(self):
        path = self.root / "many-cells.docx"
        document = Document()
        table = document.add_table(rows=32, cols=4)
        for row in range(32):
            for col in range(4):
                table.cell(row, col).text = f"cell-{row:02d}-{col}"
        table.cell(0, 0).merge(table.cell(0, 1)).text = "cell-00-0"
        document.save(path)

        expected = {f"cell-{row:02d}-{col}" for row in range(32) for col in range(4)} - {"cell-00-1"}
        first = self.request(path, MEDIA_DOCX)
        second = self.request(path, MEDIA_DOCX)
        for parsed in (first, second):
            quotes = [record["literal_quote"] for record in parsed["records"]]
            self.assertEqual(len(quotes), 127)
            self.assertEqual(set(quotes), expected)
            self.assertEqual(len({record["locator"]["stable_ref"] for record in parsed["records"]}), 127)
        self.assertEqual(first["records"], second["records"])

    def test_docx_move_revisions_use_current_amount_and_preserve_order(self):
        path = self.root / "moved-amount.docx"
        document = Document()
        paragraph = document.add_paragraph("期末资产：")

        move_from = OxmlElement("w:moveFrom")
        old_run = OxmlElement("w:r")
        old_text = OxmlElement("w:t")
        old_text.text = "999万元"
        old_run.append(old_text)
        move_from.append(old_run)
        paragraph._p.append(move_from)

        move_to = OxmlElement("w:moveTo")
        current_run = OxmlElement("w:r")
        current_text = OxmlElement("w:t")
        current_text.text = "120万元"
        current_run.append(current_text)
        move_to.append(current_run)
        paragraph._p.append(move_to)
        paragraph.add_run("，核验完毕")
        document.save(path)

        result = self.request(path, MEDIA_DOCX)
        quote = result["records"][0]["literal_quote"]
        self.assertEqual(quote, "期末资产：120万元，核验完毕")
        self.assertNotIn("999万元", quote)
        self.assertLess(quote.index("期末资产"), quote.index("120万元"))
        self.assertLess(quote.index("120万元"), quote.index("核验完毕"))
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertTrue(any(warning["code"] == "DOCX_REVISIONS_RESOLVED" for warning in result["warnings"]))

    def test_docx_revision_formatting_uses_only_effective_runs_in_order(self):
        path = self.root / "revision-formatting.docx"
        document = Document()
        paragraph = document.add_paragraph("金额：")

        def revision_run(container, text, font_name, half_points):
            run = OxmlElement("w:r")
            properties = OxmlElement("w:rPr")
            fonts = OxmlElement("w:rFonts")
            fonts.set(qn("w:ascii"), font_name)
            fonts.set(qn("w:eastAsia"), font_name)
            size = OxmlElement("w:sz")
            size.set(qn("w:val"), str(half_points))
            properties.extend([fonts, size])
            run.append(properties)
            value = OxmlElement("w:t")
            value.text = text
            run.append(value)
            container.append(run)

        deleted = OxmlElement("w:del")
        revision_run(deleted, "旧删除数字999", "DeletedFont", 44)
        paragraph._p.append(deleted)
        inserted = OxmlElement("w:ins")
        revision_run(inserted, "新插入数字120", "InsertedFont", 26)
        paragraph._p.append(inserted)

        move_from = OxmlElement("w:moveFrom")
        revision_run(move_from, "旧移动数字888", "MovedFromFont", 48)
        paragraph._p.append(move_from)
        move_to = OxmlElement("w:moveTo")
        revision_run(move_to, "新移动数字130", "MovedToFont", 30)
        paragraph._p.append(move_to)
        paragraph.add_run("，有效正文")
        document.save(path)

        result = self.request(path, MEDIA_DOCX)
        record = result["records"][0]
        formats = record["formatting"]["runs"]

        self.assertEqual(record["literal_quote"], "金额：新插入数字120新移动数字130，有效正文")
        self.assertEqual([item["sample"] for item in formats], [
            "金额：", "新插入数字120", "新移动数字130", "，有效正文",
        ])
        self.assertEqual(formats[1]["latin_font"], "InsertedFont")
        self.assertEqual(formats[1]["east_asia_font"], "InsertedFont")
        self.assertEqual(formats[1]["half_points"], "26")
        self.assertEqual(formats[2]["latin_font"], "MovedToFont")
        self.assertEqual(formats[2]["east_asia_font"], "MovedToFont")
        self.assertEqual(formats[2]["half_points"], "30")
        for excluded in ("DeletedFont", "MovedFromFont", "旧删除数字999", "旧移动数字888"):
            self.assertNotIn(excluded, json.dumps(record["formatting"], ensure_ascii=False))
        self.assertEqual(result["status"], "needs_confirmation")

    def test_docx_unresolved_revision_markers_require_confirmation(self):
        path = self.root / "revision-range.docx"
        document = Document()
        paragraph = document.add_paragraph("期末资产：120万元")
        range_start = OxmlElement("w:moveFromRangeStart")
        range_start.set(qn("w:id"), "7")
        range_start.set(qn("w:author"), "Synthetic")
        range_end = OxmlElement("w:moveFromRangeEnd")
        range_end.set(qn("w:id"), "7")
        paragraph._p.insert(0, range_start)
        paragraph._p.append(range_end)
        paragraph_mark_move = OxmlElement("w:moveFrom")
        paragraph._p.get_or_add_pPr().append(paragraph_mark_move)
        document.save(path)

        result = self.request(path, MEDIA_DOCX)
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertIn("docx_revision_effective_text_unresolved", result["records"][0]["uncertainty"])
        self.assertTrue(any(
            warning["code"] == "DOCX_UNSUPPORTED_REVISION_MARKERS"
            for warning in result["warnings"]
        ))

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
        with pdfplumber.open(path) as source:
            page = source.pages[record["locator"]["page"] - 1]
            bbox = record["locator"]["bbox"]
            recovered = page.crop((bbox["x0"], bbox["top"], bbox["x1"], bbox["bottom"])).extract_text()
        self.assertEqual(recovered, record["literal_quote"])

    def test_streamed_pdf_keeps_text_anchors_word_boxes_and_uncovered_pages(self):
        path = self.root / "streamed.pdf"
        pdf = canvas.Canvas(str(path), pagesize=(300, 300))
        pdf.drawString(50, 250, "Synthetic proceeds 123.45")
        pdf.showPage()
        pdf.drawString(50, 250, "Synthetic review anchor")
        pdf.showPage()
        pdf.showPage()
        pdf.save()

        sink = EventSink()
        stream_parse_request(self.request_payload(path, MEDIA_PDF), sink)
        self.assertEqual([event["type"] for event in sink.events], ["start", "record", "record", "end"])
        self.assertEqual(sink.events[-1]["record_count"], 2)
        self.assertEqual(sink.events[-1]["has_uncertainty"], False)
        self.assertEqual([record["locator"]["stable_ref"] for record in sink.records], ["pdf:p0001:l0001", "pdf:p0002:l0001"])
        self.assertEqual(sink.records[0]["material_id"], "material-synthetic")
        self.assertEqual(sink.records[0]["content_hash"], digest(path))
        self.assertTrue(sink.records[0]["formatting"]["word_boxes"])
        self.assertEqual(sink.records[0]["formatting"]["word_boxes"][0]["text"], "Synthetic")
        end = sink.events[-1]
        self.assertEqual(end["type"], "end")
        response = next(event["response"] for event in sink.events if event["type"] == "end")
        self.assertEqual(response["status"], "needs_confirmation")
        self.assertEqual(response["document"]["page_count"], 3)
        self.assertEqual(response["document"]["pages_without_native_text"], [3])

    def test_streamed_text_parser_crosses_read_chunks_without_losing_line_anchors(self):
        path = self.root / "streamed.txt"
        with path.open("w", encoding="utf-8", newline="") as stream:
            for index in range(20_000):
                if index and index % 100 == 0:
                    stream.write("\n")
                stream.write(f"Synthetic line {index:05d} with native amount 123.45\n")

        sink = EventSink()
        stream_parse_request(self.request_payload(path, MEDIA_TEXT), sink)
        self.assertEqual([event["type"] for event in sink.events[:2]], ["start", "record"])
        self.assertEqual(sink.events[-1]["type"], "end")
        self.assertEqual(sink.events[-1]["record_count"], 20_000)
        self.assertEqual(sink.records[0]["locator"], {"line": 1, "stable_ref": "text:l000001"})
        self.assertEqual(sink.records[-1]["locator"], {"line": 20_199, "stable_ref": "text:l020199"})
        self.assertEqual(sink.records[-1]["record_id"], "evidence-020000")
        self.assertEqual(sink.records[0]["literal_quote"], "Synthetic line 00000 with native amount 123.45")

    def test_streamed_text_overlong_line_has_terminal_limit_without_success_summary(self):
        path = self.root / "overlong.txt"
        path.write_text("first safe line\n" + "x" * (16 * 1024 + 1) + "\n", encoding="utf-8")
        sink = EventSink()
        stream_parse_request(self.request_payload(path, MEDIA_TEXT), sink)
        self.assertEqual([event["type"] for event in sink.events], ["start", "record", "failure"])
        self.assertNotIn("end", [event["type"] for event in sink.events])
        self.assertEqual(sink.events[-1]["response"]["error"]["code"], "MATERIAL_LIMIT_EXCEEDED")

    def test_pdf_with_unreadable_page_requires_confirmation(self):
        path = self.root / "text-and-blank.pdf"
        pdf = canvas.Canvas(str(path), pagesize=(300, 300))
        pdf.drawString(50, 250, "Synthetic first page")
        pdf.showPage()
        pdf.showPage()
        pdf.save()
        result = self.request(path, MEDIA_PDF)
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(result["document"]["page_count"], 2)
        self.assertEqual(result["document"]["pages_without_native_text"], [2])
        self.assertTrue(any(warning["code"] == "PDF_PAGES_WITHOUT_TEXT" for warning in result["warnings"]))

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

    def test_damaged_pdf_fails_without_partial_success(self):
        path = self.root / "damaged.pdf"
        path.write_bytes(b"%PDF-1.4\ntruncated synthetic body")
        result = self.request(path, MEDIA_PDF)
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

    def test_xlsx_preserves_cached_formula_result_as_unverified_evidence(self):
        source = self.root / "formula-source.xlsx"
        path = self.root / "formula-with-cache.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.append(["项目", "单位", "2025年"])
        sheet.append(["营业收入", "万元", 123.45])
        sheet.append(["合计", "万元", "=C2"])
        book.save(source)

        # openpyxl intentionally does not calculate formulas. Add a cached value
        # to the synthetic OOXML fixture to exercise reading an existing cache.
        spreadsheet_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        with zipfile.ZipFile(source) as source_archive, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as target_archive:
            for info in source_archive.infolist():
                payload = source_archive.read(info.filename)
                if info.filename == "xl/worksheets/sheet1.xml":
                    root = ET.fromstring(payload)
                    cell = root.find(f".//{{{spreadsheet_ns}}}c[@r='C3']")
                    self.assertIsNotNone(cell)
                    value = cell.find(f"{{{spreadsheet_ns}}}v")
                    if value is None:
                        value = ET.SubElement(cell, f"{{{spreadsheet_ns}}}v")
                    value.text = "123.45"
                    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                target_archive.writestr(info, payload)

        result = self.request(path, MEDIA_XLSX)
        formula = next(record for record in result["records"] if record["literal_quote"] == "=C2")
        self.assertEqual(formula["formatting"]["cached_formula_result"], "123.45")
        self.assertIn("formula_cached_result_unverified", formula["uncertainty"])
        self.assertNotIn("formula_result_not_cached", formula["uncertainty"])
        self.assertEqual(result["document"]["cached_formula_results"], 1)
        self.assertTrue(any(warning["code"] == "XLSX_FORMULA_CACHE_UNVERIFIED" for warning in result["warnings"]))
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
