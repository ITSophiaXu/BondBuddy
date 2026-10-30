#!/usr/bin/env python3
"""Reproduce the full-review PLANNING budget; no API calls or file writes.

All arithmetic, including both ceilings, uses exact Fraction values. Decimal
conversions are for JSON display only. This script is not a billing runtime.
See the companion Markdown file for source paths, assumptions, and limitations.
"""

import json
from decimal import Decimal, localcontext
from fractions import Fraction


def q(value):
    return Fraction(str(value))


def show(value):
    """Display up to 40 significant digits; repeating values remain exact in q."""
    with localcontext() as ctx:
        ctx.prec = 40
        result = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def ceiling(value):
    return -(-value.numerator // value.denominator)


TOKENS = {"uncached_input": 825600, "cached_input": 2318400, "output": 36000}
FLASH_USD_PER_MILLION = (q("0.30"), q("0.006"), q("1.20"))
PRO_USD_PER_MILLION = (q("1.32"), q("0.044"), q("3.96"))
FX = q("7.2")
NONBILLABLE_MODEL_ALLOWANCE = q("0.30")
SEARCH_CALLS = 20
SEARCH_CNY_PER_CALL = q("0.05")
OCR_CNY_PER_NEW_PAGE = q("0.03")
SUPPORT_PROBABILITY = q("0.10")
SUPPORT_CNY_PER_HOUR = q("100")
STANDARD_RESERVE = q("0.05")
STANDARD_MARGIN = q("0.95")
VAT_PARAMETER = q("0.06")
TARIFF_MULTIPLIER = q("1.7")


def budget(*, rates=FLASH_USD_PER_MILLION, cold=False, new_ocr_pages=0,
           support_minutes_when_used=20):
    uncached = TOKENS["uncached_input"] + (TOKENS["cached_input"] if cold else 0)
    cached = 0 if cold else TOKENS["cached_input"]
    model_parts = {
        "uncached_input": q(uncached) / 1000000 * rates[0] * FX,
        "cached_input": q(cached) / 1000000 * rates[1] * FX,
        "output": q(TOKENS["output"]) / 1000000 * rates[2] * FX,
    }
    model = sum(model_parts.values(), q(0))
    nonbillable = model * NONBILLABLE_MODEL_ALLOWANCE
    search = q(SEARCH_CALLS) * SEARCH_CNY_PER_CALL
    ocr = q(new_ocr_pages) * OCR_CNY_PER_NEW_PAGE
    support = (SUPPORT_PROBABILITY * support_minutes_when_used
               / 60 * SUPPORT_CNY_PER_HOUR)
    resource = model + nonbillable + search + ocr + support
    plan = resource * (1 + STANDARD_RESERVE)
    return {
        "model_parts_cny": {key: show(value) for key, value in model_parts.items()},
        "successful_model_cost_cny": show(model),
        "nonbillable_model_allowance_cny": show(nonbillable),
        "search_cny": show(search),
        "new_ocr_cny": show(ocr),
        "attributable_support_cny": show(support),
        "attributable_support_exact_ratio": str(support),
        "C_resource_cny": show(resource),
        "C_resource_exact_ratio": str(resource),
        "C_plan_cny": show(plan),
        "C_plan_exact_ratio": str(plan),
    }, plan


def main():
    baseline, plan = budget()
    base_unrounded = plan / (1 - STANDARD_MARGIN) * (1 + VAT_PARAMETER) * 100
    base_fen = ceiling(base_unrounded)
    points_unrounded = q(base_fen) * TARIFF_MULTIPLIER
    points = ceiling(points_unrounded)
    assert plan == q("7.5454800512")
    assert base_fen == 15997
    assert points == 27195

    stress_inputs = [
        ("100_new_ocr_pages", {"new_ocr_pages": 100}, "10.6954800512"),
        ("all_input_cold", {"cold": True}, "14.2443392"),
        ("historical_pro_rates", {"rates": PRO_USD_PER_MILLION}, "17.6641058048"),
        ("double_support_minutes", {"support_minutes_when_used": 40}, "11.0454800512"),
    ]
    stresses = []
    for name, kwargs, expected_plan in stress_inputs:
        detail, stress_plan = budget(**kwargs)
        assert stress_plan == q(expected_plan)
        stresses.append({"name": name, "locked_task_points": points, **detail})

    report = {
        "as_of": "2026-10-29",
        "status": "DRAFT_STANDARD_COST_PLANNING_NOT_DEEPSEEK_MEASURED",
        "arithmetic": "Exact Fraction; Decimal display at 40 significant digits."
                      " Recurring values also include exact ratios.",
        "sources": {
            "historical_local_root": "C:/Users/lezhai/Downloads/Bondbuddy/"
                                     "pricing-redesign-20261027/",
            "workload": "daily-task-cost-design.md:110-123,276,282-312 (D6 simulation)",
            "rates": "projection-build/audit-config.json:7-11 (2026-09-24 snapshot)",
            "support_rate": "cost-plus-20261028/inputs.json:24-25,91 (budget)",
            "current_official_price_verified": False,
            "complete_deepseek_task_measured": False,
            "original_approved_full_review_C_plan_found": False,
        },
        "inputs": {
            "tokens": TOKENS,
            "usd_per_million_flash": [show(value) for value in FLASH_USD_PER_MILLION],
            "usd_per_million_pro_stress": [show(value) for value in PRO_USD_PER_MILLION],
            "cny_per_usd": show(FX),
            "nonbillable_model_allowance": show(NONBILLABLE_MODEL_ALLOWANCE),
            "new_planning_search_calls": SEARCH_CALLS,
            "historical_search_cny_per_call": show(SEARCH_CNY_PER_CALL),
            "baseline_new_ocr_pages": 0,
            "historical_ocr_cny_per_page": show(OCR_CNY_PER_NEW_PAGE),
            "new_planning_support_probability": show(SUPPORT_PROBABILITY),
            "new_planning_support_minutes_when_used": 20,
            "support_cny_per_hour": show(SUPPORT_CNY_PER_HOUR),
            "standard_reserve": show(STANDARD_RESERVE),
            "standard_margin": show(STANDARD_MARGIN),
            "vat_parameter_not_verified_tax_status": show(VAT_PARAMETER),
            "tariff_multiplier": show(TARIFF_MULTIPLIER),
        },
        "baseline": baseline,
        "price": {
            "base_fen_before_ceiling": show(base_unrounded),
            "base_fen": base_fen,
            "points_before_ceiling": show(points_unrounded),
            "points": points,
            "list_price_cny": show(q(points) / 100),
        },
        "independent_cost_stresses_not_repricing": stresses,
        "limitations": [
            "20 searches and 10% x 20 minutes support are newly proposed assumptions.",
            "Historical model/rate snapshot and FX were not reverified.",
            "D6 final input about 246k tokens: context, segmentation and quality unverified.",
            "Support is operational support, not per-task human professional review.",
            "Fixed-payroll support/base cloud must not be counted twice in company P&L.",
            "30% models nonbillable attempts missing from successful-task geometry;"
            " 5% is planning reserve. Deduplicate overlapping allowances.",
            "Actual costs use all attempt usage, not actuals mechanically multiplied"
            " by these planning allowances.",
            "Cold cache/retries do not reprice an already locked customer task.",
            "Subscription consideration, discounts, refunds and taxes change realized revenue.",
            "This is not a company after-tax 60% margin or demand forecast.",
        ],
        "verification": "Baseline and four stress assertions passed; zero API calls.",
    }
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
