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


class NarrativeExpressionTests(unittest.TestCase):
    def setUp(self):
        self.controls = source_controls(source_fixture())
        self.document = document_fixture()

    def checked(self, identifier):
        return next(r for r in check_document(self.document, self.controls)["results"] if r["id"] == identifier)

    def expense(self):
        return self.checked("current_nonoperating_expense_narrative")

    def debt(self):
        return self.checked("current_one_year_debt_narrative")

    def test_bookkeeping_amount_sequence_wording(self):
        for wording in ["账面值为", "账面余额为", "账面值分别为", "账面余额分别为"]:
            for amounts in ["1万元、2万元和123.46万元", "1、2、123.46万元"]:
                with self.subTest(wording=wording, amounts=amounts):
                    self.document["paragraphs"][1]["text"] = f"报告期内，发行人营业外支出{wording}{amounts}。"
                    self.assertTrue(self.expense()["passed"])

    def test_bookkeeping_sequence_still_binds_explicit_period_positions(self):
        self.document["paragraphs"][1]["text"] = "2032年1-9月、2031年度、2030年度，发行人营业外支出账面值为123.46万元、2万元和1万元。"
        self.assertTrue(self.expense()["passed"])
        self.document["paragraphs"][1]["text"] = self.document["paragraphs"][1]["text"].replace("123.46万元、2万元和1万元", "1万元、2万元和123.46万元")
        self.assertFalse(self.expense()["passed"])

    def test_bookkeeping_sequence_rejects_bad_last_item_count_and_units(self):
        for amounts in ["1万元、2万元和3万元", "1万元、123.46万元",
                        "1万元、2万元、123.46万元和123.46万元", "1万元、错误2万元和123.46万元",
                        "1、2、123.46", "1千元、2千元和123.46千元", "1、2亿元和123.46万元"]:
            with self.subTest(amounts=amounts):
                self.document["paragraphs"][1]["text"] = f"报告期内，发行人营业外支出账面余额为{amounts}。"
                self.assertFalse(self.expense()["passed"])

    def test_bookkeeping_repeated_amount_cannot_hide_behind_correct_first(self):
        for tail in ["账面值为123.46万元，账面值为3万元", "账面余额为123.46万元，错误3万元",
                     "账面值为123.46万元，账面值为3", "账面值为123.46万元，账面值为3千元"]:
            with self.subTest(tail=tail):
                self.document["paragraphs"][1]["text"] = f"2032年1-9月，发行人营业外支出{tail}。"
                self.assertFalse(self.expense()["passed"])

    def test_bookkeeping_second_bad_candidate_cannot_be_ignored(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "2032年1-9月，发行人营业外支出账面值为3万元。"})
        self.assertFalse(self.expense()["passed"])
        self.assertEqual(self.expense()["candidate_count"], 2)

    def test_bookkeeping_single_debt_balance_remains_exact(self):
        for wording in ["账面值为", "账面余额为"]:
            with self.subTest(wording=wording):
                self.document["paragraphs"][2]["text"] = f"截至报告期末，公司一年以内到期的债务{wording}0.32亿元，占有息债务总额的比例为35.56%。"
                self.assertTrue(self.debt()["passed"])
                self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("0.32", "0.31")
                self.assertFalse(self.debt()["passed"])

    def test_interest_bearing_liability_ratio_synonym(self):
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("有息债务总额", "有息负债总额")
        self.assertTrue(self.debt()["passed"])
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("35.56", "99.00")
        self.assertFalse(self.debt()["passed"])

    def test_ratio_synonym_does_not_accept_ordinary_liabilities_or_duplicate_ratio(self):
        for tail in ["占负债总额的比例为35.56%", "占有息债务总额的比例为35.56%，占有息负债总额的比例为99.00%"]:
            with self.subTest(tail=tail):
                self.document["paragraphs"][2]["text"] = f"截至报告期末，公司一年以内到期的债务为0.32亿元，{tail}。"
                self.assertFalse(self.debt()["passed"])

    def test_hypothetical_liquidity_simulation_is_not_a_balance_candidate(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "假设公司以新债同额置换一年内到期债务，模拟流动比率由1.20升至1.35，前述仅为模拟结果。"})
        result = self.debt()
        self.assertTrue(result["passed"])
        self.assertEqual(result["candidate_count"], 1)
        self.assertEqual(result["ignored"][-1]["reason"], "hypothetical_liquidity_simulation_not_balance_disclosure")

    def test_hypothetical_simulation_alone_does_not_supply_actual_coverage(self):
        self.document["paragraphs"][2]["text"] = "在以新债同额置换一年内到期债务的假设下，公司模拟流动比率由1.20升至1.35。"
        result = self.debt()
        self.assertTrue(result["missing_candidate"])
        self.assertFalse(result["passed"])

    def test_hypothesis_cannot_hide_separately_disclosed_actual_balance(self):
        simulation = "假设公司同额置换一年内到期债务，模拟流动比率升至1.35"
        for amount, expected in [("0.32", True), ("9.99", False)]:
            with self.subTest(amount=amount):
                self.document["paragraphs"][2]["text"] = simulation + f"，截至2032年9月末，公司一年内到期债务账面值为{amount}亿元，占有息负债总额的比例为35.56%。"
                result = self.debt()
                self.assertEqual(result["passed"], expected)
                self.assertEqual(result["candidate_count"], 1)

    def test_hypothesis_does_not_ignore_embedded_or_elided_actual_amount(self):
        for text in [
            "假设公司同额置换一年内到期债务（当前实际余额为9.99亿元），模拟流动比率升至1.35。",
            "假设公司同额置换一年内到期债务，当前实际账面余额为9.99亿元，模拟流动比率升至1.35。",
            "假设公司同额置换一年内到期债务为9.99，模拟流动比率升至1.35。",
            "假设公司通过置换改善偿债能力，截至报告期末，公司一年内到期债务账面值为9.99亿元，占有息负债总额的比例为35.56%，模拟流动比率为1.35。",
        ]:
            with self.subTest(text=text):
                self.document["paragraphs"].append({"body_index": 30, "text": text})
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidate_count"], 2)
                self.document["paragraphs"].pop()


class ContextBindingTests(unittest.TestCase):
    def setUp(self):
        self.controls = source_controls(source_fixture())
        self.document = document_fixture()

    def checked(self, identifier):
        return next(r for r in check_document(self.document, self.controls)["results"] if r["id"] == identifier)

    def debt(self):
        return self.checked("current_one_year_debt_narrative")

    def test_explicit_issuer_is_inherited_only_within_the_same_paragraph(self):
        self.document["paragraphs"][2]["text"] = "发行人披露本期偿债情况。截至报告期末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
        result = self.debt()
        self.assertTrue(result["passed"])
        self.assertEqual(result["candidates"][0]["scope_source"], "same_paragraph_preceding_explicit_subject")
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("0.32", "9.99")
        self.assertFalse(self.debt()["passed"])

    def test_subject_is_not_inherited_from_a_different_paragraph(self):
        self.document["paragraphs"].insert(2, {"body_index": 19, "text": "发行人披露本期偿债情况。"})
        self.document["paragraphs"][3]["text"] = "截至报告期末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
        result = self.debt()
        self.assertFalse(result["passed"])
        self.assertEqual(result["candidates"][0]["scope"], "unresolved")

    def test_subject_switch_blocks_inheritance_and_cannot_hide_new_current_candidate(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "发行人披露偿债情况。子公司甲公司另有安排。截至报告期末，一年内到期债务账面值为9.99亿元，占有息债务总额的比例为35.56%。"})
        result = self.debt()
        self.assertFalse(result["passed"])
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["candidates"][-1]["scope"], "unresolved")

    def test_comparison_does_not_turn_ambiguous_subject_into_other_entity_exclusion(self):
        self.document["paragraphs"].append({"body_index": 30, "text": "发行人披露偿债情况。与母公司相比，截至报告期末，一年内到期债务账面值为9.99亿元，占有息债务总额的比例为35.56%。"})
        self.assertFalse(self.debt()["passed"])
        self.assertEqual(self.debt()["candidate_count"], 2)

    def test_balance_date_is_not_overridden_by_named_cash_flow_period(self):
        self.document["paragraphs"][2]["text"] = "截至2032年9月末，公司货币资金为7亿元，2032年1-9月经营活动现金流量净额为2亿元，公司一年内到期债务账面值为0.32亿元，占有息负债总额的比例为35.56%。"
        result = self.debt()
        self.assertTrue(result["passed"])
        self.assertEqual(result["candidates"][0]["periods"], ["2032年9月末"])
        self.assertEqual(result["candidates"][0]["other_metric_period_bindings"][0]["bound_measure"], "现金流量")

    def test_target_flow_without_a_balance_anchor_remains_unresolved(self):
        for prefix in ["2032年1-9月，公司", "2032年1-9月公司经营活动现金流量净额为2亿元，公司"]:
            with self.subTest(prefix=prefix):
                self.document["paragraphs"].append({"body_index": 30, "text": f"{prefix}一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"})
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidate_count"], 2)
                self.assertEqual(result["candidates"][-1]["period_classification"], "unresolved")
                self.document["paragraphs"].pop()

    def test_other_period_must_bind_to_an_explicit_supported_measure(self):
        self.document["paragraphs"][2]["text"] = "截至2032年9月末，公司货币资金为7亿元，2032年1-9月业务规模为2亿元，公司一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
        self.assertFalse(self.debt()["passed"])
        self.assertEqual(self.debt()["candidates"][0]["period_classification"], "ambiguous")

    def test_conflicting_balance_dates_are_never_removed_as_cash_flow_context(self):
        self.document["paragraphs"][2]["text"] = "截至2032年9月末，公司货币资金为7亿元，截至2032年6月末现金流量净额为2亿元，公司一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
        self.assertFalse(self.debt()["passed"])
        self.assertEqual(self.debt()["candidates"][0]["period_classification"], "ambiguous")

    def test_flow_metric_keeps_its_own_flow_period(self):
        self.document["paragraphs"][1]["text"] = "截至2032年9月末，公司货币资金为7亿元，2032年1-9月，发行人营业外支出账面值为123.46万元。"
        result = self.checked("current_nonoperating_expense_narrative")
        self.assertTrue(result["passed"])
        self.assertEqual(result["candidates"][0]["periods"], ["2032年1-9月"])

    def test_interest_bearing_liability_alias_is_not_ordinary_liability(self):
        self.document["paragraphs"][2]["text"] = "截至报告期末，公司一年内到期有息负债账面值为0.32亿元，占有息负债总额的比例为35.56%。"
        self.assertTrue(self.debt()["passed"])
        self.document["paragraphs"][2]["text"] = self.document["paragraphs"][2]["text"].replace("到期有息负债", "到期负债")
        self.assertFalse(self.debt()["passed"])
        self.assertTrue(self.debt()["missing_candidate"])

    def test_book_value_control_does_not_verify_face_principal(self):
        self.document["paragraphs"][2]["text"] = "截至报告期末，公司一年内到期债务账面值为0.32亿元（即票面本金），占有息债务总额的比例为35.56%。"
        self.assertFalse(self.debt()["passed"])
        self.assertIn("face_principal_not_supported_by_book_value_control", self.debt()["candidates"][0]["errors"])


class BookValueDefinitionTests(unittest.TestCase):
    terms = ["短期借款", "一年内到期的长期借款", "一年内到期的应付债券", "一年内到期的融资租赁款",
             "长期借款", "应付债券", "长期应付款中的应付融资租赁款"]
    title = "全部债务（期末账面值，不含单列应付利息）="
    note = "；其中应付债券按期末摊余成本列示，专项应付款及单列应付利息不计入。"

    def setUp(self):
        self.controls = source_controls(source_fixture())
        self.document = document_fixture()
        self.document["paragraphs"][0]["text"] = self.title + "+".join(self.terms) + self.note

    def definition(self):
        return next(r for r in check_document(self.document, self.controls)["results"]
                    if r["id"] == "debt_definition_interest_treatment")

    def table(self):
        return {"body_index": 18, "context": ["有息负债总体情况", "单位：万元、%"],
                "rows": [["项目", "2032年9月末"],
                         ["一年内到期的非流动有息负债（不含应付利息）", "1200.00"],
                         ["合计", "9000.00"]]}

    def test_expanded_carrying_value_definition_passes_complete_document(self):
        checked = check_document(self.document, self.controls)
        self.assertEqual((checked["passed"], checked["total"]), (5, 5))
        self.assertEqual(self.definition()["basis"], "principal")

    def test_compatibility_basis_explicitly_is_not_face_value_principal(self):
        self.assertIn("期末账面额", self.controls["basis_descriptions"]["principal"])
        self.assertIn("不代表票面本金", self.definition()["basis_description"])
        self.assertIn("not face-value principal", self.controls["basis_limit"])

    def test_parenthetical_comma_preserves_whole_definition(self):
        original = self.document["paragraphs"][0]["text"]
        for title in [self.title, "全部债务(期末账面值,不含单列应付利息)="]:
            with self.subTest(title=title):
                self.document["paragraphs"][0]["text"] = original.replace(self.title, title)
                self.assertTrue(self.definition()["passed"])

    def test_unique_expanded_components_can_change_order(self):
        self.document["paragraphs"][0]["text"] = self.title + "+".join(reversed(self.terms)) + self.note
        self.assertTrue(self.definition()["passed"])

    def test_expansion_rejects_missing_duplicate_extra_and_negative_terms(self):
        expressions = ["+".join(self.terms[:-1]), "+".join(self.terms + [self.terms[0]]),
                       "+".join(self.terms + ["其他债务"]), "+".join(self.terms).replace("+长期借款", "-长期借款"),
                       "+".join(self.terms).replace("+长期借款", "×长期借款"), "+".join(self.terms) + "+单列应付利息"]
        for expression in expressions:
            with self.subTest(expression=expression):
                self.document["paragraphs"][0]["text"] = self.title + expression + self.note
                self.assertEqual(self.definition()["status"], "clarification_required")
                self.assertFalse(self.definition()["passed"])

    def test_expansion_requires_book_value_interest_special_and_bond_disclosures(self):
        original = self.document["paragraphs"][0]["text"]
        for old, new in [("期末账面值", "债务金额"), ("，不含单列应付利息", ""),
                         ("专项应付款及单列应付利息不计入", "单列应付利息不计入"),
                         ("其中应付债券按期末摊余成本列示，", ""),
                         ("期末摊余成本", "票面本金")]:
            with self.subTest(old=old):
                self.document["paragraphs"][0]["text"] = original.replace(old, new)
                self.assertFalse(self.definition()["passed"])

    def test_conflicting_or_negated_exclusions_never_pass(self):
        original = self.document["paragraphs"][0]["text"]
        for extra in ["全部债务包含单列应付利息", "专项应付款计入", "全部债务包含专项应付款",
                      "专项应付款并非不计入", "单列应付利息并非不计入", "并非不含单列应付利息",
                      "全部债务未剔除单列应付利息"]:
            with self.subTest(extra=extra):
                self.document["paragraphs"][0]["text"] = original + extra
                self.assertFalse(self.definition()["passed"])

    def test_unknown_and_pending_formula_do_not_pass(self):
        original = self.document["paragraphs"][0]["text"]
        for changed in [original + "上述口径待人工确认", original + "专项应付款是否计入待核",
                        original.replace(self.title, "全部债务（未知方法）="),
                        original.replace(self.title, "全部债务（期末账面值，不含单列应付利息="),
                        original.replace("期末账面值", "票面金额")]:
            with self.subTest(changed=changed):
                self.document["paragraphs"][0]["text"] = changed
                self.assertFalse(self.definition()["passed"])

    def test_explicit_prefix_special_exclusion_is_not_mistaken_for_inclusion(self):
        self.document["paragraphs"][0]["text"] = self.document["paragraphs"][0]["text"].replace(
            "专项应付款及单列应付利息不计入", "全部债务不包含专项应付款且不包含单列应付利息")
        self.assertTrue(self.definition()["passed"])

    def test_matching_excluded_interest_alias_and_total_are_checked(self):
        self.document["tables"].append(self.table())
        result = self.definition()
        self.assertTrue(result["passed"])
        self.assertEqual(result["current_table_coverage"], "bounded_rows_checked")
        self.assertEqual({row["metric"] for row in result["current_table_comparisons"]},
                         {"current_noncurrent_yuan", "total_debt_yuan"})

    def test_wrong_alias_value_or_total_fails(self):
        for row in [1, 2]:
            with self.subTest(row=row):
                table = self.table()
                table["rows"][row][1] = "1.00"
                self.document["tables"] = [document_fixture()["tables"][0], table]
                self.assertFalse(self.definition()["passed"])

    def test_duplicate_alias_canonical_or_total_rows_fail(self):
        for added in [["一年内到期的非流动有息负债（不含应付利息）", "1200.00"],
                      ["一年内到期的非流动负债", "1200.00"], ["合计", "9000.00"]]:
            with self.subTest(added=added):
                table = self.table()
                table["rows"].append(added)
                self.document["tables"] = [document_fixture()["tables"][0], table]
                self.assertFalse(self.definition()["passed"])
                self.assertEqual(self.definition()["current_table_coverage"], "incomplete_or_ambiguous")

    def test_missing_total_cannot_claim_complete_table_comparison(self):
        table = self.table()
        table["rows"].pop()
        self.document["tables"].append(table)
        result = self.definition()
        self.assertFalse(result["passed"])
        self.assertEqual(result["current_table_coverage"], "incomplete_or_ambiguous")
        self.assertIn("total_debt_row_missing_or_duplicate", result["current_table_comparisons"][0]["errors"])

    def test_excluded_interest_alias_conflicts_with_inclusive_definition(self):
        self.document["paragraphs"][0]["text"] = document_fixture()["paragraphs"][0]["text"].replace("剔除应付利息", "包含应付利息")
        table = self.table()
        table["rows"][1][1], table["rows"][2][1] = "1260.00", "9060.00"
        self.document["tables"].append(table)
        result = self.definition()
        self.assertFalse(result["passed"])
        self.assertEqual(result["current_table_comparisons"][0]["comparisons"]["including_current_interest"]["error"],
                         "table_row_interest_treatment_conflicts_with_definition")

    def test_unsupported_interest_alias_is_not_silently_ignored(self):
        table = self.table()
        table["rows"][1][0] = table["rows"][1][0].replace("不含", "包含")
        self.document["tables"].append(table)
        self.assertFalse(self.definition()["passed"])
        self.assertEqual(self.definition()["current_table_coverage"], "incomplete_or_ambiguous")

    def test_second_bad_expanded_formula_cannot_hide_behind_correct_first(self):
        self.document["paragraphs"].append({"body_index": 30,
            "text": self.title + "+".join(self.terms[:-1]) + self.note})
        self.assertFalse(self.definition()["passed"])
        self.assertEqual(self.definition()["candidate_count"], 2)


class IndependentReviewRegressionTests(unittest.TestCase):
    def setUp(self):
        self.controls = source_controls(source_fixture())
        self.document = document_fixture()

    def checked(self, identifier):
        return next(r for r in check_document(self.document, self.controls)["results"] if r["id"] == identifier)

    def debt(self):
        return self.checked("current_one_year_debt_narrative")

    def use_book_definition(self):
        self.document["paragraphs"][0]["text"] = (BookValueDefinitionTests.title +
            "+".join(BookValueDefinitionTests.terms) + BookValueDefinitionTests.note)

    def definition(self):
        return self.checked("debt_definition_interest_treatment")

    def test_unknown_named_subject_cannot_inherit_issuer(self):
        for subject in ["甲银行", "乙基金", "丙合作社"]:
            with self.subTest(subject=subject):
                self.document["paragraphs"][2]["text"] = f"发行人披露本期偿债情况。{subject}截至报告期末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidates"][0]["scope"], "unresolved")
                self.assertNotEqual(result["candidates"][0]["scope_source"], "same_paragraph_preceding_explicit_subject")

    def test_intervening_unknown_subject_breaks_issuer_inheritance(self):
        self.document["paragraphs"][2]["text"] = "发行人披露本期偿债情况。甲银行另有安排。截至报告期末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
        self.assertFalse(self.debt()["passed"])
        self.assertEqual(self.debt()["candidates"][0]["scope"], "unresolved")

    def test_supported_temporal_prefix_still_allows_adjacent_issuer_inheritance(self):
        self.document["paragraphs"][2]["text"] = "发行人披露本期偿债情况。截至2032年9月末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
        self.assertTrue(self.debt()["passed"])

    def test_hypothesis_preposed_actual_balance_is_never_ignored(self):
        for description in ["当前实际账面余额为9.99亿元", "账面值为9.99亿元", "现有余额为9.99亿元"]:
            with self.subTest(description=description):
                self.document["paragraphs"].append({"body_index": 30, "text": f"假设公司以新债同额置换{description}的一年内到期债务，模拟流动比率由1.20升至1.35。"})
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidate_count"], 2)
                self.assertFalse(any(row.get("reason") == "hypothetical_liquidity_simulation_not_balance_disclosure" for row in result["ignored"]))
                self.document["paragraphs"].pop()

    def test_negated_bond_carrying_value_disclosure_does_not_pass(self):
        self.use_book_definition()
        original = self.document["paragraphs"][0]["text"]
        for wording in ["并非应付债券按期末摊余成本列示", "应付债券不按期末摊余成本列示", "不是应付债券按期末摊余成本列示"]:
            with self.subTest(wording=wording):
                self.document["paragraphs"][0]["text"] = original.replace("其中应付债券按期末摊余成本列示", wording)
                self.assertEqual(self.definition()["status"], "clarification_required")

    def test_correct_bond_disclosure_cannot_hide_a_second_negated_one(self):
        self.use_book_definition()
        self.document["paragraphs"][0]["text"] += "并非应付债券按期末摊余成本列示。"
        self.assertFalse(self.definition()["passed"])

    def test_undetermined_bond_measurement_remains_clarification(self):
        self.use_book_definition()
        self.document["paragraphs"][0]["text"] += "上述债券的实际列示方法尚未确定。"
        self.assertEqual(self.definition()["status"], "clarification_required")

    def test_no_need_to_exclude_special_payables_conflicts_with_exclusion(self):
        self.use_book_definition()
        original = self.document["paragraphs"][0]["text"]
        for phrase in ["无须扣除", "无须剔除", "无需扣除", "不予剔除"]:
            with self.subTest(phrase=phrase):
                self.document["paragraphs"][0]["text"] = original + f"全部债务{phrase}专项应付款。"
                self.assertFalse(self.definition()["passed"])

    def test_generic_cash_flow_mention_cannot_remove_a_conflicting_period(self):
        for description in ["根据现金流预测", "现金流情况较好", "经营活动现金流量净额尚未披露"]:
            with self.subTest(description=description):
                self.document["paragraphs"][2]["text"] = f"截至2032年9月末，公司货币资金为7亿元，2032年1-9月，{description}，公司一年内到期债务账面值为0.32亿元，占有息负债总额的比例为35.56%。"
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidates"][0]["period_classification"], "ambiguous")
                self.assertEqual(result["candidates"][0]["other_metric_period_bindings"], [])

    def test_named_measured_cash_flows_bind_only_their_own_period(self):
        for activity in ["经营", "投资", "筹资"]:
            with self.subTest(activity=activity):
                self.document["paragraphs"][2]["text"] = f"截至2032年9月末，公司货币资金为7亿元，2032年1-9月{activity}活动产生的现金流量净额为2亿元，公司一年内到期债务账面值为0.32亿元，占有息负债总额的比例为35.56%。"
                self.assertTrue(self.debt()["passed"])


class BoundedGrammarRegressionTests(unittest.TestCase):
    def setUp(self):
        self.controls = source_controls(source_fixture())
        self.document = document_fixture()

    def checked(self, identifier):
        return next(r for r in check_document(self.document, self.controls)["results"] if r["id"] == identifier)

    def debt(self):
        return self.checked("current_one_year_debt_narrative")

    def use_book_definition(self):
        self.document["paragraphs"][0]["text"] = (BookValueDefinitionTests.title +
            "+".join(BookValueDefinitionTests.terms) + BookValueDefinitionTests.note)

    def test_simulation_object_must_not_contain_an_unknown_amount_modifier(self):
        for modifier in ["当前总额为9.99亿元的", "现有金额为9.99亿元的", "总额为9.99的", "总额为九亿元的"]:
            with self.subTest(modifier=modifier):
                self.document["paragraphs"].append({"body_index": 30, "text": f"假设公司以新债同额置换{modifier}一年内到期债务，模拟流动比率由1.20升至1.35。"})
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidate_count"], 2)
                self.assertFalse(any(row.get("reason") == "hypothetical_liquidity_simulation_not_balance_disclosure" for row in result["ignored"]))
                self.document["paragraphs"].pop()

    def test_supported_amount_free_operation_objects_remain_ignored(self):
        for prefix in ["假设公司以新债同额置换", "假定发行人以新债偿还", "在以新债同额置换"]:
            with self.subTest(prefix=prefix):
                ending = "的假设下" if prefix.startswith("在") else ""
                self.document["paragraphs"].append({"body_index": 30, "text": f"{prefix}一年内到期债务{ending}，公司模拟流动比率升至1.35。"})
                result = self.debt()
                self.assertTrue(result["passed"])
                self.assertEqual(result["candidate_count"], 1)
                self.document["paragraphs"].pop()

    def test_every_special_payable_declaration_must_match_supported_exclusion(self):
        self.use_book_definition()
        original = self.document["paragraphs"][0]["text"]
        for declaration in ["全部债务不必扣除专项应付款", "全部债务不需要剔除专项应付款", "专项应付款另按其他方法处理"]:
            with self.subTest(declaration=declaration):
                self.document["paragraphs"][0]["text"] = original + declaration + "。"
                self.assertEqual(self.checked("debt_definition_interest_treatment")["status"], "clarification_required")

    def test_every_bond_measurement_declaration_must_match_supported_basis(self):
        self.use_book_definition()
        original = self.document["paragraphs"][0]["text"]
        for declaration in ["应付债券按公允价值计量", "应付债券以公允价值计价", "应付债券采用其他方法", "上述债券按其他方法计量"]:
            with self.subTest(declaration=declaration):
                self.document["paragraphs"][0]["text"] = original + declaration + "。"
                self.assertEqual(self.checked("debt_definition_interest_treatment")["status"], "clarification_required")

    def test_issuer_reporting_another_entity_is_not_an_inheritance_anchor(self):
        for introduction in ["发行人披露甲银行本期偿债情况", "发行人披露本期偿债情况及甲银行情况", "发行人与甲银行共同披露本期偿债情况"]:
            with self.subTest(introduction=introduction):
                self.document["paragraphs"][2]["text"] = introduction + "。截至报告期末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
                result = self.debt()
                self.assertFalse(result["passed"])
                self.assertEqual(result["candidates"][0]["scope"], "unresolved")

    def test_exact_owned_issuer_introduction_retains_temporal_continuation(self):
        for subject in ["发行人", self.controls["target"]["issuer"]]:
            with self.subTest(subject=subject):
                self.document["paragraphs"][2]["text"] = subject + "披露本期偿债情况。截至报告期末，一年内到期债务账面值为0.32亿元，占有息债务总额的比例为35.56%。"
                self.assertTrue(self.debt()["passed"])


if __name__ == "__main__":
    unittest.main()
