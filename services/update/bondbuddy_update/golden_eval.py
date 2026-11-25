"""与人工最终稿对比的离线评测（docs/update-service/plan.md 第 11 节）。

按表格标题编号（如「表5-1」）对齐历史稿、生成稿和人工稿的表格，逐格比较：
  correct  生成稿与人工稿一致且相对历史稿有变化
  wrong    生成稿改了，但与人工稿不一致
  missed   人工稿改了，生成稿没改
  extra    生成稿改了，人工稿没改
同时统计正文段落中报告期表述的替换情况。C 类（需要额外材料）的表不计入准确率，只计入覆盖率。
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from . import docx_model


def _key(caption: str) -> str:
    m = re.match(r"表\s*([0-9一二三四五六七八九十]+)\s*[-－—.．]\s*(\d+)", caption or "")
    return f"{m.group(1)}-{m.group(2)}" if m else ""


def _grid(t):
    return {(c.row, c.col): re.sub(r"\s+", "", c.text) for r in t.rows for c in r}


def compare(history: str, generated: str, golden: str) -> dict:
    H = docx_model.load(Path(history).read_bytes())
    G = docx_model.load(Path(generated).read_bytes())
    A = docx_model.load(Path(golden).read_bytes())
    gold_by = {}
    for t in A.tables:
        k = _key(t.caption)
        if k and k not in gold_by:
            gold_by[k] = t
    per_table, total = [], Counter()
    for th, tg in zip(H.tables, G.tables):
        k = _key(th.caption)
        ta = gold_by.get(k)
        if not k or ta is None:
            continue
        gh, gg, ga = _grid(th), _grid(tg), _grid(ta)
        if len(th.rows) != len(ta.rows) or th.ncols != ta.ncols:
            c = Counter(shape_changed=1)
        else:
            c = Counter()
            for pos, old in gh.items():
                new, gold = gg.get(pos, old), ga.get(pos, old)
                if new != old and new == gold:
                    c["correct"] += 1
                elif new != old and new != gold:
                    c["wrong"] += 1
                elif new == old and gold != old:
                    c["missed"] += 1
        if c:
            per_table.append({"table": k, "caption": th.caption[:40], **c})
            total.update(c)
    return {"total": dict(total), "tables": per_table}
