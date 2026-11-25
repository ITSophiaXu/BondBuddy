"""命令行入口。

  PYTHONPATH=python:services/update python -m bondbuddy_update run \
      --prospectus 历史募集书.docx --financial 报表.xlsx [--financial ...] \
      --issuer 发行人全称 --out 输出目录 [--golden 人工最终稿.docx]
"""
from __future__ import annotations

import argparse
import json
import sys

from . import golden_eval, pipeline


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="bondbuddy_update")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="运行确定性流水线，输出修订版/清洁版 Word 和 report.json")
    r.add_argument("--prospectus", required=True)
    r.add_argument("--financial", action="append", default=[])
    r.add_argument("--issuer", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--years", type=int, default=None, help="报告期年数（默认沿用历史募集书）")
    r.add_argument("--golden", help="人工最终稿；提供时输出与人工稿的逐格对比")
    a = ap.parse_args(argv)
    rep = pipeline.run(a.prospectus, a.financial, a.issuer, a.out, a.years)
    summary = {"period_plan": rep["period_plan"], "timings_s": rep["timings_s"],
               "replacements": rep["writer"]["replacements"], "rejected": len(rep["rejected_edits"]),
               "narrative_pending": len(rep["narrative_pending"])}
    if a.golden:
        g = golden_eval.compare(f"{a.out}/baseline-prepared.docx", f"{a.out}/清洁版.docx", a.golden)
        summary["golden"] = g["total"]
        with open(f"{a.out}/golden-eval.json", "w", encoding="utf-8") as fh:
            json.dump(g, fh, ensure_ascii=False, indent=1)
    json.dump(summary, sys.stdout, ensure_ascii=False, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
