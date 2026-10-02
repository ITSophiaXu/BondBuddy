"""Opt-in, read-only regression against the explicitly authorized rq-202506 DOCX.

Run with:
    BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION=1 \
      PYTHONPATH=python python -m unittest python.tests.test_authorized_docx_regression -v

The fixture is read in place and checked against its sample manifest before parsing.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from bondbuddy_document_parser.parser import MEDIA_DOCX, PARSER_VERSION, parse_request


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "tests/samples/2026-09-25/manifest.json"
DATE_QUESTIONS_PATH = REPO_ROOT / "tests/samples/2026-09-25/rq-202506/DATE-QUESTIONS.md"
SUPPORTED_PARSER_VERSIONS = {
    "bondbuddy-document-parser-1.0.4.1",
    "bondbuddy-document-parser-1.0.6",
    "bondbuddy-document-parser-1.0.7",
    "bondbuddy-document-parser-1.0.8",
}


class AuthorizedDocxRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if os.environ.get("BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION") != "1":
            raise unittest.SkipTest(
                "set BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION=1 to parse the authorized real DOCX"
            )
        if PARSER_VERSION not in SUPPORTED_PARSER_VERSIONS:
            raise AssertionError(
                "authorized DOCX regression has no reviewed expectation for parser version "
                f"{PARSER_VERSION!r}; supported versions are "
                f"{', '.join(sorted(SUPPORTED_PARSER_VERSIONS))}"
            )

    def test_authorized_docx_full_record_sequence_and_date_anchors_are_stable(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

        def manifest_entry(file_id: str) -> dict:
            matching = [
                entry
                for case in manifest["cases"]
                for entry in case["files"]
                if entry["file_id"] == file_id
            ]
            self.assertEqual(len(matching), 1, f"manifest must contain {file_id} exactly once")
            return matching[0]

        def checked_request(entry: dict, request_id: str) -> dict:
            source_path = MANIFEST_PATH.parent / entry["path"]
            self.assertEqual(entry["media_type"], MEDIA_DOCX)
            self.assertTrue(source_path.is_file(), f"authorized source is missing: {source_path}")
            source_bytes = source_path.read_bytes()
            source_hash = hashlib.sha256(source_bytes).hexdigest()
            self.assertEqual(len(source_bytes), entry["bytes"], "authorized source byte count differs from manifest")
            self.assertEqual(source_hash, entry["sha256"], "authorized source SHA-256 differs from manifest")
            return {
                "schema_version": "document-parse-request-v1",
                "request_id": request_id,
                "material": {
                    "material_id": entry["file_id"],
                    "material_version": 1,
                    "media_type": MEDIA_DOCX,
                    "sha256": entry["sha256"],
                    "authorized_local_path": str(source_path.resolve()),
                },
                "options": {},
            }

        historical_entry = manifest_entry("rq-202506-01")
        historical_request = checked_request(historical_entry, "authorized-rq-202506-01-regression")
        first = parse_request(historical_request)
        second = parse_request(historical_request)
        self.assertEqual(first["status"], "needs_confirmation")
        self.assertEqual(second["status"], "needs_confirmation")
        self.assertEqual(first["material"]["sha256"], historical_entry["sha256"])
        self.assertEqual(second["material"]["sha256"], historical_entry["sha256"])

        def normalized_records_digest(records: list[dict]) -> str:
            normalized = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

        self.assertEqual(
            normalized_records_digest(first["records"]),
            normalized_records_digest(second["records"]),
            "the ordered full evidence record sequence changed between identical parses",
        )
        historical_path = MANIFEST_PATH.parent / historical_entry["path"]
        with zipfile.ZipFile(historical_path) as archive:
            document_xml = ET.fromstring(archive.read("word/document.xml"))
        word_namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        xml_paragraphs = list(document_xml.iter(f"{word_namespace}p"))
        for evidence in historical_entry["evidence"]:
            with self.subTest(manifest_locator=evidence["locator"]):
                paragraph_match = re.fullmatch(r"word/document\.xml//w:p\[(\d+)\]", evidence["locator"])
                self.assertIsNotNone(paragraph_match, "manifest evidence must identify an original DOCX paragraph")
                paragraph_number = int(paragraph_match.group(1))
                self.assertGreaterEqual(paragraph_number, 1)
                self.assertLessEqual(paragraph_number, len(xml_paragraphs))
                source_paragraph = "".join(
                    node.text or ""
                    for node in xml_paragraphs[paragraph_number - 1].iter(f"{word_namespace}t")
                )
                quote = evidence["quote"]
                self.assertIn(quote, source_paragraph, "manifest quote must be present in its original OOXML paragraph")
                matching_records = [record for record in first["records"] if record["literal_quote"] == quote]
                self.assertEqual(len(matching_records), 1, "manifest quote must resolve to exactly one parser record")
                record = matching_records[0]
                self.assertEqual(record["material_id"], historical_entry["file_id"])
                self.assertEqual(record["content_hash"], historical_entry["sha256"])
                self.assertNotIn("page", record["locator"], "DOCX records must not invent static page numbers")
                if paragraph_number == 249:
                    self.assertIn(
                        {"table": 2, "row": 28, "column": 3},
                        record["locator"]["path"],
                        "manifest p[249] must resolve to table 2 / row 28 / cell 3",
                    )

        # DATE-QUESTIONS.md explicitly identifies rq-202506-04 as the source of these
        # quotes. Keep the historical prospectus double-parse above as the large-record
        # deterministic check, and validate these separate anchors against their source.
        attachment_entry = manifest_entry("rq-202506-04")
        self.assertIn("材料ID `rq-202506-04`", DATE_QUESTIONS_PATH.read_text(encoding="utf-8"))
        attachment_request = checked_request(attachment_entry, "authorized-rq-202506-04-anchor-regression")
        attachment = parse_request(attachment_request)
        self.assertEqual(attachment["status"], "needs_confirmation")

        # Quotes are copied from DATE-QUESTIONS.md; source bytes stay untouched.
        expected_anchors = (
            (
                "截止2025年3月31日，本公司将任丘市安居资产运营有限公司、任丘市城市运营有限公司、任丘市市政工程公司、任丘市洁杰环保有限公司、任丘市美丽乡村建设有限公司、任丘建投融资担保有限公司、任丘建投睿盛置业发展有限公司、任丘市村村通水利工程有限公司、任丘市经发产业投资集团有限公司、任丘建投污水处理有限公司、任丘建投城市综合开发有限公司、任丘建投基础设施建设有限公司、任丘建投科技发展有限公司等13家子公司纳入合并范围。",
                {"paragraph": 13},
                "docx:p0013",
            ),
            (
                "本公司财务报告于2025年4月20日经总经理办公会批准报出。",
                {"paragraph": 15},
                "docx:p0015",
            ),
            (
                "以下除另有指明者外，资产负债表项目“年初”指2025年1月1日数据，“期末”指2025年6月31日数据，利润表以及现金流量表项目“上期”指2024年1-6月，“本期”指2025年1-6月，金额单位为人民币元。",
                {"paragraph": 465},
                "docx:p0465",
            ),
        )
        date_questions = DATE_QUESTIONS_PATH.read_text(encoding="utf-8")
        for quote, expected_path_part, expected_stable_ref in expected_anchors:
            with self.subTest(quote=quote[:32]):
                self.assertIn(quote, date_questions, "expected quote must remain verbatim in DATE-QUESTIONS.md")
                matches = [record for record in attachment["records"] if record["literal_quote"].strip() == quote]
                self.assertEqual(len(matches), 1, f"expected exactly one record for DATE-QUESTIONS quote {quote[:32]!r}")
                record = matches[0]
                self.assertEqual(record["locator_type"], "docx_block")
                self.assertNotIn("page", record["locator"], "DOCX records must not invent static page numbers")
                self.assertIn(expected_path_part, record["locator"]["path"])
                self.assertEqual(record["locator"]["stable_ref"], expected_stable_ref)
                self.assertEqual(record["material_id"], attachment_entry["file_id"])
                self.assertEqual(record["content_hash"], attachment_entry["sha256"])


if __name__ == "__main__":
    unittest.main()
