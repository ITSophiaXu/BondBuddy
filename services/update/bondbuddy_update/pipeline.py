"""一期/年度/补更任务的确定性流水线入口（不含模型单元）。"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict
from pathlib import Path

from bondbuddy_word_delivery import writer as W

from . import derive, docx_model, fin_xlsx, tables, text_periods
from .periods import Period, plan_periods
from .plan_builder import build_plan


def old_points_from_tables(doc) -> list[Period]:
    """取财务章节里出现最多的表头期间组合作为历史报告期。"""
    from collections import Counter
    cnt = Counter()
    for t in doc.tables:
        f = tables.find_columns(t)
        if f:
            for c in f[1]:
                cnt[c.period.end] += 1
    common = [d for d, n in cnt.most_common() if n >= 3]
    return [Period(d, "point") for d in common[:4]]


def run(prospectus: str, financials: list[str], issuer: str, out_dir: str, years: int | None = None) -> dict:
    t0 = time.time()
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    timings = {}
    raw = docx_model.prepare_source(Path(prospectus).read_bytes())
    (out / "baseline-prepared.docx").write_bytes(raw)
    doc = docx_model.load(raw)
    timings["S2_parse"] = round(time.time() - t0, 2)

    t1 = time.time()
    ds = fin_xlsx.Dataset()
    unsupported = []
    for f in financials:
        if f.lower().endswith((".xlsx", ".xlsm")):
            ds.merge(fin_xlsx.read_xlsx(f, issuer))
        else:
            unsupported.append(f"{os.path.basename(f)}：本版本尚未接入该格式（DOCX 附注 / PDF 识别在后续 PR 实现）")
    findings = derive.derive_and_check(ds)
    timings["S3_financials"] = round(time.time() - t1, 2)
    if not ds.report_date:
        raise ValueError("FINANCIAL_REPORT_DATE_UNKNOWN")

    plan = plan_periods(old_points_from_tables(doc), ds.report_date, years)
    t2 = time.time()
    results = [tables.update_table(t, ds, plan, doc) for t in doc.tables]
    edits = [e for r in results for e in r.edits]
    table_refs = {e.ref for e in edits}
    txt = text_periods.update_text(doc, plan, table_refs)
    edits += txt.edits
    timings["S6_S7"] = round(time.time() - t2, 2)

    t3 = time.time()
    wplan, rejected = build_plan(doc, edits)
    src = out / "baseline-prepared.docx"
    summary = W.build(str(src), wplan, str(out / "修订版.docx"), str(out / "清洁版.docx"), str(out / "有效基线.docx"))
    timings["S9_word"] = round(time.time() - t3, 2)

    report = {
        "issuer": issuer,
        "prospectus": os.path.basename(prospectus),
        "financials": [os.path.basename(f) for f in financials],
        "dataset": {"entity": ds.entity, "report_date": ds.report_date.isoformat(), "records": len(ds.records)},
        "ignored_inputs": ds.ignored + unsupported,
        "reconciliation": findings,
        "period_plan": plan.to_json(),
        "tables": [{k: v for k, v in asdict(r).items() if k != "edits"} | {"edits": len(r.edits)} for r in results],
        "text_period_edits": len(txt.edits),
        "narrative_pending": txt.narrative,
        "rejected_edits": rejected,
        "writer": summary,
        "timings_s": timings | {"total": round(time.time() - t0, 2)},
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return report
