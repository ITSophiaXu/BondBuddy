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
from unittest.mock import patch

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from openpyxl import Workbook, load_workbook
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
from bondbuddy_document_parser import parser as parser_module


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rewrite_docx(source_path: Path, target_path: Path, replacements: dict[str, bytes | None], additions: dict[str, bytes] | None = None) -> None:
    with zipfile.ZipFile(source_path) as source, zipfile.ZipFile(target_path, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            replacement = replacements.get(entry.filename, source.read(entry))
            if replacement is not None:
                target.writestr(entry, replacement)
        for name, value in (additions or {}).items():
            if name not in {entry.filename for entry in source.infolist()}:
                target.writestr(name, value)


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
    def test_docx_note_scope_truncation_cannot_remain_resolved(self):
        references = [{"note_id": "1", "note_id_sha256": hashlib.sha256(b"1").hexdigest(),
                       "stable_ref": "docx:p:1"}
                      for _ in range(parser_module.MAX_DOCX_AUXILIARY_SCOPE_REFERENCES + 1)]
        relation = {"relationship_id": "rIdNote", "relationship_type": "footnotes", "mode": "internal",
                    "target_member": "word/footnotes.xml", "status": "resolved"}
        context = {"note_references_by_id": {("footnote", "1"): references},
                   "relationships_by_type": {"footnotes": [relation]}, "relationship_state": "valid",
                   "relationship_sha256": "a" * 64, "note_reference_overflow": False}
        scope = parser_module._note_scope("footnote", "1", context)
        self.assertEqual(scope["status"], "unknown")
        self.assertEqual(scope["reason"], "scope_detail_limit_exceeded")
        self.assertTrue(scope["truncated"])
        self.assertEqual(len(scope["body_references"]), parser_module.MAX_DOCX_AUXILIARY_SCOPE_REFERENCES)

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

    def test_docx_auxiliary_targets_are_stable_safe_and_leave_body_records_unchanged(self):
        base_path = self.root / "auxiliary-base.docx"
        document = Document()
        body = document.add_paragraph("Synthetic body amount 120")
        document.save(base_path)
        base = self.request(base_path, MEDIA_DOCX)

        path = self.root / "auxiliary.docx"
        document = Document(base_path)
        document.sections[0].header.paragraphs[0].text = "Synthetic issuer and year header"
        document.sections[0].footer.paragraphs[0].text = "Synthetic footer"
        body = document.paragraphs[0]
        drawing = OxmlElement("w:drawing")
        doc_properties = OxmlElement("wp:docPr")
        doc_properties.set("id", "77")
        doc_properties.set("descr", "Synthetic drawing alt text")
        drawing.append(doc_properties)
        blip = OxmlElement("a:blip")
        blip.set(qn("r:embed"), "rIdMissingImage")
        drawing.append(blip)
        body._p.append(drawing)
        document.save(path)

        footnotes = b'''<?xml version="1.0" encoding="UTF-8"?>
          <w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:footnote w:id="9"><w:p/></w:footnote>
          </w:footnotes>'''
        endnotes = b'''<?xml version="1.0" encoding="UTF-8"?>
          <w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:endnote w:id="12"><w:p><w:r><w:t>Synthetic endnote-only secret</w:t></w:r></w:p></w:endnote>
          </w:endnotes>'''
        for prefix, uri in {
            "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
            "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        }.items():
            ET.register_namespace(prefix, uri)
        rewritten = self.root / "auxiliary-with-notes.docx"
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                raw = source.read(entry)
                if entry.filename == "word/document.xml":
                    root = ET.fromstring(raw)
                    paragraph = root.find(".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p")
                    assert paragraph is not None
                    for reference_tag, note_id in (("footnoteReference", "9"), ("endnoteReference", "12")):
                        run = ET.SubElement(paragraph, "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}r")
                        ET.SubElement(run, f"{{http://schemas.openxmlformats.org/wordprocessingml/2006/main}}{reference_tag}",
                                      {"{http://schemas.openxmlformats.org/wordprocessingml/2006/main}id": note_id})
                    raw = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                elif entry.filename == "word/_rels/document.xml.rels":
                    root = ET.fromstring(raw)
                    relation_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
                    for note_kind in ("footnotes", "endnotes"):
                        ET.SubElement(root, f"{{{relation_ns}}}Relationship", {
                            "Id": f"rId{note_kind}",
                            "Type": f"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{note_kind}",
                            "Target": f"{note_kind}.xml",
                        })
                    raw = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                target.writestr(entry, raw)
            target.writestr("word/footnotes.xml", footnotes)
            target.writestr("word/endnotes.xml", endnotes)

        result = self.request(rewritten, MEDIA_DOCX)
        repeated = self.request(rewritten, MEDIA_DOCX)
        self.assertEqual(result["parser_version"], "bondbuddy-document-parser-1.0.7")
        self.assertEqual([item["target_id"] for item in result["document"]["auxiliary_targets"]],
                         [item["target_id"] for item in repeated["document"]["auxiliary_targets"]])
        semantic_body_fields = ("record_id", "locator_type", "locator", "literal_quote", "context", "extraction_method",
                                "confidence", "uncertainty", "formatting")
        self.assertEqual([[record[key] for key in semantic_body_fields] for record in base["records"]],
                         [[record[key] for key in semantic_body_fields] for record in result["records"]])
        self.assertEqual([warning["code"] for warning in result["warnings"]],
                         ["DOCX_DRAWINGS", "DOCX_AUXILIARY_PARTS"])
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertTrue(all(record["confidence"] is None and record["uncertainty"] == [] for record in result["records"]))
        targets = result["document"]["auxiliary_targets"]
        header = next(item for item in targets if item["kind"] == "header")
        self.assertEqual(header["part_name"], "word/header1.xml")
        self.assertTrue(header["parseable"] and header["text_summary"]["has_text"])
        self.assertEqual(header["scope"]["status"], "resolved")
        self.assertEqual(header["scope"]["section_references"][0]["reference_type"], "default")
        self.assertEqual(header["scope"]["relationships"][0]["target_part"], header["part_name"])
        self.assertNotIn("Synthetic issuer and year header", json.dumps(result, ensure_ascii=False))
        empty_footnote = next(item for item in targets if item["kind"] == "footnote")
        self.assertEqual(empty_footnote["locator"]["note_id"], "9")
        self.assertEqual(empty_footnote["parse_status"], "empty")
        self.assertEqual(empty_footnote["text_summary"]["character_count"], 0)
        self.assertEqual(empty_footnote["scope"]["status"], "resolved")
        self.assertEqual(empty_footnote["scope"]["body_references"][0]["stable_ref"], result["records"][0]["locator"]["stable_ref"])
        endnote = next(item for item in targets if item["kind"] == "endnote")
        self.assertTrue(endnote["text_summary"]["has_text"])
        self.assertEqual(endnote["scope"]["status"], "resolved")
        self.assertNotIn("Synthetic endnote-only secret", json.dumps(result, ensure_ascii=False))
        drawing_target = next(item for item in targets if item["kind"] == "drawing")
        self.assertEqual(drawing_target["locator"]["parent_stable_ref"], result["records"][0]["locator"]["stable_ref"])
        self.assertEqual(drawing_target["locator"]["drawing_ids"], ["77"])
        self.assertTrue(drawing_target["locator_resolved"])
        self.assertFalse(drawing_target["parseable"])
        self.assertEqual(drawing_target["parse_status"], "not_extracted")
        self.assertIsNone(drawing_target["text_summary"])
        self.assertEqual(drawing_target["scope"]["status"], "unknown")
        self.assertEqual(drawing_target["scope"]["relationships"][0]["status"], "missing")

    def test_docx_section_headers_bind_only_to_explicit_sections_and_keep_inheritance_unknown(self):
        path = self.root / "section-scoped-headers.docx"
        document = Document()
        document.add_paragraph("Synthetic section one body")
        document.sections[0].header.paragraphs[0].text = "Synthetic first section header"
        second = document.add_section(1)
        second.header.is_linked_to_previous = False
        second.header.paragraphs[0].text = "Synthetic second section header"
        document.add_paragraph("Synthetic section two body")
        document.add_section(1)  # linked-to-previous is intentionally implicit
        document.add_paragraph("Synthetic section three body")
        document.save(path)

        result = self.request(path, MEDIA_DOCX)
        headers = [target for target in result["document"]["auxiliary_targets"] if target["kind"] == "header" and
                   target["text_summary"] is not None and target["text_summary"]["has_text"]]
        self.assertEqual(len(headers), 2)
        first = next(target for target in headers if target["scope"]["section_references"][0]["section_index"] == 1)
        second_header = next(target for target in headers if target["scope"]["section_references"][0]["section_index"] == 2)
        self.assertEqual(first["scope"]["status"], "partially_resolved")
        self.assertEqual(second_header["scope"]["status"], "partially_resolved")
        self.assertEqual(first["scope"]["unknown_sections"], [2, 3])
        self.assertEqual(second_header["scope"]["unknown_sections"], [1, 3])
        self.assertNotEqual(first["scope"]["relationships"][0]["target_part"],
                            second_header["scope"]["relationships"][0]["target_part"])

    def test_docx_relationships_fail_closed_for_unreferenced_missing_and_hostile_targets(self):
        source_path = self.root / "relationship-source.docx"
        document = Document()
        document.add_paragraph("Synthetic relationship body")
        document.sections[0].header.paragraphs[0].text = "Synthetic hidden header"
        document.save(source_path)
        with zipfile.ZipFile(source_path) as archive:
            document_xml = archive.read("word/document.xml")
            rels_xml = archive.read("word/_rels/document.xml.rels")
        for prefix, uri in {
            "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
            "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        }.items():
            ET.register_namespace(prefix, uri)
        document_root = ET.fromstring(document_xml)
        for reference in document_root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}headerReference"):
            reference.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"] = "rIdMissingHeader"
        missing_rels = self.root / "missing-header-relation.docx"
        rewrite_docx(source_path, missing_rels, {
            "word/document.xml": ET.tostring(document_root, encoding="utf-8", xml_declaration=True),
        })
        missing_result = self.request(missing_rels, MEDIA_DOCX)
        missing_target = next(item for item in missing_result["document"]["auxiliary_targets"]
                              if item["parse_status"] == "missing_relationship")
        self.assertEqual(missing_target["scope"]["section_references"][0]["relationship_id"], "rIdMissingHeader")
        self.assertNotIn("Synthetic hidden header", json.dumps(missing_result, ensure_ascii=False))

        relation_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
        hostile_root = ET.Element(f"{{{relation_ns}}}Relationships")
        ET.SubElement(hostile_root, f"{{{relation_ns}}}Relationship", {
            "Id": "rIdHeader", "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
            "Target": "https://secret.invalid/customer-path/header.xml", "TargetMode": "External",
        })
        hostile_path = self.root / "hostile-relationship-root.docx"
        rewrite_docx(source_path, hostile_path, {
            "word/_rels/document.xml.rels": ET.tostring(hostile_root, encoding="utf-8", xml_declaration=True),
        })
        hostile_result = self.request(hostile_path, MEDIA_DOCX)
        external_relationship = next(item for item in hostile_result["document"]["auxiliary_targets"]
                                     if item["parse_status"] == "external_relationship")
        self.assertEqual(external_relationship["scope"]["status"], "unknown")
        self.assertEqual(external_relationship["scope"]["relationships"][0]["status"], "external")
        self.assertNotIn("secret.invalid", json.dumps(hostile_result, ensure_ascii=False))
        self.assertNotIn("customer-path", json.dumps(hostile_result, ensure_ascii=False))

        forged_root = ET.Element("forgedRelationships")
        ET.SubElement(forged_root, "Relationship", {
            "Id": "rIdHeader", "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
            "Target": "https://secret.invalid/customer-path/header.xml", "TargetMode": "External",
        })
        forged_path = self.root / "forged-relationship-root.docx"
        rewrite_docx(source_path, forged_path, {
            "word/_rels/document.xml.rels": ET.tostring(forged_root, encoding="utf-8", xml_declaration=True),
        })
        forged_result = self.request(forged_path, MEDIA_DOCX)
        self.assertEqual(forged_result["status"], "failed")
        self.assertNotIn("secret.invalid", json.dumps(forged_result, ensure_ascii=False))

        spoofed_root = ET.fromstring(rels_xml)
        for relationship in spoofed_root:
            if relationship.get("Type", "").endswith("/header"):
                relationship.set("Type", "https://attacker.invalid/relationships/header")
        spoofed_path = self.root / "spoofed-relationship-type.docx"
        rewrite_docx(source_path, spoofed_path, {
            "word/_rels/document.xml.rels": ET.tostring(spoofed_root, encoding="utf-8", xml_declaration=True),
        })
        spoofed_result = self.request(spoofed_path, MEDIA_DOCX)
        spoofed_header = next(item for item in spoofed_result["document"]["auxiliary_targets"] if item["kind"] == "header")
        self.assertEqual(spoofed_header["scope"]["status"], "unknown")
        self.assertEqual(spoofed_header["scope"]["reason"], "no_matching_internal_relationship")

        unreferenced_root = ET.fromstring(document_xml)
        for section_properties in unreferenced_root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr"):
            for reference in list(section_properties):
                if reference.tag == "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}headerReference":
                    section_properties.remove(reference)
        unreferenced_path = self.root / "unreferenced-header-part.docx"
        rewrite_docx(source_path, unreferenced_path, {
            "word/document.xml": ET.tostring(unreferenced_root, encoding="utf-8", xml_declaration=True),
        })
        unreferenced_result = self.request(unreferenced_path, MEDIA_DOCX)
        unreferenced_header = next(item for item in unreferenced_result["document"]["auxiliary_targets"] if item["kind"] == "header")
        self.assertEqual(unreferenced_header["scope"]["status"], "unknown")
        self.assertEqual(unreferenced_header["scope"]["reason"], "not_explicitly_referenced_by_section")

    def test_docx_missing_note_relationship_or_target_does_not_confirm_body_reference(self):
        source_path = self.root / "missing-note-source.docx"
        document = Document()
        paragraph = document.add_paragraph("Synthetic body with note reference")
        reference_run = OxmlElement("w:r")
        note_reference = OxmlElement("w:footnoteReference")
        note_reference.set(qn("w:id"), "17")
        reference_run.append(note_reference)
        paragraph._p.append(reference_run)
        document.save(source_path)
        with zipfile.ZipFile(source_path) as archive:
            document_xml = ET.fromstring(archive.read("word/document.xml"))
            rels_root = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        for prefix, uri in {
            "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        }.items():
            ET.register_namespace(prefix, uri)
        relation_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
        # Preserve the required OPC root but leave the body note reference without
        # a matching footnotes relationship. This remains a readable package.
        for relationship in list(rels_root):
            if relationship.get("Type", "").endswith("/footnotes"):
                rels_root.remove(relationship)
        missing_path = self.root / "missing-note-part.docx"
        rewrite_docx(source_path, missing_path, {
            "word/document.xml": ET.tostring(document_xml, encoding="utf-8", xml_declaration=True),
            "word/_rels/document.xml.rels": ET.tostring(rels_root, encoding="utf-8", xml_declaration=True),
        })
        result = self.request(missing_path, MEDIA_DOCX)
        missing_note = next(item for item in result["document"]["auxiliary_targets"] if item["kind"] == "footnote")
        self.assertEqual(missing_note["parse_status"], "missing_reference_target")
        self.assertEqual(missing_note["scope"]["status"], "unknown")
        self.assertEqual(missing_note["scope"]["body_references"][0]["note_id"], "17")
        self.assertEqual(missing_note["scope"]["body_references"][0]["stable_ref"], result["records"][0]["locator"]["stable_ref"])

    def test_docx_auxiliary_malicious_or_malformed_xml_stays_unresolved_without_expansion(self):
        document_path = self.root / "auxiliary-xml.docx"
        document = Document()
        document.add_paragraph("Synthetic safe body")
        document.save(document_path)
        malicious = b'''<!DOCTYPE w:footnotes [<!ENTITY private SYSTEM "file:///etc/passwd">]>
          <w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:footnote w:id="4"><w:p><w:r><w:t>&private;</w:t></w:r></w:p></w:footnote>
          </w:footnotes>'''
        malformed = b"<w:endnotes><w:endnote>"
        rewritten = self.root / "auxiliary-hostile.docx"
        with zipfile.ZipFile(document_path) as source, zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                target.writestr(entry, source.read(entry))
            target.writestr("word/footnotes.xml", malicious)
            target.writestr("word/endnotes.xml", malformed)

        result = self.request(rewritten, MEDIA_DOCX)
        targets = result["document"]["auxiliary_targets"]
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(next(item for item in targets if item["part_name"] == "word/footnotes.xml")["parse_status"], "unsafe_xml")
        self.assertEqual(next(item for item in targets if item["part_name"] == "word/endnotes.xml")["parse_status"], "parse_failed")
        self.assertNotIn("/etc/passwd", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("root:", json.dumps(result, ensure_ascii=False))
        self.assertNotIn("private SYSTEM", json.dumps(result, ensure_ascii=False))

    def test_docx_auxiliary_unknown_parts_remain_locatable_and_oversize_is_rejected_before_read(self):
        document_path = self.root / "auxiliary-prefix-source.docx"
        document = Document()
        document.add_paragraph("Synthetic safe body")
        document.save(document_path)
        odd_header = "word/headerLegacy.xml"
        oversize_footer = "word/footerCustom.xml"
        rewritten = self.root / "auxiliary-prefix-members.docx"
        with zipfile.ZipFile(document_path) as source, zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                target.writestr(entry, source.read(entry))
            target.writestr(odd_header, b"<not-a-known-header/>" )
            target.writestr(oversize_footer, b"x" * (parser_module.MAX_DOCX_AUXILIARY_PART_BYTES + 1))

        original_open = zipfile.ZipFile.open
        opened_members = []

        def guarded_open(archive, name, *args, **kwargs):
            member_name = name.filename if isinstance(name, zipfile.ZipInfo) else name
            opened_members.append(member_name)
            self.assertNotEqual(member_name, oversize_footer, "oversize auxiliary part must not be opened/inflated")
            return original_open(archive, name, *args, **kwargs)

        with patch.object(zipfile.ZipFile, "open", guarded_open):
            result = self.request(rewritten, MEDIA_DOCX)

        targets = result["document"]["auxiliary_targets"]
        expected_name_hash = hashlib.sha256(odd_header.encode("utf-8")).hexdigest()
        unknown = next(item for item in targets if item["kind"] == "auxiliary_part" and
                       item["locator"].get("member_name_sha256") == expected_name_hash)
        self.assertEqual(unknown["part_name"], f"word/auxiliary-{expected_name_hash}.xml")
        self.assertEqual(unknown["locator"]["member_name_sha256"], expected_name_hash)
        self.assertEqual(unknown["parse_status"], "unrecognized_part")
        self.assertFalse(unknown["locator_resolved"])
        self.assertFalse(unknown["parseable"])
        self.assertNotIn(odd_header, json.dumps(result, ensure_ascii=False))
        oversize = next(item for item in targets if item["parse_status"] == "size_limited")
        self.assertIsNone(oversize["part_sha256"])
        self.assertIsNone(oversize["target_sha256"])
        self.assertNotIn(oversize_footer, opened_members)
        self.assertEqual(result["warnings"][0]["code"], "DOCX_AUXILIARY_PARTS")

    def test_docx_auxiliary_empty_part_gets_placeholder_and_target_cap_fails_closed(self):
        empty_path = self.root / "empty-header-source.docx"
        document = Document()
        document.add_paragraph("Synthetic body")
        document.sections[0].header.paragraphs[0].text = "will be replaced"
        document.save(empty_path)
        rewritten = self.root / "empty-header.docx"
        empty_header = b'''<?xml version="1.0" encoding="UTF-8"?>
          <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'''
        with zipfile.ZipFile(empty_path) as source, zipfile.ZipFile(rewritten, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                target.writestr(entry, empty_header if entry.filename == "word/header1.xml" else source.read(entry))

        result = self.request(rewritten, MEDIA_DOCX)
        placeholder = next(item for item in result["document"]["auxiliary_targets"] if item["kind"] == "header")
        self.assertIsNone(placeholder["locator"]["paragraph_index"])
        self.assertEqual(placeholder["parse_status"], "empty")
        self.assertFalse(placeholder["text_summary"]["has_text"])

        capped_path = self.root / "capped-header.docx"
        capped = Document()
        capped.add_paragraph("Synthetic body")
        capped.sections[0].header.paragraphs[0].text = "first target"
        capped.sections[0].header.add_paragraph("second target")
        capped.save(capped_path)
        with patch.object(parser_module, "MAX_DOCX_AUXILIARY_TARGETS", 1):
            capped_result = self.request(capped_path, MEDIA_DOCX)
        self.assertEqual(capped_result["status"], "failed")
        self.assertEqual(capped_result["error"]["code"], "MATERIAL_LIMIT_EXCEEDED")

    def test_docx_duplicate_or_invalid_package_entries_fail_with_safe_response(self):
        valid_path = self.root / "duplicate-source.docx"
        document = Document()
        document.add_paragraph("Synthetic body")
        document.save(valid_path)
        invalid_path = self.root / "duplicate-member.docx"
        with zipfile.ZipFile(valid_path) as source, zipfile.ZipFile(invalid_path, "w", zipfile.ZIP_DEFLATED) as target:
            for entry in source.infolist():
                target.writestr(entry, source.read(entry))
            target.writestr("word/document.xml", b"<invalid/>")
        result = self.request(invalid_path, MEDIA_DOCX)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "MATERIAL_UNREADABLE")
        self.assertNotIn(str(invalid_path), json.dumps(result, ensure_ascii=False))

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

    def test_docx_table_cells_keep_element_identity_and_deduplicate_real_merges(self):
        path = self.root / "cell-identity.docx"
        document = Document()
        table = document.add_table(rows=32, cols=4)
        table.cell(0, 0).merge(table.cell(0, 1)).text = "merged-cell"
        expected = ["merged-cell"]
        for column in range(2, 4):
            value = f"cell-1-{column + 1}"
            table.cell(0, column).text = value
            expected.append(value)
        for row in range(1, 32):
            for column in range(4):
                value = f"cell-{row + 1}-{column + 1}"
                table.cell(row, column).text = value
                expected.append(value)
        document.save(path)

        first = self.request(path, MEDIA_DOCX)
        second = self.request(path, MEDIA_DOCX)
        quotes = [record["literal_quote"] for record in first["records"]]
        self.assertEqual(first["status"], "parsed")
        self.assertEqual(quotes, expected)
        self.assertEqual([record["literal_quote"] for record in second["records"]], expected)
        self.assertEqual(first["records"], second["records"])
        self.assertEqual(quotes.count("merged-cell"), 1)
        merged = first["records"][0]
        self.assertEqual(merged["locator"]["path"][0], {"table": 1, "row": 1, "column": 1})

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

    def test_docx_move_source_range_keeps_unmarked_text_and_excludes_move_from(self):
        path = self.root / "move-source-range.docx"
        document = Document()
        paragraph = document.add_paragraph("期末资产：")
        range_start = OxmlElement("w:moveFromRangeStart")
        range_start.set(qn("w:id"), "7")
        range_start.set(qn("w:author"), "Synthetic")
        paragraph._p.append(range_start)

        # The range markers identify a move-source container; ordinary run
        # content inside that range is not itself moved-from content.
        current_run = OxmlElement("w:r")
        current_properties = OxmlElement("w:rPr")
        current_fonts = OxmlElement("w:rFonts")
        current_fonts.set(qn("w:ascii"), "CurrentAmountFont")
        current_fonts.set(qn("w:eastAsia"), "CurrentAmountFont")
        current_size = OxmlElement("w:sz")
        current_size.set(qn("w:val"), "26")
        current_properties.extend([current_fonts, current_size])
        current_run.append(current_properties)
        current_text = OxmlElement("w:t")
        current_text.text = "120万元"
        current_run.append(current_text)
        paragraph._p.append(current_run)

        moved_from = OxmlElement("w:moveFrom")
        old_run = OxmlElement("w:r")
        old_properties = OxmlElement("w:rPr")
        old_fonts = OxmlElement("w:rFonts")
        old_fonts.set(qn("w:ascii"), "OldAmountFont")
        old_fonts.set(qn("w:eastAsia"), "OldAmountFont")
        old_size = OxmlElement("w:sz")
        old_size.set(qn("w:val"), "44")
        old_properties.extend([old_fonts, old_size])
        old_run.append(old_properties)
        old_text = OxmlElement("w:t")
        old_text.text = "999万元"
        old_run.append(old_text)
        moved_from.append(old_run)
        paragraph._p.append(moved_from)

        range_end = OxmlElement("w:moveFromRangeEnd")
        range_end.set(qn("w:id"), "7")
        paragraph._p.append(range_end)
        paragraph.add_run("，核验完毕")
        document.save(path)

        result = self.request(path, MEDIA_DOCX)
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(len(result["records"]), 1)
        record = result["records"][0]
        self.assertEqual(record["literal_quote"], "期末资产：120万元，核验完毕")
        self.assertNotIn("999万元", record["literal_quote"])
        self.assertEqual(record["locator_type"], "docx_block")
        self.assertEqual(record["locator"]["stable_ref"], "docx:p0001")
        self.assertNotIn("page", record["locator"])
        self.assertIn("docx_revision_effective_text_unresolved", record["uncertainty"])
        formats = record["formatting"]["runs"]
        amount_format = next(item for item in formats if item["sample"] == "120万元")
        self.assertEqual(amount_format["latin_font"], "CurrentAmountFont")
        self.assertEqual(amount_format["east_asia_font"], "CurrentAmountFont")
        self.assertEqual(amount_format["half_points"], "26")
        self.assertNotIn("999万元", json.dumps(record["formatting"], ensure_ascii=False))
        self.assertNotIn("OldAmountFont", json.dumps(record["formatting"], ensure_ascii=False))

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

    def test_xlsx_skips_whitespace_only_strings_and_preserves_record_order(self):
        path = self.root / "whitespace-cells.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.append(["start", "   ", "\t", "\u3000", 42, "=A1", "end"])
        book.save(path)

        result = self.request(path, MEDIA_XLSX)

        self.assertEqual(
            [record["literal_quote"] for record in result["records"]],
            ["start", "42", "=A1", "end"],
        )
        self.assertEqual(
            [record["record_id"] for record in result["records"]],
            [f"evidence-{index:06d}" for index in range(1, 5)],
        )
        self.assertEqual(
            [record["locator"]["cell"] for record in result["records"]],
            ["A1", "E1", "F1", "G1"],
        )
        formula = result["records"][2]
        self.assertEqual(formula["literal_quote"], "=A1")
        self.assertIn("formula_result_not_cached", formula["uncertainty"])
        self.assertEqual(result["document"]["cached_formula_results"], 0)

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

    def test_xlsx_external_workbook_cache_is_unverified_without_loading_target(self):
        source = self.root / "external-formula-source.xlsx"
        path = self.root / "external-formula.xlsx"
        book = Workbook()
        book.active["A1"] = "=[1]Source!A1"
        book.save(source)

        sheet_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
        type_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as target:
            for info in original.infolist():
                payload = original.read(info.filename)
                if info.filename == "xl/worksheets/sheet1.xml":
                    root = ET.fromstring(payload)
                    cell = root.find(f".//{{{sheet_ns}}}c[@r='A1']")
                    self.assertIsNotNone(cell)
                    value = cell.find(f"{{{sheet_ns}}}v")
                    if value is None:
                        value = ET.SubElement(cell, f"{{{sheet_ns}}}v")
                    value.text = "42"
                    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                elif info.filename == "xl/workbook.xml":
                    root = ET.fromstring(payload)
                    references = ET.SubElement(root, f"{{{sheet_ns}}}externalReferences")
                    ET.SubElement(references, f"{{{sheet_ns}}}externalReference", {f"{{{rel_ns}}}id": "rIdExternal"})
                    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                elif info.filename == "xl/_rels/workbook.xml.rels":
                    root = ET.fromstring(payload)
                    ET.SubElement(root, f"{{{package_rel_ns}}}Relationship", {
                        "Id": "rIdExternal", "Type": f"{rel_ns}/externalLink", "Target": "externalLinks/externalLink1.xml",
                    })
                    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                elif info.filename == "[Content_Types].xml":
                    root = ET.fromstring(payload)
                    ET.SubElement(root, f"{{{type_ns}}}Override", {
                        "PartName": "/xl/externalLinks/externalLink1.xml",
                        "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml",
                    })
                    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                target.writestr(info, payload)
            target.writestr("xl/externalLinks/externalLink1.xml", f'<externalLink xmlns="{sheet_ns}" xmlns:r="{rel_ns}"><externalBook r:id="rId1"/></externalLink>')
            target.writestr("xl/externalLinks/_rels/externalLink1.xml.rels", f'<Relationships xmlns="{package_rel_ns}"><Relationship Id="rId1" Type="{rel_ns}/externalLinkPath" Target="file:///nonexistent/synthetic-source.xlsx" TargetMode="External"/></Relationships>')

        with patch.object(parser_module, "load_workbook", wraps=load_workbook) as loader:
            result = self.request(path, MEDIA_XLSX)
        self.assertEqual([call.kwargs["keep_links"] for call in loader.call_args_list], [False, False])
        self.assertEqual(result["status"], "needs_confirmation")
        self.assertEqual(result["document"]["cached_formula_results"], 1)
        formula = next(record for record in result["records"] if record["literal_quote"] == "=[1]Source!A1")
        self.assertEqual(formula["formatting"]["cached_formula_result"], "42")
        self.assertIn("formula_cached_result_unverified", formula["uncertainty"])

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
