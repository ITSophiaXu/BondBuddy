"""M3 editable report and native comments; preserves the reviewed document text."""
import copy
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

from docx import Document
from lxml import etree
from .writer import W, R, CT, Q, COMMENT_REL, COMMENT_CT, parse_xml, paragraph_map, visible, make_run, write_zip, document_signature
from bondbuddy_no_history_word.writer import _canonicalize_docx

DIMENSIONS = {"financial": "财务核对", "compliance": "合规与格式", "public": "公开信息"}
OUTCOMES = {"pass": "本项通过", "issue": "发现问题", "error": "存在差错", "conflict": "证据冲突", "needs_evidence": "需要补证", "manual": "待人工核对", "uncovered": "未覆盖", "not_applicable": "不适用"}
ANCHOR_REASONS = {
    "no_source_anchor": "未提供可核对的原文位置，需人工确认。",
    "source_anchor_missing": "当前源稿中未找到指定位置，可能存在版本或位置变化，需人工确认。",
    "quote_missing_or_ambiguous": "原文未找到或出现多次，未自动添加批注，需人工确认。",
    "complex_run_boundary": "原文跨越既有修订或复杂格式，未自动添加批注，需人工确认。",
    "anchor_out_of_range": "指定文字范围超出当前段落，未自动添加批注，需人工确认。",
}


def strip_comment_location_prefix(text):
    """Remove only explicit source/reader-position prefixes, never evidence prose."""
    original = text
    text = re.sub(r"\A\s*原文件\s*[：:]\s*[^；;]*?\.(?:docx?|pdf)\s*[；;]\s*", "", text, count=1, flags=re.I)
    position = r"正文位置\s*\d+(?:\s*的表格\s*[·，,]?\s*第\s*\d+\s*行\s*[·，,]?\s*第\s*\d+\s*列)?"
    text = re.sub(r"\A\s*(?:\[\s*" + position + r"\s*\]|" + position + r")\s*(?:[；;]\s*|\n\s*)", "", text, count=1)
    return text if text.strip() else original


def _trim_generated_comment_prefixes(comments):
    # Review copies may contain comments from an earlier BondBuddy draft. Retain
    # IDs, authors, dates, runs and anchors; only trim a known redundant prefix.
    for comment in comments:
        if not re.fullmatch(r"BondBuddy(?:-[a-f0-9]{12})?", comment.get(Q("author"), "")):
            continue
        nodes = list(comment.iter(Q("t")))
        text = "".join(node.text or "" for node in nodes)
        remaining = len(text) - len(strip_comment_location_prefix(text))
        for node in nodes:
            if remaining <= 0:
                break
            value = node.text or ""
            cut = min(remaining, len(value))
            node.text = value[cut:]
            remaining -= cut


def _location(ref):
    location = ref.get("locator", {})
    if location.get("path"):
        labels = {"table": "表格", "row": "行", "column": "列", "paragraph": "段落"}
        parts = [f"{labels[key]} {value + 1}" for item in location["path"] if isinstance(item, dict)
                 for key, value in item.items() if key in labels and isinstance(value, int)]
        if parts:
            return " / ".join(parts)
    if location.get("page") is not None:
        return f"PDF 第 {location['page']} 页" + (f" · 区域 {location['bbox']}" if location.get("bbox") else "")
    if location.get("cell"):
        return f"工作表 {location.get('sheet', '')} · 单元格 {location['cell']}"
    if location.get("row") is not None:
        return f"第 {location['row']} 行 · 第 {location.get('column', '?')} 列"
    stable = str(location.get("stable_ref") or "")
    paragraph = re.fullmatch(r"docx:p(\d+)", stable)
    if paragraph:
        return f"第 {int(paragraph[1])} 段"
    table = re.fullmatch(r"docx:t(\d+):r(\d+):c(\d+):p(\d+)", stable)
    if table:
        return f"表格 {int(table[1])} / 第 {int(table[2])} 行 / 第 {int(table[3])} 列 / 第 {int(table[4])} 段"
    return stable or str(ref.get("record_id") or "位置待核")


def _boundary(paragraph, offset):
    """Return a direct-child boundary, splitting only plain text runs losslessly."""
    position = 0
    for child in list(paragraph):
        if child.tag == Q("pPr"):
            continue
        length = len(visible(child))
        if position == offset:
            return paragraph.index(child)
        if position < offset < position + length:
            if child.tag != Q("r") or any(n.tag not in (Q("rPr"), Q("t")) for n in child):
                raise ValueError("complex_run_boundary")
            text = visible(child)
            left = copy.deepcopy(child)
            right = copy.deepcopy(child)
            for run, part in ((left, text[:offset-position]), (right, text[offset-position:])):
                for n in list(run):
                    if n.tag != Q("rPr"):
                        run.remove(n)
                t = etree.SubElement(run, Q("t"))
                t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
                t.text = part
            at = paragraph.index(child)
            paragraph.remove(child)
            paragraph.insert(at, left)
            paragraph.insert(at + 1, right)
            return at + 1
        position += length
    if position == offset:
        return len(paragraph)
    raise ValueError("anchor_out_of_range")


def _comment_text(finding, *, for_report=False):
    if finding.get("comment_text"):
        return strip_comment_location_prefix(finding["comment_text"])
    lines = [f"{finding['finding_id']} · {finding['severity']} · {finding['title']}", strip_comment_location_prefix(finding["description"])]
    if finding.get("check_status") == "carried_forward":
        lines.append(f"沿用报告 {finding['origin_report_id']} 的发现，本轮未据此认定通过。")
    for ref in finding.get("evidence_refs", []):
        location = f"{ref['material_id']} · 版本 {ref['material_version']} · {_location(ref)}\n" if for_report else ""
        lines.append(f"材料依据：{location}{ref['quote']}")
    for rule in finding.get("rule_refs", []):
        lines.append(f"规则依据：{rule['rule_id']} / {rule['rule_version']} / {rule['locator']}\n{rule['quote']}")
    for source in finding.get("public_sources", []):
        lines.append(f"公开来源：{source['title']}\n{source['url']}\n检索时间：{source['retrieved_at']}；发布日期：{source.get('published_at') or '未取得'}；核对主体：{source['entity']}；核验截至：{source.get('as_of') or '待确认'}\n{source['quote']}")
    lines += ["建议：" + finding.get("suggested_change", "补充证据或人工确认"), "说明：修改、异议或补证不代表复核通过。"]
    return "\n".join(lines)


def annotate(source, destination, report):
    with zipfile.ZipFile(source) as original:
        parts = {info.filename: original.read(info.filename) for info in original.infolist()}
        root = parse_xml(parts["word/document.xml"])
        before = document_signature(root)
        anchors = paragraph_map(root)
        comments = parse_xml(parts["word/comments.xml"]) if "word/comments.xml" in parts else etree.Element(Q("comments"), nsmap={"w": W})
        _trim_generated_comment_prefixes(comments)
        used = [int(n.get(Q("id"))) for n in root.iter() if n.tag in (Q("commentRangeStart"), Q("commentReference")) and (n.get(Q("id")) or "").isdigit()]
        used += [int(n.get(Q("id"))) for n in comments if (n.get(Q("id")) or "").isdigit()]
        next_id = max(used, default=-1) + 1
        placed, unanchored = [], []
        for finding in report["findings"]:
            if not finding["target_refs"]:
                unanchored.append({"finding_id": finding["finding_id"], "reason": "no_source_anchor"})
            for target in finding["target_refs"]:
                para = anchors.get(target["locator"].get("stable_ref"))
                quote = target["quote"]
                if (target["material_id"] != report["source_material"]["material_id"] or
                    target["material_version"] != report["source_material"]["material_version"] or
                    target["material_sha256"] != report["source_material"]["sha256"] or para is None):
                    unanchored.append({"finding_id": finding["finding_id"], "locator": target["locator"], "reason": "source_anchor_missing"})
                    continue
                content = visible(para)
                if not quote or content.count(quote) != 1:
                    unanchored.append({"finding_id": finding["finding_id"], "locator": target["locator"], "reason": "quote_missing_or_ambiguous"})
                    continue
                trial = copy.deepcopy(para)
                start = content.index(quote)
                try:
                    # Split both boundaries first. Existing comments/revisions remain untouched.
                    _boundary(trial, start + len(quote))
                    begin = _boundary(trial, start)
                    end = _boundary(trial, start + len(quote))
                except ValueError as error:
                    unanchored.append({"finding_id": finding["finding_id"], "locator": target["locator"], "reason": str(error)})
                    continue
                marker_start, marker_end = etree.Element(Q("commentRangeStart")), etree.Element(Q("commentRangeEnd"))
                marker_start.set(Q("id"), str(next_id))
                marker_end.set(Q("id"), str(next_id))
                reference = etree.Element(Q("r"))
                etree.SubElement(reference, Q("commentReference")).set(Q("id"), str(next_id))
                trial.insert(end, marker_end)
                trial.insert(end + 1, reference)
                trial.insert(begin, marker_start)
                para[:] = list(trial)
                comment = etree.SubElement(comments, Q("comment"))
                comment.set(Q("id"), str(next_id))
                comment.set(Q("author"), "BondBuddy")
                comment.set(Q("date"), report["created_at"])
                for line in _comment_text(finding).splitlines():
                    etree.SubElement(comment, Q("p")).append(make_run(line))
                placed.append({"finding_id": finding["finding_id"], "comment_id": str(next_id), "locator": target["locator"]})
                next_id += 1
        if document_signature(root) != before:
            raise ValueError("WORD_REVIEW_CHANGED_SOURCE")
        parts["word/document.xml"] = etree.tostring(root, encoding="UTF-8", xml_declaration=True)
        parts["word/comments.xml"] = etree.tostring(comments, encoding="UTF-8", xml_declaration=True)
        rels_name = "word/_rels/document.xml.rels"
        rels = parse_xml(parts[rels_name]) if rels_name in parts else etree.Element(f"{{{R}}}Relationships", nsmap={None: R})
        existing = [n for n in rels if n.get("Type") == COMMENT_REL]
        if existing and any(n.get("Target") not in ("comments.xml", "/word/comments.xml") for n in existing):
            raise ValueError("WORD_REVIEW_COMMENTS_REL_UNSUPPORTED")
        if not existing:
            used_ids, number = {n.get("Id") for n in rels}, 1
            while f"rId{number}" in used_ids:
                number += 1
            etree.SubElement(rels, f"{{{R}}}Relationship", Id=f"rId{number}", Type=COMMENT_REL, Target="comments.xml")
        parts[rels_name] = etree.tostring(rels, encoding="UTF-8", xml_declaration=True)
        types = parse_xml(parts["[Content_Types].xml"])
        if not any(n.get("PartName") == "/word/comments.xml" for n in types):
            etree.SubElement(types, f"{{{CT}}}Override", PartName="/word/comments.xml", ContentType=COMMENT_CT)
        parts["[Content_Types].xml"] = etree.tostring(types, encoding="UTF-8", xml_declaration=True)
        write_zip(destination, original, parts)
    with zipfile.ZipFile(destination) as verify:
        if document_signature(parse_xml(verify.read("word/document.xml"))) != before:
            raise ValueError("WORD_REVIEW_READBACK_CHANGED_SOURCE")
        if len(parse_xml(verify.read("word/comments.xml"))) != len(comments):
            raise ValueError("WORD_REVIEW_COMMENT_COUNT_MISMATCH")
    return placed, unanchored


def write_report(destination, report, unanchored):
    document = Document()
    document.add_heading("募集书复核报告", 0)
    document.add_paragraph(f"报告 {report['report_id']} · 版本 {report['version']}\n完成时间 {report['created_at']}")
    document.add_paragraph("复核结果用于辅助判断；零发现不保证合规。已修改、异议和补证不等于复核通过。")
    document.add_heading("范围与来源", level=1)
    source = report["source_material"]
    mode = "差异复核（仅重核明确选择的问题）" if report["scope"]["mode"] == "differential_review" else "完整复核"
    document.add_paragraph(f"复核范围：{mode}\n源稿：{source['material_id']} · 版本 {source['material_version']}\n锁定输入版本：{report['input_revision']}\n执行编号：{report['run_id']}")
    if report["scope"]["finding_ids"]:
        document.add_paragraph("本轮选择：" + "、".join(report["scope"]["finding_ids"]))
    document.add_paragraph("发现数量：" + "；".join(f"{DIMENSIONS[key]} {sum(f['dimension'] == key for f in report['findings'])} 项" for key in DIMENSIONS))
    document.add_paragraph("严重性分布：" + "；".join(f"{key} {sum(f['severity'] == key for f in report['findings'])} 项" for key in ("P1", "P2", "P3")))
    document.add_heading("实际覆盖", level=1)
    for check in report["coverage"]:
        status = "本轮执行" if check["check_status"] == "rechecked" else "沿用历史，未计为本轮通过"
        document.add_paragraph(f"{DIMENSIONS[check['dimension']]}：{OUTCOMES[check['outcome']]} · {status}\n{check['reason']}\n检查编号：{check['check_id']}\n来源报告：{check['origin_report_id']}")
    for finding in report["findings"]:
        document.add_heading(f"{finding['finding_id']} · {finding['title']}", level=1)
        document.add_paragraph(_comment_text(finding, for_report=True))
        status = "本轮核对" if finding["check_status"] == "rechecked" else "沿用历史"
        document.add_paragraph(f"结论：{OUTCOMES[finding['conclusion']]}；状态：{status}；来源报告：{finding['origin_report_id']}")
        for target in finding["target_refs"]:
            document.add_paragraph(f"原文定位：材料 {target['material_id']} · 版本 {target['material_version']} · {_location(target)}\n{target['quote']}")
        if finding.get("calculation"):
            calculation = finding["calculation"]
            document.add_paragraph(f"计算方式：{calculation['expression']}\n原文数值：{calculation['observed']}；复算数值：{calculation['expected']}；单位：{calculation['unit']}\n舍入口径：{calculation['rounding']}")
        for limitation in finding["limitations"]:
            document.add_paragraph("限制：" + limitation)
    if report["limitations"] or unanchored:
        document.add_heading("未覆盖与定位限制", level=1)
        for limitation in report["limitations"]:
            document.add_paragraph(limitation)
        for item in unanchored:
            reason = str(item.get("reason") or "定位尚未确认，请人工核对。")
            explanation = ANCHOR_REASONS.get(reason, "定位尚未确认，请人工核对。" if re.fullmatch(r"[a-z_]+", reason) else reason)
            identity = f"问题 {item['finding_id']}" if item.get("finding_id") else "定位说明"
            location = f" · {_location(item)}" if item.get("locator") else ""
            document.add_paragraph(f"{identity}{location}\n{explanation}")
    document.save(destination)
    Path(destination).write_bytes(_canonicalize_docx(Path(destination)))
    if not Document(destination).paragraphs:
        raise ValueError("WORD_REVIEW_REPORT_EMPTY")


def main():
    request_path, source_path, report_path, comments_path = sys.argv[1:]
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    report = request["report"]
    placed, unanchored = [], []
    if source_path != "-":
        if hashlib.sha256(Path(source_path).read_bytes()).hexdigest() != report["source_material"]["sha256"]:
            raise ValueError("WORD_REVIEW_SOURCE_HASH_MISMATCH")
        placed, unanchored = annotate(source_path, comments_path, report)
    else:
        unanchored = [{"reason": "PDF 输入保留原页定位，不生成原 Word 批注。"}]
    write_report(report_path, report, unanchored)
    print(json.dumps({"writer_version": "bondbuddy-review-word-1.0.0", "report_sha256": hashlib.sha256(Path(report_path).read_bytes()).hexdigest(),
                      "comments_sha256": hashlib.sha256(Path(comments_path).read_bytes()).hexdigest() if source_path != "-" else None,
                      "placed": placed, "unanchored": unanchored}, ensure_ascii=False))


if __name__ == "__main__":
    main()
