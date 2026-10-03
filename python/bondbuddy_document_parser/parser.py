from __future__ import annotations

import csv
import codecs
import hashlib
import io
import json
import posixpath
import re
import zipfile
import zlib
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import quote, unquote, urlsplit
from lxml import etree

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell
import pdfplumber
from pypdf import PdfReader
from .paragraph_outline import ParagraphOutlineResolver


REQUEST_SCHEMA_VERSION = "document-parse-request-v1"
RESPONSE_SCHEMA_VERSION = "document-parse-response-v1"
PARSER_VERSION = "bondbuddy-document-parser-1.0.8"
DEFAULT_MAX_PAGES = 1500
MAX_UNCOMPRESSED_OFFICE_BYTES = 300 * 1024 * 1024
MAX_WORKSHEET_CELLS = 2_000_000
MAX_TEXT_BYTES = 100 * 1024 * 1024
MAX_TEXT_LINE_CHARS = 16 * 1024
MAX_DOCX_AUXILIARY_PART_BYTES = 4 * 1024 * 1024
MAX_DOCX_AUXILIARY_TARGETS = 10_000
MAX_DOCX_AUXILIARY_RELATIONSHIPS = 10_000
MAX_DOCX_AUXILIARY_SCOPE_REFERENCES = 128
MAX_DOCX_AUXILIARY_SCOPE_BYTES = 4 * 1024 * 1024
TRANSITIONAL_RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
STRICT_RELATIONSHIP_NS = "http://purl.oclc.org/ooxml/officeDocument/relationships"

MEDIA_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MEDIA_PDF = "application/pdf"
MEDIA_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MEDIA_CSV = "text/csv"
MEDIA_TEXT = "text/plain"
SUPPORTED_MEDIA_TYPES = {MEDIA_DOCX, MEDIA_PDF, MEDIA_XLSX, MEDIA_CSV, MEDIA_TEXT}


class ParseFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.safe_message = message


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_archive(path: Path, required_entry: str) -> None:
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = {entry.filename for entry in entries}
            if len(names) != len(entries):
                raise ParseFailure("MATERIAL_UNREADABLE", "Office document contains ambiguous package entries")
            if required_entry not in names:
                raise ParseFailure("MATERIAL_CONTENT_MISMATCH", "Office container does not match its declared format")
            total = 0
            for info in entries:
                total += info.file_size
                if total > MAX_UNCOMPRESSED_OFFICE_BYTES:
                    raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "Expanded Office content exceeds the parser limit")
    except zipfile.BadZipFile as exc:
        raise ParseFailure("MATERIAL_UNREADABLE", "Office document is damaged or unreadable") from exc


def _record(
    index: int,
    locator_type: str,
    locator: dict[str, Any],
    literal_quote: str,
    *,
    context: str = "",
    formatting: dict[str, Any] | None = None,
    uncertainty: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "record_id": f"evidence-{index:06d}",
        "material_id": None,
        "material_version": None,
        "content_hash": None,
        "locator_type": locator_type,
        "locator": locator,
        "literal_quote": literal_quote,
        "context": context,
        "extraction_method": "native_text",
        "extractor_version": PARSER_VERSION,
        "confidence": None,
        "uncertainty": uncertainty or [],
        "formatting": formatting or {},
    }


def _final_text(element: Any) -> str:
    """Return effective inline Word text without deleted or moved-from runs."""
    pieces: list[str] = []

    def visit(node: Any, excluded: bool = False) -> None:
        is_excluded = excluded or node.tag in {qn("w:del"), qn("w:moveFrom")}
        if not is_excluded:
            if node.tag == qn("w:t") and node.text:
                pieces.append(node.text)
            elif node.tag == qn("w:tab"):
                pieces.append("\t")
            elif node.tag in {qn("w:br"), qn("w:cr")}:
                pieces.append("\n")
        for child in node:
            visit(child, is_excluded)

    visit(element)
    return "".join(pieces)


def _style_chain(style: Any) -> Iterator[Any]:
    seen: set[str] = set()
    while style is not None and style.style_id not in seen:
        seen.add(style.style_id)
        yield style.element.find(qn("w:rPr"))
        style = style.base_style


def _effective_runs(paragraph: Paragraph) -> Iterator[Any]:
    """Yield visible runs in XML order, including runs inside accepted revisions."""
    excluded_tags = {qn("w:del"), qn("w:moveFrom")}

    def visit(node: Any, excluded: bool = False) -> Iterator[Any]:
        excluded = excluded or node.tag in excluded_tags
        if excluded:
            return
        if node.tag == qn("w:r"):
            yield Run(node, paragraph)
            return
        for child in node:
            yield from visit(child, excluded)

    yield from visit(paragraph._p)


def _paragraph_formatting(
    paragraph: Paragraph,
    paragraph_style: Any,
    style_layers: Any,
    default_rpr: Any,
    outline_level: str | None,
) -> dict[str, Any]:
    summaries: list[dict[str, Any]] = []
    previous_key: str | None = None
    for run in _effective_runs(paragraph):
        text = _final_text(run._r)
        if not text.strip():
            continue
        layers = [run._r.find(qn("w:rPr")), *style_layers(run._r.style, WD_STYLE_TYPE.CHARACTER),
                  *style_layers(paragraph._p.style, WD_STYLE_TYPE.PARAGRAPH), default_rpr]
        values: dict[str, str] = {}
        for prop, tag, attr in (
            ("latin_font", "w:rFonts", "w:ascii"),
            ("east_asia_font", "w:rFonts", "w:eastAsia"),
            ("latin_theme", "w:rFonts", "w:asciiTheme"),
            ("east_asia_theme", "w:rFonts", "w:eastAsiaTheme"),
            ("half_points", "w:sz", "w:val"),
        ):
            for layer in layers:
                node = layer.find(qn(tag)) if layer is not None else None
                value = node.get(qn(attr)) if node is not None else None
                if value is not None:
                    values[prop] = value
                    break
        key = json.dumps(values, sort_keys=True)
        if key != previous_key:
            summaries.append({**values, "sample": text[:100], "characters": 0})
            previous_key = key
        summary = summaries[-1]
        summary["characters"] += len(text)
    ppr = paragraph._p.find(qn("w:pPr"))
    layout: dict[str, dict[str, str]] = {}
    for tag in ("w:jc", "w:spacing", "w:ind", "w:keepNext", "w:pageBreakBefore"):
        node = ppr.find(qn(tag)) if ppr is not None else None
        if node is not None:
            layout[tag.split(":", 1)[1]] = {key.split("}")[-1]: value for key, value in node.attrib.items()}
    return {
        "style": paragraph_style.name if paragraph_style else "",
        "runs": summaries,
        "paragraph_overrides": layout,
        "outline_level": outline_level,
    }


def _walk_docx_blocks(parent: Any, prefix: tuple[dict[str, int], ...] = ()) -> Iterator[tuple[dict[str, Any], Paragraph]]:
    body = parent.element.body if hasattr(parent, "element") and hasattr(parent.element, "body") else parent._tc
    paragraph_index = 0
    table_index = 0
    for child in body:
        if child.tag == qn("w:p"):
            paragraph_index += 1
            yield {"path": [*prefix, {"paragraph": paragraph_index}]}, Paragraph(child, parent)
        elif child.tag == qn("w:tbl"):
            table_index += 1
            table = Table(child, parent)
            # Keep XML cell objects alive while deduplicating merged cells.
            # Temporary proxy ids can be reused and must not identify cells.
            seen: set[Any] = set()
            for row_index, row in enumerate(table.rows, 1):
                for column_index, cell in enumerate(row.cells, 1):
                    identity = cell._tc
                    if identity in seen:
                        continue
                    seen.add(identity)
                    cell_prefix = (*prefix, {"table": table_index, "row": row_index, "column": column_index})
                    yield from _walk_docx_blocks(cell, cell_prefix)


def _docx_locator_text(locator: dict[str, Any]) -> str:
    parts: list[str] = []
    for part in locator["path"]:
        if "table" in part:
            parts.append(f"t{part['table']:03d}:r{part['row']:03d}:c{part['column']:03d}")
        else:
            parts.append(f"p{part['paragraph']:04d}")
    return "docx:" + ":".join(parts)


def _unsupported_docx_revision_count(root: Any) -> int:
    unsupported_revision_tags = {
        "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd",
        "cellIns", "cellDel", "cellMerge", "tblPrChange", "tblGridChange", "trPrChange",
        "tcPrChange", "pPrChange", "rPrChange", "sectPrChange",
    }
    count = sum(
        1 for node in root.iter()
        if isinstance(node.tag, str) and node.tag.rsplit("}", 1)[-1] in unsupported_revision_tags
    )

    # Row insertion/deletion and move markers inside property containers are
    # structural; the inline text walker cannot safely resolve their text view.
    property_tags = {
        qn("w:trPr"), qn("w:pPr"), qn("w:rPr"), qn("w:tcPr"),
        qn("w:tblPr"), qn("w:tblGrid"), qn("w:sectPr"),
    }
    structural_revision_tags = {qn("w:ins"), qn("w:del"), qn("w:moveFrom"), qn("w:moveTo")}
    for node in root.iter():
        if node.tag not in structural_revision_tags:
            continue
        parent = node.getparent()
        while parent is not None:
            if parent.tag in property_tags:
                count += 1
                break
            parent = parent.getparent()
    return count


def _stable_auxiliary_target_id(kind: str, locator: dict[str, Any]) -> str:
    identity = json.dumps([kind, locator], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "aux-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _auxiliary_target(
    kind: str,
    part_name: str,
    locator: dict[str, Any],
    *,
    part_sha256: str | None,
    target_sha256: str | None,
    parse_status: str,
    text: str | None = None,
) -> dict[str, Any]:
    summary = None if text is None else {
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "character_count": len(text),
        "has_text": bool(text.strip()),
    }
    return {
        "target_id": _stable_auxiliary_target_id(kind, locator),
        "kind": kind,
        "part_name": part_name,
        "locator": locator,
        "scope": None,
        "part_sha256": part_sha256,
        "target_sha256": target_sha256,
        "locator_resolved": parse_status not in {"read_failed", "parse_failed", "unsafe_xml", "size_limited", "unrecognized_part",
                                                  "external_relationship", "missing_relationship", "unsafe_relationship",
                                                  "missing_reference_target"},
        "parseable": parse_status in {"parsed", "empty"},
        "parse_status": parse_status,
        "text_summary": summary,
    }


def _safe_docx_part_name(member_name: str, known_part_pattern: re.Pattern[str]) -> str:
    return member_name if known_part_pattern.fullmatch(member_name) else (
        "word/auxiliary-" + hashlib.sha256(member_name.encode("utf-8")).hexdigest() + ".xml"
    )


def _normalize_opc_internal_target(source_part: str, target: str) -> str | None:
    """Resolve an OPC relationship URI to a package member, never a filesystem path."""
    try:
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or "\\" in parsed.path or "\x00" in target:
            return None
        decoded = unquote(parsed.path, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return None
    if not decoded or "\\" in decoded or "\x00" in decoded:
        return None
    joined = decoded.lstrip("/") if decoded.startswith("/") else posixpath.join(posixpath.dirname(source_part), decoded)
    normalized = posixpath.normpath(joined)
    if normalized in {".", ".."} or normalized.startswith("../") or normalized.startswith("/"):
        return None
    return normalized


def _docx_relationship_context(archive: zipfile.ZipFile, body_root: Any, body_locators: dict[Any, str]) -> dict[str, Any]:
    """Read only document-level relationships and explicit section/note references."""
    relationship_path = "word/_rels/document.xml.rels"
    archive_names = set(archive.namelist())
    relationship_sha256: str | None = None
    relationship_state = "missing"
    relationships: dict[str, dict[str, Any]] = {}
    if relationship_path in archive_names:
        try:
            info = archive.getinfo(relationship_path)
            if info.file_size <= MAX_DOCX_AUXILIARY_PART_BYTES:
                with archive.open(info) as member:
                    raw = member.read(MAX_DOCX_AUXILIARY_PART_BYTES + 1)
                if len(raw) <= MAX_DOCX_AUXILIARY_PART_BYTES:
                    relationship_sha256 = hashlib.sha256(raw).hexdigest()
                    if not re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw, flags=re.IGNORECASE):
                        try:
                            rel_root = etree.fromstring(raw, parser=etree.XMLParser(
                                resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False,
                            ))
                            relationship_state = "unsafe"
                            if rel_root.tag == "{http://schemas.openxmlformats.org/package/2006/relationships}Relationships":
                                relationship_state = "valid"
                            for relation in rel_root if relationship_state == "valid" else ():
                                if len(relationships) >= MAX_DOCX_AUXILIARY_RELATIONSHIPS:
                                    relationship_state = "oversized"
                                    relationships.clear()
                                    break
                                if relation.tag != "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship":
                                    relationship_state = "unsafe"
                                    relationships.clear()
                                    break
                                relation_id = relation.get("Id")
                                relation_type_uri = relation.get("Type") or ""
                                relation_type_map = {
                                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header": "header",
                                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer": "footer",
                                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes": "footnotes",
                                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes": "endnotes",
                                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image": "image",
                                    "http://purl.oclc.org/ooxml/officeDocument/relationships/header": "header",
                                    "http://purl.oclc.org/ooxml/officeDocument/relationships/footer": "footer",
                                    "http://purl.oclc.org/ooxml/officeDocument/relationships/footnotes": "footnotes",
                                    "http://purl.oclc.org/ooxml/officeDocument/relationships/endnotes": "endnotes",
                                    "http://purl.oclc.org/ooxml/officeDocument/relationships/image": "image",
                                }
                                relation_type = relation_type_map.get(relation_type_uri, "other")
                                target = relation.get("Target")
                                target_mode = relation.get("TargetMode")
                                if (not relation_id or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", relation_id) or
                                        relation_id in relationships or not target):
                                    relationship_state = "unsafe"
                                    relationships.clear()
                                    break
                                if target_mode == "External":
                                    relationships[relation_id] = {
                                        "relationship_id": relation_id, "relationship_type": relation_type,
                                        "mode": "external", "target_member": None, "status": "external",
                                    }
                                    continue
                                if target_mode not in {None, "Internal"}:
                                    relationships[relation_id] = {
                                        "relationship_id": relation_id, "relationship_type": relation_type,
                                        "mode": "unknown", "target_member": None, "status": "unsafe",
                                    }
                                    continue
                                target_member = _normalize_opc_internal_target("word/document.xml", target)
                                if target_member is None:
                                    relationships[relation_id] = {
                                        "relationship_id": relation_id, "relationship_type": relation_type,
                                        "mode": "unknown", "target_member": None, "status": "unsafe",
                                    }
                                    continue
                                if relation_type in {"header", "footer"} and (
                                        not target_member.startswith("word/") or not target_member.endswith(".xml")):
                                    relationships[relation_id] = {
                                        "relationship_id": relation_id, "relationship_type": relation_type,
                                        "mode": "unknown", "target_member": None, "status": "unsafe",
                                    }
                                    continue
                                expected_note_part = {"footnotes": "word/footnotes.xml", "endnotes": "word/endnotes.xml"}.get(relation_type)
                                if expected_note_part is not None and target_member != expected_note_part:
                                    relationships[relation_id] = {
                                        "relationship_id": relation_id, "relationship_type": relation_type,
                                        "mode": "unknown", "target_member": None, "status": "unsafe",
                                    }
                                    continue
                                relationships[relation_id] = {
                                    "relationship_id": relation_id, "relationship_type": relation_type,
                                    "mode": "internal", "target_member": target_member,
                                    "status": "resolved" if target_member in archive_names else "missing",
                                }
                        except (etree.XMLSyntaxError, ValueError):
                            relationship_state = "unsafe"
                    else:
                        relationship_state = "unsafe"
                else:
                    relationship_state = "oversized"
            else:
                relationship_state = "oversized"
        except (KeyError, OSError, RuntimeError, EOFError, zipfile.BadZipFile, zlib.error):
            relationship_state = "unsafe"

    body = next((child for child in body_root if child.tag == qn("w:body")), None)
    sections: list[dict[str, Any]] = []
    section_overflow = False
    section_reference_overflow = False
    section_reference_count = 0
    if body is not None:
        for child in body.iter(qn("w:p")):
            ppr = child.find(qn("w:pPr"))
            section_properties = ppr.find(qn("w:sectPr")) if ppr is not None else None
            if section_properties is not None:
                if len(sections) >= MAX_DOCX_AUXILIARY_RELATIONSHIPS:
                    section_overflow = True
                    break
                section_index = len(sections) + 1
                section_ref = body_locators.get(child)
                refs = []
                for element_name, relation_kind in (("w:headerReference", "header"), ("w:footerReference", "footer")):
                    for reference in section_properties.findall(qn(element_name)):
                        if section_reference_count >= MAX_DOCX_AUXILIARY_RELATIONSHIPS:
                            section_reference_overflow = True
                            break
                        relation_id = reference.get(f"{{{TRANSITIONAL_RELATIONSHIP_NS}}}id") or reference.get(f"{{{STRICT_RELATIONSHIP_NS}}}id")
                        refs.append({"section_index": section_index, "reference_type": reference.get(qn("w:type")) or "default",
                                     "relationship_id": relation_id, "relationship_type": relation_kind,
                                     "section_stable_ref": section_ref})
                        section_reference_count += 1
                    if section_reference_overflow:
                        break
                sections.append({"section_index": section_index, "references": refs})
                if section_reference_overflow:
                    break
        final_section = body.find(qn("w:sectPr"))
        if final_section is not None:
            if len(sections) >= MAX_DOCX_AUXILIARY_RELATIONSHIPS:
                section_overflow = True
                final_section = None
        if final_section is not None:
            section_index = len(sections) + 1
            refs = []
            for element_name, relation_kind in (("w:headerReference", "header"), ("w:footerReference", "footer")):
                for reference in final_section.findall(qn(element_name)):
                    if section_reference_count >= MAX_DOCX_AUXILIARY_RELATIONSHIPS:
                        section_reference_overflow = True
                        break
                    refs.append({"section_index": section_index, "reference_type": reference.get(qn("w:type")) or "default",
                                 "relationship_id": reference.get(f"{{{TRANSITIONAL_RELATIONSHIP_NS}}}id") or reference.get(f"{{{STRICT_RELATIONSHIP_NS}}}id"),
                                 "relationship_type": relation_kind, "section_stable_ref": None})
                    section_reference_count += 1
                if section_reference_overflow:
                    break
            sections.append({"section_index": section_index, "references": refs})
    if not sections:
        sections.append({"section_index": 1, "references": []})

    note_references: dict[str, list[dict[str, Any]]] = {"footnote": [], "endnote": []}
    note_reference_overflow = False
    if body is not None:
        for note_kind, reference_tag in (("footnote", "w:footnoteReference"), ("endnote", "w:endnoteReference")):
            for reference in body.iter(qn(reference_tag)):
                if len(note_references[note_kind]) >= MAX_DOCX_AUXILIARY_RELATIONSHIPS:
                    note_reference_overflow = True
                    break
                paragraph = reference.getparent()
                while paragraph is not None and paragraph.tag != qn("w:p"):
                    paragraph = paragraph.getparent()
                raw_note_id = reference.get(qn("w:id"))
                safe_note_id = raw_note_id if isinstance(raw_note_id, str) and re.fullmatch(r"-?[0-9]{1,10}", raw_note_id) else None
                note_references[note_kind].append({
                    "note_id": safe_note_id,
                    "note_id_sha256": hashlib.sha256(raw_note_id.encode("utf-8")).hexdigest()
                    if isinstance(raw_note_id, str) else None,
                    "stable_ref": body_locators.get(paragraph) if paragraph is not None else None,
                })
    section_references_by_relationship: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for section in sections:
        for reference in section["references"]:
            relation_id = reference["relationship_id"]
            if isinstance(relation_id, str):
                section_references_by_relationship.setdefault((reference["relationship_type"], relation_id), []).append(reference)
    relationships_by_type: dict[str, list[dict[str, Any]]] = {}
    for relation in relationships.values():
        relationships_by_type.setdefault(relation["relationship_type"], []).append(relation)
    note_references_by_id: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for note_kind, references in note_references.items():
        for reference in references:
            note_id = reference["note_id"]
            if isinstance(note_id, str):
                note_references_by_id.setdefault((note_kind, note_id), []).append(reference)
    return {
        "relationship_sha256": relationship_sha256,
        "relationship_state": relationship_state,
        "relationships": relationships,
        "sections": sections,
        "note_references": note_references,
        "note_references_by_id": note_references_by_id,
        "section_references_by_relationship": section_references_by_relationship,
        "relationships_by_type": relationships_by_type,
        "section_overflow": section_overflow,
        "section_reference_overflow": section_reference_overflow,
        "note_reference_overflow": note_reference_overflow,
        "archive_names": archive_names,
    }


def _relationship_scope_entry(relation: dict[str, Any], target_part: str | None) -> dict[str, Any]:
    relation_id = relation["relationship_id"]
    safe_id = relation_id if isinstance(relation_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", relation_id) else None
    return {
        "relationship_id": safe_id,
        "relationship_id_sha256": hashlib.sha256(relation_id.encode("utf-8")).hexdigest()
        if isinstance(relation_id, str) else None,
        "relationship_type": relation["relationship_type"],
        "mode": relation["mode"],
        "target_part": target_part,
        "status": relation["status"],
    }


def _bounded_scope_list(items: list[Any]) -> tuple[list[Any], bool]:
    limit = MAX_DOCX_AUXILIARY_SCOPE_REFERENCES
    return items[:limit], len(items) > limit


def _section_scope_reference(reference: dict[str, Any]) -> dict[str, Any]:
    relationship_id = reference["relationship_id"]
    safe_id = relationship_id if isinstance(relationship_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", relationship_id) else None
    return {
        "section_index": reference["section_index"], "reference_type": reference["reference_type"],
        "relationship_id": safe_id,
        "relationship_id_sha256": hashlib.sha256(relationship_id.encode("utf-8")).hexdigest()
        if isinstance(relationship_id, str) else None,
        "section_stable_ref": reference["section_stable_ref"],
    }


def _section_scope_for_part(part_name: str, target_kind: str, context: dict[str, Any]) -> dict[str, Any]:
    relations = context.get("relationships_by_kind_alias", {}).get((target_kind, part_name), [])
    relation_ids = {relation["relationship_id"] for relation in relations}
    raw_section_references = [reference for relation_id in relation_ids
                              for reference in context["section_references_by_relationship"].get((target_kind, relation_id), [])]
    section_references = [_section_scope_reference(reference) for reference in raw_section_references]
    covered_sections = {reference["section_index"] for reference in raw_section_references}
    all_unknown_sections = []
    for section in context["sections"]:
        if section["section_index"] not in covered_sections:
            all_unknown_sections.append(section["section_index"])
            if len(all_unknown_sections) > MAX_DOCX_AUXILIARY_SCOPE_REFERENCES:
                break
    bounded_relationships, relationship_truncated = _bounded_scope_list(
        [_relationship_scope_entry(relation, part_name) for relation in relations])
    bounded_section_references, reference_truncated = _bounded_scope_list(section_references)
    unknown_sections, unknown_truncated = _bounded_scope_list(all_unknown_sections)
    unknown_truncated = unknown_truncated or len(all_unknown_sections) > MAX_DOCX_AUXILIARY_SCOPE_REFERENCES
    overflow = (relationship_truncated or reference_truncated or unknown_truncated or
                context["section_overflow"] or context["section_reference_overflow"])
    if context["relationship_state"] != "valid" or not relations or not section_references or overflow:
        status = "unknown"
    elif unknown_sections:
        status = "partially_resolved"
    else:
        status = "resolved"
    reason = None
    if context["relationship_state"] != "valid":
        reason = "relationship_part_" + context["relationship_state"]
    elif not relations:
        reason = "no_matching_internal_relationship"
    elif not section_references:
        reason = "not_explicitly_referenced_by_section"
    elif unknown_sections:
        reason = "section_inheritance_or_missing_reference_unknown"
    if overflow:
        reason = "scope_detail_limit_exceeded"
    return {
        "kind": "section_reference", "status": status,
        "relationship_part_sha256": context["relationship_sha256"],
        "relationships": bounded_relationships,
        "section_references": bounded_section_references, "unknown_sections": unknown_sections,
        "body_references": [], "reason": reason, "truncated": overflow,
    }


def _note_scope(kind: str, note_id: str, context: dict[str, Any]) -> dict[str, Any]:
    references = context["note_references_by_id"].get((kind, note_id), [])
    expected_part = "word/footnotes.xml" if kind == "footnote" else "word/endnotes.xml"
    relationship_type = "footnotes" if kind == "footnote" else "endnotes"
    note_relationships = context["relationships_by_type"].get(relationship_type, [])
    relationship_valid = (context["relationship_state"] == "valid" and len(note_relationships) == 1 and
                          note_relationships[0]["status"] == "resolved" and
                          note_relationships[0]["target_member"] == expected_part)
    bounded_references, references_truncated = _bounded_scope_list(references)
    bounded_relationships, relationships_truncated = _bounded_scope_list(
        [_relationship_scope_entry(
            relation, expected_part if relation["status"] == "resolved" and relation["target_member"] == expected_part else None,
        ) for relation in note_relationships])
    if references_truncated or relationships_truncated:
        status, reason = "unknown", "scope_detail_limit_exceeded"
    elif context["note_reference_overflow"]:
        status, reason = "unknown", "note_reference_limit_exceeded"
    elif not relationship_valid:
        status, reason = "unknown", "note_relationship_missing_or_mismatched"
    elif references and all(reference["stable_ref"] is not None for reference in references):
        status, reason = "resolved", None
    elif not references:
        status, reason = "unreferenced", "no_body_reference"
    else:
        status, reason = "unknown", "reference_anchor_unresolved"
    return {
        "kind": "note_reference", "status": status,
        "relationship_part_sha256": context["relationship_sha256"],
        "relationships": bounded_relationships,
        "section_references": [], "unknown_sections": [],
        "body_references": bounded_references,
        "reason": reason,
        "truncated": references_truncated or relationships_truncated or context["note_reference_overflow"],
    }


def _unresolved_relationship_scope(
    kind: str, relation_id: str | None, relation_id_hash: str | None, status: str,
    context: dict[str, Any], references: list[dict[str, Any]],
) -> dict[str, Any]:
    section_references, reference_truncated = _bounded_scope_list([_section_scope_reference(reference) for reference in references])
    all_unknown_sections = [section["section_index"] for section in context["sections"]
                            if not any(reference["relationship_type"] == kind and
                                       reference["relationship_id"] == relation_id
                                       for reference in section["references"])]
    unknown_sections, unknown_truncated = _bounded_scope_list(all_unknown_sections)
    mode = "external" if status == "external" else "unknown"
    return {
        "kind": "section_reference", "status": "unknown",
        "relationship_part_sha256": context["relationship_sha256"],
        "relationships": [{
            "relationship_id": relation_id, "relationship_id_sha256": relation_id_hash,
            "relationship_type": kind, "mode": mode,
            "target_part": None, "status": status,
        }],
        "section_references": section_references, "unknown_sections": unknown_sections,
        "body_references": [], "reason": "scope_detail_limit_exceeded" if reference_truncated or unknown_truncated else "relationship_" + status,
        "truncated": reference_truncated or unknown_truncated or context["section_overflow"] or context["section_reference_overflow"],
    }


def _docx_auxiliary_targets(path: Path, body_root: Any, body_locators: dict[Any, str]) -> list[dict[str, Any]]:
    """Describe uncovered DOCX content without copying auxiliary text into logs or the response."""
    targets: list[dict[str, Any]] = []

    def append_target(target: dict[str, Any]) -> None:
        if len(targets) >= MAX_DOCX_AUXILIARY_TARGETS:
            raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "DOCX has too many auxiliary content targets")
        targets.append(target)

    known_part_pattern = re.compile(r"word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml\Z")
    with zipfile.ZipFile(path) as archive:
        relationship_context = _docx_relationship_context(archive, body_root, body_locators)
        # Keep the historical prefix-based warning scope. Nonstandard members are
        # represented by an opaque, content-addressed alias so archive paths never
        # leak into parser responses or become path-like locator input.
        parts = {name for name in relationship_context["archive_names"]
                 if name.startswith(("word/header", "word/footer", "word/footnotes", "word/endnotes"))
                 and name.endswith(".xml")}
        parts.update(relation["target_member"] for relation in relationship_context["relationships"].values()
                     if relation["relationship_type"] in {"header", "footer"} and
                     relation["status"] == "resolved" and relation["target_member"] is not None)
        parts = sorted(parts)
        aliases_by_member = {name: _safe_docx_part_name(name, known_part_pattern) for name in parts}
        relationships_by_kind_alias: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for relation in relationship_context["relationships"].values():
            target_member = relation["target_member"]
            if target_member is not None and target_member in aliases_by_member:
                relationships_by_kind_alias.setdefault((relation["relationship_type"], aliases_by_member[target_member]), []).append(relation)
        relationship_context["relationships_by_kind_alias"] = relationships_by_kind_alias
        for member_name in parts:
            if len(targets) >= MAX_DOCX_AUXILIARY_TARGETS:
                raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "DOCX has too many auxiliary content targets")
            part_target_start = len(targets)
            is_known_part = bool(known_part_pattern.fullmatch(member_name))
            part_name = aliases_by_member[member_name]
            part_locator = {"part_name": part_name}
            if not is_known_part:
                part_locator["member_name_sha256"] = hashlib.sha256(member_name.encode("utf-8")).hexdigest()
            try:
                info = archive.getinfo(member_name)
            except (KeyError, OSError, RuntimeError, zipfile.BadZipFile):
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, part_locator, part_sha256=None,
                    target_sha256=None, parse_status="read_failed",
                ))
                continue

            # ZIP metadata is untrusted but lets us reject declared oversize parts
            # before allocating their decompressed contents. The post-read check
            # below remains as a defensive assertion against inconsistent metadata.
            if info.file_size > MAX_DOCX_AUXILIARY_PART_BYTES:
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, part_locator, part_sha256=None,
                    target_sha256=None, parse_status="size_limited",
                ))
                continue
            try:
                # Read at most the limit plus one byte so a dishonest ZIP size
                # field cannot turn this check into an unbounded decompression.
                with archive.open(info) as member:
                    raw = member.read(MAX_DOCX_AUXILIARY_PART_BYTES + 1)
            except (KeyError, OSError, RuntimeError, EOFError, zipfile.BadZipFile, zlib.error):
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, part_locator, part_sha256=None,
                    target_sha256=None, parse_status="read_failed",
                ))
                continue
            part_hash = hashlib.sha256(raw).hexdigest()
            if len(raw) > MAX_DOCX_AUXILIARY_PART_BYTES:
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, part_locator, part_sha256=None,
                    target_sha256=None, parse_status="size_limited",
                ))
                continue
            if not is_known_part:
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, part_locator, part_sha256=part_hash,
                    target_sha256=part_hash, parse_status="unrecognized_part",
                ))
                continue
            if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw, flags=re.IGNORECASE):
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, {"part_name": part_name}, part_sha256=part_hash,
                    target_sha256=part_hash, parse_status="unsafe_xml",
                ))
                continue
            try:
                xml_root = etree.fromstring(raw, parser=etree.XMLParser(
                    resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False,
                ))
            except (etree.XMLSyntaxError, ValueError):
                append_target(_auxiliary_target(
                    "auxiliary_part", part_name, {"part_name": part_name}, part_sha256=part_hash,
                    target_sha256=part_hash, parse_status="parse_failed",
                ))
                continue

            paragraphs = list(xml_root.iter(qn("w:p")))
            kind = part_name.rsplit("/", 1)[-1]
            if kind.startswith("header"):
                target_kind = "header_paragraph"
            elif kind.startswith("footer"):
                target_kind = "footer_paragraph"
            elif kind == "footnotes.xml":
                target_kind = "footnote_paragraph"
            else:
                target_kind = "endnote_paragraph"

            if target_kind in {"footnote_paragraph", "endnote_paragraph"}:
                note_tag = qn("w:footnote") if target_kind == "footnote_paragraph" else qn("w:endnote")
                notes = [note for note in xml_root if note.tag == note_tag and note.get(qn("w:id")) not in {"-1", "-2"}]
                note_ids = [note.get(qn("w:id")) for note in notes]
                if (any(not isinstance(note_id, str) or not re.fullmatch(r"-?[0-9]{1,10}", note_id)
                        for note_id in note_ids) or len(set(note_ids)) != len(note_ids)):
                    append_target(_auxiliary_target(
                        "auxiliary_part", part_name, {"part_name": part_name}, part_sha256=part_hash,
                        target_sha256=part_hash, parse_status="unsafe_xml",
                    ))
                    continue
                for note in notes:
                    note_id = note.get(qn("w:id"))
                    assert note_id is not None
                    note_paragraphs = list(note.iter(qn("w:p")))
                    if not note_paragraphs:
                        locator = {"part_name": part_name, "note_id": note_id, "paragraph_index": None}
                        node_hash = hashlib.sha256(etree.tostring(note, encoding="utf-8", with_tail=False)).hexdigest()
                        append_target(_auxiliary_target(
                            "footnote" if target_kind == "footnote_paragraph" else "endnote", part_name, locator,
                            part_sha256=part_hash, target_sha256=node_hash, parse_status="empty", text="",
                        ))
                    for paragraph_index, paragraph in enumerate(note_paragraphs, 1):
                        locator = {"part_name": part_name, "note_id": note_id, "paragraph_index": paragraph_index}
                        node_hash = hashlib.sha256(etree.tostring(paragraph, encoding="utf-8", with_tail=False)).hexdigest()
                        text = _final_text(paragraph)
                        append_target(_auxiliary_target(
                            "footnote" if target_kind == "footnote_paragraph" else "endnote", part_name, locator,
                            part_sha256=part_hash, target_sha256=node_hash,
                            parse_status="parsed" if text.strip() else "empty", text=text,
                        ))
                if len(targets) == part_target_start:
                    append_target(_auxiliary_target(
                        "auxiliary_part", part_name, {"part_name": part_name}, part_sha256=part_hash,
                        target_sha256=part_hash, parse_status="empty", text="",
                    ))
            else:
                for paragraph_index, paragraph in enumerate(paragraphs, 1):
                    locator = {"part_name": part_name, "paragraph_index": paragraph_index}
                    node_hash = hashlib.sha256(etree.tostring(paragraph, encoding="utf-8", with_tail=False)).hexdigest()
                    text = _final_text(paragraph)
                    append_target(_auxiliary_target(
                        "header" if target_kind == "header_paragraph" else "footer", part_name, locator,
                        part_sha256=part_hash, target_sha256=node_hash,
                        parse_status="parsed" if text.strip() else "empty", text=text,
                    ))
                if not paragraphs:
                    locator = {"part_name": part_name, "paragraph_index": None}
                    append_target(_auxiliary_target(
                        "header" if target_kind == "header_paragraph" else "footer", part_name, locator,
                        part_sha256=part_hash, target_sha256=part_hash, parse_status="empty", text="",
                    ))

        emitted_unknown_relationships: set[tuple[str, str | None, int | None]] = set()
        for relation_id, relation in relationship_context["relationships"].items():
            if relation["relationship_type"] not in {"header", "footer"} or relation["status"] == "resolved":
                continue
            kind = relation["relationship_type"]
            matching_refs = [reference for section in relationship_context["sections"] for reference in section["references"]
                             if reference["relationship_type"] == kind and reference["relationship_id"] == relation_id]
            relation_seed = f"opc-relationship:{kind}:{relation_id}"
            member_hash = hashlib.sha256(relation_seed.encode("utf-8")).hexdigest()
            part_name = f"word/auxiliary-{member_hash}.xml"
            parse_status = {"external": "external_relationship", "missing": "missing_relationship"}.get(
                relation["status"], "unsafe_relationship")
            target = _auxiliary_target(
                "auxiliary_part", part_name,
                {"part_name": part_name, "member_name_sha256": member_hash},
                part_sha256=None, target_sha256=None, parse_status=parse_status,
            )
            target["scope"] = _unresolved_relationship_scope(
                kind, relation_id, hashlib.sha256(relation_id.encode("utf-8")).hexdigest(),
                relation["status"], relationship_context, matching_refs,
            )
            append_target(target)
            emitted_unknown_relationships.add((kind, relation_id, None))

        for section in relationship_context["sections"]:
            for reference in section["references"]:
                kind = reference["relationship_type"]
                relation_id = reference["relationship_id"]
                relation = relationship_context["relationships"].get(relation_id) if relation_id is not None else None
                if relation is not None and relation["status"] in {"resolved", "external", "missing", "unsafe"}:
                    continue
                key = (kind, relation_id, reference["section_index"] if relation_id is None else None)
                if key in emitted_unknown_relationships:
                    continue
                relation_status = "unsafe" if relationship_context["relationship_state"] != "valid" else "missing"
                relation_seed = f"opc-section-reference:{kind}:{relation_id or ''}:{reference['section_index']}"
                member_hash = hashlib.sha256(relation_seed.encode("utf-8")).hexdigest()
                part_name = f"word/auxiliary-{member_hash}.xml"
                target = _auxiliary_target(
                    "auxiliary_part", part_name,
                    {"part_name": part_name, "member_name_sha256": member_hash},
                    part_sha256=None, target_sha256=None,
                    parse_status="unsafe_relationship" if relation_status == "unsafe" else "missing_relationship",
                )
                target["scope"] = _unresolved_relationship_scope(
                    kind, relation_id if isinstance(relation_id, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", relation_id) else None,
                    hashlib.sha256(relation_id.encode("utf-8")).hexdigest() if isinstance(relation_id, str) else None,
                    relation_status, relationship_context, [reference],
                )
                append_target(target)
                emitted_unknown_relationships.add(key)

        existing_note_keys = {(target["kind"], target["locator"].get("note_id")) for target in targets
                              if target["kind"] in {"footnote", "endnote"}}
        for note_kind, references in relationship_context["note_references"].items():
            grouped_references: dict[str, list[dict[str, Any]]] = {}
            for reference in references:
                note_id = reference["note_id"]
                if isinstance(note_id, str) and note_id:
                    grouped_references.setdefault(note_id, []).append(reference)
                else:
                    relation_seed = f"missing-{note_kind}-reference:{reference['stable_ref'] or ''}"
                    member_hash = hashlib.sha256(relation_seed.encode("utf-8")).hexdigest()
                    part_name = f"word/auxiliary-{member_hash}.xml"
                    target = _auxiliary_target(
                        "auxiliary_part", part_name,
                        {"part_name": part_name, "member_name_sha256": member_hash},
                        part_sha256=None, target_sha256=None, parse_status="missing_reference_target",
                    )
                    target["scope"] = {
                        "kind": "note_reference", "status": "unknown",
                        "relationship_part_sha256": relationship_context["relationship_sha256"],
                        "relationships": [], "section_references": [], "unknown_sections": [],
                        "body_references": [reference], "reason": "note_reference_id_missing", "truncated": False,
                    }
                    append_target(target)
            for note_id, note_refs in grouped_references.items():
                target_kind = "footnote" if note_kind == "footnote" else "endnote"
                if (target_kind, note_id) in existing_note_keys:
                    continue
                part_name = "word/footnotes.xml" if note_kind == "footnote" else "word/endnotes.xml"
                target = _auxiliary_target(
                    target_kind, part_name,
                    {"part_name": part_name, "note_id": note_id, "paragraph_index": None},
                    part_sha256=None, target_sha256=None, parse_status="missing_reference_target",
                )
                target["scope"] = {
                    "kind": "note_reference", "status": "unknown",
                    "relationship_part_sha256": relationship_context["relationship_sha256"],
                    "relationships": [], "section_references": [], "unknown_sections": [],
                    "body_references": note_refs[:MAX_DOCX_AUXILIARY_SCOPE_REFERENCES],
                    "reason": "scope_detail_limit_exceeded" if len(note_refs) > MAX_DOCX_AUXILIARY_SCOPE_REFERENCES else "referenced_note_target_missing",
                    "truncated": len(note_refs) > MAX_DOCX_AUXILIARY_SCOPE_REFERENCES,
                }
                append_target(target)

        drawing_index = 0
        try:
            document_xml = archive.read("word/document.xml")
        except (KeyError, OSError, RuntimeError, zipfile.BadZipFile, zlib.error):
            document_xml = b""
        document_hash = hashlib.sha256(document_xml).hexdigest() if document_xml else None
        for drawing in body_root.iter(qn("w:drawing")):
            drawing_index += 1
            if len(targets) >= MAX_DOCX_AUXILIARY_TARGETS:
                raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "DOCX has too many auxiliary content targets")
            parent = drawing.getparent()
            while parent is not None and parent.tag != qn("w:p"):
                parent = parent.getparent()
            parent_ref = body_locators.get(parent) if parent is not None else None
            drawing_ids = [node.get("id") for node in drawing.iter()
                           if isinstance(node.tag, str) and node.tag.endswith("}docPr") and node.get("id")]
            locator = {
                "part_name": "word/document.xml",
                "drawing_index": drawing_index,
                "parent_stable_ref": parent_ref,
                "drawing_ids": drawing_ids,
            }
            serialized = etree.tostring(drawing, encoding="utf-8", with_tail=False)
            drawing_hash = hashlib.sha256(serialized).hexdigest()
            append_target(_auxiliary_target(
                "drawing", "word/document.xml", locator, part_sha256=document_hash,
                target_sha256=drawing_hash, parse_status="not_extracted",
            ))

        drawings = list(body_root.iter(qn("w:drawing")))
        scope_cache: dict[tuple[str, str], dict[str, Any]] = {}
        scope_bytes_used = 0
        for target in targets:
            if target.get("scope") is not None:
                continue
            if target["kind"] in {"header", "footer"}:
                cache_key = (target["part_name"], target["kind"])
                if cache_key not in scope_cache:
                    scope_cache[cache_key] = _section_scope_for_part(target["part_name"], target["kind"], relationship_context)
                target["scope"] = scope_cache[cache_key]
            elif target["kind"] in {"footnote", "endnote"}:
                cache_key = (target["part_name"], target["locator"]["note_id"])
                if cache_key not in scope_cache:
                    scope_cache[cache_key] = _note_scope(target["kind"], target["locator"]["note_id"], relationship_context)
                target["scope"] = scope_cache[cache_key]
            elif target["kind"] == "drawing":
                drawing = drawings[target["locator"]["drawing_index"] - 1]
                relationship_ids: list[str] = []
                drawing_relationship_overflow = False
                for element in drawing.iter():
                    for attr_name, attr_value in element.attrib.items():
                        if attr_name.startswith((f"{{{TRANSITIONAL_RELATIONSHIP_NS}}}", f"{{{STRICT_RELATIONSHIP_NS}}}")) and \
                                attr_name.rsplit("}", 1)[-1] in {"embed", "link", "id"} and attr_value not in relationship_ids:
                            if len(relationship_ids) >= MAX_DOCX_AUXILIARY_SCOPE_REFERENCES + 1:
                                drawing_relationship_overflow = True
                                break
                            relationship_ids.append(attr_value)
                    if drawing_relationship_overflow:
                        break
                drawing_relations = []
                for relation_id in relationship_ids:
                    relation = relationship_context["relationships"].get(relation_id)
                    if relation is None:
                        status = "unsafe" if relationship_context["relationship_state"] != "valid" else "missing"
                        drawing_relations.append({
                            "relationship_id": relation_id if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", relation_id) else None,
                            "relationship_id_sha256": hashlib.sha256(relation_id.encode("utf-8")).hexdigest(),
                            "relationship_type": "image", "mode": "unknown", "target_part": None, "status": status,
                        })
                    else:
                        drawing_relations.append(_relationship_scope_entry(
                            {**relation, "status": "external" if relation["mode"] == "external" else "unsupported"}, None,
                        ))
                bounded_drawing_relations, drawing_relations_truncated = _bounded_scope_list(drawing_relations)
                target["scope"] = {
                    "kind": "drawing_relationship", "status": "unknown",
                    "relationship_part_sha256": relationship_context["relationship_sha256"],
                    "relationships": bounded_drawing_relations, "section_references": [], "unknown_sections": [],
                    "body_references": [],
                    "reason": "scope_detail_limit_exceeded" if drawing_relations_truncated else "drawing_relationship_targets_not_extracted",
                    "truncated": drawing_relations_truncated or drawing_relationship_overflow,
                }
            elif target["part_name"] in {"word/footnotes.xml", "word/endnotes.xml"}:
                note_kind = "footnote" if target["part_name"] == "word/footnotes.xml" else "endnote"
                bounded_note_references, note_references_truncated = _bounded_scope_list(relationship_context["note_references"][note_kind])
                target["scope"] = {
                    "kind": "note_reference", "status": "unknown",
                    "relationship_part_sha256": relationship_context["relationship_sha256"],
                    "relationships": [], "section_references": [], "unknown_sections": [],
                    "body_references": bounded_note_references,
                    "reason": "scope_detail_limit_exceeded" if note_references_truncated else "note_part_unparseable",
                    "truncated": note_references_truncated or relationship_context["note_reference_overflow"],
                }
            elif target["kind"] == "auxiliary_part":
                relation_types = {relation["relationship_type"] for relation in relationship_context["relationships"].values()
                                  if relation["target_member"] is not None and aliases_by_member.get(relation["target_member"]) == target["part_name"] and
                                  relation["relationship_type"] in {"header", "footer"}}
                if len(relation_types) == 1:
                    relation_type = next(iter(relation_types))
                    cache_key = (target["part_name"], relation_type)
                    if cache_key not in scope_cache:
                        scope_cache[cache_key] = _section_scope_for_part(target["part_name"], relation_type,
                                                                        relationship_context)
                    target["scope"] = scope_cache[cache_key]
                else:
                    target["scope"] = {
                        "kind": "unknown", "status": "unknown",
                        "relationship_part_sha256": relationship_context["relationship_sha256"],
                        "relationships": [], "section_references": [], "unknown_sections": [],
                        "body_references": [], "reason": "auxiliary_part_scope_unknown", "truncated": False,
                    }
            else:
                target["scope"] = {
                    "kind": "unknown", "status": "unknown",
                    "relationship_part_sha256": relationship_context["relationship_sha256"],
                    "relationships": [], "section_references": [], "unknown_sections": [],
                    "body_references": [], "reason": "auxiliary_part_scope_unknown", "truncated": False,
                }
            scope_bytes = len(json.dumps(target["scope"], ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if scope_bytes_used + scope_bytes > MAX_DOCX_AUXILIARY_SCOPE_BYTES:
                target["scope"] = {
                    "kind": target["scope"]["kind"], "status": "unknown",
                    "relationship_part_sha256": relationship_context["relationship_sha256"],
                    "relationships": [], "section_references": [], "unknown_sections": [],
                    "body_references": [], "reason": "scope_total_detail_limit_exceeded", "truncated": True,
                }
                scope_bytes = len(json.dumps(target["scope"], separators=(",", ":")).encode("utf-8"))
            scope_bytes_used += scope_bytes
    return targets


def _parse_docx(path: Path, options: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    _validate_archive(path, "word/document.xml")
    try:
        document = Document(path)
    except Exception as exc:
        raise ParseFailure("MATERIAL_UNREADABLE", "DOCX is damaged or unreadable") from exc
    root = document.element
    unsupported_revision_count = _unsupported_docx_revision_count(root)
    styles = document.styles
    outline_resolver = ParagraphOutlineResolver(styles.element)
    defaults = styles.element.find(qn("w:docDefaults"))
    default_rpr = defaults.find(".//" + qn("w:rPr")) if defaults is not None else None
    style_cache: dict[tuple[int, str | None], tuple[Any, list[Any]]] = {}

    def cached_style(style_id: str | None, style_type: WD_STYLE_TYPE) -> tuple[Any, list[Any]]:
        key = (int(style_type), style_id)
        if key not in style_cache:
            style = styles.get_by_id(style_id, style_type)
            style_cache[key] = (style, list(_style_chain(style)))
        return style_cache[key]

    def style_layers(style_id: str | None, style_type: WD_STYLE_TYPE) -> list[Any]:
        return cached_style(style_id, style_type)[1]

    records: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    heading = ""
    body_locators: dict[Any, str] = {}
    for locator, paragraph in _walk_docx_blocks(document):
        locator["stable_ref"] = _docx_locator_text(locator)
        body_locators[paragraph._p] = locator["stable_ref"]
        value = _final_text(paragraph._p)
        if not value.strip():
            continue
        paragraph_style = cached_style(paragraph._p.style, WD_STYLE_TYPE.PARAGRAPH)[0]
        if paragraph_style and ("Heading" in paragraph_style.name or "标题" in paragraph_style.name):
            heading = value
        uncertainty = ["docx_revision_effective_text_unresolved"] if unsupported_revision_count else None
        records.append(_record(
            len(records) + 1,
            "docx_block",
            locator,
            value,
            context=heading,
            formatting=_paragraph_formatting(paragraph, paragraph_style, style_layers, default_rpr, outline_resolver.resolve(paragraph._p)),
            uncertainty=uncertainty,
        ))

    inserted = len(list(root.iter(qn("w:ins"))))
    deleted = len(list(root.iter(qn("w:del"))))
    moved_from = len(list(root.iter(qn("w:moveFrom"))))
    moved_to = len(list(root.iter(qn("w:moveTo"))))
    if inserted or deleted or moved_from or moved_to:
        warnings.append({
            "code": "DOCX_REVISIONS_RESOLVED",
            "message": (
                f"Effective text includes {inserted} insertion revision(s) and {moved_to} moved-to revision(s), "
                f"and excludes {deleted} deletion revision(s) and {moved_from} moved-from revision(s); "
                "the source file was not changed."
            ),
        })
    if unsupported_revision_count:
        warnings.append({
            "code": "DOCX_UNSUPPORTED_REVISION_MARKERS",
            "message": (
                f"The document contains {unsupported_revision_count} range, table, or property revision marker(s) "
                "whose effective text is not resolved; review before relying on extracted text."
            ),
        })
    for tag, code, label in (
        ("w:sdt", "DOCX_CONTENT_CONTROLS", "content control(s)"),
        ("w:txbxContent", "DOCX_TEXT_BOXES", "text box(es)"),
        ("w:drawing", "DOCX_DRAWINGS", "drawing/image object(s)"),
    ):
        count = len(list(root.iter(qn(tag))))
        if count:
            warnings.append({"code": code, "message": f"The document contains {count} {label}; non-body content requires confirmation."})
    auxiliary_targets = _docx_auxiliary_targets(path, root, body_locators)
    if any(target["part_name"] != "word/document.xml" for target in auxiliary_targets):
        warnings.append({"code": "DOCX_AUXILIARY_PARTS", "message": "Headers, footers, footnotes, or endnotes are not included in body records."})
    if not records:
        raise ParseFailure("MATERIAL_UNREADABLE", "DOCX contains no extractable effective body text")
    return records, warnings, {"page_count": None, "revision_summary": {"insertions": inserted, "deletions": deleted},
                               "auxiliary_targets": auxiliary_targets}


def _parse_pdf(path: Path, options: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    max_pages = options.get("max_pages", DEFAULT_MAX_PAGES)
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or max_pages < 1 or max_pages > DEFAULT_MAX_PAGES:
        raise ParseFailure("INVALID_PARSE_REQUEST", f"max_pages must be between 1 and {DEFAULT_MAX_PAGES}")
    records: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    blank_pages: list[int] = []
    image_pages: list[int] = []
    try:
        if PdfReader(path).is_encrypted:
            raise ParseFailure("MATERIAL_ENCRYPTED", "PDF is encrypted; provide an authorized readable copy")
        with pdfplumber.open(path) as pdf:
            page_count = len(pdf.pages)
            if page_count > max_pages:
                raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", f"PDF has {page_count} pages; parser limit is {max_pages}")
            for page_number, page in enumerate(pdf.pages, 1):
                # pdfplumber caches layout objects per page; without closing each page a 50-page text PDF
                # peaked at ~700 MiB, above the 320M production worker limit (#17 capacity).
                try:
                    if page.images:
                        image_pages.append(page_number)
                    words = page.extract_words(x_tolerance=2, y_tolerance=3, keep_blank_chars=False, extra_attrs=["fontname", "size"]) or []
                    if not words:
                        blank_pages.append(page_number)
                        continue
                    lines: list[list[dict[str, Any]]] = []
                    for word in sorted(words, key=lambda item: (round(float(item["top"]), 1), float(item["x0"]))):
                        if not lines or abs(float(word["top"]) - float(lines[-1][0]["top"])) > 3:
                            lines.append([word])
                        else:
                            lines[-1].append(word)
                    for line_number, line in enumerate(lines, 1):
                        line.sort(key=lambda item: float(item["x0"]))
                        text = " ".join(str(item["text"]) for item in line).strip()
                        if not text:
                            continue
                        bbox = {
                            "x0": round(min(float(item["x0"]) for item in line), 3),
                            "top": round(min(float(item["top"]) for item in line), 3),
                            "x1": round(max(float(item["x1"]) for item in line), 3),
                            "bottom": round(max(float(item["bottom"]) for item in line), 3),
                        }
                        locator = {"page": page_number, "line": line_number, "bbox": bbox, "stable_ref": f"pdf:p{page_number:04d}:l{line_number:04d}"}
                        fonts: dict[tuple[str, float], int] = {}
                        word_boxes: list[dict[str, Any]] = []
                        for item in line:
                            font_key = (str(item.get("fontname") or ""), round(float(item.get("size") or 0), 3))
                            fonts[font_key] = fonts.get(font_key, 0) + len(str(item["text"]))
                            word_boxes.append({
                                "text": str(item["text"]),
                                "x0": round(float(item["x0"]), 3),
                                "top": round(float(item["top"]), 3),
                                "x1": round(float(item["x1"]), 3),
                                "bottom": round(float(item["bottom"]), 3),
                            })
                        formatting = {
                            "fonts": [{"font_name": key[0], "size": key[1], "characters": count} for key, count in fonts.items()],
                            "word_boxes": word_boxes,
                        }
                        records.append(_record(len(records) + 1, "pdf_bbox", locator, text, context=f"PDF page {page_number}", formatting=formatting))
                finally:
                    page.close()
    except ParseFailure:
        raise
    except Exception as exc:
        message = str(exc).lower()
        if "password" in message or "encrypt" in message:
            raise ParseFailure("MATERIAL_ENCRYPTED", "PDF is encrypted; provide an authorized readable copy") from exc
        raise ParseFailure("MATERIAL_UNREADABLE", "PDF is damaged or unreadable") from exc
    if blank_pages:
        warnings.append({"code": "PDF_PAGES_WITHOUT_TEXT", "message": f"No native text was extracted from page(s): {','.join(map(str, blank_pages))}. OCR is required before those pages can be treated as covered."})
    if image_pages:
        warnings.append({"code": "PDF_IMAGES_NOT_OCRD", "message": f"Image content on {len(image_pages)} page(s) was not OCR processed by this parser."})
    if not records:
        raise ParseFailure("MATERIAL_UNREADABLE", "PDF contains no native text; OCR is required")
    return records, warnings, {"page_count": page_count, "pages_without_native_text": blank_pages, "pages_with_images": image_pages}


def _iter_pdf_records(path: Path, options: dict[str, Any], metadata: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Yield one PDF evidence record at a time; keep only the current page's layout alive."""
    max_pages = options.get("max_pages", DEFAULT_MAX_PAGES)
    if not isinstance(max_pages, int) or isinstance(max_pages, bool) or max_pages < 1 or max_pages > DEFAULT_MAX_PAGES:
        raise ParseFailure("INVALID_PARSE_REQUEST", f"max_pages must be between 1 and {DEFAULT_MAX_PAGES}")
    blank_pages: list[int] = []
    image_pages: list[int] = []
    try:
        if PdfReader(path).is_encrypted:
            raise ParseFailure("MATERIAL_ENCRYPTED", "PDF is encrypted; provide an authorized readable copy")
        with pdfplumber.open(path) as pdf:
            page_count = len(pdf.pages)
            if page_count > max_pages:
                raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", f"PDF has {page_count} pages; parser limit is {max_pages}")
            metadata["document"] = {"page_count": page_count}
            record_index = 0
            for page_number, page in enumerate(pdf.pages, 1):
                try:
                    if page.images:
                        image_pages.append(page_number)
                    words = page.extract_words(x_tolerance=2, y_tolerance=3, keep_blank_chars=False, extra_attrs=["fontname", "size"]) or []
                    if not words:
                        blank_pages.append(page_number)
                        continue
                    lines: list[list[dict[str, Any]]] = []
                    for word in sorted(words, key=lambda item: (round(float(item["top"]), 1), float(item["x0"]))):
                        if not lines or abs(float(word["top"]) - float(lines[-1][0]["top"])) > 3:
                            lines.append([word])
                        else:
                            lines[-1].append(word)
                    for line_number, line in enumerate(lines, 1):
                        line.sort(key=lambda item: float(item["x0"]))
                        text = " ".join(str(item["text"]) for item in line).strip()
                        if not text:
                            continue
                        bbox = {
                            "x0": round(min(float(item["x0"]) for item in line), 3),
                            "top": round(min(float(item["top"]) for item in line), 3),
                            "x1": round(max(float(item["x1"]) for item in line), 3),
                            "bottom": round(max(float(item["bottom"]) for item in line), 3),
                        }
                        locator = {"page": page_number, "line": line_number, "bbox": bbox, "stable_ref": f"pdf:p{page_number:04d}:l{line_number:04d}"}
                        fonts: dict[tuple[str, float], int] = {}
                        word_boxes: list[dict[str, Any]] = []
                        for item in line:
                            font_key = (str(item.get("fontname") or ""), round(float(item.get("size") or 0), 3))
                            fonts[font_key] = fonts.get(font_key, 0) + len(str(item["text"]))
                            word_boxes.append({
                                "text": str(item["text"]),
                                "x0": round(float(item["x0"]), 3),
                                "top": round(float(item["top"]), 3),
                                "x1": round(float(item["x1"]), 3),
                                "bottom": round(float(item["bottom"]), 3),
                            })
                        formatting = {
                            "fonts": [{"font_name": key[0], "size": key[1], "characters": count} for key, count in fonts.items()],
                            "word_boxes": word_boxes,
                        }
                        record_index += 1
                        yield _record(record_index, "pdf_bbox", locator, text, context=f"PDF page {page_number}", formatting=formatting)
                finally:
                    page.close()
    except ParseFailure:
        raise
    except Exception as exc:
        message = str(exc).lower()
        if "password" in message or "encrypt" in message:
            raise ParseFailure("MATERIAL_ENCRYPTED", "PDF is encrypted; provide an authorized readable copy") from exc
        raise ParseFailure("MATERIAL_UNREADABLE", "PDF is damaged or unreadable") from exc
    metadata["document"] = {"page_count": page_count, "pages_without_native_text": blank_pages, "pages_with_images": image_pages}
    if blank_pages:
        metadata.setdefault("warnings", []).append({"code": "PDF_PAGES_WITHOUT_TEXT", "message": f"No native text was extracted from page(s): {','.join(map(str, blank_pages))}. OCR is required before those pages can be treated as covered."})
    if image_pages:
        metadata.setdefault("warnings", []).append({"code": "PDF_IMAGES_NOT_OCRD", "message": f"Image content on {len(image_pages)} page(s) was not OCR processed by this parser."})


def _detect_text_encoding(path: Path) -> str:
    if path.stat().st_size > MAX_TEXT_BYTES:
        raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "Text material exceeds the parser byte limit")
    for encoding in ("utf-8-sig", "gb18030"):
        decoder = codecs.getincrementaldecoder(encoding)(errors="strict")
        try:
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(64 * 1024), b""):
                    if b"\x00" in block:
                        raise ParseFailure("MATERIAL_CONTENT_MISMATCH", "Text material contains binary null bytes")
                    decoder.decode(block)
                decoder.decode(b"", final=True)
            return encoding
        except UnicodeDecodeError:
            continue
    raise ParseFailure("MATERIAL_UNREADABLE", "Text encoding is unsupported; provide UTF-8 or GB18030")


def _iter_text_records(path: Path, encoding: str) -> Iterator[dict[str, Any]]:
    """Decode a bounded line at a time so text size does not multiply into Python objects."""
    endings = "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029"

    def record(line_number: int, part: str) -> dict[str, Any] | None:
        value = part[:-2] if part.endswith("\r\n") else part[:-1] if part and part[-1] in endings else part
        if len(value) > MAX_TEXT_LINE_CHARS:
            raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "Text line exceeds the parser record limit")
        if not value.strip():
            return None
        return _record(line_number, "text_line", {"line": line_number, "stable_ref": f"text:l{line_number:06d}"}, value)

    try:
        with path.open("rb") as raw:
            with io.TextIOWrapper(raw, encoding=encoding, errors="strict", newline=None) as stream:
                carry = ""
                line_number = 0
                record_index = 0
                while True:
                    chunk = stream.read(64 * 1024)
                    if not chunk:
                        break
                    parts = (carry + chunk).splitlines(keepends=True)
                    carry = ""
                    if parts and (not parts[-1] or parts[-1][-1] not in endings):
                        carry = parts.pop()
                    if len(carry) > MAX_TEXT_LINE_CHARS:
                        raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "Text line exceeds the parser record limit")
                    for part in parts:
                        line_number += 1
                        item = record(line_number, part)
                        if item is not None:
                            record_index += 1
                            item["record_id"] = f"evidence-{record_index:06d}"
                            yield item
                if carry:
                    line_number += 1
                    item = record(line_number, carry)
                    if item is not None:
                        record_index += 1
                        item["record_id"] = f"evidence-{record_index:06d}"
                        yield item
    except ParseFailure:
        raise
    except Exception as exc:
        raise ParseFailure("MATERIAL_UNREADABLE", "Text encoding is unsupported; provide UTF-8 or GB18030") from exc


def stream_parse_request(payload: Any, output: Any) -> None:
    """Write a bounded NDJSON record stream for PDF/TXT materials; no whole-response record list."""
    request_id: str | None = None
    material: dict[str, Any] | None = None

    def emit(event: dict[str, Any]) -> None:
        output.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
        output.write("\n")

    try:
        if not isinstance(payload, dict) or payload.get("schema_version") != REQUEST_SCHEMA_VERSION:
            raise ParseFailure("INVALID_PARSE_REQUEST", f"schema_version must be {REQUEST_SCHEMA_VERSION}")
        request_id = _require_string(payload.get("request_id"), "request_id", r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
        material = payload.get("material")
        if not isinstance(material, dict):
            raise ParseFailure("INVALID_PARSE_REQUEST", "material is required")
        material_id = _require_string(material.get("material_id"), "material.material_id", r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
        version = material.get("material_version")
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ParseFailure("INVALID_PARSE_REQUEST", "material.material_version must be a positive integer")
        media_type = _require_string(material.get("media_type"), "material.media_type")
        if media_type not in {MEDIA_PDF, MEDIA_TEXT}:
            raise ParseFailure("INVALID_PARSE_REQUEST", "streaming parser supports PDF and plain text only")
        expected_hash = _require_string(material.get("sha256"), "material.sha256", r"[a-f0-9]{64}")
        authorized_path = _require_string(material.get("authorized_local_path"), "material.authorized_local_path")
        path = Path(authorized_path)
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ParseFailure("MATERIAL_UNREADABLE", "Authorized material handle is unavailable")
        if _sha256(path) != expected_hash:
            raise ParseFailure("MATERIAL_CONTENT_MISMATCH", "Material bytes do not match the immutable SHA-256")
        options = payload.get("options", {})
        if not isinstance(options, dict) or set(options) - {"max_pages"}:
            raise ParseFailure("INVALID_PARSE_REQUEST", "options contains unsupported fields")
        safe_material = {"material_id": material_id, "material_version": version, "sha256": expected_hash, "media_type": media_type}
        metadata: dict[str, Any] = {"warnings": []}

        if media_type == MEDIA_PDF:
            records = _iter_pdf_records(path, options, metadata)
            first = next(records, None)  # Initialize PDF metadata before emitting the stream header.
            document = metadata.get("document", {"page_count": None})
            if document.get("page_count") is None:
                raise ParseFailure("MATERIAL_UNREADABLE", "PDF has no readable pages")
        else:
            encoding = _detect_text_encoding(path)
            document = {"page_count": None, "encoding": encoding}
            records = _iter_text_records(path, encoding)
            first = next(records, None)

        emit({"type": "start", "schema_version": "document-parse-stream-v1", "request_id": request_id,
              "parser_version": PARSER_VERSION, "material": safe_material, "document": document})
        count = 0
        has_uncertainty = False

        def write_record(record: dict[str, Any] | None) -> None:
            nonlocal count, has_uncertainty
            if record is None:
                return
            record["material_id"] = material_id
            record["material_version"] = version
            record["content_hash"] = expected_hash
            count += 1
            has_uncertainty = has_uncertainty or bool(record["uncertainty"])
            emit({"type": "record", "record": record})

        write_record(first)
        for record in records:
            write_record(record)
        if count == 0:
            raise ParseFailure("MATERIAL_UNREADABLE", "Material contains no extractable native text")
        warnings = metadata.get("warnings", [])
        status = "needs_confirmation" if warnings or has_uncertainty else "parsed"
        if media_type == MEDIA_PDF:
            document = metadata["document"]
        emit({"type": "end", "record_count": count, "has_uncertainty": has_uncertainty,
              "response": {"schema_version": RESPONSE_SCHEMA_VERSION, "request_id": request_id, "parser_version": PARSER_VERSION,
                           "status": status, "material": safe_material, "warnings": warnings, "document": document, "error": None}})
    except ParseFailure as exc:
        emit({"type": "failure", "response": failure_response(request_id, material, exc.code, exc.safe_message)})
    except Exception as exc:
        emit({"type": "failure", "response": failure_response(request_id, material, "MATERIAL_UNREADABLE", f"Unable to parse material: {type(exc).__name__}")})


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def _parse_xlsx(path: Path, options: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    _validate_archive(path, "xl/workbook.xml")
    try:
        formulas = load_workbook(path, read_only=False, data_only=False, keep_links=False)
        values = load_workbook(path, read_only=False, data_only=True, keep_links=False)
    except Exception as exc:
        raise ParseFailure("MATERIAL_UNREADABLE", "XLSX is damaged or unreadable") from exc
    records: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    missing_formula_results = 0
    cached_formula_results = 0
    try:
        for sheet in formulas.worksheets:
            if sheet.max_row * sheet.max_column > MAX_WORKSHEET_CELLS:
                raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", f"Worksheet {sheet.title!r} exceeds {MAX_WORKSHEET_CELLS} addressable cells")
            value_sheet = values[sheet.title]
            merged_by_cell: dict[str, str] = {}
            for merged_range in sheet.merged_cells.ranges:
                for row in sheet[merged_range.coord]:
                    for cell in row:
                        merged_by_cell[cell.coordinate] = merged_range.coord
            for row in sheet.iter_rows():
                for cell in row:
                    if isinstance(cell, MergedCell):
                        continue
                    raw_value = cell.value
                    cached_value = value_sheet[cell.coordinate].value
                    if raw_value is None:
                        continue
                    if isinstance(raw_value, str) and not raw_value.strip():
                        continue
                    uncertainty: list[str] = []
                    formatting = {"number_format": cell.number_format, "data_type": cell.data_type, "sheet_state": sheet.sheet_state}
                    if isinstance(raw_value, str) and raw_value.startswith("="):
                        if cached_value is None:
                            missing_formula_results += 1
                            uncertainty.append("formula_result_not_cached")
                        else:
                            cached_formula_results += 1
                            # Preserve the workbook's cached value as source evidence only. The
                            # parser cannot establish when or by which calculation engine it was produced.
                            formatting["cached_formula_result"] = _cell_text(cached_value)
                            uncertainty.append("formula_cached_result_unverified")
                        literal = raw_value
                    else:
                        literal = _cell_text(raw_value)
                    locator = {
                        "sheet": sheet.title,
                        "cell": cell.coordinate,
                        "merged_range": merged_by_cell.get(cell.coordinate),
                        "stable_ref": f"xlsx:{quote(sheet.title, safe='')}:cell:{cell.coordinate}",
                    }
                    records.append(_record(len(records) + 1, "xlsx_cell", locator, literal, context=f"Worksheet {sheet.title}", formatting=formatting, uncertainty=uncertainty))
            if sheet.sheet_state != "visible":
                warnings.append({"code": "XLSX_HIDDEN_SHEET", "message": f"Hidden worksheet {sheet.title!r} was parsed and must not be silently omitted."})
    finally:
        formulas.close()
        values.close()
    if missing_formula_results:
        warnings.append({"code": "XLSX_FORMULA_RESULT_MISSING", "message": f"{missing_formula_results} formula cell(s) have no cached result; they are not treated as zero."})
    if cached_formula_results:
        warnings.append({
            "code": "XLSX_FORMULA_CACHE_UNVERIFIED",
            "message": f"{cached_formula_results} formula cell(s) include cached results from the source workbook; freshness and calculation correctness are unverified.",
        })
    if not records:
        raise ParseFailure("MATERIAL_UNREADABLE", "XLSX contains no non-empty cells")
    return records, warnings, {
        "page_count": None,
        "worksheet_count": len(formulas.sheetnames),
        "missing_formula_results": missing_formula_results,
        "cached_formula_results": cached_formula_results,
    }


def _decode_text(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    if len(raw) > MAX_TEXT_BYTES:
        raise ParseFailure("MATERIAL_LIMIT_EXCEEDED", "Text material exceeds the parser byte limit")
    if b"\x00" in raw:
        raise ParseFailure("MATERIAL_CONTENT_MISMATCH", "Text material contains binary null bytes")
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise ParseFailure("MATERIAL_UNREADABLE", "Text encoding is unsupported; provide UTF-8 or GB18030")


def _parse_text(path: Path, options: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    text, encoding = _decode_text(path)
    records = [
        _record(index, "text_line", {"line": line_number, "stable_ref": f"text:l{line_number:06d}"}, line)
        for index, (line_number, line) in enumerate(((number, value) for number, value in enumerate(text.splitlines(), 1) if value.strip()), 1)
    ]
    if not records:
        raise ParseFailure("MATERIAL_UNREADABLE", "Text material contains no non-empty lines")
    return records, [], {"page_count": None, "encoding": encoding}


def _parse_csv(path: Path, options: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    text, encoding = _decode_text(path)
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel
    records: list[dict[str, Any]] = []
    try:
        for row_number, row in enumerate(csv.reader(io.StringIO(text), dialect), 1):
            for column_number, value in enumerate(row, 1):
                if not value.strip():
                    continue
                locator = {"row": row_number, "column": column_number, "stable_ref": f"csv:r{row_number:06d}:c{column_number:04d}"}
                records.append(_record(len(records) + 1, "csv_cell", locator, value))
    except csv.Error as exc:
        raise ParseFailure("MATERIAL_UNREADABLE", "CSV structure is malformed") from exc
    if not records:
        raise ParseFailure("MATERIAL_UNREADABLE", "CSV contains no non-empty cells")
    return records, [], {"page_count": None, "encoding": encoding, "delimiter": dialect.delimiter}


PARSERS = {
    MEDIA_DOCX: _parse_docx,
    MEDIA_PDF: _parse_pdf,
    MEDIA_XLSX: _parse_xlsx,
    MEDIA_CSV: _parse_csv,
    MEDIA_TEXT: _parse_text,
}


def failure_response(
    request_id: str | None,
    material: dict[str, Any] | None,
    code: str,
    message: str,
) -> dict[str, Any]:
    safe_material = None
    if isinstance(material, dict):
        safe_material = {
            "material_id": material.get("material_id"),
            "material_version": material.get("material_version"),
            "sha256": material.get("sha256"),
            "media_type": material.get("media_type"),
        }
    return {
        "schema_version": RESPONSE_SCHEMA_VERSION,
        "request_id": request_id,
        "parser_version": PARSER_VERSION,
        "status": "failed",
        "material": safe_material,
        "records": [],
        "warnings": [],
        "document": {"page_count": None},
        "error": {"code": code, "message": message},
    }


def _require_string(value: Any, name: str, pattern: str | None = None) -> str:
    if not isinstance(value, str) or not value or len(value) > 512:
        raise ParseFailure("INVALID_PARSE_REQUEST", f"{name} is required")
    if pattern and not re.fullmatch(pattern, value):
        raise ParseFailure("INVALID_PARSE_REQUEST", f"{name} has an invalid format")
    return value


def parse_request(payload: Any) -> dict[str, Any]:
    request_id: str | None = None
    material: dict[str, Any] | None = None
    try:
        if not isinstance(payload, dict) or payload.get("schema_version") != REQUEST_SCHEMA_VERSION:
            raise ParseFailure("INVALID_PARSE_REQUEST", f"schema_version must be {REQUEST_SCHEMA_VERSION}")
        request_id = _require_string(payload.get("request_id"), "request_id", r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
        material = payload.get("material")
        if not isinstance(material, dict):
            raise ParseFailure("INVALID_PARSE_REQUEST", "material is required")
        material_id = _require_string(material.get("material_id"), "material.material_id", r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
        version = material.get("material_version")
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ParseFailure("INVALID_PARSE_REQUEST", "material.material_version must be a positive integer")
        media_type = _require_string(material.get("media_type"), "material.media_type")
        if media_type not in SUPPORTED_MEDIA_TYPES:
            raise ParseFailure("MATERIAL_FORMAT_UNSUPPORTED", "Material type is outside the M1 native parser scope")
        expected_hash = _require_string(material.get("sha256"), "material.sha256", r"[a-f0-9]{64}")
        authorized_path = _require_string(material.get("authorized_local_path"), "material.authorized_local_path")
        path = Path(authorized_path)
        if not path.is_absolute() or not path.is_file() or path.is_symlink():
            raise ParseFailure("MATERIAL_UNREADABLE", "Authorized material handle is unavailable")
        actual_hash = _sha256(path)
        if actual_hash != expected_hash:
            raise ParseFailure("MATERIAL_CONTENT_MISMATCH", "Material bytes do not match the immutable SHA-256")
        options = payload.get("options", {})
        if not isinstance(options, dict) or set(options) - {"max_pages"}:
            raise ParseFailure("INVALID_PARSE_REQUEST", "options contains unsupported fields")
        records, warnings, document = PARSERS[media_type](path, options)
        for record in records:
            record["material_id"] = material_id
            record["material_version"] = version
            record["content_hash"] = expected_hash
        status = "needs_confirmation" if warnings or any(record["uncertainty"] for record in records) else "parsed"
        return {
            "schema_version": RESPONSE_SCHEMA_VERSION,
            "request_id": request_id,
            "parser_version": PARSER_VERSION,
            "status": status,
            "material": {
                "material_id": material_id,
                "material_version": version,
                "sha256": expected_hash,
                "media_type": media_type,
            },
            "records": records,
            "warnings": warnings,
            "document": document,
            "error": None,
        }
    except ParseFailure as exc:
        return failure_response(request_id, material, exc.code, exc.safe_message)
