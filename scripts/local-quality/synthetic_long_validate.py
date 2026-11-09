"""Read-only validation of the saved synthetic input bundle, independent of its builders."""
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from openpyxl import load_workbook
from rq_q3_baseline import word_inventory


def validate(directory):
    manifest = json.loads((directory / "fixture-manifest.json").read_text(encoding="utf-8"))
    assert manifest["synthetic_only"] is True and manifest["customer_inputs_read"] is False
    for item in manifest["files"]:
        path = (directory / item["filename"]).resolve()
        assert path.parent == directory
        data = path.read_bytes()
        assert len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"]
    book = load_workbook(directory / "synthetic-2026q3-financials.xlsx", read_only=True, data_only=True)
    assert book.sheetnames == [s["name"] for s in manifest["sheets"]]
    for control in manifest["controls"]:
        sheet = next(s for s in manifest["sheets"] if s["name"] == control["source_sheet"])
        value = book[control["source_sheet"]][control["source_cell"]].value
        assert isinstance(value, (int, float))
        assert abs(Decimal(str(value)) * sheet["multiplier"] - Decimal(control["yuan"])) < Decimal("0.00001"), control
    reconciliations = []
    for scope in ["合并", "母公司"]:
        def values(statement):
            sheet = book[scope + statement]
            multiplier = 1 if scope == "合并" else 10000
            return {row[0].value: [Decimal(str(cell.value)) * multiplier for cell in row[1:] if cell.value is not None]
                    for row in sheet.iter_rows(min_row=6) if row[0].value}
        balance, income, cash = (values(statement) for statement in ["资产负债表", "利润表", "现金流量表"])
        def equals(left, right):
            assert abs(left - right) < Decimal("0.00001")
        for column in range(3):
            equals(balance["资产总计"][column], sum(balance[k][column] for k in ["货币资金", "应收账款", "存货", "固定资产", "其他资产"]))
            equals(balance["资产总计"][column], balance["负债合计"][column] + balance["所有者权益合计"][column])
        for column in range(4):
            equals(income["利润总额"][column], income["营业收入"][column] - sum(income[k][column] for k in ["营业成本", "税金及附加", "期间费用"]))
            equals(income["净利润"][column], income["利润总额"][column] - income["所得税费用"][column])
            equals(cash["经营活动产生的现金流量净额"][column], cash["经营活动现金流入小计"][column] - cash["经营活动现金流出小计"][column])
            equals(cash["现金及现金等价物净增加额"][column], sum(cash[k][column] for k in ["经营活动产生的现金流量净额", "投资活动产生的现金流量净额", "筹资活动产生的现金流量净额"]))
        equals(cash["现金及现金等价物净增加额"][1], balance["货币资金"][1] - balance["货币资金"][0])
        equals(cash["现金及现金等价物净增加额"][3], balance["货币资金"][2] - balance["货币资金"][1])
        reconciliations.append(scope)
    source = word_inventory((directory / "synthetic-2025-prospectus.docx").read_bytes())
    assert len(source["chapters"]) == 14 and source["table_count"] == 6 and len(manifest["retention_anchors"]) == 26
    report = {"synthetic_only": True, "customer_inputs_read": False, "typed_controls_verified": len(manifest["controls"]),
              "scope_reconciliations": reconciliations, "sheets": len(book.sheetnames), "chapters": len(source["chapters"]),
              "source_characters": source["accepted_characters"], "cross_page_candidate_tables": source["table_count"],
              "rendered_page_count": "separate_renderer_receipt_required", "industry_signoff": False,
              "source_hashes": manifest["files"]}
    (directory / "fixture-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "source_hashes"}, ensure_ascii=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-dir", type=Path, required=True)
    validate(parser.parse_args().fixture_dir.resolve())
