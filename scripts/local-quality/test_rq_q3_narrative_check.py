"""Purely synthetic adversarial fixtures; no customer text, numbers or files."""
from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
import io
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from rq_q3_baseline import W, output_directory, word_inventory
from rq_q3_narrative_check import check, check_document, source_controls


def source_fixture() -> dict:
    target = {"issuer": "合成测试企业有限公司", "cutoff": "2032-09-30", "annual_years": [2030, 2031]}

    def sheet(kind: str, amounts: list[tuple[str, str]]) -> dict:
        values = {"A1": "合并" + kind, "A3": "编制单位：" + target["issuer"],
                  "B3": "2032年9月30日" if kind == "资产负债表" else "2032年1-9月",
                  "F3": "金额单位：人民币元", "D4": "期末余额" if kind == "资产负债表" else "2032年1-9月"}
        cells = [{"cell": cell, "value": value, "type": "s"} for cell, value in values.items()]
        for i, (metric, value) in enumerate(amounts, 7):
            cells.extend([{"cell": f"A{i}", "value": metric, "type": "s"},
                          {"cell": f"D{i}", "value": value, "type": "n"}])
        return {"name": "合并" + kind, "state": "visible", "cells": cells}

    return {"target": target, "source_word": {"sha256": "synthetic-source"},
            "financial_workbook": {"sha256": "synthetic-workbook", "sheets": [
                sheet("利润表", [("减：营业外支出", "1234567.89")]),
                sheet("资产负债表", [("短期借款", "20000000"), ("一年内到期的非流动负债", "12600000"),
                                    ("长期借款", "30000000"), ("应付债券", "20000000")])]},
            "notes_word": {"sha256": "synthetic-notes", "paragraphs": [
                {"body_index": 0, "text": target["issuer"] + "2032年1-9月财务报表附注"},
                {"body_index": 1, "text": "金额单位为人民币元。"},
                {"body_index": 2, "text": "（一）一年内到期的非流动负债"},
                {"body_index": 8, "text": "（二）长期应付款"}], "tables": [
                    {"body_index": 3, "rows": [["项目", "期末余额", "上年年末余额"],
                                              ["一年内到期的长期借款", "3,000,000.00", "1"],
                                              ["一年内到期的应付债券", "4,000,000.00", "1"]]},
                    {"body_index": 5, "rows": [["项目", "期末余额", "年初余额"],
                                              ["一年内到期的长期应付款-应付融资租赁款", "5,000,000.00", "1"],
                                              ["应付利息", "600,000.00", "1"], ["合计", "12,600,000.00", "4"]]},
                    {"body_index": 9, "rows": [["项目", "期末余额", "年初余额"],
                                              ["长期应付款", "8,000,000.00", "1"], ["专项应付款", "999,000.00", "1"]]},
                    {"body_index": 10, "rows": [["项目", "期末余额", "年初余额"],
                                               ["合成企业融资租赁", "3,000,000.00", "1"]]},
                    {"body_index": 12, "rows": [["项目", "期末余额", "年初余额"],
                                               ["合成子公司融资租赁", "5,000,000.00", "1"], ["合计", "8,000,000.00", "2"]]}]}}


def document_fixture() -> dict:
    return {"tables": [{"body_index": 1, "context": ["释义"], "rows": [
        ["最近两年及一期", "指", "2030年度、2031年度和2032年1-9月"],
        ["最近两年及一期末", "指", "2030年末、2031年末和2032年9月末"]]}],
        "paragraphs": [
            {"body_index": 5, "text": "全部债务=短期借款+一年内到期的非流动负债（剔除应付利息）+长期借款+应付债券+长期应付款中有息债务"},
            {"body_index": 10, "text": "报告期内，发行人营业外支出分别为1.00万元、2.00万元和123.46万元。"},
            {"body_index": 20, "text": "截至报告期末，公司于一年以内到期的债务为0.32亿元，占有息债务总额的比例为35.56%。"}]}


def word_bytes(document: dict) -> bytes:
    root = ET.Element(f"{{{W}}}document")
    body = ET.SubElement(root, f"{{{W}}}body")
    ET.SubElement(ET.SubElement(ET.SubElement(body, f"{{{W}}}p"), f"{{{W}}}r"), f"{{{W}}}t").text = "释义"
    for table in document["tables"]:
        table_element = ET.SubElement(body, f"{{{W}}}tbl")
        for row in table["rows"]:
            tr = ET.SubElement(table_element, f"{{{W}}}tr")
            for value in row:
                cell = ET.SubElement(tr, f"{{{W}}}tc")
                ET.SubElement(ET.SubElement(ET.SubElement(cell, f"{{{W}}}p"), f"{{{W}}}r"), f"{{{W}}}t").text = value
    for row in document["paragraphs"]:
        ET.SubElement(ET.SubElement(ET.SubElement(body, f"{{{W}}}p"), f"{{{W}}}r"), f"{{{W}}}t").text = row["text"]
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as package:
        package.writestr("word/document.xml", ET.tostring(root, encoding="utf-8"))
    return data.getvalue()


class NarrativeTests(unittest.TestCase):
    def setUp(self):
        self.source = source_fixture()
        self.controls = source_controls(self.source)
        self.document = document_fixture()

    def checked(self, identifier: str) -> dict:
        return next(r for r in check_document(self.document, self.controls)["results"] if r["id"] == identifier)

    def expense(self) -> dict:
        return self.checked("current_nonoperating_expense_narrative")

    def debt(self) -> dict:
        return self.checked("current_one_year_debt_narrative")

    def test_correct_complete_document(self):
        result = check_document(self.document, self.controls)
        self.assertEqual((result["passed"], result["total"]), (5, 5))

    def test_old_period_definitions_fail_independently(self):
        for row in range(2):
            with self.subTest(row=row):
                self.document = document_fixture()
                self.document["tables"][0]["rows"][row][2] = self.document["tables"][0]["rows"][row][2].replace("9月", "6月")
                result = check_document(self.document, self.controls)
                self.assertEqual(result["passed"], 4)

    def test_missing_glossary_or_wrong_annual_years_fails(self):
        self.document["tables"] = []
        self.assertFalse(self.checked("period_definition_flow")["passed"])
        self.document = document_fixture()
        self.document["tables"][0]["rows"][0][2] = "2029年度、2031年度和2032年1-9月"
        self.assertFalse(self.checked("period_definition_flow")["passed"])

    def test_conflicting_definition_cannot_hide_behind_correct_one(self):
        old = deepcopy(self.document["tables"][0]["rows"][0])
        old[2] = old[2].replace("9月", "6月")
        self.document["tables"][0]["rows"].append(old)
        self.assertFalse(self.checked("period_definition_flow")["passed"])

    def test_stale_expense_fails(self):
        self.document["paragraphs"][1]["text"] = "报告期内，发行人营业外支出分别为1万元、2万元和3万元。"
        self.assertFalse(self.expense()["passed"])

    def test_current_amount_in_first_explicit_series_position(self):
        self.document["paragraphs"][1]["text"] = "2032年1-9月、2031年度、2030年度，发行人营业外支出分别为123.46万元、2万元和1万元。"
        self.assertTrue(self.expense()["passed"])

    def test_history_does_not_invalidate_correct_current_disclosure(self):
        self.document["paragraphs"].extend([
            {"body_index": 30, "text": "2031年度，发行人营业外支出为999万元。"},
            {"body_index": 31, "text": "2032年1-6月，发行人营业外支出为888万元。"},
            {"body_index": 32, "text": "截至2032年6月末，公司一年以内到期的债务为9亿元，占有息债务总额的比例为90%。"}])
        self.assertTrue(self.expense()["passed"])
        self.assertTrue(self.debt()["passed"])
        self.assertEqual(len(self.expense()["ignored"]), 2)

    def test_history_only_is_not_current_coverage(self):
        self.document["paragraphs"][1]["text"] = "2032年1-6月，发行人营业外支出为123.46万元。"
        self.assertTrue(self.expense()["missing_candidate"])
        self.assertFalse(self.expense()["passed"])

    def test_same_sentence_historical_comparison(self):
        self.document["paragraphs"][1]["text"] = "2031年度，发行人营业外支出为99万元；2032年1-9月，发行人营业外支出为123.46万元，同比有所增长。"
        self.assertTrue(self.expense()["passed"])

    def test_other_enterprise_and_parent_scope_do_not_invalidate_current(self):
        for subject in ["子公司甲公司", "母公司", "担保人", "其他企业", "另一企业有限公司", "该公司"]:
            with self.subTest(subject=subject):
                self.document = document_fixture()
                self.document["paragraphs"].append({"body_index": 30, "text": f"2032年1-9月，{subject}营业外支出为999万元。"})
                self.assertTrue(self.expense()["passed"])
                self.assertEqual(len(self.expense()["ignored"]), 1)

    def test_other_enterprise_cannot_satisfy_current_coverage(self):
        self.document["paragraphs"][1]["text"] = "2032年1-9月，发行人的子公司甲公司营业外支出为123.46万元。"
        self.assertFalse(self.expense()["passed"])
        self.assertTrue(self.expense()["missing_candidate"])

    def test_headings_are_not_quantitative_candidates(self):
        self.document["paragraphs"].extend([
            {"body_index": 30, "text": "7、营业外支出分析"},
            {"body_index": 31, "text": "表3-2发行人最近两年及一期营业外支出明细"}])
        self.assertTrue(self.expense()["passed"])
        self.assertEqual(self.expense()["candidate_count"], 1)

    def test_currency_units_and_display_rounding(self):
        for amount in ["1,234,567.89元", "123.46万元", "0.012346亿元"]:
            with self.subTest(amount=amount):
                self.document["paragraphs"][1]["text"] = f"2032年1-9月，发行人营业外支出为{amount}。"
                self.assertTrue(self.expense()["passed"])

    def test_missing_unsupported_or_wrong_units_fail(self):
        for amount in ["123.46", "123.46千元", "123.46元", "123.45万元"]:
            with self.subTest(amount=amount):
                self.document["paragraphs"][1]["text"] = f"2032年1-9月，发行人营业外支出为{amount}。"
                self.assertFalse(self.expense()["passed"])

    def test_shared_final_sequence_unit(self):
        self.document["paragraphs"][1]["text"] = "报告期内，发行人营业外支出分别为1、2、123.46万元。"
        self.assertTrue(self.expense()["passed"])

    def test_duplicate_bad_current_candidate_fails(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "2032年1-9月，发行人营业外支出为3万元。"})
        self.assertFalse(self.expense()["passed"])

    def test_complete_date_definition_cannot_hide_conflicting_period(self):
        value = "2030年度、2031年度和2032年1月1日至2032年9月30日"
        self.document["tables"][0]["rows"][0][2] = value
        self.assertTrue(self.checked("period_definition_flow")["passed"])
        for extra in ["、2032年1-6月", "、2032年6月末"]:
            with self.subTest(extra=extra):
                self.document["tables"][0]["rows"][0][2] = value + extra
                self.assertFalse(self.checked("period_definition_flow")["passed"])

    def test_flow_and_balance_annual_definitions_are_not_interchangeable(self):
        for row, value, identifier in [
            (0, "2030年末、2031年末和2032年1-9月", "period_definition_flow"),
            (1, "2030年度、2031年度和2032年9月末", "period_definition_balance"),
        ]:
            with self.subTest(row=row):
                self.document = document_fixture()
                self.document["tables"][0]["rows"][row][2] = value
                self.assertFalse(self.checked(identifier)["passed"])

    def test_single_amount_with_conflicting_periods_is_not_current_coverage(self):
        self.document["paragraphs"][1]["text"] = "2032年1-9月（即2032年1-6月），发行人营业外支出为123.46万元。"
        result = self.expense()
        self.assertFalse(result["passed"])
        self.assertEqual(result["candidates"][0]["period_classification"], "ambiguous")

    def test_relative_period_conflict_is_not_ignored_beside_correct_candidate(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "报告期内（2032年1-6月），发行人营业外支出为999万元。"})
        self.assertFalse(self.expense()["passed"])
        self.assertEqual(self.expense()["candidate_count"], 2)

    def test_parent_comparison_does_not_hide_issuer_amount(self):
        for amount, expected in [("999", False), ("123.46", True)]:
            with self.subTest(amount=amount):
                self.document = document_fixture()
                self.document["paragraphs"].append({"body_index": 30, "text": f"与母公司相比，2032年1-9月，发行人营业外支出为{amount}万元。"})
                self.assertEqual(self.expense()["passed"], expected)
                self.assertEqual(self.expense()["candidate_count"], 2)

    def test_mixed_local_subjects_are_not_silently_excluded(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "2032年1-9月，母公司及发行人营业外支出为999万元。"})
        self.assertFalse(self.expense()["passed"])
        self.assertEqual(self.expense()["candidate_count"], 2)

    def test_complete_date_current_narrative_is_supported(self):
        self.document["paragraphs"][1]["text"] = "2032年1月1日至2032年9月30日，发行人营业外支出为123.46万元。"
        self.assertTrue(self.expense()["passed"])

    def test_extra_amount_cannot_hide_after_parsed_series(self):
        for suffix in ["以及3万元", "另有3万元", "和3万元", "和", "以及"]:
            with self.subTest(suffix=suffix):
                self.document["paragraphs"][1]["text"] = f"报告期内，发行人营业外支出分别为1万元、2万元和123.46万元{suffix}。"
                self.assertFalse(self.expense()["passed"])

    def test_comma_separated_explicit_history_does_not_inherit_current_period(self):
        current = "2032年1-9月，发行人营业外支出为123.46万元"
        historical = "2031年度，发行人营业外支出为99万元"
        for text in [current + "，而" + historical, historical + "，而" + current]:
            with self.subTest(text=text):
                self.document["paragraphs"][1]["text"] = text + "。"
                self.assertTrue(self.expense()["passed"])
                self.assertEqual(self.expense()["candidate_count"], 1)
                self.assertEqual(len(self.expense()["ignored"]), 1)

    def test_comma_separated_history_does_not_hide_bad_current_amount(self):
        self.document["paragraphs"][1]["text"] = "2031年度，发行人营业外支出为123.46万元，而2032年1-9月，发行人营业外支出为99万元。"
        self.assertFalse(self.expense()["passed"])
        self.assertEqual(self.expense()["candidate_count"], 1)

    def test_series_commas_and_additional_historical_comparison(self):
        self.document["paragraphs"][1]["text"] = "报告期内，发行人营业外支出分别为1万元，2万元以及123.46万元，而2031年度，发行人营业外支出为99万元。"
        self.assertTrue(self.expense()["passed"])
        self.assertEqual(self.expense()["candidate_count"], 1)
        self.assertEqual(len(self.expense()["ignored"]), 1)

    def test_conflicting_source_currency_units_are_rejected(self):
        cell = next(c for c in self.source["financial_workbook"]["sheets"][0]["cells"] if c["cell"] == "F3")
        cell["value"] = "金额单位：人民币元；金额单位：万元"
        with self.assertRaisesRegex(ValueError, "unit"):
            source_controls(self.source)

    def test_missing_unparseable_and_unresolved_candidates_fail(self):
        for text in ["营业外支出分析", "报告期内，发行人营业外支出待人工确认。", "发行人营业外支出为123.46万元。"]:
            with self.subTest(text=text):
                self.document["paragraphs"][1]["text"] = text
                self.assertFalse(self.expense()["passed"])

    def test_stale_debt_amount_or_ratio_fails(self):
        for old, new in [("0.32", "0.31"), ("35.56", "35.00")]:
            with self.subTest(old=old):
                self.document = document_fixture()
                self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace(old, new)
                self.assertFalse(self.debt()["passed"])

    def test_debt_units_are_converted_from_unrounded_sources(self):
        for amount in ["32,000,000.00元", "3,200.00万元", "0.3200亿元"]:
            with self.subTest(amount=amount):
                self.document["paragraphs"][2]["text"] = f"截至2032年9月末，公司一年以内到期的债务为{amount}，占有息债务总额的比例为35.5556%。"
                self.assertTrue(self.debt()["passed"])

    def test_ambiguous_definition_never_passes_even_matching_principal(self):
        self.document["paragraphs"][0]["text"] = self.document["paragraphs"][0]["text"].replace("（剔除应付利息）", "")
        self.assertEqual(self.checked("debt_definition_interest_treatment")["status"], "clarification_required")
        self.assertEqual(self.debt()["status"], "clarification_required")

    def test_explicit_inclusive_basis_is_not_mistaken_for_principal(self):
        self.document["paragraphs"][0]["text"] = self.document["paragraphs"][0]["text"].replace("剔除应付利息", "不剔除应付利息")
        self.assertFalse(self.debt()["passed"])
        self.document["paragraphs"][2]["text"] = "截至报告期末，公司一年以内到期的债务为0.326亿元，占有息债务总额的比例为35.98%。"
        self.assertTrue(self.debt()["passed"])

    def test_negative_interest_wording_is_not_principal(self):
        for wording in ["未剔除应付利息", "未扣除应付利息", "不得扣除应付利息"]:
            with self.subTest(wording=wording):
                self.document["paragraphs"][0]["text"] = document_fixture()["paragraphs"][0]["text"].replace("剔除应付利息", wording)
                self.assertEqual(self.checked("debt_definition_interest_treatment")["basis"], "including_current_interest")
                self.assertFalse(self.debt()["passed"])

    def test_explicit_prose_debt_definition(self):
        self.document["paragraphs"][0]["text"] = "全部债务按本金口径计算，不包括应付利息。"
        self.assertTrue(self.checked("debt_definition_interest_treatment")["passed"])
        self.assertTrue(self.debt()["passed"])

    def test_contractual_proof_requirements_are_not_debt_definitions(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "募集资金用于偿还有息债务的，使用凭证包括借款合同、转账凭证。"})
        result = self.checked("debt_definition_interest_treatment")
        self.assertTrue(result["passed"])
        self.assertEqual(result["candidate_count"], 1)

    def test_current_debt_table_must_agree_with_explicit_definition(self):
        table = {"body_index": 18, "context": ["有息负债总体情况", "单位：万元、%"],
                 "rows": [["项目", "2031年末", "2032年9月末"], ["", "金额", "占比", "金额", "占比"],
                          ["一年内到期的非流动负债", "1", "1", "1200.00", "1"], ["合计", "1", "1", "9000.00", "100"]]}
        self.document["tables"].append(table)
        self.assertTrue(self.checked("debt_definition_interest_treatment")["passed"])
        self.document["paragraphs"][0]["text"] = self.document["paragraphs"][0]["text"].replace("剔除应付利息", "包含应付利息")
        self.assertFalse(self.checked("debt_definition_interest_treatment")["passed"])
        # A generated value cannot change the independent source controls.
        self.assertEqual(Decimal(self.controls["debt_variants"]["principal"]["total_debt_yuan"]), Decimal("90000000"))

    def test_missing_definition_or_debt_candidate_does_not_pass(self):
        self.document["paragraphs"] = self.document["paragraphs"][1:]
        self.assertEqual(self.checked("debt_definition_interest_treatment")["status"], "clarification_required")
        self.document["paragraphs"] = self.document["paragraphs"][:1]
        self.assertTrue(self.debt()["missing_candidate"])
        self.assertFalse(self.debt()["passed"])

    def test_pending_definition_is_not_explicit_resolution(self):
        self.document["paragraphs"][0]["text"] += "；是否剔除应付利息待人工确认"
        self.assertFalse(self.checked("debt_definition_interest_treatment")["passed"])

    def test_source_controls_are_dynamic_and_derived_from_originals(self):
        self.assertEqual(Decimal(self.controls["debt_variants"]["principal"]["within_one_year_yuan"]), Decimal("32000000"))
        self.assertEqual(Decimal(self.controls["debt_variants"]["principal"]["total_debt_yuan"]), Decimal("90000000"))
        source = source_fixture()
        cell = next(c for c in source["financial_workbook"]["sheets"][0]["cells"] if c["cell"] == "D7")
        cell["value"] = "9876543.21"
        changed = source_controls(source)
        self.assertEqual(changed["components"]["expense"]["value_yuan"], "9876543.21")
        self.assertFalse(check_document(self.document, changed)["checks"]["current_nonoperating_expense_narrative"])

    def test_numeric_zero_source_expense_is_not_missing(self):
        cell = next(c for c in self.source["financial_workbook"]["sheets"][0]["cells"] if c["cell"] == "D7")
        cell["value"] = 0
        controls = source_controls(self.source)
        self.document["paragraphs"][1]["text"] = "2032年1-9月，发行人营业外支出为0.00万元。"
        self.assertTrue(check_document(self.document, controls)["checks"]["current_nonoperating_expense_narrative"])

    def test_source_error_and_hidden_sheet_are_not_silently_zero_or_used(self):
        for mutate in [lambda s: s["financial_workbook"]["sheets"][0].update(state="hidden"),
                       lambda s: s["financial_workbook"]["sheets"][0]["cells"][-1].update(type="e", value="#VALUE!"),
                       lambda s: s["notes_word"]["tables"][1]["rows"][2].__setitem__(1, "")]:
            with self.subTest(mutate=mutate):
                source = source_fixture()
                mutate(source)
                with self.assertRaises(ValueError):
                    source_controls(source)

    def test_disagreeing_note_components_fail_source_reconciliation(self):
        self.source["notes_word"]["tables"][1]["rows"][2][1] = "500,000.00"
        with self.assertRaisesRegex(ValueError, "reconciliation"):
            source_controls(self.source)

    def test_source_period_boilerplate_discrepancy_is_preserved(self):
        self.source["notes_word"]["paragraphs"][1]["text"] = "期末指2032年6月末，金额单位为人民币元。"
        self.assertEqual(len(source_controls(self.source)["source_period_caveats"]), 1)

    def test_report_is_separate_and_documents_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = output_directory(Path(temporary))
            data = word_bytes(self.document)
            clean, tracked = directory / "clean.docx", directory / "tracked.docx"
            clean.write_bytes(data)
            tracked.write_bytes(data)
            mechanical = directory / "rq-q3-quality-report.json"
            mechanical.write_text('"existing-independent-evidence"', encoding="utf-8")
            report = check(clean, tracked, directory, self.source)
            self.assertEqual(report["status"], "passed")
            self.assertEqual((clean.read_bytes(), tracked.read_bytes()), (data, data))
            self.assertEqual(mechanical.read_text(encoding="utf-8"), '"existing-independent-evidence"')
            self.assertEqual(json.loads((directory / "rq-q3-narrative-report.json").read_text(encoding="utf-8"))["passed"], 10)

    def test_tracked_deleted_text_cannot_supply_current_candidate(self):
        data = word_bytes(self.document)
        with zipfile.ZipFile(io.BytesIO(data)) as package:
            root = ET.fromstring(package.read("word/document.xml"))
        body = root.find(f"{{{W}}}body")
        p = next(p for p in body if p.tag == f"{{{W}}}p" and "营业外支出" in "".join(p.itertext()))
        runs = list(p)
        for run in runs:
            p.remove(run)
        deleted = ET.SubElement(p, f"{{{W}}}del")
        for run in runs:
            deleted.append(run)
        revised = io.BytesIO()
        with zipfile.ZipFile(revised, "w") as package:
            package.writestr("word/document.xml", ET.tostring(root, encoding="utf-8"))
        inventory = word_inventory(revised.getvalue())
        result = check_document(inventory, self.controls)
        self.assertFalse(result["checks"]["current_nonoperating_expense_narrative"])


class DebtAdversarialTests(unittest.TestCase):
    def setUp(self):
        self.controls = source_controls(source_fixture())
        self.document = document_fixture()

    def checked(self, identifier):
        return next(r for r in check_document(self.document, self.controls)["results"] if r["id"] == identifier)

    def definition(self):
        return self.checked("debt_definition_interest_treatment")

    def debt(self):
        return self.checked("current_one_year_debt_narrative")

    def test_conflicting_interest_declarations_in_one_paragraph_never_pass(self):
        for text, narrative in [
            ("全部债务包含应付利息，同时剔除应付利息。", "截至报告期末，公司一年以内到期的债务为0.326亿元，占有息债务总额的比例为35.98%。"),
            ("全部债务按本金口径计算，不包括应付利息；全部债务包含应付利息。", document_fixture()["paragraphs"][2]["text"]),
        ]:
            with self.subTest(text=text):
                self.document["paragraphs"][0]["text"] = text
                self.document["paragraphs"][2]["text"] = narrative
                self.assertEqual(self.definition()["status"], "clarification_required")
                self.assertIsNone(self.definition()["basis"])
                self.assertFalse(self.debt()["passed"])

    def test_formula_cannot_readd_interest_or_change_a_component_sign(self):
        formula = document_fixture()["paragraphs"][0]["text"]
        for changed in [formula + "+应付利息", formula + "-应付利息",
                        formula.replace("+长期借款", "-长期借款"),
                        formula.replace("+应付债券", "+应付债券+应付债券"),
                        formula.replace("+长期借款", "×长期借款")]:
            with self.subTest(formula=changed):
                self.document["paragraphs"][0]["text"] = changed
                self.assertEqual(self.definition()["status"], "clarification_required")
                self.assertFalse(self.debt()["passed"])

    def test_supported_single_interest_subtraction_formula_remains_usable(self):
        self.document["paragraphs"][0]["text"] = self.document["paragraphs"][0]["text"].replace("（剔除应付利息）", "-应付利息")
        self.assertTrue(self.definition()["passed"])
        self.assertTrue(self.debt()["passed"])

    def test_local_narrative_interest_treatment_must_agree_with_definition(self):
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("。", "（包含应付利息）。")
        self.assertFalse(self.debt()["passed"])
        self.document = document_fixture()
        self.document["paragraphs"][0]["text"] = self.document["paragraphs"][0]["text"].replace("剔除应付利息", "包含应付利息")
        self.document["paragraphs"][2]["text"] = "截至报告期末，公司一年以内到期的债务为0.326亿元，占有息债务总额的比例为35.98%（剔除应付利息）。"
        self.assertTrue(self.definition()["passed"])
        self.assertFalse(self.debt()["passed"])

    def test_local_conflicting_interest_declarations_never_pass(self):
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("。", "（包含应付利息，同时剔除应付利息）。")
        self.assertFalse(self.debt()["passed"])

    def test_second_current_ratio_cannot_hide_behind_first_correct_ratio(self):
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("35.56%。", "35.56%，占有息债务总额的比例为99.00%。")
        self.assertFalse(self.debt()["passed"])

    def test_explicit_historical_ratio_comparison_is_not_a_current_conflict(self):
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("35.56%。", "35.56%，2031年末占有息债务总额的比例为99.00%。")
        self.assertTrue(self.debt()["passed"])

    def test_explicit_historical_definition_does_not_override_current_basis(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "截至2031年末，全部债务包含应付利息。"})
        self.assertTrue(self.definition()["passed"])
        self.assertEqual(self.definition()["basis"], "principal")
        self.assertTrue(self.debt()["passed"])

    def test_explicit_historical_interest_comparison_does_not_override_current_basis(self):
        self.document["paragraphs"][0]["text"] += "；截至2031年末，全部债务包含应付利息。"
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("。", "，截至2031年末，债务包含应付利息。")
        self.assertTrue(self.definition()["passed"])
        self.assertEqual(self.definition()["basis"], "principal")
        self.assertTrue(self.debt()["passed"])

    def test_ratio_with_mixed_current_and_old_period_is_ambiguous(self):
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("，占", "，2032年9月末和2032年6月末占")
        self.assertFalse(self.debt()["passed"])

    def test_mixed_current_and_old_table_header_is_not_silently_ignored(self):
        self.document["tables"].append({"body_index": 18, "context": ["有息负债总体情况", "单位：万元、%"],
            "rows": [["项目", "2032年9月末和2032年6月末"], ["一年内到期的非流动负债", "1200.00"], ["合计", "9000.00"]]})
        self.assertFalse(self.definition()["passed"])
        self.assertEqual(self.definition()["current_table_comparisons"][0]["metric"], "ambiguous_current_table_header")

    def test_explicit_old_debt_table_does_not_invalidate_current_disclosure(self):
        self.document["tables"].append({"body_index": 18, "context": ["有息负债总体情况", "单位：万元、%"],
            "rows": [["项目", "2031年末"], ["一年内到期的非流动负债", "1.00"], ["合计", "2.00"]]})
        self.assertTrue(self.definition()["passed"])


if __name__ == "__main__":
    unittest.main()
