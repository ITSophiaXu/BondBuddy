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
DEBT = re.compile(r"(?:一年|1年)(?:以内|内)(?:到期)?的?(?:(?:有息)?债务|有息负债)(?:本金)?")
DEBT_RATIO = re.compile(rf"占(?:全部债务|有息(?:债务|负债))(?:总额)?(?:的)?(?:比例)?(?:为|是)?({NUMBER})%")
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
    """Reconcile issuer saved carrying values; no generated-table inputs allowed."""
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
            "basis_descriptions": {
                "principal": "期末账面额，扣除单列应付利息；principal 仅为兼容键，不代表票面本金。应付债券沿用已保存的期末账面值，不重新解释为票面金额。",
                "including_current_interest": "上述期末账面额加回附注单列应付利息；不代表票面本金。",
            },
            "basis_limit": "The compatibility key principal means saved period-end carrying amounts excluding separately stated interest, not face-value principal. The interest-inclusive variant adds only the separately stated source interest. These are comparison controls, not a choice of document definition or approval of facts. Notes period boilerplate is retained as a caveat; current components reconcile to the visible target statement."}


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
        if re.search(r"与[^,，;；。]*(?:相比|比较)", subject):
            return "unresolved"
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
    bookkeeping = bool(re.match(r"(?:分别)?账面(?:值|余额)", tail))
    intro = re.match(r"(?:分别)?(?:账面值|账面余额|发生额|金额|余额)?(?:分别)?(?:为|是|[:：])", tail)
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
    # A supported bookkeeping declaration must not silently stop before another
    # monetary value. Ordinary percentage prose is not another money amount.
    if bookkeeping and (any(match["unit"] for match in AMOUNT.finditer(tail[position:])) or
                        re.search(r"账面(?:值|余额)(?:分别)?(?:为|是|[:：])", tail[position:])):
        return []
    # A single final unit may apply to an enumerated sequence; competing explicit
    # units must stay local to each amount rather than being silently unified.
    explicit = {x["unit"] for x in found if x["unit"]}
    if len(explicit) == 1:
        for item in found:
            item["unit"] = item["unit"] or next(iter(explicit))
    return found


def amount_series(tail: str, values: list[dict]) -> bool:
    return "分别" in tail or (bool(re.match(r"账面(?:值|余额)(?:为|是|[:：])", tail)) and len(values) > 1)


def amount_match(actual: dict, expected_yuan: str) -> dict:
    value = numeric(actual["number"])
    unit = actual.get("unit")
    if value is None or unit not in UNITS:
        return {"matches": False, "error": "missing_or_unsupported_amount_unit"}
    precision = Decimal(1).scaleb(value.as_tuple().exponent)
    expected = (Decimal(expected_yuan) / UNITS[unit]).quantize(precision, rounding=ROUND_HALF_UP)
    return {"matches": value == expected, "delivered_value": str(value), "unit": unit,
            "expected_value_at_display_precision": str(expected)}


def bound_metric_period(prefix: str, target: dict, flow_kind: bool, *, sequence: bool = False) -> tuple[str, list[str], list[dict]]:
    """Keep a metric's own period; exclude only a named opposite-kind measure."""
    flow, balance = period_patterns(target)
    opposite = balance if flow_kind else flow
    mentions = list(PERIOD.finditer(prefix))
    excluded = []
    if not sequence:
        for index, mention in enumerate(mentions):
            if not opposite.fullmatch(mention[0]):
                continue
            end = mentions[index + 1].start() if index + 1 < len(mentions) else len(prefix)
            attached = prefix[mention.end():end]
            measure = re.search(r"现金流(?:量)?|货币资金|资产总额|总资产|负债总额", attached)
            name = r"(?:货币资金|资产总额|总资产|负债总额)" if flow_kind else r"(?:经营|投资|筹资)活动(?:产生的)?现金流量净额"
            disclosure = re.search(rf"{name}(?:为|是|[:：]){NUMBER}(?:亿元|万元|元)", attached)
            # A period is attached to an explicit measured financial statement,
            # not a general forecast/reference that merely contains its name.
            if (measure and disclosure and disclosure.start() <= measure.start() < disclosure.end()
                    and re.fullmatch(r"[,，]*(?:发行人|本公司|公司)?[,，]*", attached[:disclosure.start()])):
                excluded.append({"start": mention.start(), "end": mention.end(), "period": mention[0],
                                 "bound_measure": measure[0], "reason": "explicit_other_metric_period"})
    filtered = prefix
    for item in reversed(excluded):
        filtered = filtered[:item["start"]] + filtered[item["end"]:]
    status, periods = classify_period(filtered, target, flow_kind, sequence=sequence)
    # A target flow range is not a historical balance date, nor vice versa.
    # Keep it unresolved instead of letting another correct candidate hide it.
    if status == "explicit_other_period" and any(opposite.fullmatch(p) for p in periods):
        status = "unresolved"
    return status, periods, excluded


def temporal_only_prefix(prefix: str) -> bool:
    """Only a fully recognized temporal continuation may inherit a subject."""
    remainder = PERIOD.sub("", prefix)
    remainder = re.sub(r"最近两年及一期(?:末)?|报告期(?:内|末)|本期(?:末)?|截至|期末|于|在", "", remainder)
    return not re.sub(r"[,，:：()（）]", "", remainder)


def owned_issuer_introduction(text: str, target: dict) -> bool:
    """The supported inheritance anchor introduces the issuer's own subject."""
    clean = text.replace(compact(target["issuer"]), "发行人")
    return bool(re.fullmatch(r"(?:发行人|本公司|公司)披露(?:本期)?偿债情况", clean))


def metric_clauses(document: dict, pattern: re.Pattern, target: dict, flow_kind: bool) -> tuple[list[dict], list[dict]]:
    candidates, ignored = [], []
    for paragraph in document["paragraphs"]:
        inherited_issuer = False
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
                scope_source = "local_prefix"
                if scope == "unresolved" and inherited_issuer and temporal_only_prefix(prefix):
                    scope, scope_source = "issuer", "same_paragraph_preceding_explicit_subject"
                period, periods, bindings = bound_metric_period(prefix, target, flow_kind,
                                                               sequence=amount_series(tail, amount_sequence(tail)))
                row = {"body_index": paragraph["body_index"], "text": clause, "prefix": prefix,
                       "tail": tail, "scope": scope, "scope_source": scope_source,
                       "period_classification": period, "periods": periods, "other_metric_period_bindings": bindings}
                if re.fullmatch(r"(?:分析|明细|情况)?[:：]?", row["tail"]) or re.match(r"^表\d", clause):
                    row["reason"] = "heading_or_table_caption_not_narrative"
                    ignored.append(row)
                elif scope == "other_entity_or_scope" or period in {"explicit_other_period", "historical"}:
                    row["reason"] = scope if scope == "other_entity_or_scope" else period
                    ignored.append(row)
                else:
                    candidates.append(row)
            # Mentioning the issuer as the reporting actor is not evidence that
            # the reported facts concern it. Only a complete supported anchor
            # may establish ownership for the next temporal continuation.
            inherited_issuer = owned_issuer_introduction(text, target)
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
        if any(value["unit"] not in UNITS for value in values):
            errors.append("missing_or_unsupported_sequence_unit")
        if amount_series(candidate["tail"], values):
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
    interest = r"(?:单列)?应付利息"
    inclusive_negative = rf"(?:不|未|不予|不得|无需|无须)(?:扣除|剔除){interest}"
    double_negative = rf"(?:并非|不是|并不)(?:不含|不包括|不包含){interest}|{interest}(?:并非|不是|并不)不计入"
    inclusive = rf"{inclusive_negative}|{double_negative}|(?:包含|包括|含|[+＋]){interest}|{interest}(?:仍|亦|也)?计入"
    principal = rf"(?:不含|不包括|不包含|扣除|剔除|[\-−－]){interest}|{interest}不计入"
    # Full negative forms precede their positive suffixes. The suffix form also
    # covers an explicit shared exclusion: 专项应付款及单列应付利息不计入.
    phrases = re.finditer(rf"{double_negative}|{inclusive_negative}|{principal}|{inclusive}", text)
    return ["including_current_interest" if re.fullmatch(inclusive, match[0]) else "principal"
            for match in phrases]


def declared_basis(text: str) -> str | None:
    if re.search(r"未明确|是否|待(?:人工)?确认|待核", text):
        return None
    bases = set(debt_basis_declarations(text))
    return next(iter(bases)) if len(bases) == 1 else None


def current_debt_clauses(text: str, target: dict) -> tuple[str, bool]:
    """Keep the current/undated declaration; retain ambiguity, skip explicit history."""
    selected, active, ambiguous = [], True, False
    clauses, start, depth = [], 0, 0
    for index, character in enumerate(text):
        if character in "(（":
            depth += 1
        elif character in ")）":
            depth -= 1
            if depth < 0:
                ambiguous, depth = True, 0
        elif character in ",，。；;" and depth == 0:
            clauses.append(text[start:index])
            start = index + 1
    clauses.append(text[start:])
    ambiguous = ambiguous or depth != 0
    for clause in clauses:
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
    text = text.translate(str.maketrans({"（": "(", "）": ")", "＋": "+", "－": "-", "−": "-"}))
    expressions = list(re.finditer(r"(?:全部|有息)债务([^=＝。；;\n]{0,160})[=＝]([^。；;\n]+)", text))
    expected = {"短期借款", "一年内到期的非流动负债", "长期借款", "应付债券", "长期应付款中有息债务"}
    expanded = {"短期借款", "一年内到期的长期借款", "一年内到期的应付债券", "一年内到期的融资租赁款",
                "长期借款", "应付债券", "长期应付款中的应付融资租赁款"}
    explanations = text
    for expression_match in reversed(expressions):
        explanations = explanations[:expression_match.start()] + ";" + explanations[expression_match.end():]
    explanation_clauses = [clause for clause in re.split(r"[,，。；;\n]", explanations) if clause]
    for match in expressions:
        qualifier, expression = match[1], match[2]
        qualifier = re.sub(r"^(?:的)?(?:计算公式)?", "", qualifier)
        expanded_terms = expression.split("+")
        if len(expanded_terms) == len(expanded) and set(expanded_terms) == expanded:
            # The expanded formula contains saved carrying-value components. Its
            # exclusions and bond basis must be stated, never inferred from a sum.
            annotation = re.fullmatch(r"\(([^()]*)\)", qualifier)
            declarations = re.split(r"[,，]", annotation[1]) if annotation else []
            if len(declarations) != 2 or set(declarations) != {"期末账面值", "不含单列应付利息"}:
                return False
            interest_excluded = declared_basis(text) == "principal"
            # Whole declarations are checked. An unknown or negative prefix
            # cannot become an exclusion merely because it contains "扣除".
            special_disclosures = [clause for clause in explanation_clauses if "专项应付款" in clause]
            special_exclusion = (r"专项应付款(?:及单列应付利息)?不计入|"
                r"(?:(?:全部|有息)债务)?(?:不含|不包括|不包含|扣除|剔除)专项应付款"
                r"(?:且(?:不含|不包括|不包含)(?:单列)?应付利息)?")
            special_excluded = bool(special_disclosures) and all(
                re.fullmatch(special_exclusion, clause) for clause in special_disclosures)
            # Every current bond declaration outside the formulas is retained,
            # including other measurement methods and unrecognized wording.
            bond_disclosures = [clause for clause in explanation_clauses if "债券" in clause]
            bond_carrying_value = bool(bond_disclosures) and all(
                re.fullmatch(r"(?:其中)?应付债券按期末摊余成本列示", clause) for clause in bond_disclosures)
            pending_or_face_value = bool(re.search(r"待(?:定|核|确认)|未(?:明确|确定)|是否|票面(?:本金|金额|价值)|(?<!账)面值", text))
            if not interest_excluded or not special_excluded or not bond_carrying_value or pending_or_face_value:
                return False
            continue
        # A note may explain the interest treatment, but cannot change a sign,
        # add a sixth debt component, or subtract the same interest twice.
        if qualifier:
            return False
        annotations = re.findall(r"\(([^()]*)\)", expression)
        if any(declared_basis(annotation) is None for annotation in annotations):
            return False
        if len(debt_basis_declarations(expression)) > 1:
            return False
        expression = re.sub(r"\([^()]*\)", "", expression)
        expression = re.sub(r"-(?:单列)?应付利息", "", expression)
        terms = expression.split("+")
        if len(terms) != len(expected) or set(terms) != expected:
            return False
    return True


def debt_table_comparisons(document: dict, controls: dict) -> list[dict]:
    """Generated tables corroborate definition consistency, never supply controls."""
    _, balance = period_patterns(controls["target"])
    candidates = []
    row_bases = {"一年内到期的非流动负债": None,
                 "一年内到期的非流动有息负债(不含应付利息)": "principal",
                 "一年内到期的非流动有息负债(不含单列应付利息)": "principal"}
    for table in document["tables"]:
        context = table.get("context", [])
        if not any(re.search(r"有息(?:债务|负债)|全部债务", text) for text in context):
            continue
        if any("母公司" in text or "担保人" in text for text in context[-3:]):
            continue
        # This control covers the debt composition table, not a maturity table
        # whose first column represents a different measure.
        rows = table["rows"]
        current_rows = [(i, row) for i, row in enumerate(rows) if row and
                        re.fullmatch(r"一年内到期的非流动(?:有息)?负债(?:\([^()]*\))?", compact(row[0]))]
        if not current_rows:
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
        total_rows = [(i, row) for i, row in enumerate(rows) if row and compact(row[0]) == "合计"]
        coverage_errors = []
        if len(current_rows) != 1:
            coverage_errors.append("current_noncurrent_row_must_be_unique")
        if len(total_rows) != 1:
            coverage_errors.append("total_debt_row_missing_or_duplicate")
        if any(compact(row[0]) not in row_bases for _, row in current_rows):
            coverage_errors.append("unsupported_current_noncurrent_row_label")
        if coverage_errors:
            candidates.append({"body_index": table["body_index"], "metric": "incomplete_or_ambiguous_debt_table",
                               "coverage": "incomplete_or_ambiguous", "errors": coverage_errors,
                               "current_row_count": len(current_rows), "total_row_count": len(total_rows),
                               "comparisons": {basis: {"matches": False, "error": "incomplete_or_ambiguous_debt_table"}
                                               for basis in controls["debt_variants"]}})
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
            for row_number, row in current_rows + total_rows:
                metric = "current_noncurrent_yuan" if compact(row[0]) != "合计" else "total_debt_yuan"
                value = row[data_column] if data_column < len(row) else ""
                comparisons = {basis: amount_match({"number": value, "unit": unit}, amounts[metric])
                               for basis, amounts in controls["debt_variants"].items()}
                row_basis = row_bases.get(compact(row[0]))
                if row_basis:
                    for basis, comparison in comparisons.items():
                        if basis != row_basis:
                            comparison.update(matches=False, error="table_row_interest_treatment_conflicts_with_definition")
                candidates.append({"body_index": table["body_index"], "row": row_number, "column": data_column,
                                   "metric": metric, "row_label": row[0], "row_basis": row_basis,
                                   "coverage": "bounded_rows_checked" if not coverage_errors else "incomplete_or_ambiguous",
                                   "comparisons": comparisons})
    return candidates


def debt_definition_check(document: dict, controls: dict) -> dict:
    candidates = []
    paragraphs = sorted(document["paragraphs"], key=lambda p: p["body_index"])
    for i, paragraph in enumerate(paragraphs):
        text = compact(paragraph["text"])
        definition_match = re.search(r"(?:全部|有息)债务[^=＝。；;\n]{0,160}[=＝]|(?:全部|有息)债务(?:均)?(?:按本金|按[^,，。;；]{0,20}口径|不?包括|不?包含|的定义|的口径)", text)
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
                           "basis_description": controls.get("basis_descriptions", {}).get(basis),
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
    checked["basis_description"] = controls.get("basis_descriptions", {}).get(checked["basis"])
    checked["current_table_comparisons"] = debt_table_comparisons(document, controls)
    checked["current_table_coverage"] = ("not_present" if not checked["current_table_comparisons"] else
        "incomplete_or_ambiguous" if any(item.get("coverage") == "incomplete_or_ambiguous" or
            item["metric"] == "ambiguous_current_table_header" for item in checked["current_table_comparisons"]) else "bounded_rows_checked")
    if checked["basis"] and any(not item["comparisons"][checked["basis"]]["matches"] for item in checked["current_table_comparisons"]):
        checked.update(passed=False, status="failed", reason="current_debt_table_disagrees_with_explicit_definition")
    return checked


def hypothetical_liquidity_simulation(candidate: dict) -> bool:
    """Exclude only an action object in an explicit simulation, never a balance."""
    text, prefix, tail = candidate["text"], candidate["prefix"], candidate["tail"]
    if not (re.search(r"假设|假定", text) and re.search(r"置换|偿还|替换", prefix)
            and "模拟" in text and "流动比率" in tail):
        return False
    # Only a plain supported operation may take the debt as its object. Any
    # additional modifier, including an unknown amount phrase, remains reviewable.
    if not re.fullmatch(r"(?:假设|假定|在)?(?:发行人|本公司|公司)?(?:以新债)?(?:同额)?(?:置换|偿还|替换)", prefix):
        return False
    # Actual balance wording on either side of the debt reference stays a
    # candidate; a hypothetical action cannot conceal a preposed actual balance.
    if re.search(r"账面|余额|本金|实际", prefix):
        return False
    if re.match(r"(?:分别)?(?:为|是|[:：])", tail) or re.search(r"账面|余额|金额|本金|实际", tail) or DEBT_RATIO.search(tail):
        return False
    return not any(match["unit"] for match in AMOUNT.finditer(tail))


def debt_narrative_check(document: dict, controls: dict, definition: dict) -> dict:
    candidates, ignored = metric_clauses(document, DEBT, controls["target"], False)
    actual = []
    for candidate in candidates:
        if hypothetical_liquidity_simulation(candidate):
            candidate["reason"] = "hypothetical_liquidity_simulation_not_balance_disclosure"
            ignored.append(candidate)
        else:
            actual.append(candidate)
    candidates = actual
    for candidate in candidates:
        amounts = amount_sequence(candidate["tail"])
        all_ratios = list(DEBT_RATIO.finditer(candidate["tail"]))
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
        if re.search(r"票面(?:本金|金额)", candidate["text"]):
            errors.append("face_principal_not_supported_by_book_value_control")
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
        if errors == ["unresolved_issuer_or_period"]:
            status = "clarification_required"
        elif errors or not any(c["matches"] for c in comparisons.values()) or (basis and not comparisons[basis]["matches"]):
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
