"""报表勾稽与派生（S3 校验）。

1. 缺失或公式错误（#REF!）的合计项按会计恒等式推算，并标明「推算」；
2. 检查主要恒等式，不一致的写入核对清单。
"""
from __future__ import annotations

from .fin_xlsx import Dataset, Record

TOL = 1.0  # 元

IDENTITIES = [
    # (目标, [(系数, 科目)]) 目标 = Σ 系数×科目
    ("所有者权益合计", [(1, "资产总计"), (-1, "负债合计")]),
    ("负债和所有者权益合计", [(1, "资产总计")]),
    ("归属于母公司所有者权益合计", [(1, "所有者权益合计"), (-1, "少数股东权益")]),
]


def derive_and_check(ds: Dataset) -> list[dict]:
    findings = []
    periods = {(r.scope, r.period) for r in ds.records if r.statement == "balance"}
    for scope, period in sorted(periods, key=lambda x: (x[0], x[1].end)):
        for target, terms in IDENTITIES:
            parts = [ds.get(scope, k, period) for _, k in terms]
            if any(p is None for p in parts):
                continue
            value = sum(c * p.value for (c, _), p in zip(terms, parts))
            have = ds.get(scope, target, period)
            if have is None:
                rec = Record(scope, "balance", target, target, period, value,
                             "推算：" + " ".join(("+" if c > 0 else "-") + k for c, k in terms))
                ds.records.append(rec)
                ds.index[(scope, target, period)] = rec
                ds.loose_keys.setdefault((scope, target), set()).add(target)
                findings.append({"kind": "derived", "scope": scope, "item": target, "period": period.label(),
                                 "value": value, "note": "原表缺失或公式错误，按恒等式推算"})
            elif abs(have.value - value) > TOL:
                findings.append({"kind": "mismatch", "scope": scope, "item": target, "period": period.label(),
                                 "value": have.value, "expected": value, "source": have.source})
    ds.build_index()
    return findings
