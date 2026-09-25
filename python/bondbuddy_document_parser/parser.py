from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import quote

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from openpyxl import load_workbook
from openpyxl.cell.cell import MergedCell
import pdfplumber
from pypdf import PdfReader


REQUEST_SCHEMA_VERSION = "document-parse-request-v1"
RESPONSE_SCHEMA_VERSION = "document-parse-response-v1"
PARSER_VERSION = "bondbuddy-document-parser-1.0.3"
DEFAULT_MAX_PAGES = 1500
MAX_UNCOMPRESSED_OFFICE_BYTES = 300 * 1024 * 1024
MAX_WORKSHEET_CELLS = 2_000_000
MAX_TEXT_BYTES = 100 * 1024 * 1024

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
            names = set(archive.namelist())
            if required_entry not in names:
                raise ParseFailure("MATERIAL_CONTENT_MISMATCH", "Office container does not match its declared format")
            total = 0
            for info in archive.infolist():
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


def _paragraph_formatting(paragraph: Paragraph, document: Any) -> dict[str, Any]:
    defaults = document.styles.element.find(qn("w:docDefaults"))
    default_rpr = defaults.find(".//" + qn("w:rPr")) if defaults is not None else None
    summaries: list[dict[str, Any]] = []
    previous_key: str | None = None
    for run in _effective_runs(paragraph):
        text = _final_text(run._r)
        if not text.strip():
            continue
        layers = [run._r.find(qn("w:rPr")), *_style_chain(run.style), *_style_chain(paragraph.style), default_rpr]
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
        "style": paragraph.style.name if paragraph.style else "",
        "runs": summaries,
        "paragraph_overrides": layout,
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
            seen: set[int] = set()
            for row_index, row in enumerate(table.rows, 1):
                for column_index, cell in enumerate(row.cells, 1):
                    identity = id(cell._tc)
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


def _parse_docx(path: Path, options: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    _validate_archive(path, "word/document.xml")
    try:
        document = Document(path)
    except Exception as exc:
        raise ParseFailure("MATERIAL_UNREADABLE", "DOCX is damaged or unreadable") from exc
    root = document.element
    unsupported_revision_count = _unsupported_docx_revision_count(root)
    records: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    heading = ""
    for locator, paragraph in _walk_docx_blocks(document):
        value = _final_text(paragraph._p)
        if not value.strip():
            continue
        if paragraph.style and ("Heading" in paragraph.style.name or "标题" in paragraph.style.name):
            heading = value
        locator["stable_ref"] = _docx_locator_text(locator)
        uncertainty = ["docx_revision_effective_text_unresolved"] if unsupported_revision_count else None
        records.append(_record(
            len(records) + 1,
            "docx_block",
            locator,
            value,
            context=heading,
            formatting=_paragraph_formatting(paragraph, document),
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
    with zipfile.ZipFile(path) as archive:
        extra_parts = sorted(name for name in archive.namelist() if name.startswith(("word/header", "word/footer", "word/footnotes", "word/endnotes")) and name.endswith(".xml"))
    if extra_parts:
        warnings.append({"code": "DOCX_AUXILIARY_PARTS", "message": "Headers, footers, footnotes, or endnotes are not included in body records."})
    if not records:
        raise ParseFailure("MATERIAL_UNREADABLE", "DOCX contains no extractable effective body text")
    return records, warnings, {"page_count": None, "revision_summary": {"insertions": inserted, "deletions": deleted}}


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
