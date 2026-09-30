from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from docx import Document
from lxml import etree

from bondbuddy_word_delivery.test_marking import MARK, PENDING_REVIEW, mark


class TestWordMarking(unittest.TestCase):
    def test_banner_header_and_located_review_comment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest, target = (root / name for name in ("source.docx", "manifest.json", "target.docx"))
            doc = Document()
            doc.add_paragraph("合成风险说明。")
            doc.save(source)
            manifest.write_text(json.dumps([{
                "kind": "rule_check", "rule_id": "synthetic-rule", "reason_code": "needs_review",
                "source_ref_ids": ["synthetic-source"], "evidence_ref": "docx:p0001"
            }]), encoding="utf-8")
            mark(str(source), str(manifest), str(target))
            with zipfile.ZipFile(target) as archive:
                document = archive.read("word/document.xml").decode()
                comments = archive.read("word/comments.xml").decode()
                headers = [name for name in archive.namelist() if name.startswith("word/header") and name.endswith(".xml")]
                self.assertTrue(headers)
                self.assertIn(MARK, document)
                self.assertIn(PENDING_REVIEW, document)
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
                "kind": "rule_check", "rule_id": "synthetic-rule", "reason_code": "needs_review",
                "source_ref_ids": ["synthetic-source"], "evidence_ref": "docx:p9999"
            }]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "TEST_UNCOVERED_ANCHOR_MISSING"):
                mark(str(source), str(manifest), str(target))
            self.assertFalse(target.exists())

    def test_unmapped_coverage_gap_preserves_provenance_without_fake_rule(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest, target = (root / name for name in ("source.docx", "manifest.json", "target.docx"))
            doc = Document()
            doc.add_paragraph("合成正文")
            doc.save(source)
            gap = {"kind": "coverage_gap", "manifest_id": "synthetic-manifest", "manifest_version": "draft.6",
                   "item_id": "no-rule-yet", "candidate_asset_sha256": "a" * 64, "disposition": "uncovered",
                   "area": "资金用途", "rationale": "缺少配套依据", "rule_ids": [],
                   "source_ref_ids": ["synthetic-source"], "reason_code": "coverage_uncovered", "evidence_ref": None}
            manifest.write_text(json.dumps([gap]), encoding="utf-8")
            mark(str(source), str(manifest), str(target))
            with zipfile.ZipFile(target) as archive:
                comments = archive.read("word/comments.xml").decode()
                body = archive.read("word/document.xml").decode()
                for expected in ("no-rule-yet", "资金用途", "缺少配套依据", "synthetic-manifest@draft.6",
                                 "a" * 64, "synthetic-source", "无显式关联"):
                    self.assertIn(expected, comments)
                self.assertIn("待人工确认：覆盖项 no-rule-yet", body)
                self.assertNotIn("规则 no-rule-yet", comments)

    def test_scope_exclusion_is_rejected_in_uncovered_list(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest, target = (root / name for name in ("source.docx", "manifest.json", "target.docx"))
            doc = Document()
            doc.add_paragraph("合成正文")
            doc.save(source)
            manifest.write_text(json.dumps([{"kind": "coverage_gap", "item_id": "other-markets",
                "disposition": "not_applicable", "reason_code": "scope_exclusion", "source_ref_ids": []}]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "TEST_UNCOVERED_ITEMS_INVALID"):
                mark(str(source), str(manifest), str(target))
            self.assertFalse(target.exists())


    def test_copy_only_marking_keeps_auxiliary_bytes_and_visible_body_banner(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, manifest, target = (root / name for name in ('source.docx', 'manifest.json', 'target.docx'))
            doc = Document()
            doc.add_paragraph('合成原文100万元')
            doc.sections[0].header.paragraphs[0].text = '原页眉2023年'
            doc.sections[0].footer.paragraphs[0].text = '原页脚'
            doc.save(source)
            manifest.write_text('[]', encoding='utf-8')
            mark(str(source), str(manifest), str(target), preserve_auxiliary=True)
            with zipfile.ZipFile(source) as original, zipfile.ZipFile(target) as marked:
                for name in original.namelist():
                    if name.startswith(('word/header', 'word/footer', 'word/media/', 'word/_rels/')):
                        self.assertEqual(original.read(name), marked.read(name), name)
                self.assertIn(MARK, marked.read('word/document.xml').decode())
                self.assertIn('合成原文100万元', marked.read('word/document.xml').decode())
