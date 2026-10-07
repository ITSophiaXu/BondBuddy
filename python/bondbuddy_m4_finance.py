"""Deterministic M4 arithmetic over explicitly sourced observations.

This validates arithmetic and provenance shape, not the truth of extracted facts.
Only the host can authorize sources or confirm ambiguous OCR/accounting inputs.
CLI: python bondbuddy_m4_finance.py --input request.json --output result.json
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
from decimal import Decimal, localcontext
from pathlib import Path

VERSION = "m4-finance-v1"
UNITS = {"元": Decimal(1), "万元": Decimal(10000), "亿元": Decimal(100000000)}
METRICS = {
    "asset_liability_ratio": ("资产负债率", ("total_liabilities", "total_assets"), "total_liabilities / total_assets × 100", "percent"),
    "current_ratio": ("流动比率", ("current_assets", "current_liabilities"), "current_assets / current_liabilities", "multiple"),
    "quick_ratio": ("速动比率（扣除存货口径）", ("current_assets", "inventory", "current_liabilities"), "(current_assets - inventory) / current_liabilities", "multiple"),
    "cash_ratio": ("现金比率（货币资金口径）", ("cash", "current_liabilities"), "cash / current_liabilities", "multiple"),
    "interest_coverage": ("利息保障倍数（EBIT口径）", ("ebit", "interest_expense"), "ebit / interest_expense", "multiple"),
    "return_on_equity": ("净资产收益率（平均净资产口径）", ("net_profit", "average_equity"), "net_profit / average_equity × 100", "percent"),
}
DENOMINATORS = {
    "asset_liability_ratio": "total_assets", "current_ratio": "current_liabilities",
    "quick_ratio": "current_liabilities", "cash_ratio": "current_liabilities",
    "interest_coverage": "interest_expense", "return_on_equity": "average_equity",
}
FLOW_METRICS = {"interest_coverage", "return_on_equity"}
NUMBER = re.compile(r"^-?(?:\d{1,24}|\d{1,3}(?:,\d{3}){1,7})(?:\.\d{1,12})?$")
HASH = re.compile(r"^[a-f0-9]{64}$")


class CalculationError(ValueError):
    def __init__(self, code: str, field: str = ""):
        super().__init__(code)
        self.code, self.field = code, field


def _object(value, field):
    if not isinstance(value, dict):
        raise CalculationError("INVALID_INPUT", field)
    return value


def _string(value, field, limit=256):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise CalculationError("INVALID_INPUT", field)
    return value


def _date(value, field):
    _string(value, field, 10)
    try:
        if datetime.date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except ValueError:
        raise CalculationError("INVALID_PERIOD", field) from None
    return value


def _decimal(value, field):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise CalculationError("INVALID_NUMBER", field)
    raw = str(value)
    if not NUMBER.fullmatch(raw):
        raise CalculationError("INVALID_NUMBER", field)
    return Decimal(raw.replace(",", ""))


def _render(value):
    # Round only the final display; unrounded values remain in the calculation log.
    result = format(value.quantize(Decimal("0.0001")), "f").rstrip("0").rstrip(".")
    return "0" if result in ("", "-0") else result


def _source(value, field, allowed):
    source = _object(value, field)
    kind = source.get("kind")
    if kind not in ("material", "artifact"):
        raise CalculationError("SOURCE_REQUIRED", field)
    ref_id = _string(source.get("id"), field + ".id", 128)
    project = _string(source.get("project_id"), field + ".project_id", 128)
    version = source.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise CalculationError("SOURCE_REQUIRED", field)
    digest = source.get("sha256")
    if not isinstance(digest, str) or not HASH.fullmatch(digest):
        raise CalculationError("SOURCE_REQUIRED", field)
    locator = _string(source.get("locator"), field + ".locator", 2000)
    pin = {"kind": kind, "id": ref_id, "project_id": project, "version": version, "sha256": digest}
    if allowed is not None and pin not in allowed:
        raise CalculationError("SOURCE_NOT_AUTHORIZED", field)
    return {**pin, "locator": locator}


def _period(metric, value, allowed):
    period = _object(value, "period")
    end = _date(period.get("period_end"), "period_end")
    entity = _string(period.get("entity_id"), "entity_id", 128)
    scope = period.get("scope")
    if scope not in ("consolidated", "parent"):
        raise CalculationError("SCOPE_REQUIRED", "scope")
    start = None
    if metric in FLOW_METRICS:
        if period.get("period_start") is None:
            raise CalculationError("PERIOD_BASIS_REQUIRED", "period_start")
        start = _date(period.get("period_start"), "period_start")
        if start > end:
            raise CalculationError("INVALID_PERIOD", "period_start")
    values = _object(period.get("values"), "values")
    operands = []
    normalized = {}
    for name in METRICS[metric][1]:
        observation = _object(values.get(name), name)
        if observation.get("uncertain") is not False:
            raise CalculationError("INPUT_NEEDS_CONFIRMATION", name)
        if observation.get("period_end") != end or observation.get("entity_id") != entity:
            raise CalculationError("PERIOD_OR_ENTITY_CONFLICT", name)
        if start is not None and observation.get("period_start") != start:
            raise CalculationError("PERIOD_OR_ENTITY_CONFLICT", name)
        if observation.get("scope") != scope:
            raise CalculationError("SCOPE_CONFLICT", name)
        unit = observation.get("unit")
        if not isinstance(unit, str) or unit not in UNITS:
            raise CalculationError("UNIT_REQUIRED", name)
        number = _decimal(observation.get("value"), name)
        source = _source(observation.get("source"), name + ".source", allowed)
        normalized[name] = number * UNITS[unit]
        operands.append({"name": name, "raw_value": str(observation["value"]), "unit": unit,
                         "normalized_yuan": str(normalized[name]), "source": source})
    denominator = normalized[DENOMINATORS[metric]]
    if denominator == 0:
        raise CalculationError("ZERO_DENOMINATOR", DENOMINATORS[metric])
    if denominator < 0:
        raise CalculationError("DENOMINATOR_NEEDS_REVIEW", DENOMINATORS[metric])
    numerator = (normalized["current_assets"] - normalized["inventory"] if metric == "quick_ratio"
                 else normalized[METRICS[metric][1][0]])
    ratio = numerator / denominator
    result = ratio * 100 if METRICS[metric][3] == "percent" else ratio
    return {"period_start": start, "period_end": end, "entity_id": entity, "scope": scope, "operands": operands,
            "value": _render(result), "unrounded_value": str(result), "unit": METRICS[metric][3]}, result


def calculate(request):
    """Return a fail-closed result; callers must not show an error as a zero value."""
    try:
        request = _object(request, "request")
        metric = request.get("metric")
        if not isinstance(metric, str) or metric not in METRICS:
            raise CalculationError("METRIC_NOT_SUPPORTED", "metric")
        periods = request.get("periods")
        if not isinstance(periods, list) or len(periods) not in (1, 2):
            raise CalculationError("PERIOD_COUNT_NOT_SUPPORTED", "periods")
        allowed = request.get("authorized_sources")
        if allowed is not None and (not isinstance(allowed, list) or len(allowed) > 100):
            raise CalculationError("INVALID_INPUT", "authorized_sources")
        with localcontext() as context:
            context.prec = 72
            rows = [_period(metric, period, allowed) for period in periods]
            result = {"version": VERSION, "status": "calculated", "metric": metric,
                      "label": METRICS[metric][0], "formula": METRICS[metric][2],
                      "periods": [row[0] for row in rows], "comparison": None,
                      "fact_verification": "not_performed", "external_retrieval": "not_performed"}
            if len(rows) == 2:
                previous, current = rows[0][0], rows[1][0]
                if previous["entity_id"] != current["entity_id"] or previous["scope"] != current["scope"]:
                    raise CalculationError("COMPARISON_SCOPE_CONFLICT", "periods")
                if previous["period_end"] >= current["period_end"]:
                    raise CalculationError("COMPARISON_PERIOD_ORDER", "periods")
                if metric in FLOW_METRICS and (
                    previous["period_start"][5:] != current["period_start"][5:]
                    or previous["period_end"][5:] != current["period_end"][5:]
                    or int(previous["period_end"][:4]) - int(previous["period_start"][:4])
                    != int(current["period_end"][:4]) - int(current["period_start"][:4])
                ):
                    raise CalculationError("COMPARISON_FLOW_PERIOD_CONFLICT", "periods")
                delta = rows[1][1] - rows[0][1]
                prior = rows[0][1]
                result["comparison"] = {"previous_period": previous["period_end"],
                    "current_period": current["period_end"], "delta": _render(delta),
                    "delta_unit": "percentage_points" if previous["unit"] == "percent" else "multiple",
                    "relative_change_percent": _render(delta / prior * 100) if prior > 0 else None,
                    "relative_change_status": "calculated" if prior > 0 else "non_positive_base",
                    "relative_change_formula": "(current - previous) / previous × 100"}
            return result
    except CalculationError as error:
        return {"version": VERSION, "status": "needs_confirmation", "error": error.code,
                "field": error.field, "value": None, "fact_verification": "not_performed",
                "external_retrieval": "not_performed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    raw = Path(args.input).read_bytes()
    if len(raw) > 1024 * 1024:
        parser.error("input exceeds 1 MiB")
    try:
        request = json.loads(raw)
        result = calculate(request)
    except (ValueError, RecursionError):
        result = {"version": VERSION, "status": "needs_confirmation", "error": "INVALID_JSON", "value": None}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
