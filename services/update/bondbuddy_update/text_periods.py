"""正文报告期表述替换（S7 的确定性部分）。

只替换「不含金额」的段落（表格标题、引导句、单位行等）中的报告期表述。含金额、比例的段落
数字也要随之更新，不能只改期间，交给叙述章节单元（S8，模型）处理，这里只列入待办。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .docx_model import Prospectus
from .periods import PeriodPlan, find_period_mentions
from .tables import CellEdit, _replace_periods_full as _replace_periods

AMOUNT = re.compile(r"\d[\d,，]*\.\d+|\d+(?:\.\d+)?\s*(?:万元|亿元|元|%|％|个百分点|倍)")


@dataclass
class TextResult:
    edits: list[CellEdit]
    narrative: list[dict]   # 含金额、需要模型改写的段落


def update_text(doc: Prospectus, plan: PeriodPlan, skip_refs: set[str]) -> TextResult:
    edits, narrative = [], []
    for b in doc.blocks:
        if b.kind != "para" or b.ref in skip_refs:
            continue
        mentions = [m for m in find_period_mentions(b.text) if m[2] in plan.mapping]
        if not mentions:
            continue
        if AMOUNT.search(re.sub(r"20\d{2}\s*年|\d{1,2}\s*月|\d{1,2}\s*日", "", b.text)):
            narrative.append({"ref": b.ref, "text": b.text})
            continue
        new = _replace_periods(b.text, plan)
        if new != b.text:
            edits.append(CellEdit(b.ref, b.text, new, "报告期表述"))
    return TextResult(edits, narrative)
