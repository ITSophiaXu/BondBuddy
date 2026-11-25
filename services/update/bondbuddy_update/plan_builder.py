"""把各阶段的编辑汇总成 python/bondbuddy_word_delivery/writer.py 可执行的计划（S9）。"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone

from .docx_model import Prospectus
from .tables import CellEdit


def ref_path(ref: str) -> list[dict]:
    parts = ref.split(":")[1:]
    path, i = [], 0
    while i < len(parts):
        if parts[i].startswith("t"):
            path.append({"table": int(parts[i][1:]), "row": int(parts[i + 1][1:]), "column": int(parts[i + 2][1:])})
            i += 3
        else:
            path.append({"paragraph": int(parts[i][1:])})
            i += 1
    return path


def utf16_len(s: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


def minimal_change(before: str, after: str) -> tuple[int, int, str, str]:
    """返回最小替换区间（UTF-16 偏移）：只把真正变化的字符标成修订。"""
    i = 0
    while i < min(len(before), len(after)) and before[i] == after[i]:
        i += 1
    j = 0
    while j < min(len(before), len(after)) - i and before[-1 - j] == after[-1 - j]:
        j += 1
    # 数字整体替换更易读：扩展到完整数字
    while i > 0 and re.match(r"[\d,.]", before[i - 1]):
        i -= 1
    while j > 0 and re.match(r"[\d,.]", before[len(before) - j]):
        j -= 1
    b_mid = before[i:len(before) - j]
    a_mid = after[i:len(after) - j]
    return utf16_len(before[:i]), utf16_len(before[:i]) + utf16_len(b_mid), b_mid, a_mid


def build_plan(doc: Prospectus, edits: list[CellEdit]) -> tuple[dict, list[dict]]:
    """返回 (writer 计划, 被拒绝的编辑)。同一块只允许一处编辑来源。"""
    by_ref: dict[str, CellEdit] = {}
    rejected = []
    for e in edits:
        blk = doc.by_ref.get(e.ref)
        if blk is None or blk.text != e.before:
            rejected.append({"ref": e.ref, "reason": "定位或原文不一致", "edit": e.reason})
            continue
        if not blk.simple:
            rejected.append({"ref": e.ref, "reason": "段落结构复杂（含超链接、域等），无法安全修订", "edit": e.reason,
                             "before": e.before, "after": e.after})
            continue
        if e.ref in by_ref and by_ref[e.ref].after != e.after:
            rejected.append({"ref": e.ref, "reason": "同一位置有冲突的修改", "edit": e.reason})
            continue
        by_ref[e.ref] = e
    previews, replacements = [], []
    for b in doc.blocks:
        loc = {"path": ref_path(b.ref), "stable_ref": b.ref}
        after = by_ref[b.ref].after if b.ref in by_ref else b.text
        previews.append({"recordId": b.ref, "locator": loc, "before": b.text, "after": after})
        if b.ref in by_ref:
            pre = b.text[:b.prefix]
            if not after.startswith(pre):
                raise ValueError("EDIT_TOUCHES_PARAGRAPH_PROPERTIES")
            s, e, bm, am = minimal_change(b.text[b.prefix:], after[b.prefix:])
            replacements.append({"recordId": b.ref, "locator": loc, "start": s, "end": e, "before": bm, "after": am})
    plan = {
        "source": {"contentHash": doc.sha256, "format": "docx_effective"},
        "deliverable": False,
        "_delivery_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "textPreview": previews,
        "replacements": replacements,
        "columns": [],
        "additions": [],
        "reviewNotes": [],
    }
    body = json.dumps({k: plan[k] for k in ("source", "replacements")}, ensure_ascii=False, sort_keys=True)
    plan["baselineHash"] = doc.sha256
    plan["planHash"] = hashlib.sha256(body.encode()).hexdigest()
    return plan, rejected
