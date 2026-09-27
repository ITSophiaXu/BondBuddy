"""Mark an internal test DOCX while preserving its existing OOXML parts."""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

from lxml import etree

from .writer import CT, Q, R, W, add_comments, make_run, paragraph_map, parse_xml, write_zip

MARK = "内部测试工作稿·未经专业审核·不得对外使用"
HEADER_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"
HEADER_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"


def paragraph(text: str):
    node = etree.Element(Q("p"))
    node.append(make_run(text))
    return node


def mark(source: str, manifest: str, target: str) -> None:
    uncovered = json.loads(Path(manifest).read_text(encoding="utf-8"))
    if not isinstance(uncovered, list) or len(uncovered) > 200:
        raise ValueError("TEST_UNCOVERED_ITEMS_INVALID")
    with zipfile.ZipFile(source) as original:
        parts = {name: original.read(name) for name in original.namelist()}
        root = parse_xml(parts["word/document.xml"])
        body = root.find(Q("body"))
        if body is None:
            raise ValueError("WORD_BODY_MISSING")
        existing = paragraph_map(root)
        notes = []
        by_record = {}
        for index, item in enumerate(uncovered):
            if not isinstance(item, dict) or not isinstance(item.get("rule_id"), str) or not isinstance(item.get("reason_code"), str):
                raise ValueError("TEST_UNCOVERED_ITEMS_INVALID")
            ref = item.get("evidence_ref")
            if ref is not None and not isinstance(ref, str):
                raise ValueError("TEST_UNCOVERED_ITEMS_INVALID")
            anchor = existing.get(ref) if ref and ref.startswith("docx:") else None
            if ref and ref.startswith("docx:") and anchor is None:
                raise ValueError("TEST_UNCOVERED_ANCHOR_MISSING")
            if anchor is None:
                anchor = paragraph(f"待人工确认：{item['rule_id']}（{item['reason_code']}）")
                section = body.find(Q("sectPr"))
                body.insert(body.index(section) if section is not None else len(body), anchor)
            key = f"test-uncovered-{index}"
            by_record[key] = anchor
            notes.append({"recordId": key, "message": f"待人工确认：规则 {item['rule_id']}；原因 {item['reason_code']}；证据 {ref or '未提供'}"})
        add_comments(parts, root, notes, by_record)
        body.insert(0, paragraph(MARK))
        rels_name = "word/_rels/document.xml.rels"
        rels = parse_xml(parts[rels_name]) if rels_name in parts else etree.Element(f"{{{R}}}Relationships", nsmap={None: R})
        header_names = [name for name in parts if name.startswith("word/header") and name.endswith(".xml")]
        for name in header_names:
            header = parse_xml(parts[name])
            header.insert(0, paragraph(MARK))
            parts[name] = etree.tostring(header, encoding="UTF-8", xml_declaration=True)
        if not header_names:
            name = "word/headerBondBuddyTest.xml"
            if name in parts:
                raise ValueError("TEST_HEADER_COLLISION")
            header = etree.Element(Q("hdr"), nsmap={"w": W})
            header.append(paragraph(MARK))
            parts[name] = etree.tostring(header, encoding="UTF-8", xml_declaration=True)
            used = {node.get("Id") for node in rels}
            index = 1
            while f"rId{index}" in used:
                index += 1
            relation_id = f"rId{index}"
            etree.SubElement(rels, f"{{{R}}}Relationship", Id=relation_id, Type=HEADER_REL, Target="headerBondBuddyTest.xml")
            for section in root.findall(".//" + Q("sectPr")):
                if not any(ref.get(Q("type")) == "default" for ref in section.findall(Q("headerReference"))):
                    ref = etree.Element(Q("headerReference"))
                    ref.set(Q("type"), "default")
                    ref.set("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", relation_id)
                    section.insert(0, ref)
            if not root.findall(".//" + Q("sectPr")):
                section = etree.SubElement(body, Q("sectPr"))
                ref = etree.SubElement(section, Q("headerReference"))
                ref.set(Q("type"), "default")
                ref.set("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", relation_id)
            types = parse_xml(parts["[Content_Types].xml"])
            etree.SubElement(types, f"{{{CT}}}Override", PartName="/" + name, ContentType=HEADER_CT)
            parts["[Content_Types].xml"] = etree.tostring(types, encoding="UTF-8", xml_declaration=True)
        parts[rels_name] = etree.tostring(rels, encoding="UTF-8", xml_declaration=True)
        parts["word/document.xml"] = etree.tostring(root, encoding="UTF-8", xml_declaration=True)
        write_zip(target, original, parts)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: test_marking.py source manifest target")
    mark(*sys.argv[1:])
