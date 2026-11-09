"""Read-only, bounded narrative regressions, independent of delivery/mechanical QA.

No customer amounts or issuer names are embedded here. Controls are extracted from
the authorized source inventory, never from the generated tables. This is not a
general semantic reviewer: unsupported wording, missing candidates and ambiguous
debt definitions require review instead of becoming successful checks.
"""
from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re

from rq_q3_baseline import baseline, output_directory, sha, word_inventory
from rq_q3_check import compact, numeric

SCHEMA = "rq-q3-narrative-regression-v1"
UNITS = {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}
NUMBER = r"-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
AMOUNT = re.compile(rf"(?P<number>{NUMBER})(?P<unit>亿元|万元|元)?")
PERIOD = re.compile(r"\d{4}年1月1日[至到](?:\d{4}年)?\d{1,2}月\d{1,2}日|"
                    r"\d{4}年(?:1[-—－–~～至]\d{1,2}月|前三季度|上半年|\d{1,2}月(?:\d{1,2}日|末)?|度|末)?|"
                    r"\d{4}[-./]\d{2}[-./]\d{2}")
DEBT = re.compile(r"(?:一年|1年)(?:以内|内)(?:到期)?的?(?:有息)?债务(?:本金)?")
SECTION = re.compile(r"^[（(][一二三四五六七八九十百]+[）)]")


def fail(message: str) -> None:
    raise ValueError(message)


def one(items: list, description: str):
    if len(items) != 1:
        fail(f"Expected exactly one {description}; found {len(items)}")
    return items[0]


def label(value: str) -> str:
    value = compact(value)
    value = re.sub(r"^[一二三四五六七八九十百\d]+[、.:：]", "", value)
    value = SECTION.sub("", value)
    return re.sub(r"^(?:减|加|其中)[:：]", "", value)


def period_patterns(target: dict) -> tuple[re.Pattern, re.Pattern]:
    cutoff = date.fromisoformat(target["cutoff"])
    y, m, d = cutoff.year, cutoff.month, cutoff.day
    flow = rf"{y}年(?:1[-—－–~～至]{m}月|1月1日[至到](?:{y}年)?{m}月{d}日)"
    if m == 9:
        flow += rf"|{y}年前三季度"
    balance = rf"{y}(?:年{m}月(?:{d}日|末)|[-./]{m:02d}[-./]{d:02d})"
    return re.compile(flow), re.compile(balance)


def unit_in(text: str) -> str:
    found = re.findall(r"(?:金额)?单位(?:为|[:：])(?:人民币)?(亿元|万元|元)(?=$|[,、;；。%])", compact(text))
    units = set(found)
    if len(units) != 1:
        fail("Missing, conflicting or unsupported monetary unit in source")
    return next(iter(units))


def statement_value(source: dict, kind: str, metric: str) -> dict:
    target = source["target"]
    flow, balance = period_patterns(target)
    sheet = one([s for s in source["financial_workbook"]["sheets"]
                 if s["state"] == "visible" and re.fullmatch(r"\d*合并" + kind, compact(s["name"]))],
                f"visible consolidated {kind}")
    cells = {c["cell"]: c for c in sheet["cells"]}
    headers = [c for c in sheet["cells"] if re.fullmatch(r"[A-Z]+[1-4]", c["cell"])]
    header_text = ";".join(str(c.get("value") or "") for c in headers)
    if compact(target["issuer"]) not in compact(header_text):
        fail("Source statement issuer does not match target")
    pattern = balance if kind == "资产负债表" else flow
    if not pattern.search(compact(header_text)):
        fail("Source statement does not disclose target period")
    column_headers = [c for c in headers if c["cell"].endswith("4") and
                      (compact(str(c.get("value") or "")) == "期末余额" if kind == "资产负债表"
                       else pattern.fullmatch(compact(str(c.get("value") or ""))))]
    column = re.sub(r"\d+", "", one(column_headers, "current financial column")["cell"])
    metric_cell = one([c for c in sheet["cells"] if re.fullmatch(r"A\d+", c["cell"])
                       and label(str(c.get("value") or "")) == metric], f"{metric} source row")
    address = column + re.sub(r"\D+", "", metric_cell["cell"])
    cell = cells.get(address, {})
    value = numeric(str(cell["value"])) if cell.get("value") is not None else None
    if cell.get("type") != "n" or value is None:
        fail(f"Missing numeric saved value for {metric}")
    unit = unit_in(header_text)
    return {"metric": metric, "value_yuan": str(value * UNITS[unit]), "sheet": sheet["name"],
            "cell": address, "source_unit": unit, "saved_value": cell["value"],
            "formula": cell.get("formula"), "external_reference": cell.get("external_reference", False)}


def note_section(notes: dict, title: str) -> list[dict]:
    headings = [p for p in notes["paragraphs"] if SECTION.match(compact(p["text"]))]
    start = one([p["body_index"] for p in headings if label(p["text"]) == title], f"notes section {title}")
    end = min((p["body_index"] for p in headings if p["body_index"] > start), default=10**9)
    return [t for t in notes["tables"] if start < t["body_index"] < end]


def note_value(tables: list[dict], metric: str, unit: str) -> dict:
    candidates = []
    for table in tables:
        header = table["rows"][0]
        columns = [i for i, value in enumerate(header) if compact(value) == "期末余额"]
        if not columns:
            continue
        column = one(columns, "notes period-end column")
        for row_number, row in enumerate(table["rows"][1:], 1):
            if row and label(row[0]) == metric:
                value = numeric(row[column]) if len(row) > column else None
                if value is None:
                    fail(f"Missing numeric source notes value for {metric}")
                candidates.append({"metric": metric, "value_yuan": str(value * UNITS[unit]),
                                   "body_index": table["body_index"], "row": row_number, "column": column,
                                   "source_unit": unit})
    return one(candidates, f"notes row {metric}")


def source_controls(source: dict) -> dict:
    """Reconcile issuer principal independently; no generated-table inputs allowed."""
    notes, target = source["notes_word"], source["target"]
    flow, balance = period_patterns(target)
    opening = "".join(p["text"] for p in notes["paragraphs"][:4])
    if compact(target["issuer"]) not in compact(opening) or not flow.search(compact(opening)):
        fail("Notes title must identify the target issuer and period")
    notes_unit = unit_in(";".join(p["text"] for p in notes["paragraphs"] if "金额单位" in p["text"]))
    current = note_section(notes, "一年内到期的非流动负债")
    long_payables = note_section(notes, "长期应付款")
    controls = {key: statement_value(source, kind, metric) for key, kind, metric in [
        ("expense", "利润表", "营业外支出"), ("short_loan", "资产负债表", "短期借款"),
        ("current_noncurrent", "资产负债表", "一年内到期的非流动负债"),
        ("long_loan", "资产负债表", "长期借款"), ("long_bond", "资产负债表", "应付债券")]}
    for key, metric in [("current_loan", "一年内到期的长期借款"), ("current_bond", "一年内到期的应付债券"),
                        ("current_lease", "一年内到期的长期应付款-应付融资租赁款"),
                        ("current_interest", "应付利息"), ("notes_current_total", "合计")]:
        controls[key] = note_value(current, metric, notes_unit)
    controls["long_lease"] = note_value(long_payables, "长期应付款", notes_unit)
    lease_rows = []
    for table in long_payables:
        for row_number, row in enumerate(table["rows"]):
            if row and "融资租赁" in row[0]:
                # The note section is consolidated: subsidiary lease components
                # belong in this total even though subsidiary narratives do not.
                value = numeric(row[1]) if len(row) > 1 else None
                if value is None:
                    fail("Lease component is blank or nonnumeric")
                lease_rows.append({"body_index": table["body_index"], "row": row_number,
                                   "value_yuan": str(value * UNITS[notes_unit])})
    values = {key: Decimal(row["value_yuan"]) for key, row in controls.items()}
    principal = sum(values[k] for k in ["current_loan", "current_bond", "current_lease"])
    reconciliations = {
        "notes_current_total_matches_visible_statement": abs(values["notes_current_total"] - values["current_noncurrent"]) <= Decimal("0.01"),
        "current_components_plus_interest_match_visible_statement": abs(principal + values["current_interest"] - values["current_noncurrent"]) <= Decimal("0.01"),
        "lease_components_match_long_payables": bool(lease_rows) and abs(sum(Decimal(r["value_yuan"]) for r in lease_rows) - values["long_lease"]) <= Decimal("0.01"),
    }
    if not all(reconciliations.values()):
        fail("Independent principal source reconciliation failed: " + ", ".join(k for k, v in reconciliations.items() if not v))
    within = values["short_loan"] + principal
    total = within + sum(values[k] for k in ["long_loan", "long_bond", "long_lease"])
    if within <= 0 or total <= 0:
        fail("Debt denominator/numerator must be positive for this control")
    variants = {}
    for basis, interest in [("principal", Decimal(0)), ("including_current_interest", values["current_interest"])]:
        variants[basis] = {"within_one_year_yuan": str(within + interest), "total_debt_yuan": str(total + interest),
                           "current_noncurrent_yuan": str(principal + interest),
                           "ratio_percent": str((within + interest) / (total + interest) * 100)}
    caveats = [{"body_index": p["body_index"], "text": p["text"]} for p in notes["paragraphs"]
               if "期末" in p["text"] and "指" in p["text"] and "金额单位" in p["text"]
               and not balance.search(compact(p["text"]))]
    return {"target": target, "components": controls, "lease_components": lease_rows, "reconciliations": reconciliations,
            "debt_variants": variants, "source_period_caveats": caveats,
            "source_is_approved_fact": False, "external_links_evaluated": False,
            "basis_limit": "Principal and interest-inclusive variants are comparison controls, not a choice of document definition. Notes period boilerplate is retained as a caveat; current components reconcile to the visible target statement."}


def result(identifier: str, candidates: list[dict], ignored: list[dict] | None = None) -> dict:
    passed = bool(candidates) and all(c["status"] == "passed" for c in candidates)
    status = "passed" if passed else "failed" if not candidates or any(c["status"] == "failed" for c in candidates) else "clarification_required"
    return {"id": identifier, "status": status, "passed": passed, "candidate_count": len(candidates),
            "missing_candidate": not candidates, "candidates": candidates, "ignored": ignored or []}


def definition_checks(document: dict, target: dict) -> list[dict]:
    flow, balance = period_patterns(target)
    results = []
    for key, pattern in [("最近两年及一期", flow), ("最近两年及一期末", balance)]:
        candidates = []
        for table in document["tables"]:
            for index, row in enumerate(table["rows"]):
                if not row or compact(row[0]) != key:
                    continue
                # Only glossary rows, not financial tables mentioning the phrase.
                if not any("释义" in c for c in table.get("context", [])):
                    continue
                value = compact("".join(row[1:])).removeprefix("指")
                expected_years = target["annual_years"]
                years = {int(y) for y in re.findall(r"(\d{4})年", value)}
                target_year = date.fromisoformat(target["cutoff"]).year
                matches = bool(pattern.search(value)) and years == set(expected_years) | {target_year}
                annual_suffix = r"度" if key.endswith("期") else r"(?:末|12月31日)"
                annual = re.compile(rf"(?:{'|'.join(str(year) for year in expected_years)})年{annual_suffix}")
                for year in expected_years:
                    matches = matches and bool(re.search(rf"{year}年{annual_suffix}", value))
                # Full-date ranges are single tokens. Every explicit period must
                # belong to this flow/balance definition; one correct range
                # cannot conceal a stale or differently typed period.
                periods = PERIOD.findall(value)
                matches = matches and all(pattern.fullmatch(p) or annual.fullmatch(p) for p in periods)
                candidates.append({"body_index": table["body_index"], "row": index, "text": " | ".join(row),
                                   "status": "passed" if matches else "failed", "reason": "target_period_definition"})
        results.append(result("period_definition_" + ("flow" if key.endswith("期") else "balance"), candidates))
    return results


def issuer_scope(prefix: str, target: dict) -> str:
    clean = prefix.replace(compact(target["issuer"]), "发行人")
    # Prefer the local subject over a comparison elsewhere in the prefix, e.g.
    # "与母公司相比，...，发行人". Mixed local subjects stay unresolved.
    local = re.split(r"[,，;；。]", clean)[-1]
    subject = local if re.search(r"发行人|本公司|公司|担保人|其他企业", local) else clean
    issuer = bool(re.search(r"发行人|本公司|(?:^|[,，])公司", subject))
    other = bool(re.search(r"子公司|担保人|母公司|该公司|其他企业", subject) or
                 re.search(r"[^,，;；。()]{2,}(?:有限公司|有限责任公司)", subject))
    if issuer and other:
        return "other_entity_or_scope" if re.search(r"(?:发行人|本公司)(?:的)?(?:子公司|母公司)", subject) else "unresolved"
    if other:
        return "other_entity_or_scope"
    if issuer:
        return "issuer"
    return "unresolved"


def classify_period(prefix: str, target: dict, flow_kind: bool, *, sequence: bool = False) -> tuple[str, list[str]]:
    flow, balance = period_patterns(target)
    pattern = flow if flow_kind else balance
    periods = PERIOD.findall(prefix)
    current = [p for p in periods if pattern.fullmatch(p)]
    relative = bool(re.search(r"报告期(?:内|末)|最近两年及一期(?:末)?|本期", prefix))
    if current:
        if not sequence and any(not pattern.fullmatch(p) for p in periods):
            return "ambiguous", periods
        return "current", periods
    if periods:
        if relative:
            return "ambiguous", periods
        return "explicit_other_period", periods
    if relative:
        return "current_relative", []
    if re.search(r"历史|最近两年(?:末)?|上年|上期", prefix):
        return "historical", []
    return "unresolved", []


def amount_sequence(tail: str) -> list[dict]:
    intro = re.match(r"(?:分别)?(?:发生额|金额|余额)?(?:分别)?(?:为|是|[:：])", tail)
    if not intro:
        return []
    tail = tail[intro.end():]
    found, position = [], 0
    while True:
        match = AMOUNT.match(tail, position)
        if not match:
            break
        found.append({"number": match["number"], "unit": match["unit"]})
        position = match.end()
        separator = re.match(r"(?:以及|[、,，及和与])", tail[position:])
        if not separator:
            break
        position += separator.end()
        if separator[0] not in {",", "，"} and not AMOUNT.match(tail, position):
            return []
    if re.match(r"(?:以及|还有|另有|和|与|及)(?:-?\d|$)", tail[position:]):
        return []
    # A single final unit may apply to an enumerated sequence; competing explicit
    # units must stay local to each amount rather than being silently unified.
    explicit = {x["unit"] for x in found if x["unit"]}
    if len(explicit) == 1:
        for item in found:
            item["unit"] = item["unit"] or next(iter(explicit))
    return found


def amount_match(actual: dict, expected_yuan: str) -> dict:
    value = numeric(actual["number"])
    unit = actual.get("unit")
    if value is None or unit not in UNITS:
        return {"matches": False, "error": "missing_or_unsupported_amount_unit"}
    precision = Decimal(1).scaleb(value.as_tuple().exponent)
    expected = (Decimal(expected_yuan) / UNITS[unit]).quantize(precision, rounding=ROUND_HALF_UP)
    return {"matches": value == expected, "delivered_value": str(value), "unit": unit,
            "expected_value_at_display_precision": str(expected)}


def metric_clauses(document: dict, pattern: re.Pattern, target: dict, flow_kind: bool) -> tuple[list[dict], list[dict]]:
    candidates, ignored = [], []
    for paragraph in document["paragraphs"]:
        for text in re.split(r"[。；;\n]", compact(paragraph["text"])):
            matches = list(pattern.finditer(text))
            starts = [0]
            for previous, match in zip(matches, matches[1:]):
                between = text[previous.end():match.start()]
                period = PERIOD.search(between) or re.search(r"截至|报告期|最近两年及一期|本期", between)
                comma = between.rfind(",", 0, period.start()) if period else between.rfind(",")
                starts.append(previous.end() + comma + 1 if comma >= 0 else previous.end())
            for index, match in enumerate(matches):
                start = starts[index]
                end = starts[index + 1] if index + 1 < len(starts) else len(text)
                clause = text[start:end].strip(",")
                prefix = text[start:match.start()].strip(",")
                tail = text[match.end():end].rstrip(",")
                scope = issuer_scope(prefix, target)
                period, periods = classify_period(prefix, target, flow_kind, sequence="分别" in tail)
                row = {"body_index": paragraph["body_index"], "text": clause, "prefix": prefix,
                       "tail": tail, "scope": scope, "period_classification": period, "periods": periods}
                if re.fullmatch(r"(?:分析|明细|情况)?[:：]?", row["tail"]) or re.match(r"^表\d", clause):
                    row["reason"] = "heading_or_table_caption_not_narrative"
                    ignored.append(row)
                elif scope == "other_entity_or_scope" or period in {"explicit_other_period", "historical"}:
                    row["reason"] = scope if scope == "other_entity_or_scope" else period
                    ignored.append(row)
                else:
                    candidates.append(row)
    return candidates, ignored


def expense_check(document: dict, controls: dict) -> dict:
    target = controls["target"]
    candidates, ignored = metric_clauses(document, re.compile("营业外支出"), target, True)
    flow, _ = period_patterns(target)
    for candidate in candidates:
        values = amount_sequence(candidate["tail"])
        errors, selected = [], None
        if candidate["scope"] != "issuer" or candidate["period_classification"] not in {"current", "current_relative"}:
            errors.append("unresolved_issuer_or_period")
        if "分别" in candidate["tail"]:
            periods = candidate["periods"]
            if periods:
                indexes = [i for i, p in enumerate(periods) if flow.fullmatch(p)]
                if len(values) == len(periods) and len(indexes) == 1:
                    selected = values[indexes[0]]
            elif len(values) == len(target["annual_years"]) + 1:
                selected = values[-1]
        elif len(values) == 1:
            selected = values[0]
        if selected is None:
            errors.append("unparsed_or_ambiguous_current_amount")
            comparison = {"matches": False}
        else:
            comparison = amount_match(selected, controls["components"]["expense"]["value_yuan"])
        candidate.update({"status": "passed" if not errors and comparison["matches"] else "failed",
                          "errors": errors, "comparison": comparison})
    return result("current_nonoperating_expense_narrative", candidates, ignored)


def debt_basis_declarations(text: str) -> list[str]:
    # Consume a complete negative phrase before its positive suffix. Retain all
    # declarations so a correct first phrase cannot hide a contradictory one.
    inclusive_negative = r"(?:不|未|不予|不得|无需|无须)(?:扣除|剔除)应付利息"
    phrases = re.finditer(rf"{inclusive_negative}|(?:不含|不包括|不包含|扣除|剔除)应付利息|(?:包含|包括|含)应付利息|[+＋\-−－]应付利息", text)
    return ["including_current_interest" if re.fullmatch(inclusive_negative, match[0]) or
            re.fullmatch(r"(?:包含|包括|含|[+＋])应付利息", match[0]) else "principal"
            for match in phrases]


def declared_basis(text: str) -> str | None:
    if re.search(r"未明确|是否|待(?:人工)?确认|待核", text):
        return None
    bases = set(debt_basis_declarations(text))
    return next(iter(bases)) if len(bases) == 1 else None


def current_debt_clauses(text: str, target: dict) -> tuple[str, bool]:
    """Keep the current/undated declaration; retain ambiguity, skip explicit history."""
    selected, active, ambiguous = [], True, False
    for clause in re.split(r"[,，。；;]", text):
        period, _ = classify_period(clause, target, False)
        if period in {"explicit_other_period", "historical"}:
            active = False
        elif period in {"current", "current_relative", "ambiguous"}:
            active = True
        if active:
            selected.append(clause)
            ambiguous = ambiguous or period == "ambiguous"
    return ";".join(selected), ambiguous


def supported_debt_formulas(text: str) -> bool:
    """Recognize a bounded sum, not arbitrary mathematical/prose expressions."""
    expressions = re.findall(r"(?:全部|有息)债务(?:的)?(?:计算公式)?[=＝]([^。；;\n]+)", text)
    expected = {"短期借款", "一年内到期的非流动负债", "长期借款", "应付债券", "长期应付款中有息债务"}
    for expression in expressions:
        # A note may explain the interest treatment, but cannot change a sign,
        # add a sixth debt component, or subtract the same interest twice.
        expression = expression.translate(str.maketrans({"（": "(", "）": ")", "＋": "+", "－": "-", "−": "-"}))
        annotations = re.findall(r"\(([^()]*)\)", expression)
        if any(declared_basis(annotation) is None for annotation in annotations):
            return False
        if len(debt_basis_declarations(expression)) > 1:
            return False
        expression = re.sub(r"\([^()]*\)", "", expression)
        expression = expression.replace("-应付利息", "")
        terms = expression.split("+")
        if len(terms) != len(expected) or set(terms) != expected:
            return False
    return True


def debt_table_comparisons(document: dict, controls: dict) -> list[dict]:
    """Generated tables corroborate definition consistency, never supply controls."""
    _, balance = period_patterns(controls["target"])
    candidates = []
    for table in document["tables"]:
        context = table.get("context", [])
        if not any(re.search(r"有息(?:债务|负债)|全部债务", text) for text in context):
            continue
        if any("母公司" in text or "担保人" in text for text in context[-3:]):
            continue
        # This control covers the debt composition table, not a maturity table
        # whose first column represents a different measure.
        rows = table["rows"]
        if not any(row and compact(row[0]) == "一年内到期的非流动负债" for row in rows):
            continue
        header_matches = [(r, i) for r, row in enumerate(rows[:2]) for i, value in enumerate(row)
                          if balance.fullmatch(compact(value))]
        ambiguous_headers = [(r, i, value) for r, row in enumerate(rows[:2]) for i, value in enumerate(row)
                             if balance.search(compact(value)) and not balance.fullmatch(compact(value))]
        for header_row, column, value in ambiguous_headers:
            candidates.append({"body_index": table["body_index"], "row": header_row, "column": column,
                               "metric": "ambiguous_current_table_header", "text": value,
                               "comparisons": {basis: {"matches": False, "error": "ambiguous_current_table_header"}
                                               for basis in controls["debt_variants"]}})
        if not header_matches:
            continue
        units = [text for text in [*context, *(";".join(row) for row in rows[:2])] if "单位" in text]
        try:
            unit = unit_in(units[-1]) if units else None
        except ValueError:
            unit = None
        for header_row, column in header_matches:
            # Support the common two-line amount/percentage header without
            # interpreting the later period's raw cell index as a data column.
            data_column = column
            if header_row + 1 < len(rows) and rows[header_row + 1].count("金额") > 1:
                subheader = rows[header_row + 1]
                amount_columns = [i for i, value in enumerate(subheader) if compact(value) == "金额"]
                if 0 < column <= len(amount_columns):
                    data_column = amount_columns[column - 1]
            for row_number, row in enumerate(rows):
                if not row or compact(row[0]) not in {"一年内到期的非流动负债", "合计"}:
                    continue
                metric = "current_noncurrent_yuan" if compact(row[0]) != "合计" else "total_debt_yuan"
                value = row[data_column] if data_column < len(row) else ""
                comparisons = {basis: amount_match({"number": value, "unit": unit}, amounts[metric])
                               for basis, amounts in controls["debt_variants"].items()}
                candidates.append({"body_index": table["body_index"], "row": row_number, "column": data_column,
                                   "metric": metric, "comparisons": comparisons})
    return candidates


def debt_definition_check(document: dict, controls: dict) -> dict:
    candidates = []
    paragraphs = sorted(document["paragraphs"], key=lambda p: p["body_index"])
    for i, paragraph in enumerate(paragraphs):
        text = compact(paragraph["text"])
        definition_match = re.search(r"(?:全部|有息)债务(?:的)?(?:计算公式)?[=＝]|(?:全部|有息)债务(?:均)?(?:按本金|按[^,，。;；]{0,20}口径|不?包括|不?包含|的定义|的口径)", text)
        if not definition_match:
            continue
        if "母公司" in text or "子公司" in text or "担保人" in text:
            continue
        following = paragraphs[i + 1] if i + 1 < len(paragraphs) else None
        if following and following["body_index"] == paragraph["body_index"] + 1 and re.search(r"上述|全部债务|有息债务", following["text"]):
            text += compact(following["text"])
        basis_text, ambiguous_period = current_debt_clauses(text, controls["target"])
        if not basis_text:
            continue
        basis = declared_basis(basis_text)
        formula_supported = supported_debt_formulas(basis_text) and not ambiguous_period
        reason = ("unsupported_or_conflicting_debt_formula" if not formula_supported else
                  "conflicting_debt_interest_treatments" if len(set(debt_basis_declarations(basis_text))) > 1 else
                  "explicit_debt_interest_treatment" if basis else "debt_definition_must_state_interest_treatment")
        candidates.append({"body_index": paragraph["body_index"], "text": text, "basis": basis,
                           "status": "passed" if basis and formula_supported else "clarification_required",
                           "reason": reason})
    bases = {c["basis"] for c in candidates if c["basis"]}
    if len(bases) > 1:
        for candidate in candidates:
            candidate.update(status="clarification_required", reason="conflicting_debt_definitions")
    checked = result("debt_definition_interest_treatment", candidates)
    if not candidates:
        checked["status"] = "clarification_required"
    checked["basis"] = next(iter(bases)) if checked["passed"] and len(bases) == 1 else None
    checked["current_table_comparisons"] = debt_table_comparisons(document, controls)
    if checked["basis"] and any(not item["comparisons"][checked["basis"]]["matches"] for item in checked["current_table_comparisons"]):
        checked.update(passed=False, status="failed", reason="current_debt_table_disagrees_with_explicit_definition")
    return checked


def debt_narrative_check(document: dict, controls: dict, definition: dict) -> dict:
    candidates, ignored = metric_clauses(document, DEBT, controls["target"], False)
    for candidate in candidates:
        amounts = amount_sequence(candidate["tail"])
        all_ratios = list(re.finditer(rf"占(?:全部|有息)债务(?:总额)?(?:的)?(?:比例)?(?:为|是)?({NUMBER})%", candidate["tail"]))
        ratios, ambiguous_ratio_period = [], False
        for item in all_ratios:
            ratio_prefix = re.split(r"[,，]", candidate["tail"][:item.start()])[-1]
            ratio_period, _ = classify_period(ratio_prefix, controls["target"], False)
            if ratio_period not in {"explicit_other_period", "historical"}:
                ratios.append(item)
                ambiguous_ratio_period = ambiguous_ratio_period or ratio_period == "ambiguous"
        ratio = ratios[0] if len(ratios) == 1 else None
        errors = []
        if candidate["scope"] != "issuer" or candidate["period_classification"] not in {"current", "current_relative"}:
            errors.append("unresolved_issuer_or_period")
        if len(ratios) > 1:
            errors.append("multiple_current_debt_ratios")
        if ambiguous_ratio_period:
            errors.append("ambiguous_current_debt_ratio_period")
        local_text, ambiguous_local_period = current_debt_clauses(candidate["text"], controls["target"])
        local_declarations = debt_basis_declarations(local_text)
        local_basis = declared_basis(local_text)
        if local_declarations and (local_basis is None or ambiguous_local_period or
                                   (definition["basis"] and local_basis != definition["basis"])):
            errors.append("conflicting_or_unresolved_local_debt_basis")
        comparisons = {}
        for basis, values in controls["debt_variants"].items():
            amount = amount_match(amounts[0], values["within_one_year_yuan"]) if len(amounts) == 1 else {"matches": False}
            ratio_matches = False
            expected_ratio = None
            if ratio:
                number = numeric(ratio[1])
                precision = Decimal(1).scaleb(number.as_tuple().exponent)
                expected_ratio = str(Decimal(values["ratio_percent"]).quantize(precision, rounding=ROUND_HALF_UP))
                ratio_matches = number == Decimal(expected_ratio)
            comparisons[basis] = {"amount": amount, "delivered_ratio": ratio[1] if ratio else None,
                                  "expected_ratio_at_display_precision": expected_ratio,
                                  "matches": amount["matches"] and ratio_matches}
        basis = definition["basis"]
        if errors or not any(c["matches"] for c in comparisons.values()) or (basis and not comparisons[basis]["matches"]):
            status = "failed"
        else:
            status = "passed" if basis else "clarification_required"
        candidate.update(status=status, errors=errors, comparisons=comparisons,
                         declared_basis=basis, reason="source_reconciled_debt_variants; ambiguous basis cannot pass")
    return result("current_one_year_debt_narrative", candidates, ignored)


def check_document(document: dict, controls: dict) -> dict:
    definition = debt_definition_check(document, controls)
    checks = [*definition_checks(document, controls["target"]), expense_check(document, controls),
              debt_narrative_check(document, controls, definition), definition]
    return {"checks": {r["id"]: r["passed"] for r in checks}, "results": checks,
            "passed": sum(r["passed"] for r in checks), "total": len(checks)}


def check(clean_path: Path, tracked_path: Path, directory: Path, source: dict | None = None) -> dict:
    directory = output_directory(directory)
    source_mode = "provided_source_inventory" if source is not None else "verified_authorized_originals"
    source = source if source is not None else baseline()
    controls = source_controls(source)
    clean_bytes, tracked_bytes = clean_path.read_bytes(), tracked_path.read_bytes()
    clean, tracked = word_inventory(clean_bytes), word_inventory(tracked_bytes)
    clean_result, tracked_result = check_document(clean, controls), check_document(tracked, controls)
    checks = {f"{name}_{key}": value for name, result_ in [("clean", clean_result), ("tracked", tracked_result)]
              for key, value in result_["checks"].items()}
    report = {"schema": SCHEMA, "status": "passed" if all(checks.values()) else "not_accepted",
              "checks": checks, "passed": sum(checks.values()), "total": len(checks),
              "clean": clean_result, "tracked": tracked_result, "source_controls": controls,
              "source_mode": source_mode,
              "source_hashes": {key: source[key].get("sha256") for key in ["source_word", "notes_word", "financial_workbook"]},
              "document_hashes": {"clean": sha(clean_bytes), "tracked": sha(tracked_bytes)},
              "originals_or_generated_files_modified": False, "external_links_evaluated": False,
              "financial_fact_approval": False, "industry_signoff": False,
              "limitations": ["Bounded regression checks are not complete semantic, legal or visual review.",
                              "Explicit historical disclosures and other entities are outside issuer current controls; they cannot satisfy missing current candidates.",
                              "Debt values are independently reconciled saved-source controls. Ambiguous debt definitions require clarification, even when a value matches one variant.",
                              "Qualitative assertions and source-note inconsistencies require the separate manual review; numeric matching does not approve facts."]}
    if clean_path.read_bytes() != clean_bytes or tracked_path.read_bytes() != tracked_bytes:
        fail("A delivered Word changed during the read-only inspection")
    (directory / "rq-q3-narrative-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clean", required=True, type=Path)
    parser.add_argument("--tracked", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--baseline", type=Path, help="Optional private saved source inventory; default rereads authorized originals")
    args = parser.parse_args()
    directory = output_directory(args.output_dir)
    try:
        source = json.loads(args.baseline.read_text(encoding="utf-8-sig")) if args.baseline else None
        report = check(args.clean.resolve(), args.tracked.resolve(), directory, source)
    except (ValueError, KeyError, OSError) as error:
        report = {"schema": SCHEMA, "status": "source_or_execution_error", "checks": {}, "passed": 0, "total": 0,
                  "error": str(error), "financial_fact_approval": False}
        (directory / "rq-q3-narrative-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"schema": SCHEMA, "status": report["status"], "passed": 0, "total": 0}))
        raise SystemExit(2)
    print(json.dumps({key: report[key] for key in ["schema", "status", "checks", "passed", "total"]}, ensure_ascii=False))
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
