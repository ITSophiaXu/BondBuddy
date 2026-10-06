import copy
import unittest

from bondbuddy_m4_finance import calculate


def period(date="2025-12-31", liabilities="5000", assets="10000", unit="万元", scope="consolidated"):
    metadata = {"period_end": date, "entity_id": "synthetic-issuer", "scope": scope, "uncertain": False,
                "unit": unit, "source": {"kind": "material", "id": "synthetic-material", "project_id": "synthetic-project",
                "version": 3, "sha256": "a" * 64, "locator": "第三章/财务表/合并口径"}}
    return {"period_end": date, "entity_id": "synthetic-issuer", "scope": scope,
            "values": {"total_liabilities": {**copy.deepcopy(metadata), "value": liabilities},
                       "total_assets": {**copy.deepcopy(metadata), "value": assets}}}


class M4FinanceTests(unittest.TestCase):
    def calc(self, *periods):
        return calculate({"metric": "asset_liability_ratio", "periods": list(periods)})

    def test_ratio_and_exact_provenance(self):
        result = self.calc(period())
        self.assertEqual(result["periods"][0]["value"], "50")
        self.assertEqual(result["periods"][0]["operands"][0]["source"]["version"], 3)
        self.assertEqual(result["fact_verification"], "not_performed")

    def test_decimal_precision_and_grouped_number(self):
        result = self.calc(period(liabilities="1", assets="3"))
        self.assertEqual(result["periods"][0]["value"], "33.3333")
        self.assertEqual(self.calc(period(assets="10,000"))["periods"][0]["value"], "50")

    def test_mixed_units_are_normalized(self):
        data = period(liabilities="1", assets="20000")
        data["values"]["total_liabilities"]["unit"] = "亿元"
        self.assertEqual(self.calc(data)["periods"][0]["value"], "50")

    def test_zero_not_fake_zero_result(self):
        result = self.calc(period(assets="0"))
        self.assertEqual(result["error"], "ZERO_DENOMINATOR")
        self.assertIsNone(result["value"])

    def test_negative_denominator(self):
        self.assertEqual(self.calc(period(assets="-1"))["error"], "DENOMINATOR_NEEDS_REVIEW")

    def test_missing_number_and_ocr(self):
        data = period()
        del data["values"]["total_assets"]
        self.assertEqual(self.calc(data)["status"], "needs_confirmation")
        data = period()
        data["values"]["total_assets"]["uncertain"] = True
        self.assertEqual(self.calc(data)["error"], "INPUT_NEEDS_CONFIRMATION")

    def test_mother_consolidated_conflict(self):
        data = period()
        data["values"]["total_assets"]["scope"] = "parent"
        self.assertEqual(self.calc(data)["error"], "SCOPE_CONFLICT")

    def test_source_period_conflict(self):
        data = period()
        data["values"]["total_assets"]["period_end"] = "2024-12-31"
        self.assertEqual(self.calc(data)["error"], "PERIOD_OR_ENTITY_CONFLICT")

    def test_source_hash_and_locator_required(self):
        for key in ("sha256", "locator", "version"):
            data = period()
            del data["values"]["total_assets"]["source"][key]
            self.assertEqual(self.calc(data)["status"], "needs_confirmation")

    def test_host_pins_reject_old_or_foreign_source(self):
        data = period()
        result = calculate({"metric": "asset_liability_ratio", "periods": [data], "authorized_sources": []})
        self.assertEqual(result["error"], "SOURCE_NOT_AUTHORIZED")
        source = {k: v for k, v in data["values"]["total_assets"]["source"].items() if k != "locator"}
        result = calculate({"metric": "asset_liability_ratio", "periods": [data], "authorized_sources": [source]})
        self.assertEqual(result["status"], "calculated")

    def test_two_period_change_distinguishes_percentage_points(self):
        result = self.calc(period("2024-12-31", liabilities="4000"), period(liabilities="5000"))
        self.assertEqual(result["comparison"]["delta"], "10")
        self.assertEqual(result["comparison"]["delta_unit"], "percentage_points")
        self.assertEqual(result["comparison"]["relative_change_percent"], "25")

    def test_zero_prior_ratio_comparison_retains_delta(self):
        result = self.calc(period("2024-12-31", liabilities="0"), period())
        self.assertEqual(result["comparison"]["delta"], "50")
        self.assertIsNone(result["comparison"]["relative_change_percent"])
        self.assertEqual(result["comparison"]["relative_change_status"], "non_positive_base")

    def test_comparison_order_and_scope(self):
        self.assertEqual(self.calc(period(), period("2024-12-31"))["error"], "COMPARISON_PERIOD_ORDER")
        self.assertEqual(self.calc(period("2024-12-31"), period(scope="parent"))["error"], "COMPARISON_SCOPE_CONFLICT")
        self.assertEqual(self.calc(period(), period(), period())["error"], "PERIOD_COUNT_NOT_SUPPORTED")

    def test_invalid_input_does_not_compute(self):
        for number in ("NaN", "1e3", "1,23", True, 1.5):
            self.assertEqual(self.calc(period(assets=number))["error"], "INVALID_NUMBER")
        data = period()
        data["values"]["total_assets"]["unit"] = "美元"
        self.assertEqual(self.calc(data)["error"], "UNIT_REQUIRED")

    def test_quick_ratio_has_explicit_formula(self):
        data = period()
        observed = data["values"]["total_assets"]
        data["values"] = {"current_assets": {**copy.deepcopy(observed), "value": "200"},
                          "inventory": {**copy.deepcopy(observed), "value": "50"},
                          "current_liabilities": {**copy.deepcopy(observed), "value": "100"}}
        result = calculate({"metric": "quick_ratio", "periods": [data]})
        self.assertEqual(result["periods"][0]["value"], "1.5")
        self.assertIn("inventory", result["formula"])

    def test_malformed_json_shapes_fail_closed(self):
        self.assertEqual(calculate({"metric": [], "periods": []})["status"], "needs_confirmation")
        data = period()
        data["values"]["total_assets"]["unit"] = {}
        self.assertEqual(self.calc(data)["error"], "UNIT_REQUIRED")

    def test_flow_metrics_require_comparable_intervals(self):
        def flow(start, end):
            data = period(end)
            observed = data["values"]["total_assets"]
            data["period_start"] = start
            data["values"] = {"ebit": {**copy.deepcopy(observed), "period_start": start, "value": "20"},
                              "interest_expense": {**copy.deepcopy(observed), "period_start": start, "value": "5"}}
            return data
        request = {"metric": "interest_coverage", "periods": [flow("2024-01-01", "2024-12-31"), flow("2025-01-01", "2025-06-30")]}
        self.assertEqual(calculate(request)["error"], "COMPARISON_FLOW_PERIOD_CONFLICT")
        request["periods"][1] = flow("2025-01-01", "2025-12-31")
        self.assertEqual(calculate(request)["status"], "calculated")
        del request["periods"][1]["period_start"]
        self.assertEqual(calculate(request)["error"], "PERIOD_BASIS_REQUIRED")


if __name__ == "__main__":
    unittest.main()
