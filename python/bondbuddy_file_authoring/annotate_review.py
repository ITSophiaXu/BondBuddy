"""Attach the saved report's findings to the immutable source, without another model call.

Markdown remains the single finding source used by the page, report and comments.
Comments omit source-location/quotation fields already represented by their anchor.
Only unique exact quotations are anchored; ambiguity is a reported limitation.
"""
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile

from bondbuddy_word_delivery.review import annotate, ANCHOR_REASONS, strip_comment_location_prefix
from bondbuddy_word_delivery.writer import parse_xml, paragraph_map, visible
from bondbuddy_file_authoring.report_from_text import export_report


def plain(text):
    # Remove paired Markdown decoration, never arithmetic operators in evidence.
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    return re.sub(r"`([^`]+)`", r"\1", text).strip()


def findings_from_markdown(markdown):
    headings = list(re.finditer(r"^###\s+(.+)$", markdown, re.M))
    findings, edits = [], []
    for index, heading in enumerate(headings):
        end = re.search(r"^#{1,3}\s+", markdown[heading.end():], re.M)
        body = markdown[heading.end():heading.end() + end.start() if end else len(markdown)].strip()
        identity = f"R{index + 1:03d}"
        title = re.sub(r"^(?:R\d+\s*[·.、:]\s*|\d+[.、]\s*)", "", heading[1])
        comment_lines = []
        targets, location = [], "原文位置待确认"
        field = None
        # Repeated disclosure fields are allowed for one finding at several places.
        for line in body.splitlines():
            match = re.match(r"^\s*(?:[-*]\s+)?(?:\*\*)?([^*：:]{2,12})(?:\*\*)?[：:](?:\*\*)?\s*(.*)$", line)
            if match:
                field, value = match[1].strip(), match[2]
                if field == "原文位置":
                    location = plain(value)
                if field not in ("原文位置", "原文披露", "原文件"):
                    concise = strip_comment_location_prefix(plain(value))
                    comment_lines.append(f"{field}：{concise}" if concise != plain(value) else plain(line))
                elif field == "原文件":
                    original = f"{field}：{plain(value)}"
                    concise = strip_comment_location_prefix(original)
                    if concise != original:
                        comment_lines.append(concise)
            elif field == "原文披露" and line.strip():
                value = re.sub(r"^\s*[-*]\s+", "", line)
            else:
                if field not in ("原文位置", "原文披露", "原文件"):
                    comment_lines.append(strip_comment_location_prefix(plain(line)))
                continue
            if field == "原文披露":
                quote = value.strip().strip('`“”「」"').strip()
                if quote:
                    targets.append({"quote": quote, "location": location})
        content = f"{identity} · {plain(title)}\n" + "\n".join(comment_lines).strip()
        findings.append({"finding_id": identity, "title": title, "comment_text": content.rstrip(), "targets": targets})
        edits.append((heading.start(), heading.end(), f"### {identity} · {title}"))
    for start, end, replacement in reversed(edits):
        markdown = markdown[:start] + replacement + markdown[end:]
    return markdown, findings


def annotate_docx(source, target, findings, pin, created_at):
    with ZipFile(source) as z:
        if sum(i.file_size for i in z.infolist()) > 250_000_000:
            raise ValueError("REVIEW_SOURCE_TOO_LARGE")
        anchors = paragraph_map(parse_xml(z.read("word/document.xml")))
    report = {"source_material": pin, "created_at": created_at, "findings": []}
    missing = []
    for finding in findings:
        refs = []
        if not finding["targets"]:
            missing.append({"finding_id": finding["finding_id"], "location": "未提供原文片段", "reason": "no_source_anchor"})
        for target_ref in finding["targets"]:
            quote = target_ref["quote"]
            matches = [(key, text) for key, node in anchors.items() if (text := visible(node)).count(quote)]
            if len(matches) != 1 or matches[0][1].count(quote) != 1:
                missing.append({"finding_id": finding["finding_id"], **target_ref, "reason": "quote_missing_or_ambiguous"})
                continue
            refs.append({"material_id": pin["material_id"], "material_version": pin["material_version"],
                         "material_sha256": pin["sha256"], "quote": quote, "locator": {"stable_ref": matches[0][0]}})
        if refs:
            report["findings"].append({**finding, "target_refs": refs})
    placed, complex_missing = annotate(source, target, report)
    for item in complex_missing:
        finding = next(f for f in findings if f["finding_id"] == item["finding_id"])
        item["location"] = "；".join(t["location"] + "：" + t["quote"] for t in finding["targets"])
    return placed, missing + complex_missing


def annotate_pdf(source, target, findings):
    import pdfplumber
    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import Highlight
    from pypdf.generic import ArrayObject, FloatObject, NameObject, TextStringObject
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError("REVIEW_ENCRYPTED_PDF_UNSUPPORTED")
    writer = PdfWriter(clone_from=reader)
    placed, missing = [], []
    with pdfplumber.open(source) as document:
        for finding in findings:
            if not finding["targets"]:
                missing.append({"finding_id": finding["finding_id"], "location": "未提供原文片段", "reason": "no_source_anchor"})
            for ref in finding["targets"]:
                matches = []
                # A page locator is a physical one-based page, not a printed page number.
                page_ref = re.search(r"物理第\s*(\d+)\s*页", ref["location"])
                for index, page in enumerate(document.pages):
                    if page_ref and index + 1 != int(page_ref[1]):
                        continue
                    for hit in page.search(ref["quote"], regex=False, case=True) or []:
                        matches.append((index, page, hit))
                if len(matches) != 1:
                    missing.append({"finding_id": finding["finding_id"], **ref, "reason": "pdf_quote_missing_or_ambiguous"})
                    continue
                index, page, hit = matches[0]
                native = reader.pages[index]
                if native.rotation or tuple(native.cropbox) != tuple(native.mediabox):
                    missing.append({"finding_id": finding["finding_id"], **ref, "reason": "pdf_coordinate_unsupported"})
                    continue
                # Group glyphs by visual line so a multiline quote does not highlight unrelated text.
                lines = []
                for char in hit["chars"]:
                    group = next((g for g in lines if abs(g[0]["top"] - char["top"]) < 2), None)
                    if group is None:
                        lines.append([char])
                    else:
                        group.append(char)
                boxes = [(min(c["x0"] for c in line), max(c["x1"] for c in line),
                          float(native.mediabox.top) - min(c["top"] for c in line),
                          float(native.mediabox.top) - max(c["bottom"] for c in line)) for line in lines]
                quads = ArrayObject([FloatObject(v) for x0, x1, top, bottom in boxes for v in (x0, top, x1, top, x0, bottom, x1, bottom)])
                rect = (min(b[0] for b in boxes), min(b[3] for b in boxes), max(b[1] for b in boxes), max(b[2] for b in boxes))
                note = Highlight(rect=rect, quad_points=quads, highlight_color="ffdf66")
                note[NameObject("/Contents")] = TextStringObject(finding["comment_text"])
                note[NameObject("/T")] = TextStringObject("BondBuddy")
                writer.add_annotation(index, note)
                placed.append({"finding_id": finding["finding_id"], "page": index + 1, "quote": ref["quote"]})
    writer.write(target)
    readback = PdfReader(target)
    if len(readback.pages) != len(reader.pages) or any(
        (before.get_contents().get_data() if before.get_contents() else b"") !=
        (after.get_contents().get_data() if after.get_contents() else b"")
        for before, after in zip(reader.pages, readback.pages)
    ):
        raise ValueError("REVIEW_PDF_CHANGED_SOURCE")
    return placed, missing


REASONS = {**ANCHOR_REASONS,
    "pdf_quote_missing_or_ambiguous": "原页未找到唯一可检索的原文片段（可能为扫描页或重复文字），未自动标注。",
    "pdf_coordinate_unsupported": "该 PDF 页带旋转或裁剪，当前无法可靠转换批注坐标，未自动标注。"}


def build(source, text, output, pin, created_at, filename):
    if hashlib.sha256(source.read_bytes()).hexdigest() != pin["sha256"]:
        raise ValueError("INPUT_REVISION_CONFLICT")
    markdown, findings = findings_from_markdown(text)
    target = output / ("comments" + source.suffix)
    if source.suffix == ".docx":
        placed, missing = annotate_docx(source, target, findings, pin, created_at)
    elif source.suffix == ".pdf":
        placed, missing = annotate_pdf(source, target, findings)
    else:
        raise ValueError("REVIEW_SOURCE_FORMAT_UNSUPPORTED")
    summary = ["", "## 原文批注与待确认定位", "",
               f"底稿：{filename} · 上传版本 V{pin['material_version']}。正文未改写。",
               f"本报告识别 {len(findings)} 项问题，已添加 {len(placed)} 处原文批注，{len(missing)} 处无法自动定位。"]
    if not findings:
        summary.append("报告没有提供可识别的问题条目，未自动添加批注；请结合报告核对，不能据此认定没有问题。")
    for item in missing:
        summary.append(f"- {item['finding_id']} · {item.get('location', '原文位置待确认')} · {item.get('quote', '')}：{REASONS.get(item['reason'], '定位受限，请人工核对。')}")
    if source.suffix == ".pdf":
        summary.append("PDF 使用原页高亮批注；扫描文字、重复片段及旋转/裁剪页的定位限制逐项列在上方。批注副本不继承原件数字签名效力。")
    if not missing and findings:
        summary.append("各问题提供的原文片段已标注；缺失披露和未覆盖事项仍以报告说明为准。")
    canonical = markdown.rstrip() + "\n" + "\n".join(summary) + "\n"
    (output / "report.md").write_text(canonical, encoding="utf-8")
    export_report(output / "report.md", output / "report.docx")
    receipt = {"version": "review-source-comments-v1", "source": pin, "placed": placed, "unanchored": missing, "findings": len(findings)}
    (output / "annotations.json").write_text(json.dumps(receipt, ensure_ascii=False), encoding="utf-8")
    return receipt


def main():
    source, request_path, report_path, output = map(Path, sys.argv[1:])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if report_path.suffix == ".docx":
        from docx import Document
        doc = Document(report_path)
        text = "\n".join(("### " if p.style.name == "Heading 3" else "## " if p.style.name == "Heading 2" else "") + p.text for p in doc.paragraphs)
        text += "\n" + "\n".join(" | ".join(c.text for c in row.cells) for t in doc.tables for row in t.rows)
    else:
        text = report_path.read_text(encoding="utf-8-sig")
    build(source, text, output, request["pin"], request["created_at"], request["filename"])


if __name__ == "__main__":
    main()
