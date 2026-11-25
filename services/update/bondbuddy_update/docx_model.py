"""历史募集书 DOCX 结构解析（S2）。

定位方式与 python/bondbuddy_word_delivery/writer.py 的 paragraph_map 完全一致
（docx:p0001、docx:t003:r002:c004:p0001），保证后续生成的编辑计划能被现有 writer 直接执行。
"""
from __future__ import annotations

import hashlib
import io
import re
import zipfile
from dataclasses import dataclass, field

from lxml import etree

from bondbuddy_word_delivery import writer as W

Q = W.Q


@dataclass
class Block:
    ref: str              # writer 定位，如 docx:p0012 或 docx:t003:r002:c004:p0001
    text: str
    kind: str             # "para" | "cell"
    order: int            # 文档顺序
    simple: bool          # 段落只含 pPr/r 且 run 只含文字，可被 writer 直接修改
    prefix: int = 0       # writer.visible() 会把 pPr 里的制表位定义计成 "\t"；这部分不在 run 里，编辑偏移要跳过


@dataclass
class Cell:
    row: int              # 1 起
    col: int              # 1 起，按物理网格列号（含 gridBefore/gridSpan）
    span: int
    refs: list[str]       # 单元格内非空段落的定位
    text: str


@dataclass
class Table:
    index: int            # 顶层表格序号（1 起）
    order: int            # 在文档中的位置（与 Block.order 同一序列）
    rows: list[list[Cell]]
    caption: str = ""     # 表前最近的「表x-x」标题
    unit_text: str = ""   # 表前的「单位：万元」
    context: list[str] = field(default_factory=list)  # 表前 3 段非空正文
    chapter: str = ""

    def cell_at(self, row: int, col: int) -> Cell | None:
        for c in self.rows[row - 1]:
            if c.col == col:
                return c
        return None

    @property
    def ncols(self) -> int:
        return max((c.col + c.span - 1 for r in self.rows for c in r), default=0)


@dataclass
class Prospectus:
    source_bytes: bytes
    sha256: str
    blocks: list[Block]
    tables: list[Table]
    by_ref: dict[str, Block]


_SIMPLE_RUN_CHILDREN = {Q("rPr"), Q("t"), Q("tab"), Q("br"), Q("cr")}
# 编辑前可以安全移除或挪到段尾的节点：它们不影响可见文字
_SAFE_DROP = {Q("lastRenderedPageBreak"), Q("proofErr")}
_EDGE_KEEP = {Q("bookmarkStart"), Q("bookmarkEnd")}


def _ppr_prefix(p) -> int:
    ppr = p.find(Q("pPr"))
    return len(W.visible(ppr)) if ppr is not None else 0


def _is_simple(p) -> bool:
    for child in p:
        if child.tag not in (Q("pPr"), Q("r")):
            return False
        if child.tag == Q("r") and any(c.tag not in _SIMPLE_RUN_CHILDREN for c in child):
            return False
    return True


def prepare_source(raw: bytes) -> bytes:
    """生成「可编辑基线」：去掉不影响显示的 lastRenderedPageBreak/proofErr，把段落中间的书签挪到段首/段尾。

    这样大多数含目录书签的标题段落也能被 writer 修改。可见文字和版式不变。
    """
    zin = zipfile.ZipFile(io.BytesIO(raw))
    root = W.parse_xml(zin.read("word/document.xml"))
    for node in list(root.iter(*_SAFE_DROP)):
        node.getparent().remove(node)
    for p in list(root.iter(Q("p"))):
        kids = list(p)
        if not any(k.tag in _EDGE_KEEP for k in kids):
            continue
        if any(k.tag not in (Q("pPr"), Q("r"), Q("bookmarkStart"), Q("bookmarkEnd")) for k in kids):
            continue  # 含超链接/域等复杂结构的段落不动，后续编辑会被 writer 拒绝并转人工
        parent = p.getparent()
        if parent is None or parent.tag not in (Q("body"), Q("tc")):
            continue
        # 书签在 OOXML 中允许作为 body/tc 的直接子节点：挪到段落前后，段落本身变成可编辑的简单段落
        at = parent.index(p)
        for k in [k for k in kids if k.tag == Q("bookmarkStart")]:
            p.remove(k)
            parent.insert(at, k)
            at += 1
        at = parent.index(p) + 1
        for k in [k for k in kids if k.tag == Q("bookmarkEnd")]:
            p.remove(k)
            parent.insert(at, k)
            at += 1
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == "word/document.xml":
                data = etree.tostring(root, encoding="UTF-8", xml_declaration=True, standalone=True)
            zout.writestr(info, data)
    return out.getvalue()


def _writer_safe_bookmarks(p) -> bool:
    """书签已挪到边缘的段落：writer 仍会拒绝，因此视为不可直接编辑，除非书签不存在。"""
    return _is_simple(p)


_CAPTION = re.compile(r"^表\s*[0-9一二三四五六七八九十]+[-－—.．]\s*\d+")
_UNIT = re.compile(r"单位[:：]")
_CHAPTER = re.compile(r"^第[一二三四五六七八九十百]+[章节]")


def load(raw: bytes) -> Prospectus:
    root = W.parse_xml(zipfile.ZipFile(io.BytesIO(raw)).read("word/document.xml"))
    W.normalize_old_revisions(root)
    body = root.find(Q("body"))
    blocks: list[Block] = []
    tables: list[Table] = []
    order = 0
    recent: list[str] = []
    chapter = ""
    p_no = t_no = 0
    for child in body:
        if child.tag == Q("p"):
            p_no += 1
            text = W.visible(child)
            if text.strip():
                order += 1
                ref = f"docx:p{p_no:04d}"
                blocks.append(Block(ref, text, "para", order, _is_simple(child), _ppr_prefix(child)))
                s = text.strip()
                if _CHAPTER.match(s) and len(s) < 40:
                    chapter = re.sub(r"\s+", "", s)
                recent.append(s)
                recent = recent[-4:]
        elif child.tag == Q("tbl"):
            t_no += 1
            order += 1
            rows: list[list[Cell]] = []
            for r_no, tr in enumerate(child.findall(Q("tr")), 1):
                before = tr.find(Q("trPr") + "/" + Q("gridBefore"))
                col = int(before.get(Q("val"))) + 1 if before is not None else 1
                cells: list[Cell] = []
                for tc in tr.findall(Q("tc")):
                    span_el = tc.find(Q("tcPr") + "/" + Q("gridSpan"))
                    span = int(span_el.get(Q("val"))) if span_el is not None else 1
                    merge = tc.find(Q("tcPr") + "/" + Q("vMerge"))
                    if merge is None or merge.get(Q("val")) == "restart":
                        refs, texts = [], []
                        cp = 0
                        for cc in tc:
                            if cc.tag == Q("p"):
                                cp += 1
                                t = W.visible(cc)
                                if t.strip():
                                    ref = f"docx:t{t_no:03d}:r{r_no:03d}:c{col:03d}:p{cp:04d}"
                                    refs.append(ref)
                                    texts.append(t)
                                    blocks.append(Block(ref, t, "cell", order, _is_simple(cc), _ppr_prefix(cc)))
                            elif cc.tag == Q("tbl"):
                                pass  # 嵌套表格：writer 用更长的前缀定位，这里不编辑，只保证计数一致
                        cells.append(Cell(r_no, col, span, refs, "\n".join(texts).strip()))
                    col += span
                rows.append(cells)
            caption = next((s for s in reversed(recent) if _CAPTION.match(s)), "")
            unit = next((s for s in reversed(recent) if _UNIT.search(s) and len(s) < 40), "")
            tables.append(Table(t_no, order, rows, caption, unit, list(recent[-3:]), chapter))
            recent = []
    # writer 还会给嵌套表格里的段落编号；为保证 textPreview 数量一致，补全这些块
    mapped = W.paragraph_map(root)
    have = {b.ref for b in blocks}
    for ref, p in mapped.items():
        if ref not in have:
            blocks.append(Block(ref, W.visible(p), "cell", 10 ** 9, False))
    by_ref = {b.ref: b for b in blocks}
    if set(by_ref) != set(mapped):
        raise ValueError("DOCX_REF_MISMATCH")
    return Prospectus(raw, hashlib.sha256(raw).hexdigest(), blocks, tables, by_ref)
