"""Synthetic in-memory controls validate the independent quality checker only.

These cases never create a product run or generated Word, and cannot be reported
as full-document generation evidence. No customer values are copied here.
"""
from __future__ import annotations

from copy import deepcopy
import json

from rq_q3_check import chapter_body_checks, finance_checks


CONTROL = {"id": "synthetic-q3-control", "scope": "合并", "metric": "资产总计", "label": {"saved_value": "资产总计"},
           "sheet": "01合并资产负债表", "cell": "D78", "period": "2025-09-30", "saved_value": "1234500"}
TABLE = {"table_index": 0, "context": ["合并资产负债表", "金额单位：万元"],
         "rows": [["项目", "2025年9月30日", "2024年末"], ["资产总计", "123.45", "123.45"]]}


def checked(table: dict, expected: bool, extra: list[dict] | None = None, control: dict | None = None) -> None:
    result = finance_checks({"tables": [table, *(extra or [])]}, [control or CONTROL])[0]
    if result["passed"] != expected:
        raise AssertionError(f"Synthetic matcher expected {expected}: {result}")


def main() -> None:
    count = 0
    checked(deepcopy(TABLE), True); count += 1
    for context in [["母公司资产负债表", "金额单位：万元"], ["合并利润表", "金额单位：万元"],
                    ["合并资产负债表", "金额单位：元"], ["合并资产负债表"]]:
        case = deepcopy(TABLE); case["context"] = context
        checked(case, False); count += 1
    for heading in ["2025年6月30日", "2024年9月30日", "2025年1—9月", "2025年9月30日前后预测"]:
        case = deepcopy(TABLE); case["rows"][0][1] = heading
        checked(case, False); count += 1
    wrong_current = deepcopy(TABLE); wrong_current["rows"][1][1] = "999.99"
    checked(wrong_current, False); count += 1  # prior-period matching number is insufficient
    checked(deepcopy(TABLE), False, [wrong_current]); count += 1  # conflicting current disclosure is insufficient
    wrong_columns = deepcopy(TABLE); wrong_columns["rows"][0] = ["项目", "2024年末", "2025年9月30日"]
    wrong_columns["rows"][1] = ["资产总计", "123.45", "999.99"]
    checked(wrong_columns, False); count += 1
    yuan = deepcopy(TABLE); yuan["context"][-1] = "单位：人民币元"; yuan["rows"][1][1] = "1,234,500.00"
    checked(yuan, True); count += 1
    unaudited = deepcopy(TABLE); unaudited["rows"][0][1] = "2025年9月30日（未经审计）"
    checked(unaudited, True); count += 1
    flow_control = {**CONTROL, "metric": "净利润", "label": {"saved_value": "净利润"}, "sheet": "02合并利润表",
                    "period": "2025-01-01 至 2025-09-30"}
    flow = deepcopy(TABLE); flow["context"][0] = "合并利润表"; flow["rows"][0][1] = "2025年1—9月"; flow["rows"][1][0] = "净利润"
    checked(flow, True, control=flow_control); count += 1
    flow["rows"][0][1] = "2025年9月30日"
    checked(flow, False, control=flow_control); count += 1
    source_chapter = {"chapter_bodies": [{"key": "1", "title": "synthetic chapter", "accepted_characters": 1000}]}
    for chars, expected in [(0, False), (10, False), (200, True)]:
        output = {"chapter_bodies": [{"key": "1", "title": "synthetic chapter", "accepted_characters": chars}]}
        assert chapter_body_checks(source_chapter, output)[0]["passed"] == expected
        count += 1

    # A correct disclosure must not hide a second malformed current disclosure.
    for declaration in ["单位：元", "单位：千元", "单位：百万元", "单位："]:
        case = deepcopy(TABLE); case["rows"][0].append(declaration)
        checked(deepcopy(TABLE), False, [case]); count += 1
    case = deepcopy(TABLE); case["rows"][1] = ["资产总计"]
    checked(deepcopy(TABLE), False, [case]); count += 1
    case = deepcopy(TABLE); case["context"] = ["合并资产负债表"]
    checked(deepcopy(TABLE), False, [case]); count += 1
    for declaration in ["母公司口径", "合并资产负债表与母公司资产负债表"]:
        case = deepcopy(TABLE); case["rows"][0].append(declaration)
        checked(deepcopy(TABLE), False, [case]); count += 1
    for heading in ["2025年9月30日及2024年末", "2025年9月30日前后预测", "2025年1—9月", "2025年9月30日累计"]:
        case = deepcopy(TABLE); case["rows"][0][1] = heading
        checked(deepcopy(TABLE), False, [case]); count += 1
    flow["rows"][0][1] = "2025年1—9月"
    for heading in ["2025年1—9月及2024年度", "2025年1—9月末", "2025年9月30日", "2025年1—9月余额"]:
        case = deepcopy(flow); case["rows"][0][1] = heading
        checked(deepcopy(flow), False, [case], control=flow_control); count += 1
    case = deepcopy(TABLE); case["rows"][0].append("2025年9月30日及2024年末")
    case["rows"][1].append("123.45")
    checked(case, False); count += 1
    case = deepcopy(TABLE); case["rows"][0].append("单位：元"); case["rows"][1][1] = "1234500"
    checked(case, False); count += 1  # matching the header unit cannot excuse a conflicting caption

    # Historical and other-scope statements remain legitimate separate tables.
    for heading in ["2024年9月30日", "2025年6月30日", "2024年末"]:
        old = deepcopy(TABLE); old["rows"][0][1] = heading
        old["context"][-1] = "单位：千元"
        checked(deepcopy(TABLE), True, [old]); count += 1
    parent = deepcopy(TABLE); parent["context"][0] = "母公司资产负债表"
    parent["rows"][1][1] = "987.65"
    checked(deepcopy(TABLE), True, [parent]); count += 1
    same = deepcopy(TABLE); same["rows"][0].append("单位：万元")
    checked(same, True); count += 1
    earlier = deepcopy(TABLE); earlier["context"] = ["母公司利润表", "单位：元", *TABLE["context"]]
    checked(earlier, True); count += 1
    compiled = deepcopy(TABLE); compiled["rows"].insert(0, ["编制单位：完全虚构测试公司"])
    checked(compiled, True); count += 1
    alias = deepcopy(TABLE); alias["rows"][1][0] = "一、资产合计"
    checked(alias, True); count += 1
    closing = deepcopy(TABLE); closing["rows"][0][1] += "余额"
    checked(closing, True); count += 1
    cumulative = deepcopy(flow); cumulative["rows"][0][1] += "累计"
    checked(cumulative, True, control=flow_control); count += 1
    other_statement = deepcopy(TABLE); other_statement["rows"].insert(0, ["合并利润表"])
    checked(other_statement, False); count += 1
    checked(deepcopy(TABLE), True, [other_statement]); count += 1
    titled = deepcopy(TABLE); titled["context"] = ["母公司资产负债表", "单位：元"]
    titled["rows"].insert(0, ["合并资产负债表", "金额单位：万元"])
    checked(titled, True); count += 1
    split_unit = deepcopy(TABLE); split_unit["rows"][0].extend(["单位：", "万元"])
    checked(split_unit, True); count += 1
    print(json.dumps({"synthetic_checker_cases": count, "passed": count, "product_runs": 0, "generated_documents": 0}))


if __name__ == "__main__":
    main()
