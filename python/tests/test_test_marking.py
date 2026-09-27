from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from docx import Document
from lxml import etree

from bondbuddy_word_delivery.test_marking import MARK, mark


class TestWordMarking(unittest.TestCase):
    def test_banner_header_and_located_review_comment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest, target = (root / name for name in ("source.docx", "manifest.json", "target.docx"))
            doc = Document()
            doc.add_paragraph("合成风险说明。")
            doc.save(source)
            manifest.write_text(json.dumps([{
                "rule_id": "synthetic-rule", "reason_code": "needs_review", "evidence_ref": "docx:p0001"
            }]), encoding="utf-8")
            mark(str(source), str(manifest), str(target))
            with zipfile.ZipFile(target) as archive:
                document = archive.read("word/document.xml").decode()
                comments = archive.read("word/comments.xml").decode()
                headers = [name for name in archive.namelist() if name.startswith("word/header") and name.endswith(".xml")]
                self.assertTrue(headers)
                self.assertIn(MARK, document)
                self.assertIn(MARK, archive.read(headers[0]).decode())
                self.assertIn("合成风险说明", document)
                self.assertIn("待人工确认", comments)
                self.assertIn("synthetic-rule", comments)
                self.assertIsNotNone(etree.fromstring(archive.read("word/document.xml")))

    def test_missing_docx_anchor_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest, target = (root / name for name in ("source.docx", "manifest.json", "target.docx"))
            doc = Document()
            doc.add_paragraph("合成正文")
            doc.save(source)
            manifest.write_text(json.dumps([{
                "rule_id": "synthetic-rule", "reason_code": "needs_review", "evidence_ref": "docx:p9999"
            }]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "TEST_UNCOVERED_ANCHOR_MISSING"):
                mark(str(source), str(manifest), str(target))
            self.assertFalse(target.exists())
