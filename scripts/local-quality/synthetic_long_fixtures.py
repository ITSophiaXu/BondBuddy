"""Create entirely invented long-form inputs, never read customer samples or product outputs."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from PIL import Image, ImageDraw, ImageFont

CASE = "synthetic-long-2026q3-v1"
ISSUER = "合成澄星测试投资有限公司"
CHAPTERS = ["概览", "风险因素", "发行安排", "募集资金用途", "发行人基本情况", "公司治理", "业务运营",
            "财务资料", "债务结构", "偿债保障", "税项说明", "持有人保护", "信息披露", "备查资料"]
CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四"]
TOPICS = [
    ("文件范围", "期间衔接", "信息来源", "阅读方法", "口径边界", "资料顺序", "定义", "更新记录"),
    ("回款波动", "资金计划", "运营中断", "合同履约", "利率变化", "集中管理", "信息误用", "应对记录"),
    ("发行对象", "发行规模", "期限安排", "计息约定", "支付安排", "登记方式", "交易安排", "执行记录"),
    ("资金分类", "使用计划", "账户管理", "支出凭证", "审批过程", "使用边界", "余额核对", "用途记录"),
    ("主体说明", "设立过程", "业务板块", "组织结构", "经营场所", "人员分工", "资料维护", "变更记录"),
    ("决策程序", "职责分离", "内部控制", "授权管理", "利益冲突", "监督检查", "整改安排", "治理记录"),
    ("服务流程", "项目接收", "需求核实", "履约管理", "质量管理", "结算流程", "档案管理", "运营记录"),
    ("合并范围", "比较期间", "计量单位", "资产结构", "利润结构", "现金流量", "母公司口径", "财务说明"),
    ("债务分类", "期限分布", "融资合同", "担保边界", "借款用途", "偿还顺序", "对账安排", "债务记录"),
    ("资金归集", "支付准备", "备用安排", "权限控制", "异常上报", "核对程序", "现金管理", "保障记录"),
    ("税项范围", "计量期间", "纳税主体", "合同约定", "资料留存", "核对路径", "待确认事项", "税务记录"),
    ("沟通机制", "通知方式", "会议资料", "表决记录", "保护安排", "争议处理", "信息完整", "持有人记录"),
    ("定期资料", "临时事项", "信息核对", "责任分工", "披露时间", "修改记录", "访问权限", "披露档案"),
    ("文件目录", "原件归档", "版本管理", "访问登记", "索引维护", "差异记录", "保存安排", "交接记录"),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def set_font(style, size: float, bold=False):
    style.font.name = "Arial"
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.underline = False
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Microsoft YaHei")


def field(paragraph, code: str, display: str):
    node = OxmlElement("w:fldSimple")
    node.set(qn("w:instr"), code)
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = display
    run.append(text)
    node.append(run)
    paragraph._p.append(node)


def document(title: str):
    doc = Document()
    doc.core_properties.author = "BondBuddy synthetic acceptance fixture"
    doc.core_properties.title = title
    doc.core_properties.subject = "Entirely invented engineering fixture"
    doc.core_properties.created = datetime(2026, 11, 9, tzinfo=timezone.utc)
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21), Cm(29.7)
    section.top_margin, section.bottom_margin = Cm(2.2), Cm(2.1)
    section.left_margin = section.right_margin = Cm(2.2)
    section.header_distance = section.footer_distance = Cm(1.0)
    for name, size, bold in [("Normal", 10.5, False), ("Title", 21, True), ("Subtitle", 12, False), ("Heading 1", 15, True), ("Heading 2", 12, True), ("Caption", 9, False)]:
        set_font(doc.styles[name], size, bold)
    for style in doc.styles:
        for border in style.element.findall(".//" + qn("w:pBdr")):
            border.getparent().remove(border)
    normal = doc.styles["Normal"].paragraph_format
    normal.line_spacing = 1.35
    normal.space_after = Pt(7)
    normal.widow_control = True
    for name in ["Heading 1", "Heading 2"]:
        doc.styles[name].paragraph_format.keep_with_next = True
        doc.styles[name].paragraph_format.space_before = Pt(12)
        doc.styles[name].paragraph_format.space_after = Pt(10)
    header = section.header.paragraphs[0]
    header.text = ISSUER + "  纯合成验收资料"
    set_font(doc.styles["Header"], 8)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.add_run("纯合成数据  第 ")
    field(footer, "PAGE", "1")
    footer.add_run(" 页")
    set_font(doc.styles["Footer"], 8)
    return doc


def title_page(doc, title, cutoff):
    doc.add_paragraph(ISSUER, "Title")
    doc.add_paragraph(title, "Title")
    doc.add_paragraph(f"最新报告期 {cutoff}", "Subtitle")
    doc.add_paragraph("本文件为从零编写的工程验收资料。企业名称、业务安排、财务数据和图片均为虚构，不对应真实企业、客户、证券或交易。")
    doc.add_paragraph("本次资料用于检查长篇文件的章节保留、期间更新、合并与母公司口径、单位换算、表格跨页及修订版本一致性。文件不代表行业审核或专业签认。")
    doc.add_paragraph("原稿市场设为上交所，品种设为普通私募公司债。所有其他发行安排在本合成案例内保持不变；未经新资料提供的事实不得自行补充。")
    doc.add_paragraph(f"合成案例编号 {CASE}")


def bookmark(paragraph, number):
    begin = OxmlElement("w:bookmarkStart")
    begin.set(qn("w:id"), str(number))
    begin.set(qn("w:name"), f"syn_chapter_{number}")
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(number))
    paragraph._p.insert(0, begin)
    paragraph._p.append(end)


def toc(doc):
    doc.add_page_break()
    doc.add_paragraph("目录", "Heading 1")
    doc.add_paragraph("点击下列章节名称可跳转至正文。目录采用内链，页码由页脚显示。")
    for index, name in enumerate(CHAPTERS, 1):
        paragraph = doc.add_paragraph()
        link = OxmlElement("w:hyperlink")
        link.set(qn("w:anchor"), f"syn_chapter_{index}")
        run, text = OxmlElement("w:r"), OxmlElement("w:t")
        text.text = f"第{CN[index-1]}章 {name}"
        run.append(text)
        link.append(run)
        paragraph._p.append(link)


def table(doc, headers, rows, widths=None):
    result = doc.add_table(rows=1, cols=len(headers))
    result.autofit = False
    widths = widths or [8.4] + [4.1] * (len(headers) - 1)
    for cell, label, width in zip(result.rows[0].cells, headers, widths):
        cell.text = label
        cell.width = Cm(width)
    repeat = OxmlElement("w:tblHeader")
    result.rows[0]._tr.get_or_add_trPr().append(repeat)
    for values in rows:
        for cell, value, width in zip(result.add_row().cells, values, widths):
            cell.text = str(value)
            cell.width = Cm(width)
    borders = OxmlElement("w:tblBorders")
    for edge in ["top", "left", "bottom", "right", "insideH", "insideV"]:
        child = OxmlElement("w:" + edge)
        for key, value in [("val", "single"), ("sz", "4"), ("color", "D9D9D9")]:
            child.set(qn("w:" + key), value)
        borders.append(child)
    result._tbl.tblPr.append(borders)
    for index, row in enumerate(result.rows):
        # Allow variable height while preventing a row from being split mid-cell.
        row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
        for column, cell in enumerate(row.cells):
            cell.vertical_alignment = 1
            margins = OxmlElement("w:tcMar")
            for edge in ["top", "bottom", "left", "right"]:
                child = OxmlElement("w:" + edge)
                child.set(qn("w:w"), "70")
                child.set(qn("w:type"), "dxa")
                margins.append(child)
            cell._tc.get_or_add_tcPr().append(margins)
            if index == 0:
                shade = OxmlElement("w:shd")
                shade.set(qn("w:fill"), "DCE6F1")
                cell._tc.get_or_add_tcPr().append(shade)
            for paragraph in cell.paragraphs:
                paragraph.paragraph_format.space_after = Pt(1)
                paragraph.paragraph_format.line_spacing = 1.12
                paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT if column == 0 else WD_ALIGN_PARAGRAPH.RIGHT
                for run in paragraph.runs:
                    run.font.size = Pt(9)
                    run.font.bold = index == 0
    return result


def finances():
    sheets, controls = [], []
    for scope_index, (scope, unit, multiplier) in enumerate([("合并", "元", 1), ("母公司", "万元", 10000)]):
        # Values are arbitrary invented integers, generated without any external input.
        base = 10000000 if scope == "合并" else 3000000
        balance_rows = ["货币资金", "应收账款", "存货", "固定资产", "其他资产", "资产总计", "短期借款", "长期借款", "其他负债", "负债合计", "所有者权益合计"]
        income_rows = ["营业收入", "营业成本", "税金及附加", "期间费用", "利润总额", "所得税费用", "净利润"]
        cash_rows = ["经营活动现金流入小计", "经营活动现金流出小计", "经营活动产生的现金流量净额", "投资活动产生的现金流量净额", "筹资活动产生的现金流量净额", "现金及现金等价物净增加额"]
        for kind, labels, selected in [("资产负债表", balance_rows, ["货币资金", "资产总计", "负债合计"]),
                                      ("利润表", income_rows, ["营业收入", "利润总额", "净利润"]),
                                      ("现金流量表", cash_rows, ["经营活动产生的现金流量净额", "投资活动产生的现金流量净额", "现金及现金等价物净增加额"])]:
            periods = ["2024-12-31", "2025-12-31", "2026-09-30"] if kind == "资产负债表" else ["2024年度", "2025年度", "2025年1至9月", "2026年1至9月"]
            values = []
            for p in range(len(periods)):
                offset = (p + 1) * 123457 + scope_index * 1901
                if kind == "资产负债表":
                    assets = [base + offset + k * 337751 for k in range(5)]
                    assets[0] = base + (p + 1) ** 2 * 123457 + scope_index * 1901
                    liabilities = [base // 2 + offset + k * 79213 for k in range(3)]
                    amounts = [*assets, sum(assets), *liabilities, sum(liabilities), sum(assets) - sum(liabilities)]
                elif kind == "利润表":
                    revenue = base * 2 + offset
                    costs, tax, expenses = base + offset // 3, 312457 + offset // 11, 1765432 + offset // 7
                    profit = revenue - costs - tax - expenses
                    income_tax = profit // 4
                    amounts = [revenue, costs, tax, expenses, profit, income_tax, profit - income_tax]
                else:
                    received, paid = base * 2 + offset * 3, base + offset * 2 + 654321
                    operating, investing = received - paid, -(base // 3 + offset)
                    # 2025 annual and 2026 Q3 net cash movements reconcile to the balance-sheet cash changes.
                    # The prior-Q3 comparative is an independently invented shorter-period movement.
                    net_change = [123457, 370371, 246913, 617285][p]
                    financing = net_change - operating - investing
                    amounts = [received, paid, operating, investing, financing, operating + investing + financing]
                values.append(amounts)
            rows = [{"metric": label, "yuan": [amounts[i] for amounts in values]} for i, label in enumerate(labels)]
            # Repeated record rows exercise multi-page tables without inventing extra financial totals.
            for i in range(1, 47):
                rows.append({"metric": f"合成明细索引 {i:02d}", "yuan": [base // 100 + i * 139 + p * 17 for p in range(len(periods))], "detail_only": True})
            sheet = {"name": scope + kind, "scope": scope, "statement": kind, "unit": unit,
                     "multiplier": multiplier, "periods": periods, "rows": rows}
            sheets.append(sheet)
            for metric in selected:
                row = next(row for row in rows if row["metric"] == metric)
                controls.append({"id": f"{scope}-{kind}-{metric}-current", "scope": scope, "statement": kind,
                                 "metric": metric, "period": "2026-09-30" if kind == "资产负债表" else "2026年1至9月",
                                 "yuan": row["yuan"][-1], "source_sheet": sheet["name"],
                                 "source_cell": f"{chr(66+len(periods)-1)}{6+rows.index(row)}"})
            # Separate old-period controls catch opening-balance and same-period-year swaps.
            metric = selected[0]
            row = next(row for row in rows if row["metric"] == metric)
            comparison = 1 if kind == "资产负债表" else 2
            controls.append({"id": f"{scope}-{kind}-{metric}-comparison", "scope": scope, "statement": kind,
                             "metric": metric, "period": periods[comparison], "yuan": row["yuan"][comparison],
                             "source_sheet": sheet["name"], "source_cell": f"{chr(66+comparison)}{6+rows.index(row)}"})
    return sheets, controls


def display(amount, unit):
    divisor = Decimal(10000) if unit == "万元" else Decimal(1)
    return f"{Decimal(amount)/divisor:,.2f}"


def build(directory: Path):
    directory.mkdir(parents=True, exist_ok=False)
    picture = directory / "synthetic-process.png"
    image = Image.new("RGB", (1000, 230), "white")
    drawing = ImageDraw.Draw(image)
    image_font = ImageFont.load_default(size=32)
    for i, label in enumerate(["SOURCE", "REVIEW", "RECORD"]):
        x = 25 + i * 330
        drawing.rectangle((x, 50, x + 280, 150), outline="#53697f", fill="#e8eef4", width=3)
        drawing.text((x + 65, 83), label, fill="black", font=image_font)
        if i < 2:
            drawing.line((x + 280, 100, x + 327, 100), fill="black", width=3)
    drawing.text((350, 180), "SYNTHETIC ONLY", fill="black", font=image_font)
    image.save(picture)
    sheets, controls = finances()
    source = document("2025年度募集说明书合成验收原稿")
    title_page(source, "2025年度募集说明书合成验收原稿", "2025年12月31日")
    toc(source)
    anchors = []
    for index, name in enumerate(CHAPTERS, 1):
        heading = source.add_paragraph(f"第{CN[index-1]}章 {name}", "Heading 1")
        heading.paragraph_format.page_break_before = True
        bookmark(heading, index)
        if name == "财务资料":
            source.add_paragraph("以下报表均为合成数据，原稿列示2024及2025年度。合成明细索引为独立测试记录，不参与主表科目加总。")
            for table_index, sheet in enumerate(sheets):
                heading = source.add_paragraph(sheet["name"], "Heading 2")
                heading.paragraph_format.page_break_before = bool(table_index)
                source.add_paragraph(f"{sheet['name']} 单位 万元")
                headers = ["项目", "2024年12月31日" if sheet["statement"] == "资产负债表" else "2024年度",
                           "2025年12月31日" if sheet["statement"] == "资产负债表" else "2025年度"]
                table(source, headers, [[row["metric"], display(row["yuan"][0], "万元"), display(row["yuan"][1], "万元")] for row in sheet["rows"]])
            continue
        for page in [1, 2]:
            heading = source.add_paragraph(f"{name}的{'基本安排' if page == 1 else '执行记录'}", "Heading 2")
            heading.paragraph_format.page_break_before = page == 2
            anchor = f"SYN-C{index:02d}-P{page}"
            anchors.append(anchor)
            source.add_paragraph(f"本节资料编号 {anchor}。本节描述虚构企业在合成案例内的处理程序，不构成真实业务陈述。")
            for item, topic in enumerate(TOPICS[index-1][:6], 1):
                action = "核对资料内容与责任分工" if page == 1 else "保存经办过程与差异说明"
                source.add_paragraph(f"关于{topic}，合成公司按照统一台账{action}。经办人员先确定本项事项适用的资料范围，再逐项核对日期、主体和文件版本。"
                                     f"如本次事项存在不同口径，应在{topic}记录中分别列示原因、处理过程和后续核对安排，避免用未确认信息覆盖已有记录。"
                                     f"本项为第{index}章第{page}组第{item}项虚构程序，其对应资料在本章末尾按编号归档。")
            if index == 5 and page == 2:
                source.add_picture(str(picture), width=Cm(12))
                source.add_paragraph("图一 合成资料处理流程", "Caption")
    source_path = directory / "synthetic-2025-prospectus.docx"
    source.save(source_path)
    notes = document("2026年三季度财务附注合成资料")
    title_page(notes, "2026年三季度财务附注合成资料", "2026年9月30日")
    notes.add_page_break()
    notes.add_paragraph("第一章 口径与期间", "Heading 1")
    for text in ["本期财务资料全部为虚构工程数据。合并报表包括合成母公司及两个虚构子主体，母公司报表仅反映母公司自身。",
                 "配套工作簿的合并报表以元列示，母公司报表以万元列示。原稿中的所有报表以万元列示。转换时1万元等于10000元，不得将数值原样挪入不同单位。",
                 "资产负债表的2026年9月30日为期末，2025年12月31日为年初。利润表和现金流量表的2026年1至9月为本期累计，2025年1至9月为上年同期，2025年度为完整年度，三者不能互换。",
                 "本次目标期间为2024及2025年度、2026年1至9月。更新时保留必要的上年同期比较；不得将本期累计数年化为全年。明细索引是独立的合成记录，不属于主表科目分解。",
                 "本合成案例没有新增担保、发行条款或业务事实。2025年原稿中非财务程序继续适用；不确定内容应保留待确认文字，不得编造真实机构、公告编号或批准文件。"]:
        notes.add_paragraph(text)
    notes.add_paragraph("第二章 核对数据", "Heading 1")
    notes.add_paragraph("下表列示供人工和独立脚本核对的虚构关键值，统一折算为元。它们来自本案例的独立数字定义，不属于专业签认。")
    table(notes, ["口径和科目", "期间", "金额 元"], [[c["scope"] + c["metric"], c["period"], display(c["yuan"], "元")] for c in controls], [6.8, 4.7, 5.1])
    notes_path = directory / "synthetic-2026q3-notes.docx"
    notes.save(notes_path)
    result = {"schema": CASE, "synthetic_only": True, "customer_inputs_read": False, "issuer": ISSUER,
              "source_cutoff": "2025-12-31", "target_cutoff": "2026-09-30", "chapters": CHAPTERS,
              "retention_anchors": anchors, "controls": controls, "sheets": sheets,
              "files": [{"role": role, "filename": file.name, "bytes": file.stat().st_size, "sha256": sha(file)}
                        for role, file in [("historical", source_path), ("notes", notes_path)]],
              "image_sha256": sha(picture), "industry_signoff": False, "rendered_visual_review": "pending"}
    (directory / "case.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"directory": str(directory), "controls": len(controls), "chapters": len(CHAPTERS), "files": result["files"]}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    build(parser.parse_args().output_dir.resolve())
