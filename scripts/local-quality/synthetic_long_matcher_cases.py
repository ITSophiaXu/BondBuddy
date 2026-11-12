"""Synthetic checker tests only; none of these tables is a product-generated document."""
from copy import deepcopy
import unittest

from synthetic_long_check import financial_checks, period_matches

CONTROL = {"id": "synthetic-revenue", "scope": "合并", "statement": "利润表", "metric": "营业收入",
           "period": "2026年1至9月", "yuan": 12345678}


def inventory(value="1234.57", caption="合并利润表 单位 万元", header="2026年1至9月"):
    return {"tables": [{"table_index": 0, "context": [caption],
                         "rows": [["项目", header], ["营业收入", value]]}]}


def passed(data, control=CONTROL):
    return financial_checks(data, [control])[0]["passed"]


class SyntheticFinancialMatcher(unittest.TestCase):
    def test_correct_scaled_current_value(self):
        self.assertTrue(passed(inventory()))

    def test_same_amount_in_yuan(self):
        self.assertTrue(passed(inventory("12,345,678.00", "合并利润表 单位 元")))

    def test_wrong_unit_is_rejected(self):
        self.assertFalse(passed(inventory("1234.57", "合并利润表 单位 元")))

    def test_parent_cannot_stand_in_for_consolidated(self):
        self.assertFalse(passed(inventory(caption="母公司利润表 单位 万元")))

    def test_old_period_cannot_stand_in_for_current(self):
        self.assertFalse(passed(inventory(header="2025年1至9月")))

    def test_full_year_cannot_stand_in_for_nine_month_flow(self):
        self.assertFalse(passed(inventory(header="2026年度")))

    def test_stock_date_cannot_stand_in_for_flow(self):
        self.assertFalse(passed(inventory(header="2026年9月30日")))

    def test_conflicting_new_value_fails_even_with_one_correct_match(self):
        data = inventory()
        second = deepcopy(data["tables"][0])
        second["table_index"] = 1
        second["rows"][1][1] = "8765.43"
        data["tables"].append(second)
        self.assertFalse(passed(data))

    def test_prior_context_cannot_override_nearest_parent_caption(self):
        data = inventory(caption="母公司利润表 单位 万元")
        data["tables"][0]["context"].insert(0, "合并利润表 单位 万元")
        self.assertFalse(passed(data))

    def test_forecast_does_not_count_as_current_observation(self):
        self.assertFalse(passed(inventory(header="预计2026年1至9月")))

    def test_opening_balance_cannot_stand_in_for_closing(self):
        self.assertFalse(period_matches("2025年12月31日", "2026-09-30", "资产负债表"))

    def test_missing_unit_is_unverified(self):
        self.assertFalse(passed(inventory(caption="合并利润表")))

    def test_header_unit_cannot_conflict_with_caption(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("单位：元")
        self.assertFalse(passed(data))

    def test_later_paragraph_unit_cannot_conflict_with_caption(self):
        data = inventory()
        data["tables"][0]["context"].append("单位：元")
        self.assertFalse(passed(data))

    def test_one_correct_table_cannot_mask_an_ambiguous_table(self):
        data = inventory()
        ambiguous = deepcopy(data["tables"][0])
        ambiguous["table_index"] = 1
        ambiguous["rows"][0].append("单位：元")
        data["tables"].append(ambiguous)
        self.assertFalse(passed(data))

    def test_later_scope_cannot_conflict_with_caption(self):
        data = inventory()
        data["tables"][0]["context"].append("母公司数据")
        self.assertFalse(passed(data))

    def test_header_scope_cannot_conflict_with_caption(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("母公司口径")
        self.assertFalse(passed(data))

    def test_missing_scope_is_unverified(self):
        self.assertFalse(passed(inventory(caption="利润表 单位 万元")))

    def test_separate_matching_scope_and_unit_are_accepted(self):
        data = inventory(caption="合并利润表")
        data["tables"][0]["context"].append("单位：人民币万元")
        self.assertTrue(passed(data))

    def test_repeated_same_unit_is_not_a_conflict(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("单位：万元")
        self.assertTrue(passed(data))

    def test_mixed_current_and_comparison_period_is_rejected(self):
        self.assertFalse(passed(inventory(header="2026年1至9月及2025年度")))

    def test_flow_period_with_stock_suffix_is_rejected(self):
        self.assertFalse(passed(inventory(header="2026年1至9月末")))

    def test_mixed_current_stock_dates_are_rejected(self):
        self.assertFalse(period_matches("2026年9月30日及2025年12月31日", "2026-09-30", "资产负债表"))

    def test_full_year_followed_by_flow_period_is_rejected(self):
        self.assertFalse(period_matches("2025年度2026年1至9月", "2025年度", "利润表"))

    def test_valid_date_and_flow_label_variants(self):
        for header in ["2026年1-9月", "2026年1月—9月", "2026年前三季度", "2026年1至9月（未经审计）"]:
            self.assertTrue(passed(inventory(header=header)), header)
        for header in ["2026-09-30", "截至2026年9月30日", "2026年9月末"]:
            self.assertTrue(period_matches(header, "2026-09-30", "资产负债表"), header)

    def test_invalid_duplicate_period_does_not_hide_behind_valid_column(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("2026年1至9月末")
        data["tables"][0]["rows"][1].append("1234.57")
        self.assertFalse(passed(data))

    def test_correct_new_table_cannot_mask_an_unchanged_old_table(self):
        data = inventory()
        old = deepcopy(data["tables"][0])
        old["table_index"] = 1
        old["rows"][0][1] = "2025年度"
        data["tables"].append(old)
        self.assertFalse(passed(data))

    def test_correct_table_cannot_mask_missing_value_cell(self):
        data = inventory()
        incomplete = deepcopy(data["tables"][0])
        incomplete["table_index"] = 1
        incomplete["rows"][1] = ["营业收入"]
        data["tables"].append(incomplete)
        self.assertFalse(passed(data))

    def test_unsupported_thousand_yuan_declaration_is_not_ignored(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("单位：千元")
        self.assertFalse(passed(data))

    def test_unsupported_million_yuan_declaration_is_not_ignored(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("单位：百万元")
        self.assertFalse(passed(data))

    def test_unsupported_unit_alone_is_unverified(self):
        self.assertFalse(passed(inventory(caption="合并利润表 单位 千元")))

    def test_empty_unit_declaration_is_not_ignored(self):
        data = inventory()
        data["tables"][0]["rows"][0].append("单位：")
        self.assertFalse(passed(data))


if __name__ == "__main__":
    unittest.main()
