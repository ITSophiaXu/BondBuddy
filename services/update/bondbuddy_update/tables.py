"""财务表格更新（S6 的确定性部分）。

流程：识别表头里的报告期列 → 行名对应到财务数据集科目 → 对未变化的期间做「旧数复核」
→ 为被替换的期间生成新数值 → 占比列按复核得到的分母重新计算。
无法对应或复核不通过的表格/行，不做修改，列入待办，后续交给模型映射单元（S6 映射）或人工。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .docx_model import Cell, Prospectus, Table
from .fin_xlsx import Dataset
from .items import normalize
from .periods import Period, PeriodPlan, find_period_mentions, parse_period

RATIO_HDR = re.compile(r"^(占比|比例|比重|占比（%）|占比\(%\)|%|增长率|变动比例|增减幅度)$")
UNIT_MAP = [("亿元", 1e8), ("万元", 1e4), ("元", 1.0)]
NUM_RX = re.compile(r"^[-－—–]?\(?[\d,，]+(\.\d+)?\)?%?$")
BLANK = {"-", "—", "－", "–", "--", "/", "", "0", "0.00"}

DENOM_CANDIDATES = ["资产总计", "负债合计", "流动资产合计", "非流动资产合计", "流动负债合计", "非流动负债合计",
                    "所有者权益合计", "营业总收入", "营业收入", "营业成本", "负债和所有者权益合计"]


@dataclass
class CellEdit:
    ref: str
    before: str
    after: str
    reason: str
    sources: list[str] = field(default_factory=list)


@dataclass
class TableResult:
    table: int
    caption: str
    status: str                         # updated | skipped | needs_mapping | verify_failed
    reason: str = ""
    edits: list[CellEdit] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    checked: int = 0                    # 旧数复核通过的格子
    check_failed: list[str] = field(default_factory=list)


def parse_number(text: str) -> float | None:
    s = re.sub(r"\s+", "", text or "").replace("，", ",").replace("－", "-").replace("—", "-").replace("–", "-")
    if not s or not NUM_RX.match(s):
        return None
    neg = s.startswith("-") or (s.startswith("(") and s.endswith(")"))
    s = s.strip("-()%").replace(",", "")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def fmt_like(value: float, sample: str, decimals: int | None = None) -> str:
    """按原单元格的写法输出：小数位、千分位、负号。"""
    s = (sample or "").strip()
    if decimals is None:
        m = re.search(r"\.(\d+)", s)
        decimals = len(m.group(1)) if m else 2
    comma = ("," in s) or not s or parse_number(s) is None or abs(parse_number(s) or 0) >= 1000 or True
    text = f"{abs(value):,.{decimals}f}" if comma else f"{abs(value):.{decimals}f}"
    if value < 0 and round(abs(value), decimals) != 0:
        text = "-" + text
    return text


def table_unit(t: Table) -> float:
    txt = t.unit_text + " " + t.caption
    for word, mult in UNIT_MAP:
        if word in txt:
            return mult
    return 1e4


def table_scope(t: Table) -> str:
    return "parent" if "母公司" in (t.caption + " ".join(t.context)) else "consolidated"


@dataclass
class Column:
    col: int
    period: Period
    span: int = 1
    ratio_cols: list[int] = field(default_factory=list)
    header_cells: list[Cell] = field(default_factory=list)


VALUE_SUB = re.compile(r"^(金额|余额|账面余额|账面价值|期末余额|数值|万元|金额（万元）)$")


def find_columns(t: Table) -> tuple[int, list[Column]] | None:
    """返回 (表头最后一行行号, 期间列)。只看前 3 行。

    支持两种表头：
      单行：项目 | 2025年6月末 | 占比 | 2024年末 | 占比
      两行：项目 | 2025年6月末(跨两列) | 2024年末(跨两列)
            　　 | 金额 | 占比 | 金额 | 占比
    """
    for hr in range(1, min(3, len(t.rows)) + 1):
        cols: list[Column] = []
        last: Column | None = None
        for c in t.rows[hr - 1]:
            p = parse_period(c.text)
            if p is not None:
                last = Column(c.col, p, header_cells=[c])
                last.span = c.span
                cols.append(last)
            elif last is not None and RATIO_HDR.match(re.sub(r"\s+", "", c.text)):
                last.ratio_cols.append(c.col)
        if len(cols) >= 2:
            if hr < len(t.rows) and any(getattr(c, "span", 1) > 1 for c in cols):
                sub = {c.col: re.sub(r"\s+", "", c.text) for c in t.rows[hr]}
                for c in cols:
                    span = getattr(c, "span", 1)
                    inside = [(k, v) for k, v in sub.items() if c.col <= k < c.col + span]
                    vals = [k for k, v in inside if VALUE_SUB.match(v)]
                    if vals:
                        c.col = vals[0]
                    c.ratio_cols = [k for k, v in inside if RATIO_HDR.match(v)]
                return hr + 1, cols
            return hr, cols
    return None


def _lookup(ds: Dataset, scope: str, key: str, end) -> tuple[float | None, str | None]:
    for kind in ("point", "flow"):
        r = ds.get(scope, key, Period(end, kind))
        if r is not None:
            return r.value, r.source
    return None, None


def _known_key(ds: Dataset, scope: str, key: str) -> bool:
    return any(k[0] == scope and k[1] == key for k in ds.index)


def update_table(t: Table, ds: Dataset, plan: PeriodPlan, doc: Prospectus) -> TableResult:
    res = TableResult(t.index, t.caption or (t.context[-1] if t.context else ""), "skipped")
    found = find_columns(t)
    if not found:
        res.reason = "表头没有报告期列"
        return res
    hr, cols = found
    changed = [c for c in cols if plan.new_for(c.period).end != c.period.end]
    if not changed:
        res.reason = "报告期未变化"
        return res
    scope, unit = table_scope(t), table_unit(t)
    data_rows = t.rows[hr:]
    labels = []
    for row in data_rows:
        first = row[0] if row else None
        lab = normalize(first.text) if first else ""
        labels.append((ds.resolve(scope, lab) or lab) if lab else "")
    matched = [lab for lab in labels if lab and _known_key(ds, scope, lab)]
    if len(matched) < max(2, int(0.6 * len([x for x in labels if x]))):
        res.status = "needs_mapping"
        res.reason = f"行名能直接对应到财务数据的只有 {len(matched)}/{len([x for x in labels if x])} 行，需要模型映射或人工"
        return res

    # 1. 旧数复核：未变化的期间，旧稿数值应与数据集一致
    for col in cols:
        if col in changed:
            continue
        for row, lab in zip(data_rows, labels):
            if not lab:
                continue
            cell = t.cell_at(row[0].row, col.col)
            if cell is None:
                continue
            old = parse_number(cell.text)
            val, src = _lookup(ds, scope, lab, col.period.end)
            if val is None or old is None:
                continue
            if abs(val / unit - old) <= 0.0101:
                res.checked += 1
            else:
                res.check_failed.append(f"{lab} {col.period.label()}：原稿 {cell.text}，数据 {val / unit:,.2f}（{src}）")
    total_checks = res.checked + len(res.check_failed)
    if res.check_failed and len(res.check_failed) > max(1, 0.05 * total_checks):
        res.status = "verify_failed"
        res.reason = f"旧数复核不一致 {len(res.check_failed)}/{total_checks} 格，映射可能有误"
        return res

    # 2. 占比列分母：用旧稿的数值反推（找使大多数行「数值/分母」等于原占比的那一行或那个科目）
    def infer_denominator(col: Column, rcol: int):
        best, best_hits = None, 0
        olds = []
        for row, lab in zip(data_rows, labels):
            v = t.cell_at(row[0].row, col.col)
            r = t.cell_at(row[0].row, rcol)
            if v and r and parse_number(v.text) is not None and parse_number(r.text) is not None:
                olds.append((lab, parse_number(v.text), parse_number(r.text)))
        cands = [("row", lab, v) for lab, v, _ in olds if v] + \
                [("item", k, None) for k in DENOM_CANDIDATES]
        for kind, name, dv in cands:
            if kind == "item":
                val, _ = _lookup(ds, scope, name, col.period.end)
                if val is None:
                    continue
                dv = val / unit
            hits = sum(1 for _, v, pct in olds if dv and abs(v / dv * 100 - pct) <= 0.011)
            if hits > best_hits:
                best, best_hits = (kind, name), hits
        if best and best_hits >= max(2, int(0.6 * len(olds))):
            return best
        return None

    # 3. 生成新值
    for col in changed:
        newp = plan.new_for(col.period)
        for hc in col.header_cells:
            for ref in hc.refs[:1]:
                blk = doc.by_ref[ref]
                new_text = _replace_periods_full(blk.text, plan)
                if new_text != blk.text:
                    res.edits.append(CellEdit(ref, blk.text, new_text, "表头报告期"))
        new_vals: dict[str, float] = {}
        for row, lab in zip(data_rows, labels):
            cell = t.cell_at(row[0].row, col.col)
            if cell is None or not lab:
                continue
            val, src = _lookup(ds, scope, lab, newp.end)
            if val is None:
                if _known_key(ds, scope, lab) and cell.text.strip() in BLANK:
                    continue  # 本期无此科目、原稿也为空：保持
                if _known_key(ds, scope, lab):
                    val, src = 0.0, "本期报表未列示，视为 0"
                else:
                    if cell.text.strip() and cell.text.strip() not in BLANK:
                        res.pending.append(f"{lab}（{newp.label()}）：无法从财务数据中取得，原值 {cell.text.strip()} 未更新")
                    continue
            new_vals[lab] = val / unit
            after = fmt_like(val / unit, cell.text) if abs(val) >= 0.005 else _zero_like(cell.text)
            if not cell.refs:
                if after.strip() not in BLANK:
                    res.pending.append(f"{lab}（{newp.label()}）：原单元格为空，新值 {after} 需人工填入")
                continue
            blk = doc.by_ref[cell.refs[0]]
            if blk.text.strip() != after:
                res.edits.append(CellEdit(blk.ref, blk.text, after, f"{lab} {newp.label()}", [src or ""]))
        for rcol in col.ratio_cols:
            den = infer_denominator(col, rcol)
            if den is None:
                res.pending.append(f"第 {rcol} 列占比：无法确定分母，未重算")
                continue
            kind, name = den
            if kind == "row":
                dv = new_vals.get(name)
            else:
                v, _ = _lookup(ds, scope, name, newp.end)
                dv = v / unit if v is not None else None
            if not dv:
                res.pending.append(f"第 {rcol} 列占比：新一期分母「{name}」缺失，未重算")
                continue
            for row, lab in zip(data_rows, labels):
                rc = t.cell_at(row[0].row, rcol)
                if rc is None or not rc.refs or lab not in new_vals:
                    continue
                pct = new_vals[lab] / dv * 100
                after = fmt_like(pct, rc.text) if abs(pct) >= 0.005 else _zero_like(rc.text)
                blk = doc.by_ref[rc.refs[0]]
                if blk.text.strip() != after:
                    res.edits.append(CellEdit(blk.ref, blk.text, after, f"{lab} 占比 {newp.label()}（分母：{name}）"))
    res.status = "updated"
    return res


def _zero_like(sample: str) -> str:
    s = (sample or "").strip()
    return s if s in BLANK else "-"


def _replace_periods(text: str, plan: PeriodPlan) -> str:
    out, pos = [], 0
    for start, end, p, raw in find_period_mentions(text):
        newp = plan.mapping.get(p)
        if newp is None:
            continue
        out.append(text[pos:start])
        out.append(_relabel(raw, newp))
        pos = end
    out.append(text[pos:])
    return "".join(out)


def _replace_periods_full(text: str, plan: PeriodPlan) -> str:
    out = _replace_periods(text, plan)
    # 「2025年1-6月/6月末」这类合并写法：斜杠后的月份没有年份，按同一映射替换
    for old, new in plan.mapping.items():
        if old.kind == "point" and old.end.month != new.end.month:
            out = re.sub(rf"(/|／)\s*{old.end.month}\s*月末", rf"\g<1>{new.end.month}月末", out)
    return out


def _relabel(raw: str, p: Period) -> str:
    """沿用原写法：2025年6月末→2025年9月末，2025年1-6月→2025年1-9月，2025年6月30日→2025年9月30日。"""
    y, m, d = p.end.year, p.end.month, p.end.day
    if re.search(r"月\s*\d{1,2}\s*日", raw):
        return f"{y}年{m}月{d}日"
    if re.search(r"1\s*[-–—~～至]", raw):
        dash = re.search(r"[-–—~～至]", raw).group(0)
        return f"{y}年1{dash}{m}月" if m != 12 else f"{y}年度"
    if "月末" in raw or "月 末" in raw:
        return f"{y}年{m}月末" if m != 12 else f"{y}年末"
    if "年末" in raw or "年底" in raw:
        return f"{y}年末" if m == 12 else f"{y}年{m}月末"
    if "年度" in raw:
        return f"{y}年度" if m == 12 else f"{y}年1-{m}月"
    return raw
