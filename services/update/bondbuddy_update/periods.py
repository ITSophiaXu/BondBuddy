"""报告期识别与规划（S5）。

把「2025年9月末」「2025年1-9月」「2024年度」「2024年12月31日」等写法解析成统一的
Period，并根据历史募集书的报告期和财务材料的最新一期，生成新旧报告期对应关系。
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date

CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12}


@dataclass(frozen=True, order=True)
class Period:
    """kind=point 表示时点（期末余额），kind=flow 表示期间（当年 1 月至 end 月的累计发生额）。"""
    end: date
    kind: str  # "point" | "flow"

    @property
    def months(self) -> int:
        return self.end.month

    @property
    def is_full_year(self) -> bool:
        return self.end.month == 12

    def label(self, style: str = "auto") -> str:
        y, m = self.end.year, self.end.month
        if self.kind == "point":
            if style == "date":
                return f"{y}年{m}月{self.end.day}日"
            return f"{y}年末" if m == 12 else f"{y}年{m}月末"
        if style == "year_only" and m == 12:
            return f"{y}年"
        return f"{y}年度" if m == 12 else f"{y}年1-{m}月"


def month_end(y: int, m: int) -> date:
    return date(y, m, calendar.monthrange(y, m)[1])


_NUM = r"(\d{1,2}|[一二三四五六七八九十]{1,3})"
_PATTERNS = [
    # 2025年1-9月 / 2025年1～9月 / 2025年1-9月份
    (re.compile(r"(20\d{2})\s*年\s*1\s*[-–—~～至]\s*" + _NUM + r"\s*月"), "flow_ytd"),
    # 2025年9月30日 / 2025年12月31日
    (re.compile(r"(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日"), "point_date"),
    # 2025年9月末 / 2025年6月末
    (re.compile(r"(20\d{2})\s*年\s*" + _NUM + r"\s*月\s*末"), "point_month"),
    # 2024年末 / 2024年年末 / 2024年底
    (re.compile(r"(20\d{2})\s*年\s*(?:年末|末|底)"), "point_year"),
    # 2024年度 / 2024年（单独出现时视为全年）
    (re.compile(r"(20\d{2})\s*年\s*度"), "flow_year"),
    (re.compile(r"(20\d{2})\s*年(?![\d一二三四五六七八九十])"), "flow_year_bare"),
]


def _num(token: str) -> int:
    return int(token) if token.isdigit() else CN_DIGITS[token]


def parse_period(text: str, allow_bare_year: bool = True) -> Period | None:
    """解析一个单元格或短语里的报告期；无法确定时返回 None。"""
    t = re.sub(r"\s+", "", text or "")
    if not t or len(t) > 24:
        return None
    for rx, kind in _PATTERNS:
        m = rx.search(t)
        if not m:
            continue
        y = int(m.group(1))
        if kind == "flow_ytd":
            return Period(month_end(y, _num(m.group(2))), "flow")
        if kind == "point_date":
            mo, d = int(m.group(2)), int(m.group(3))
            if 1 <= mo <= 12 and d == calendar.monthrange(y, mo)[1]:
                return Period(date(y, mo, d), "point")
            return None
        if kind == "point_month":
            return Period(month_end(y, _num(m.group(2))), "point")
        if kind == "point_year":
            return Period(date(y, 12, 31), "point")
        if kind == "flow_year":
            return Period(date(y, 12, 31), "flow")
        if kind == "flow_year_bare" and allow_bare_year and re.fullmatch(r"20\d{2}年", t):
            return Period(date(y, 12, 31), "flow")
    return None


def find_period_mentions(text: str) -> list[tuple[int, int, Period, str]]:
    """在一段正文里找出所有报告期表述，返回 (start, end, period, 原文)，按位置排序、互不重叠。"""
    found: list[tuple[int, int, Period, str]] = []
    taken = [False] * (len(text) + 1)
    for rx, kind in _PATTERNS[:5]:
        for m in rx.finditer(text):
            if any(taken[m.start():m.end()]):
                continue
            p = parse_period(m.group(0))
            if p is None:
                continue
            found.append((m.start(), m.end(), p, m.group(0)))
            for i in range(m.start(), m.end()):
                taken[i] = True
    return sorted(found)


@dataclass
class PeriodPlan:
    """新旧报告期对应关系。

    mode:
      replace_latest  一期更新：年度期间不变，只把最近一期（如 2025年6月末）换成新一期（2025年9月末）
      roll            年度更新：整体向后滚动，部分期间重叠
      replace_all     跨多年补更：新旧期间无重叠，表格按新报告期重建
    mapping: 旧 Period -> 新 Period（同一 kind）。没有出现在 mapping 里的旧期间保持不变。
    """
    mode: str
    old_points: list[Period]
    new_points: list[Period]
    mapping: dict[Period, Period] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def new_for(self, old: Period) -> Period:
        return self.mapping.get(old, old)

    def to_json(self) -> dict:
        return {
            "mode": self.mode,
            "old": [p.label() for p in self.old_points],
            "new": [p.label() for p in self.new_points],
            "mapping": {f"{k.kind}:{k.end.isoformat()}": f"{v.kind}:{v.end.isoformat()}" for k, v in self.mapping.items()},
            "notes": self.notes,
        }


def report_points(latest: date, years: int) -> list[Period]:
    """最近 N 年及一期：latest 为最近一期末；若 latest 是年末，则为最近 N+1 个年末。"""
    pts = [Period(latest, "point")]
    y = latest.year if latest.month != 12 else latest.year
    start = y - 1 if latest.month != 12 else y - 1
    for i in range(years):
        pts.append(Period(date(start - i, 12, 31), "point"))
    return pts


def plan_periods(old_points: list[Period], new_latest: date, years: int | None = None) -> PeriodPlan:
    """old_points: 历史募集书主要财务表格里出现的时点（降序）；new_latest: 新的最近一期末。"""
    old_sorted = sorted(set(old_points), reverse=True)
    if not old_sorted:
        raise ValueError("PERIOD_OLD_UNKNOWN")
    old_latest = old_sorted[0].end
    old_years = [p.end.year for p in old_sorted if p.end.month == 12 and p.end != old_latest]
    if years is None:
        years = max(2, len(old_years))
    new_points = report_points(new_latest, years)
    plan = PeriodPlan(mode="", old_points=old_sorted, new_points=new_points)
    old_set = {p.end for p in old_sorted}
    new_set = {p.end for p in new_points}
    overlap = old_set & new_set
    if new_latest <= old_latest:
        raise ValueError("PERIOD_NOT_NEWER")
    old_year_ends = sorted(d for d in old_set if d.month == 12 and d != old_latest)
    new_year_ends = sorted(d for d in new_set if d.month == 12 and d != new_latest)
    if old_year_ends == new_year_ends and old_latest.month != 12 and new_latest.month != 12:
        plan.mode = "replace_latest"
        for kind in ("point", "flow"):
            plan.mapping[Period(old_latest, kind)] = Period(new_latest, kind)
    elif overlap:
        plan.mode = "roll"
        olds = sorted(old_set, reverse=True)
        news = sorted(new_set, reverse=True)
        for o, n in zip(olds, news):
            if o != n:
                for kind in ("point", "flow"):
                    plan.mapping[Period(o, kind)] = Period(n, kind)
    else:
        plan.mode = "replace_all"
        olds = sorted(old_set, reverse=True)
        news = sorted(new_set, reverse=True)
        for o, n in zip(olds, news):
            for kind in ("point", "flow"):
                plan.mapping[Period(o, kind)] = Period(n, kind)
        if len(news) != len(olds):
            plan.notes.append(f"期间数量由 {len(olds)} 期变为 {len(news)} 期，表格需要重建列结构")
    return plan
