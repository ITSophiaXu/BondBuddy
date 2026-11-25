"""从财务报表 XLSX 读取标准化财务数据（S3，XLSX 路径）。

只读取能确认身份的报表工作表（资产负债表、利润表、现金流量表）。编制单位或报表日期与本次任务
不一致、或无法识别的工作表一律忽略，并记录原因，供「更新说明」列出。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta

import openpyxl

from .items import normalize
from .periods import Period, month_end, parse_period

STATEMENTS = [
    ("balance", re.compile(r"资产负债表|资产表|负债表")),
    ("income", re.compile(r"利润表|损益表")),
    ("cashflow", re.compile(r"现金流量表")),
    ("equity", re.compile(r"所有者权益变动表|股东权益变动表")),
]
UNIT = [(re.compile(r"万元"), 10000.0), (re.compile(r"亿元"), 1e8), (re.compile(r"(?<![万亿])元"), 1.0)]


@dataclass
class Record:
    scope: str          # consolidated | parent
    statement: str      # balance | income | cashflow
    label: str          # 原始行名
    key: str            # 规范化科目名
    period: Period
    value: float        # 单位：元
    source: str         # 文件名!工作表!单元格


@dataclass
class Dataset:
    entity: str = ""
    report_date: date | None = None
    records: list[Record] = field(default_factory=list)
    ignored: list[str] = field(default_factory=list)
    index: dict = field(default_factory=dict)

    def build_index(self):
        from .items import loose
        self.index = {}
        self.loose_keys: dict[tuple[str, str], set[str]] = {}
        for r in self.records:
            k = (r.scope, r.key, r.period)
            self.index.setdefault(k, r)
            self.loose_keys.setdefault((r.scope, loose(r.key)), set()).add(r.key)
        return self

    def resolve(self, scope: str, key: str) -> str | None:
        """把募集书里的行名解析成数据集中的科目名：先精确，再宽松（宽松键必须唯一）。"""
        from .items import loose
        if any(k[0] == scope and k[1] == key for k in self.index):
            return key
        cands = self.loose_keys.get((scope, loose(key)), set())
        return next(iter(cands)) if len(cands) == 1 else None

    def get(self, scope: str, key: str, period: Period) -> Record | None:
        return self.index.get((scope, key, period))

    def periods(self) -> set[Period]:
        return {r.period for r in self.records}

    def merge(self, other: "Dataset"):
        self.records += other.records
        self.ignored += other.ignored
        if other.report_date and (not self.report_date or other.report_date > self.report_date):
            self.report_date = other.report_date
            self.entity = other.entity or self.entity
        return self.build_index()


def _cell_str(v) -> str:
    return "" if v is None else str(v).strip()


def _num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = _cell_str(v).replace(",", "").replace("，", "")
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return float(s)
    if re.fullmatch(r"[（(]-?\d+(\.\d+)?[)）]", s):
        return -float(s[1:-1])
    return None


def _header_period(text: str, report_date: date, statement: str, has_opening: bool = False) -> Period | None:
    t = re.sub(r"\s+", "", text)
    if not t:
        return None
    y, m = report_date.year, report_date.month
    kind = "point" if statement == "balance" else "flow"
    if t in ("期末余额", "期末数", "期末金额", "本期末", "期末账面余额"):
        return Period(report_date, "point")
    if t in ("年初余额", "年初数", "期初余额", "期初数"):
        return Period(date(y - 1, 12, 31), "point")
    if t in ("上年年末余额", "上年末余额", "上年年末数"):
        # 同一张表同时有「年初余额」时，「上年年末余额」指再上一年年末（见任丘建投 2025 年三季报样本）
        return Period(date(y - (2 if has_opening else 1), 12, 31), "point")
    if t in ("本期金额", "本期数", "本期发生额", "本年金额", "本年累计", "本年累计数", "本年数"):
        return Period(report_date, "flow")
    if t in ("上期金额", "上期数", "上期发生额", "上年金额", "上年同期", "上年同期数", "上年数"):
        return Period(month_end(y - 1, m), "flow")
    p = parse_period(t)
    if p is None:
        return None
    if statement == "balance":
        return Period(p.end, "point")
    return Period(p.end, "flow")


def read_xlsx(path: str, expected_entity: str = "") -> Dataset:
    name = path.rsplit("/", 1)[-1]
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ds = Dataset()
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        head_text = " ".join(_cell_str(v) for r in rows[:6] for v in r if v is not None)
        statement = next((k for k, rx in STATEMENTS if rx.search(ws.title) or rx.search(head_text[:200])), None)
        if statement is None or statement == "equity":
            ds.ignored.append(f"{name}!{ws.title}：不是资产负债表、利润表或现金流量表，未使用")
            continue
        scope = "parent" if re.search(r"母公司", ws.title + head_text[:120]) else "consolidated"
        if re.search(r"^(资产表|负债表|利润表|现金流量表)$", ws.title.strip()):
            scope = "parent"  # 有些工作簿以「合并资产表/资产表」区分合并与母公司
        m_ent = re.search(r"编制单位[:：]\s*([^\s]+)", head_text)
        entity = m_ent.group(1) if m_ent else ""
        rd = None
        for v in [c for r in rows[:6] for c in r]:
            if hasattr(v, "year") and hasattr(v, "month"):
                rd = date(v.year, v.month, v.day)
            elif isinstance(v, (int, float)) and 36000 < v < 60000 and float(v).is_integer():
                rd = date(1899, 12, 30) + timedelta(days=int(v))  # Excel 日期序列号
            else:
                p = parse_period(_cell_str(v))
                rd = p.end if p else None
            if rd:
                break
        if rd is None:
            ds.ignored.append(f"{name}!{ws.title}：找不到报表日期，未使用")
            continue
        if expected_entity and entity and expected_entity[:4] not in entity:
            ds.ignored.append(f"{name}!{ws.title}：编制单位为「{entity}」，与发行人不一致，未使用")
            continue
        unit = 1.0
        for rx, mult in UNIT:
            if rx.search(head_text):
                unit = mult
                break
        # 表头行：含「项目」
        hdr_i = next((i for i, r in enumerate(rows[:10]) if any(re.sub(r"\s+", "", _cell_str(v)) in ("项目", "项目名称", "资产", "负债和所有者权益") for v in r)), None)
        if hdr_i is None:
            ds.ignored.append(f"{name}!{ws.title}：找不到表头，未使用")
            continue
        hdr = [_cell_str(v) for v in rows[hdr_i]]
        # 一张表可能左右两栏（资产 | 负债），按「项目」列切成多段
        label_cols = [j for j, h in enumerate(hdr) if re.sub(r"\s+", "", h) in ("项目", "项目名称", "资产", "负债和所有者权益")]
        segments = []
        for si, lc in enumerate(label_cols):
            end = label_cols[si + 1] if si + 1 < len(label_cols) else len(hdr)
            cols = []
            has_opening = any(re.sub(r"\s+", "", h) in ("年初余额", "年初数", "期初余额", "期初数") for h in hdr[lc + 1:end])
            for j in range(lc + 1, end):
                p = _header_period(hdr[j], rd, statement, has_opening)
                if p is not None and p not in [c[1] for c in cols]:
                    cols.append((j, p))
            segments.append((lc, cols))
        used = False
        for lc, cols in segments:
            for i in range(hdr_i + 1, len(rows)):
                r = rows[i]
                label = _cell_str(r[lc] if lc < len(r) else None)
                if not label or len(label) > 60:
                    continue
                key = normalize(label)
                for j, p in cols:
                    v = _num(r[j] if j < len(r) else None)
                    if v is None:
                        continue
                    ds.records.append(Record(scope, statement, label, key, p, v * unit, f"{name}!{ws.title}!R{i + 1}C{j + 1}"))
                    used = True
        if used:
            if not ds.report_date or rd > ds.report_date:
                ds.report_date = rd
                ds.entity = entity or ds.entity
        else:
            ds.ignored.append(f"{name}!{ws.title}：没有读到数值，未使用")
    return ds.build_index()
