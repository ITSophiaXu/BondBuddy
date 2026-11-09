"""Read-only independent OOXML evidence for the authorized RQ Q3 acceptance case.

Never evaluates external links, rewrites originals, or writes product facts. Customer
values and generated-document excerpts belong outside every Git checkout.
"""
from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"w": W, "s": S, "r": R}
CHAPTER = re.compile(r"^第([一二三四五六七八九十百零〇\d]+)[章节](.+)")
NUMERIC = re.compile(r"^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalized(text: str) -> str:
    return re.sub(r"\s+", "", text).replace("，", ",").replace("．", ".")


def output_directory(path: Path) -> Path:
    result = path.resolve()
    if result == ROOT or result.is_relative_to(ROOT):
        raise ValueError("Customer evidence must be outside this Git checkout")
    for ancestor in [result, *result.parents]:
        if (ancestor / ".git").exists() or ((ancestor / "HEAD").is_file() and ((ancestor / "objects").is_dir() or (ancestor / "commondir").is_file())):
            raise ValueError("Customer evidence must be outside every Git repository")
    result.mkdir(parents=True, exist_ok=True)
    return result


def authorized_files() -> list[tuple[dict, Path, bytes]]:
    manifest = json.loads((ROOT / "tests/samples/2026-09-25/manifest.json").read_text(encoding="utf-8"))
    case = next(item for item in manifest["cases"] if item.get("case_id", item.get("id")) == "rq-202509")
    result = []
    for item in case["files"]:
        path = (ROOT / "tests/samples/2026-09-25" / item["path"]).resolve()
        if not path.is_relative_to((ROOT / "tests/samples/2026-09-25/rq-202509").resolve()):
            raise ValueError("Unauthorized source path")
        data = path.read_bytes()
        if len(data) != item["bytes"] or sha(data) != item["sha256"]:
            raise ValueError("Authorized source hash/size mismatch")
        result.append((item, path, data))
    if {item[0]["file_id"] for item in result} != {"rq-202509-01", "rq-202509-02", "rq-202509-03"}:
        raise ValueError("Exactly the three authorized RQ Q3 files are required")
    return result


def visible_text(element: ET.Element, accept: bool = True) -> str:
    tag = element.tag.removeprefix("{" + W + "}")
    if (accept and tag in {"del", "moveFrom"}) or (not accept and tag in {"ins", "moveTo"}):
        return ""
    if tag in {"t", "delText"}:
        return element.text or ""
    if tag == "tab":
        return "\t"
    if tag in {"br", "cr"}:
        return "\n"
    text = "".join(visible_text(child, accept) for child in element)
    return text + ("\n" if tag == "p" else "")


def word_inventory(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        # Parse all Word XML parts to catch broken XML independently of delivery availability.
        xml_errors = []
        for part in package.namelist():
            if part.startswith("word/") and part.endswith(".xml"):
                try:
                    ET.fromstring(package.read(part))
                except ET.ParseError as error:
                    xml_errors.append({"part": part, "error": str(error)})
        document = ET.fromstring(package.read("word/document.xml"))
        body = document.find("w:body", NS)
        if body is None:
            raise ValueError("Word document has no body")
        paragraphs, tables, nearby, chapters = [], [], [], []
        for index, child in enumerate(body):
            if child.tag == f"{{{W}}}p":
                text = visible_text(child).strip()
                style = child.find("w:pPr/w:pStyle", NS)
                row = {"body_index": index, "text": text, "style": style.attrib.get(f"{{{W}}}val") if style is not None else None}
                paragraphs.append(row)
                if text:
                    nearby.append(text)
                compact = normalized(text)
                chapter = CHAPTER.match(compact)
                # TOC entries normally have a trailing page number; body headings do not.
                if chapter and len(compact) <= 100 and not re.search(r"\d+$", compact):
                    chapters.append({"key": chapter.group(1), "title": compact, "body_index": index})
            elif child.tag == f"{{{W}}}tbl":
                rows = [[visible_text(cell).strip() for cell in row.findall("w:tc", NS)] for row in child.findall("w:tr", NS)]
                tables.append({"table_index": len(tables), "body_index": index, "context": nearby[-8:], "rows": rows})
        # Repeated headings in TOCs are not allowed to masquerade as full body coverage.
        unique = {item["key"]: item for item in chapters}
        accepted, rejected = visible_text(body, True), visible_text(body, False)
        chapter_bodies = []
        ordered = sorted(unique.values(), key=lambda value: value["body_index"])
        for position, heading in enumerate(ordered):
            end = ordered[position + 1]["body_index"] if position + 1 < len(ordered) else len(body)
            block = list(body)[heading["body_index"] + 1:end]
            chapter_bodies.append({"key": heading["key"], "title": heading["title"],
                                   "body_index": heading["body_index"], "end_body_index": end,
                                   "accepted_characters": sum(len(normalized(visible_text(element))) for element in block),
                                   "paragraph_count": sum(len(element.findall(".//w:p", NS)) + int(element.tag == f"{{{W}}}p") for element in block),
                                   "table_count": sum(int(element.tag == f"{{{W}}}tbl") for element in block)})
        media = [{"part": part, "bytes": len(package.read(part)), "sha256": sha(package.read(part))}
                 for part in package.namelist() if part.startswith("word/media/") and not part.endswith("/")]
        layout_tags = {"pgSz", "pgMar", "cols", "docGrid", "type", "titlePg"}
        layouts = [{child.tag.removeprefix("{" + W + "}"): dict(sorted(child.attrib.items())) for child in section
                    if child.tag.removeprefix("{" + W + "}") in layout_tags}
                   for section in document.findall(".//w:sectPr", NS)]
        style_ids = []
        if "word/styles.xml" in package.namelist():
            styles = ET.fromstring(package.read("word/styles.xml"))
            style_ids = sorted(style.attrib[f"{{{W}}}styleId"] for style in styles.findall("w:style", NS))
        return {
            "bytes": len(data), "sha256": sha(data), "word_xml_errors": xml_errors,
            "paragraph_count": len(paragraphs), "all_paragraph_count": len(body.findall(".//w:p", NS)),
            "table_count": len(tables), "accepted_characters": len(normalized(accepted)),
            "changes": {name: len(document.findall(f".//w:{name}", NS)) for name in ["ins", "del", "moveFrom", "moveTo"]},
            "chapters": list(unique.values()), "paragraphs": paragraphs, "tables": tables,
            "accepted_text": accepted, "rejected_text": rejected,
            "package_parts": len(package.namelist()), "chapter_bodies": chapter_bodies,
            "embedded_media": media, "section_layouts": layouts, "defined_style_ids": style_ids,
        }


def spreadsheet_inventory(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        strings = []
        if "xl/sharedStrings.xml" in package.namelist():
            strings = ["".join(item.itertext()) for item in ET.fromstring(package.read("xl/sharedStrings.xml")).findall("s:si", NS)]
        rels = {item.attrib["Id"]: item.attrib["Target"] for item in ET.fromstring(package.read("xl/_rels/workbook.xml.rels"))}
        sheets = []
        for item in ET.fromstring(package.read("xl/workbook.xml")).findall("s:sheets/s:sheet", NS):
            target = rels[item.attrib[f"{{{R}}}id"]]
            part = target.lstrip("/") if target.startswith("/") else "xl/" + target
            xml = ET.fromstring(package.read(part))
            state = item.attrib.get("state", "visible")
            cells = []
            for cell in xml.findall(".//s:sheetData/s:row/s:c", NS):
                kind, value = cell.attrib.get("t", "n"), cell.findtext("s:v", namespaces=NS)
                if kind == "s" and value is not None:
                    value = strings[int(value)]
                elif kind == "inlineStr":
                    value = "".join(cell.find("s:is", NS).itertext())
                formula = cell.findtext("s:f", namespaces=NS)
                cells.append({"cell": cell.attrib["r"], "value": value, "formula": formula, "type": kind,
                              "external_reference": bool(formula and "[" in formula)})
            sheets.append({"name": item.attrib["name"], "state": state, "cells": cells,
                           "used_for_current_financial_evidence": state == "visible",
                           "headers": [cell for cell in cells if re.search(r"^[A-Z]+[1-4]$", cell["cell"])],
                           "saved_errors": [cell for cell in cells if cell["type"] == "e"]})
        return {"bytes": len(data), "sha256": sha(data), "sheets": sheets,
                "visible_sheets": [item["name"] for item in sheets if item["state"] == "visible"],
                "excluded_hidden_sheets": [item["name"] for item in sheets if item["state"] != "visible"],
                "external_links_evaluated": False, "recalculated": False}


def additional_financial_controls(workbook: dict) -> list[dict]:
    """Choose disclosed line-item controls from the six visible current statements."""
    result = []
    balance_metrics = {"货币资金", "流动资产合计", "非流动资产合计", "负债合计", "所有者权益（或股东权益）合计",
                       "短期借款", "长期借款", "应付债券", "一年内到期的非流动负债"}
    profit_metrics = {"营业利润", "利润总额"}
    cash_metrics = {"投资活动产生的现金流量净额", "筹资活动产生的现金流量净额", "现金及现金等价物净增加额", "期末现金及现金等价物余额"}
    for sheet in workbook["sheets"]:
        if sheet["state"] != "visible" or not sheet["name"].startswith(("01", "02", "03")):
            continue
        scope = "母公司" if "母公司" in sheet["name"] else "合并"
        category = sheet["name"][:2]
        desired = {"01": balance_metrics, "02": profit_metrics, "03": cash_metrics}[category]
        cells = {cell["cell"]: cell for cell in sheet["cells"]}
        column = "C" if category == "03" else "D"
        unit_headers = [cell for cell in sheet["headers"] if isinstance(cell["value"], str) and "金额单位" in cell["value"]]
        if not unit_headers or any(normalized(cell["value"]).replace(":", "：") != "金额单位：人民币元" for cell in unit_headers):
            raise ValueError("Authorized source statement monetary unit changed or is ambiguous")
        for cell in sheet["cells"]:
            if not re.fullmatch(r"A\d+", cell["cell"]) or not isinstance(cell["value"], str):
                continue
            label = re.sub(r"^[一二三四五六七八九十]+[、:：]", "", normalized(cell["value"]))
            label = re.sub(r"^[（(][一二三四五六七八九十\d]+[）)]", "", label)
            matched = next((metric for metric in desired if label == metric or label.startswith(metric + "（") or label.startswith(metric + "(")), None)
            if matched is None:
                continue
            address = column + cell["cell"][1:]
            value = cells.get(address)
            if value is None or value["type"] != "n" or value["value"] is None or not NUMERIC.fullmatch(value["value"]):
                continue
            amount = Decimal(value["value"])
            # A blank or undetermined amount is not promoted to zero. Optional zero rows are not mandatory disclosure controls.
            if amount == 0:
                continue
            result.append({"id": f"RQ-Q3-LINE-{len(result)+1:02d}", "scope": scope, "metric": matched,
                           "sheet": sheet["name"], "cell": address, "period": "2025-09-30" if category == "01" else "2025-01-01 至 2025-09-30",
                           "unit": "人民币元", "saved_value": str(amount), "formula": value["formula"],
                           "external_reference": value["external_reference"], "label": {"saved_value": cell["value"]},
                           "source_unit_headers": unit_headers, "period_header": cells.get("B3"), "column_header": cells.get(column + "4"),
                           "review_status": "待人工确认", "source_is_approved_fact": False})
    return result


def baseline() -> dict:
    sources = authorized_files()
    evidence = {"schema": "rq-q3-source-baseline-v1", "case": "rq-202509", "real_customer_inputs": True,
                "target": {"issuer": "任丘市建设投资集团有限公司", "market": "sse", "offering": "private", "cutoff": "2025-09-30", "annual_years": [2023, 2024]},
                "source_cutoff": "2025-06-30", "sources": [], "source_word": None, "notes_word": None, "financial_workbook": None}
    for item, path, data in sources:
        evidence["sources"].append({"file_id": item["file_id"], "path": item["path"], "bytes": len(data), "sha256": sha(data)})
        kind = {"rq-202509-01": "source_word", "rq-202509-02": "financial_workbook", "rq-202509-03": "notes_word"}[item["file_id"]]
        evidence[kind] = spreadsheet_inventory(data) if kind == "financial_workbook" else word_inventory(data)
        if path.read_bytes() != data:
            raise ValueError("Original changed during read-only inspection")
    spec = importlib.util.spec_from_file_location("existing_rq_review", ROOT / "scripts/prepare_rq_q3_review.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    evidence["core_financial_cells"] = module.extract(ROOT)["rows"]
    evidence["additional_financial_cells"] = additional_financial_controls(evidence["financial_workbook"])
    evidence["financial_status"] = "Original saved formula caches, not approved facts; external links were not evaluated"
    return evidence


def summary(data: dict) -> dict:
    return {"case": data["case"], "verified_sources": len(data["sources"]),
            "source_word": {key: data["source_word"][key] for key in ["paragraph_count", "all_paragraph_count", "table_count", "accepted_characters"]},
            "source_chapter_count": len(data["source_word"]["chapters"]),
            "notes_word": {key: data["notes_word"][key] for key in ["paragraph_count", "table_count"]},
            "visible_sheets": len(data["financial_workbook"]["visible_sheets"]),
            "excluded_hidden_sheets": len(data["financial_workbook"]["excluded_hidden_sheets"]),
            "core_cells": len(data["core_financial_cells"]), "additional_line_item_cells": len(data["additional_financial_cells"]), "originals_unchanged": True}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT.parent / "quality-prelaunch-20261107")
    args = parser.parse_args()
    directory = output_directory(args.output_dir)
    data = baseline()
    (directory / "rq-q3-source-baseline.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    report = summary(data)
    (directory / "rq-q3-source-summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
