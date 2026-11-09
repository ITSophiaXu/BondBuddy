"""Independent post-download checks, separate from product delivery availability.

Original formula caches are comparison controls, not approved financial facts.
The checker never changes a document or evaluates workbook external links.
"""
from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
from pathlib import Path
import re
import unicodedata

from rq_q3_baseline import ROOT, baseline, normalized, output_directory, word_inventory

BALANCE_PERIOD = re.compile(r"2025(?:年)?(?:9月(?:30日|末)|[-./]0?9[-./]30)")
FLOW_PERIOD = re.compile(r"2025(?:年)?(?:1[-—－–~～至]9月|前三季度)")
SCOPE = re.compile(r"(合并|母公司)(资产负债表|利润表|现金流量表)")
UNIT = re.compile(r"(?:金额)?单位[:：]?(?:人民币)?(亿元|万元|元)")


def metric_label(text: str) -> str:
    value = compact(text)
    value = re.sub(r"^[一二三四五六七八九十]+[、:：]", "", value)
    return re.sub(r"^[（(][一二三四五六七八九十\d]+[）)]", "", value)


def compact(text: str) -> str:
    return normalized(unicodedata.normalize("NFKC", text))


def numeric(text: str) -> Decimal | None:
    value = compact(text).replace(",", "").replace("人民币", "")
    if value.startswith("(") and value.endswith(")"):
        value = "-" + value[1:-1]
    if not re.fullmatch(r"-?\d+(?:\.\d+)?", value):
        return None
    try:
        return Decimal(value)
    except InvalidOperation:
        return None


def table_statement(table: dict) -> tuple[str, str] | None:
    # The nearest explicit statement title controls the table, not any issuer narrative.
    for row in table["rows"][:2]:
        matches = list(SCOPE.finditer("".join(map(compact, row))))
        if matches:
            return matches[-1].group(1), matches[-1].group(2)
    for text in reversed(table["context"]):
        matches = list(SCOPE.finditer(compact(text)))
        if matches:
            return matches[-1].group(1), matches[-1].group(2)
    return None


def table_scope(table: dict) -> str | None:
    statement = table_statement(table)
    return statement[0] if statement else None


def table_unit(table: dict) -> str | None:
    for row in table["rows"][:2]:
        match = UNIT.search("".join(map(compact, row)))
        if match:
            return match.group(1)
    for text in reversed(table["context"]):
        match = UNIT.search(compact(text))
        if match:
            return match.group(1)
    return None


def period_header(text: str, pattern: re.Pattern) -> bool:
    value = compact(text)
    value = re.sub(r"\((?:未经审计|未审计|经审计|已审计)\)$", "", value)
    value = re.sub(r"(?:余额|累计)$", "", value)
    # A date mentioned in a prediction or explanation cannot identify a financial column.
    return pattern.fullmatch(value) is not None


def finance_checks(document: dict, controls: list[dict]) -> list[dict]:
    results = []
    for control in controls:
        candidates = []
        statement_kind = {"01": "资产负债表", "02": "利润表", "03": "现金流量表"}[control["sheet"][:2]]
        period = BALANCE_PERIOD if statement_kind == "资产负债表" else FLOW_PERIOD
        aliases = {metric_label(control["metric"]), metric_label(control["label"].get("saved_value") or "")}
        if control["metric"] == "资产总计":
            aliases.add("资产合计")
        if control["metric"] == "所有者权益（或股东权益）合计":
            aliases.update({"所有者权益合计", "股东权益合计"})
        for table in document["tables"]:
            if table_statement(table) != (control["scope"], statement_kind):
                continue
            unit = table_unit(table)
            if unit is None:
                continue
            target_columns = {i for row in table["rows"][:6] for i, text in enumerate(row) if period_header(text, period)}
            if not target_columns:
                continue
            divisor = {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}[unit]
            expected = (Decimal(control["saved_value"]) / divisor).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            for row_number, row in enumerate(table["rows"]):
                if not row:
                    continue
                label = metric_label(row[0])
                if not any(alias and (label == alias or label.removeprefix("其中:") == alias or label.removeprefix("其中：") == alias or label.startswith(alias + "(")) for alias in aliases):
                    continue
                for column in target_columns:
                    if column == 0 or column >= len(row):
                        continue
                    value = numeric(row[column])
                    candidates.append({"table": table["table_index"], "row": row_number, "column": column,
                                       "scope": control["scope"], "unit": unit, "delivered_text": row[column],
                                       "delivered_value": str(value) if value is not None else None, "expected_saved_cache_value": str(expected),
                                       "matches": value is not None and value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) == expected})
        results.append({"control_id": control["id"], "scope": control["scope"], "metric": control["metric"],
                        "source_sheet": control["sheet"], "source_cell": control["cell"], "source_period": control["period"],
                        "statement": statement_kind, "source_is_approved_fact": False,
                        "passed": bool(candidates) and all(row["matches"] for row in candidates), "candidates": candidates})
    return results


def first_difference(left: str, right: str) -> dict | None:
    a, b = compact(left), compact(right)
    if a == b:
        return None
    offset = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    return {"offset": offset, "left_characters": len(a), "right_characters": len(b),
            "left_context": a[max(0, offset-50):offset+100], "right_context": b[max(0, offset-50):offset+100]}


def chapter_checks(source: dict, generated: dict) -> list[dict]:
    generated_by_key = {row["key"]: row for row in generated["chapters"]}
    result = []
    for source_heading in source["chapters"]:
        found = generated_by_key.get(source_heading["key"])
        matching_title = found is not None and found["title"] == source_heading["title"]
        result.append({"title": source_heading["title"], "source_body_index": source_heading["body_index"],
                       "generated_body_index": found["body_index"] if found else None, "passed": matching_title})
    return result


def chapter_body_checks(source: dict, generated: dict) -> list[dict]:
    generated_by_key = {row["key"]: row for row in generated["chapter_bodies"]}
    return [{"key": chapter["key"], "title": chapter["title"], "source_characters": chapter["accepted_characters"],
             "delivered_characters": generated_by_key.get(chapter["key"], {}).get("accepted_characters", 0),
             # This detects empty/headings-only chapters; it does not approve the wording of a revised chapter.
             "passed": generated_by_key.get(chapter["key"], {}).get("accepted_characters", 0) >= min(200, chapter["accepted_characters"])}
            for chapter in source["chapter_bodies"]]


def check(clean_path: Path, tracked_path: Path, directory: Path) -> dict:
    source = baseline()
    clean = word_inventory(clean_path.read_bytes())
    tracked = word_inventory(tracked_path.read_bytes())
    clean_financial = finance_checks(clean, source["core_financial_cells"])
    tracked_financial = finance_checks(tracked, source["core_financial_cells"])
    additional_clean = finance_checks(clean, source["additional_financial_cells"])
    additional_tracked = finance_checks(tracked, source["additional_financial_cells"])
    chapters = chapter_checks(source["source_word"], clean)
    chapter_bodies = chapter_body_checks(source["source_word"], clean)
    source_media = {row["sha256"] for row in source["source_word"]["embedded_media"]}
    clean_media = {row["sha256"] for row in clean["embedded_media"]}
    acceptance_difference = first_difference(tracked["accepted_text"], clean["accepted_text"])
    rejection_difference = first_difference(tracked["rejected_text"], source["source_word"]["accepted_text"])
    clean_has_no_changes = not any(clean["changes"].values())
    tracked_has_changes = any(tracked["changes"].values())
    checks = {
        "all_source_chapters_retained": all(row["passed"] for row in chapters),
        "all_source_chapters_have_body_content": all(row["passed"] for row in chapter_bodies),
        # Half-size is a severe truncation sentinel, not a legal/completeness standard or a substitute for substantive review.
        "clean_body_not_severely_truncated": clean["accepted_characters"] >= source["source_word"]["accepted_characters"] // 2,
        "clean_all_eight_current_period_scope_and_unit_controls": all(row["passed"] for row in clean_financial),
        "tracked_all_eight_current_period_scope_and_unit_controls": all(row["passed"] for row in tracked_financial),
        "clean_additional_current_line_item_controls": bool(additional_clean) and all(row["passed"] for row in additional_clean),
        "tracked_additional_current_line_item_controls": bool(additional_tracked) and all(row["passed"] for row in additional_tracked),
        "clean_has_no_tracked_markup": clean_has_no_changes,
        "tracked_contains_actual_changes": tracked_has_changes,
        "accepting_tracked_changes_matches_clean_body": acceptance_difference is None,
        "rejecting_tracked_changes_matches_original_body": rejection_difference is None,
        "all_word_xml_parts_parse": not clean["word_xml_errors"] and not tracked["word_xml_errors"],
        "source_embedded_media_retained": source_media <= clean_media,
        "source_page_layout_sections_retained": source["source_word"]["section_layouts"] == clean["section_layouts"],
        "source_style_ids_retained": set(source["source_word"]["defined_style_ids"]) <= set(clean["defined_style_ids"]),
    }
    report = {"schema": "rq-q3-post-delivery-quality-v1", "real_customer_inputs": True, "external_links_evaluated": False,
              "industry_signoff": False, "financial_fact_approval": False, "rendered_visual_review": "not_performed",
              "checks": checks, "passed": sum(checks.values()), "total": len(checks), "chapters": chapters, "chapter_bodies": chapter_bodies,
              "clean_financial": clean_financial, "tracked_financial": tracked_financial,
              "additional_clean_financial": additional_clean, "additional_tracked_financial": additional_tracked,
              "acceptance_difference": acceptance_difference, "rejection_difference": rejection_difference,
              "source": {key: source["source_word"][key] for key in ["sha256", "paragraph_count", "table_count", "accepted_characters"]},
              "clean": {key: clean[key] for key in ["sha256", "bytes", "paragraph_count", "table_count", "accepted_characters", "changes", "word_xml_errors"]},
              "tracked": {key: tracked[key] for key in ["sha256", "bytes", "paragraph_count", "table_count", "accepted_characters", "changes", "word_xml_errors"]},
              "format_preservation": {"source_media_count": len(source_media), "delivered_media_count": len(clean_media),
                                      "source_section_layouts": source["source_word"]["section_layouts"], "delivered_section_layouts": clean["section_layouts"],
                                      "source_style_count": len(source["source_word"]["defined_style_ids"]), "delivered_style_count": len(clean["defined_style_ids"])},
              "limitations": ["Core and line-item formula caches are source comparison controls, not approved facts", "Half-size and chapter-content sentinels detect severe truncation only; full business and legal text still requires substantive review", "Structural XML checks do not establish Word/WPS layout compatibility"]}
    (directory / "rq-q3-quality-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (directory / "rq-q3-clean-inventory.json").write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    (directory / "rq-q3-tracked-inventory.json").write_text(json.dumps(tracked, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean", required=True, type=Path)
    parser.add_argument("--tracked", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    report = check(args.clean.resolve(), args.tracked.resolve(), output_directory(args.output_dir))
    print(json.dumps({"checks": report["checks"], "passed": report["passed"], "total": report["total"]}, ensure_ascii=False))
    raise SystemExit(0 if report["passed"] == report["total"] else 1)


if __name__ == "__main__":
    main()
