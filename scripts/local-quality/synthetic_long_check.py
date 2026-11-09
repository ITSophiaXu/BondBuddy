"""Independent checks of synthetic product output. No customer files or product state are read."""
from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

# These pure OOXML helpers perform no file I/O on import. Do not call baseline()/authorized_files().
from rq_q3_baseline import word_inventory, sha, visible_text, NS


def compact(value):
    return re.sub(r"\s+", "", value).replace("，", ",").replace("：", ":")


def number(value):
    text = compact(value).replace(",", "")
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    if text.startswith("（") and text.endswith("）"):
        text = "-" + text[1:-1]
    try:
        return Decimal(text) if re.fullmatch(r"-?\d+(?:\.\d+)?", text) else None
    except InvalidOperation:
        return None


def period_label(header):
    text = re.sub(r"(?<=[\d月])至(?=\d)", "-", compact(header).replace("—", "-").replace("–", "-"))
    return re.sub(r"(?:（(?:未经审计|未审计|经审计|已审计)）|\((?:未经审计|未审计|经审计|已审计)\))$", "", text)


def period_pattern(year, statement, expected=None):
    if statement == "资产负债表":
        september = year+r"(?:年9月(?:30日|末)|[-./]0?9[-./]30)"
        december = year+r"(?:年(?:12月31日|12月末|末)|[-./]12[-./]31)"
        selected = september if expected and expected.endswith("09-30") else december if expected else f"(?:{september}|{december})"
        return r"(?:截至)?" + selected
    annual = year + r"年度"
    flow = year+r"年(?:0?1-0?9月|前三季度|0?1月-0?9月)"
    return annual if expected and expected.endswith("年度") else flow if expected else f"(?:{annual}|{flow})"


def period_matches(header, expected, statement):
    year = expected[:4]
    # Full-cell matching rejects merged years, forecasts and flow labels ending in “月末”.
    return bool(re.fullmatch(period_pattern(year, statement, expected), period_label(header)))


def financial_checks(inventory, controls):
    results = []
    for control in controls:
        candidates = []
        for item in inventory["tables"]:
            # The nearest statement caption owns scope/unit. Earlier captions cannot qualify a different table.
            caption_index = next((i for i in reversed(range(len(item["context"])))
                                  if any(k in item["context"][i] for k in ["资产负债表", "利润表", "现金流量表"])), None)
            if caption_index is None or control["statement"] not in item["context"][caption_index]:
                continue
            context = " ".join(item["context"][caption_index:])
            metric_rows = [(i, row) for i, row in enumerate(item["rows"])
                           if row and compact(row[0]) == compact(control["metric"])]
            if not metric_rows:
                continue
            headers = item["rows"][:min(3, metric_rows[0][0])]
            scope_text = context + " ".join(" ".join(row) for row in headers)
            scopes = {scope for scope in ["合并", "母公司"] if scope in scope_text}
            if len(scopes) == 1 and control["scope"] not in scopes:
                continue
            # A later unit/scope declaration cannot silently lose to an earlier correct one.
            units = set()
            for value in [*item["context"][caption_index:], *(cell for row in item["rows"] for cell in row)]:
                for marker in re.finditer(r"单位\s*[:：]?\s*", value):
                    declaration = re.match(r"(?:人民币\s*)?([^\s,，;；。()（）]+)", value[marker.end():])
                    units.add(declaration[1] if declaration else "<unparsed-unit>")
            malformed_periods = [value for row in headers for value in row[1:]
                                 if re.search(r"(?:19|20)\d{2}(?:年|[-./])", compact(value))
                                 and not re.fullmatch(period_pattern(r"(?:19|20)\d{2}", control["statement"]), period_label(value))]
            errors = []
            if scopes != {control["scope"]}:
                errors.append("missing_or_conflicting_scope")
            if len(units) != 1 or not units <= {"元", "万元", "亿元"}:
                errors.append("missing_conflicting_or_unsupported_units")
            if malformed_periods:
                errors.append("ambiguous_or_invalid_period")
            if errors:
                candidates.append({"table": item["table_index"], "matches": False, "errors": errors,
                                   "scopes": sorted(scopes), "units": sorted(units), "invalid_periods": malformed_periods})
                continue
            unit = next(iter(units))
            multiplier = {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}[unit]
            columns = set()
            for row in headers:
                for index, value in enumerate(row):
                    if index > 0 and period_matches(value, control["period"], control["statement"]):
                        columns.add(index)
            if not columns:
                candidates.append({"table": item["table_index"], "matches": False, "errors": ["required_period_missing"],
                                   "required_period": control["period"]})
                continue
            for row_number, row in metric_rows:
                for column in columns:
                    if column >= len(row):
                        candidates.append({"table": item["table_index"], "row": row_number, "column": column,
                                           "matches": False, "errors": ["required_value_cell_missing"]})
                        continue
                    actual = number(row[column])
                    expected = Decimal(control["yuan"]) / multiplier
                    matches = actual is not None and actual.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) == expected.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
                    candidates.append({"table": item["table_index"], "row": row_number, "column": column,
                                       "unit": unit, "text": row[column], "expected": str(expected), "matches": matches})
        results.append({"id": control["id"], "passed": bool(candidates) and all(c["matches"] for c in candidates), "candidates": candidates})
    return results


def auxiliary(path):
    with zipfile.ZipFile(path) as package:
        roots = {name: ET.fromstring(package.read(name)) for name in package.namelist()
                 if name.startswith("word/") and name.endswith(".xml")}
        document = roots["word/document.xml"]
        return {"headers": [compact(visible_text(root)) for name, root in roots.items() if re.fullmatch(r"word/header\d+\.xml", name)],
                "footers": [compact(visible_text(root)) for name, root in roots.items() if re.fullmatch(r"word/footer\d+\.xml", name)],
                "repeating_table_headers": len(document.findall(".//w:tblHeader", NS)),
                "toc_links": len(document.findall(".//w:hyperlink[@w:anchor]", NS)),
                "toc_targets": [link.get("{" + NS["w"] + "}anchor") for link in document.findall(".//w:hyperlink[@w:anchor]", NS)],
                "bookmarks": len(document.findall(".//w:bookmarkStart", NS)),
                "bookmark_names": [item.get("{" + NS["w"] + "}name") for item in document.findall(".//w:bookmarkStart", NS)]}


def inspect_outputs(fixture_dir, clean_path, tracked_path, output_dir):
    manifest = json.loads((fixture_dir / "fixture-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != "synthetic-long-2026q3-v1" or manifest.get("synthetic_only") is not True or manifest.get("customer_inputs_read") is not False:
        raise ValueError("Only the dedicated purely synthetic fixture is accepted")
    for item in manifest["files"]:
        path = (fixture_dir / item["filename"]).resolve()
        if path.parent != fixture_dir or len(path.read_bytes()) != item["bytes"] or sha(path.read_bytes()) != item["sha256"]:
            raise ValueError("Synthetic input identity changed")
    source_path = fixture_dir / next(f["filename"] for f in manifest["files"] if f["role"] == "historical")
    source, clean, tracked = (word_inventory(path.read_bytes()) for path in [source_path, clean_path, tracked_path])
    source_aux, clean_aux = auxiliary(source_path), auxiliary(clean_path)
    clean_finance, tracked_finance = (financial_checks(item, manifest["controls"]) for item in [clean, tracked])
    clean_text, tracked_text = compact(clean["accepted_text"]), compact(tracked["accepted_text"])
    source_text = compact(source["accepted_text"])
    chapter_titles = {c["title"] for c in source["chapters"]}
    chapters_retained = chapter_titles <= {c["title"] for c in clean["chapters"]}
    body = {c["key"]: c["accepted_characters"] for c in clean["chapter_bodies"]}
    checks = {
        "fourteen_chapters_retained": len(chapter_titles) == 14 and chapters_retained,
        "each_chapter_keeps_substantial_body": all(body.get(c["key"], 0) >= max(200, c["accepted_characters"] * .6) for c in source["chapter_bodies"]),
        "all_26_source_retention_anchors": all(a in clean_text for a in manifest["retention_anchors"]),
        "body_not_severely_truncated": len(clean_text) >= len(source_text) * .75,
        "clean_all_24_financial_controls": len(clean_finance) == 24 and all(c["passed"] for c in clean_finance),
        "tracked_all_24_financial_controls": len(tracked_finance) == 24 and all(c["passed"] for c in tracked_finance),
        "clean_has_no_revision_markup": not any(clean["changes"].values()),
        "tracked_contains_actual_changes": any(tracked["changes"].values()),
        "accepted_tracked_matches_clean": tracked_text == clean_text,
        "rejected_tracked_matches_original": compact(tracked["rejected_text"]) == source_text,
        "word_xml_parse": not clean["word_xml_errors"] and not tracked["word_xml_errors"],
        "invented_image_bytes_preserved": {x["sha256"] for x in source["embedded_media"]} <= {x["sha256"] for x in clean["embedded_media"]},
        "section_geometry_preserved": source["section_layouts"] == clean["section_layouts"],
        "source_styles_preserved": set(source["defined_style_ids"]) <= set(clean["defined_style_ids"]),
        "source_header_footer_preserved": source_aux["headers"] == clean_aux["headers"] and source_aux["footers"] == clean_aux["footers"],
        "cross_page_table_headers_preserved": clean_aux["repeating_table_headers"] >= source_aux["repeating_table_headers"] >= 6,
        "directory_links_and_chapter_bookmarks_preserved": len(set(source_aux["toc_targets"])) == 14
        and set(source_aux["toc_targets"]) <= set(clean_aux["toc_targets"])
        and set(clean_aux["toc_targets"]) <= set(clean_aux["bookmark_names"]),
    }
    report = {"schema": "synthetic-long-quality-v1", "synthetic_only": True, "customer_inputs_read": False,
              "industry_signoff": False, "rendered_visual_review": "not_performed", "checks": checks,
              "passed": sum(checks.values()), "total": len(checks), "clean_finance": clean_finance, "tracked_finance": tracked_finance,
              "source": {k: source[k] for k in ["sha256", "table_count", "paragraph_count", "accepted_characters"]},
              "clean": {k: clean[k] for k in ["sha256", "table_count", "paragraph_count", "accepted_characters", "changes"]},
              "tracked": {k: tracked[k] for k in ["sha256", "changes"]}, "auxiliary": {"source": source_aux, "clean": clean_aux},
              "limitations": ["Mechanical sentinels do not establish full semantic correctness, industry signoff or Word/WPS compatibility.",
                              "Render and inspect every actual generated page separately."]}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "synthetic-long-quality-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", type=Path, required=True)
    parser.add_argument("--clean", type=Path, required=True)
    parser.add_argument("--tracked", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    result = inspect_outputs(args.fixture_dir.resolve(), args.clean.resolve(), args.tracked.resolve(), args.output_dir.resolve())
    print(json.dumps({"checks": result["checks"], "passed": result["passed"], "total": result["total"]}, ensure_ascii=False))
    raise SystemExit(0 if result["passed"] == result["total"] else 1)
