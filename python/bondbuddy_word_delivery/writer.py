"""Build a tracked DOCX and an accepted clean copy from locked, literal edits.

The source ZIP is never changed. This writer deliberately refuses unsupported inline
objects and merged tables instead of moving comments or losing Word structures.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path
from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
Q = lambda name: f"{{{W}}}{name}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
AUTHOR = "BondBuddy"
WRITER_VERSION = "bondbuddy-word-delivery-1.0.0"
COMMENT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
COMMENT_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"
MAX_SOURCE_PARTS = 2048
MAX_SOURCE_PART = 32 * 1024 * 1024
MAX_SOURCE_EXPANDED = 128 * 1024 * 1024
XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)


def parse_xml(data):
    return etree.fromstring(data, parser=XML_PARSER)


def fail(code: str):
    raise ValueError(code)


def visible(node):
    out = []
    for child in node.iter():
        if child.tag == Q("t"):
            out.append(child.text or "")
        elif child.tag == Q("tab"):
            out.append("\t")
        elif child.tag in (Q("br"), Q("cr")):
            out.append("\n")
    return "".join(out)


def normalize_old_revisions(root):
    unsupported = {Q(x) for x in ("cellIns", "cellDel", "cellMerge", "numberingChange", "pPrChange", "rPrChange", "tblPrChange", "trPrChange", "tcPrChange", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd")}
    if any(node.tag in unsupported for node in root.iter()):
        fail("WORD_BASELINE_REVISION_UNSUPPORTED")
    if any(node.tag in (Q("ins"), Q("del"), Q("moveFrom"), Q("moveTo")) and node.getparent() is not None and
           node.getparent().tag in (Q("trPr"), Q("tcPr"), Q("pPr"), Q("rPr"), Q("tblPr")) for node in root.iter()):
        fail("WORD_BASELINE_REVISION_UNSUPPORTED")
    for node in list(root.iter()):
        if node.tag in (Q("del"), Q("moveFrom")) and node.getparent() is not None:
            node.getparent().remove(node)
        elif node.tag in (Q("ins"), Q("moveTo")) and node.getparent() is not None:
            parent = node.getparent()
            at = parent.index(node)
            for child in list(node):
                node.remove(child)
                parent.insert(at, child)
                at += 1
            parent.remove(node)


def paragraph_map(root):
    result = {}

    def walk(container, prefix=()):
        paragraph = table = 0
        for child in container:
            if child.tag == Q("p"):
                paragraph += 1
                if visible(child).strip():
                    locator = "docx:" + ":".join((*prefix, f"p{paragraph:04d}"))
                    result[locator] = child
            elif child.tag == Q("tbl"):
                table += 1
                for row_no, row in enumerate(child.findall(Q("tr")), 1):
                    before = row.find(Q("trPr") + "/" + Q("gridBefore"))
                    column = int(before.get(Q("val"))) + 1 if before is not None else 1
                    for cell in row.findall(Q("tc")):
                        span = cell.find(Q("tcPr") + "/" + Q("gridSpan"))
                        width = int(span.get(Q("val"))) if span is not None else 1
                        merge = cell.find(Q("tcPr") + "/" + Q("vMerge"))
                        if merge is None or merge.get(Q("val")) == "restart":
                            walk(cell, (*prefix, f"t{table:03d}", f"r{row_no:03d}", f"c{column:03d}"))
                        column += width
    body = root.find(Q("body"))
    if body is None:
        fail("WORD_BODY_MISSING")
    walk(body)
    return result


def stable_ref(locator):
    path = locator.get("path")
    if not isinstance(path, list):
        fail("WORD_ANCHOR_INVALID")
    parts = []
    for entry in path:
        if "table" in entry:
            parts += [f"t{entry['table']:03d}", f"r{entry['row']:03d}", f"c{entry['column']:03d}"]
        else:
            parts.append(f"p{entry['paragraph']:04d}")
    ref = "docx:" + ":".join(parts)
    if locator.get("stable_ref") != ref:
        fail("WORD_ANCHOR_INVALID")
    return ref


def utf16_index(text, offset):
    if not isinstance(offset, int) or offset < 0:
        fail("WORD_OFFSET_INVALID")
    units = 0
    for index, char in enumerate(text):
        if units == offset:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
        if units > offset:
            fail("WORD_OFFSET_SPLITS_CHARACTER")
    if units == offset:
        return len(text)
    fail("WORD_OFFSET_INVALID")


def make_run(text, style=None, deleted=False):
    run = etree.Element(Q("r"))
    if style is not None:
        run.append(copy.deepcopy(style))
    if text:
        node = etree.SubElement(run, Q("delText" if deleted else "t"))
        node.set(XML_SPACE, "preserve")
        node.text = text
    return run


def apply_replacements(paragraph, changes, tracked, next_id, stamp):
    children = list(paragraph)
    if any(child.tag not in (Q("pPr"), Q("r")) for child in children):
        fail("WORD_EDITED_PARAGRAPH_COMPLEX")
    pieces = []
    for run in paragraph.findall(Q("r")):
        style = run.find(Q("rPr"))
        for child in run:
            if child.tag == Q("rPr"):
                continue
            if child.tag == Q("t"):
                pieces.append((child.text or "", style))
            elif child.tag == Q("tab"):
                pieces.append(("\t", style))
            elif child.tag in (Q("br"), Q("cr")):
                pieces.append(("\n", style))
            else:
                fail("WORD_EDITED_RUN_COMPLEX")
    source = "".join(piece[0] for piece in pieces)
    rendered = []

    def emit_span(start, end, deleted=False):
        pos = 0
        for value, style in pieces:
            stop = pos + len(value)
            overlap_start, overlap_end = max(start, pos), min(end, stop)
            if overlap_start < overlap_end:
                part = value[overlap_start - pos:overlap_end - pos]
                if "\t" in part or "\n" in part:
                    if deleted:
                        fail("WORD_EDIT_WITH_CONTROL_CHARACTER")
                    for char in part:
                        if char in "\t\n":
                            run = make_run("", style)
                            etree.SubElement(run, Q("tab" if char == "\t" else "br"))
                            rendered.append(run)
                        else:
                            rendered.append(make_run(char, style))
                elif part:
                    rendered.append(make_run(part, style, deleted))
            pos = stop

    def style_at(index):
        pos = 0
        previous = None
        for value, style in pieces:
            stop = pos + len(value)
            if pos <= index < stop:
                return style
            if stop <= index and value:
                previous = style
            pos = stop
        return previous

    current = 0
    for change in sorted(changes, key=lambda item: item["start"]):
        start, end = utf16_index(source, change["start"]), utf16_index(source, change["end"])
        if start < current or end < start or source[start:end] != change["before"]:
            fail("WORD_EDIT_ANCHOR_MISMATCH")
        if not change["before"] and not change["after"]:
            fail("WORD_EMPTY_EDIT")
        emit_span(current, start)
        old_start = len(rendered)
        emit_span(start, end, tracked)
        if not tracked:
            del rendered[old_start:]
        elif len(rendered) > old_start:
            wrapper = etree.Element(Q("del"))
            wrapper.set(Q("id"), str(next_id()))
            wrapper.set(Q("author"), AUTHOR)
            wrapper.set(Q("date"), stamp)
            for child in rendered[old_start:]:
                wrapper.append(child)
            rendered[old_start:] = [wrapper]
        if change["after"]:
            style = style_at(start)
            inserted = make_run(change["after"], style)
            if tracked:
                wrapper = etree.Element(Q("ins"))
                wrapper.set(Q("id"), str(next_id()))
                wrapper.set(Q("author"), AUTHOR)
                wrapper.set(Q("date"), stamp)
                wrapper.append(inserted)
                rendered.append(wrapper)
            else:
                rendered.append(inserted)
        current = end
    emit_span(current, len(source))
    for child in children:
        if child.tag != Q("pPr"):
            paragraph.remove(child)
    for child in rendered:
        paragraph.append(child)


def insert_columns(root, columns, tracked, next_id, stamp):
    tables = root.find(Q("body")).findall(Q("tbl"))
    for change in sorted(columns, key=lambda c: (c["table"], c["afterColumn"]), reverse=True):
        index = change["table"] - 1
        if index < 0 or index >= len(tables):
            fail("WORD_TABLE_ANCHOR_MISSING")
        table = tables[index]
        grid = table.find(Q("tblGrid"))
        rows = table.findall(Q("tr"))
        cells = sorted(change["cells"], key=lambda c: c["row"])
        after = change["afterColumn"]
        if grid is None or len(cells) != len(rows) or [c["row"] for c in cells] != list(range(1, len(rows) + 1)):
            fail("WORD_TABLE_GRID_UNSUPPORTED")
        grid_columns = grid.findall(Q("gridCol"))
        if after < 1 or after > len(grid_columns):
            fail("WORD_TABLE_GRID_UNSUPPORTED")
        for row_no, (row, planned) in enumerate(zip(rows, cells), 1):
            physical = row.findall(Q("tc"))
            if len(physical) != len(grid_columns) or after > len(physical):
                fail("WORD_TABLE_GRID_UNSUPPORTED")
            if any(tc.find(".//" + Q("gridSpan")) is not None or tc.find(".//" + Q("vMerge")) is not None for tc in physical):
                fail("WORD_TABLE_GRID_UNSUPPORTED")
            anchor = physical[after - 1]
            if not planned["anchorRecordId"] or planned["before"] != "":
                fail("WORD_TABLE_ANCHOR_MISMATCH")
            cell = etree.Element(Q("tc"))
            old_properties = anchor.find(Q("tcPr"))
            properties = copy.deepcopy(old_properties) if old_properties is not None else etree.Element(Q("tcPr"))
            if tracked:
                marker = etree.SubElement(properties, Q("cellIns"))
                marker.set(Q("id"), str(next_id()))
                marker.set(Q("author"), AUTHOR)
                marker.set(Q("date"), stamp)
            cell.append(properties)
            paragraph = etree.SubElement(cell, Q("p"))
            run = make_run(planned["after"])
            if tracked:
                wrapper = etree.SubElement(paragraph, Q("ins"))
                wrapper.set(Q("id"), str(next_id()))
                wrapper.set(Q("author"), AUTHOR)
                wrapper.set(Q("date"), stamp)
                wrapper.append(run)
            else:
                paragraph.append(run)
            row.insert(row.index(anchor) + 1, cell)
        grid.insert(grid.index(grid_columns[after - 1]) + 1, copy.deepcopy(grid_columns[after - 1]))


def add_comments(parts, root, notes, by_record, tracked=False, next_id=None, stamp=None):
    if not notes:
        return
    existing = parts.get("word/comments.xml")
    comments = parse_xml(existing) if existing else etree.Element(Q("comments"), nsmap={"w": W})
    current = [int(node.get(Q("id"))) for node in comments.findall(Q("comment")) if (node.get(Q("id")) or "").isdigit()]
    new_id = max(current, default=-1) + 1
    for note in notes:
        paragraph = by_record.get(note["recordId"])
        if paragraph is None or not isinstance(note.get("message"), str) or not note["message"].strip():
            fail("WORD_REVIEW_NOTE_ANCHOR_MISSING")
        marker_start = etree.Element(Q("commentRangeStart"))
        marker_end = etree.Element(Q("commentRangeEnd"))
        reference = etree.Element(Q("r"))
        etree.SubElement(reference, Q("commentReference")).set(Q("id"), str(new_id))
        marker_start.set(Q("id"), str(new_id))
        marker_end.set(Q("id"), str(new_id))
        paragraph.append(marker_start)
        marker = make_run('【待人工确认】')
        if tracked:
            if next_id is None or stamp is None:
                fail("WORD_COMMENT_REVISION_METADATA_MISSING")
            insertion = etree.SubElement(paragraph, Q("ins"))
            insertion.set(Q("id"), str(next_id()))
            insertion.set(Q("author"), AUTHOR)
            insertion.set(Q("date"), stamp)
            insertion.append(marker)
        else:
            paragraph.append(marker)
        paragraph.append(marker_end)
        paragraph.append(reference)
        comment = etree.SubElement(comments, Q("comment"))
        comment.set(Q("id"), str(new_id))
        comment.set(Q("author"), AUTHOR)
        p = etree.SubElement(comment, Q("p"))
        etree.SubElement(etree.SubElement(p, Q("r")), Q("t")).text = note["message"]
        new_id += 1
    parts["word/comments.xml"] = etree.tostring(comments, encoding="UTF-8", xml_declaration=True)
    rels_name = "word/_rels/document.xml.rels"
    rels = parse_xml(parts[rels_name]) if rels_name in parts else etree.Element(f"{{{R}}}Relationships", nsmap={None: R})
    if not any(item.get("Type") == COMMENT_REL for item in rels):
        used = {item.get("Id") for item in rels}
        index = 1
        while f"rId{index}" in used:
            index += 1
        etree.SubElement(rels, f"{{{R}}}Relationship", Id=f"rId{index}", Type=COMMENT_REL, Target="comments.xml")
    parts[rels_name] = etree.tostring(rels, encoding="UTF-8", xml_declaration=True)
    types = parse_xml(parts["[Content_Types].xml"])
    if not any(item.get("PartName") == "/word/comments.xml" for item in types):
        etree.SubElement(types, f"{{{CT}}}Override", PartName="/word/comments.xml", ContentType=COMMENT_CT)
    parts["[Content_Types].xml"] = etree.tostring(types, encoding="UTF-8", xml_declaration=True)


def write_zip(path, original, parts):
    with zipfile.ZipFile(path, "w") as target:
        for info in original.infolist():
            target.writestr(copy.copy(info), parts.pop(info.filename))
        for name, data in parts.items():
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(info, data)


def document_signature(root):
    """Semantic paragraph and physical table shape used for local accept/reject checks."""
    body = root.find(Q("body"))
    paragraphs = [visible(p) for p in body.iter(Q("p"))]
    tables = []
    for table in body.iter(Q("tbl")):
        grid = table.find(Q("tblGrid"))
        tables.append((len(grid.findall(Q("gridCol"))) if grid is not None else -1,
                       tuple(tuple(visible(tc) for tc in row.findall(Q("tc"))) for row in table.findall(Q("tr")))))
    return paragraphs, tables


def accept_own_revisions(root):
    for node in list(root.iter()):
        if node.tag in (Q("del"), Q("cellIns")) and node.getparent() is not None:
            node.getparent().remove(node)
        elif node.tag == Q("ins") and node.getparent() is not None:
            parent, index = node.getparent(), node.getparent().index(node)
            for child in list(node):
                node.remove(child)
                parent.insert(index, child)
                index += 1
            parent.remove(node)


def reject_own_revisions(root, columns):
    for node in list(root.iter()):
        if node.tag == Q("ins") and node.getparent() is not None:
            node.getparent().remove(node)
        elif node.tag == Q("del") and node.getparent() is not None:
            parent, index = node.getparent(), node.getparent().index(node)
            for child in list(node):
                node.remove(child)
                for text in child.iter(Q("delText")):
                    text.tag = Q("t")
                parent.insert(index, child)
                index += 1
            parent.remove(node)
    for column in sorted(columns, key=lambda c: (c["table"], c["afterColumn"]), reverse=True):
        table = root.find(Q("body")).findall(Q("tbl"))[column["table"] - 1]
        grid = table.find(Q("tblGrid"))
        grid.remove(grid.findall(Q("gridCol"))[column["afterColumn"]])
        for row in table.findall(Q("tr")):
            inserted = [tc for tc in row.findall(Q("tc")) if tc.find(".//" + Q("cellIns")) is not None]
            if len(inserted) != 1:
                fail("WORD_REJECT_COLUMN_MISMATCH")
            row.remove(inserted[0])


def build(source_path, plan, revision_path, clean_path, baseline_path=None):
    source = Path(source_path).read_bytes()
    if hashlib.sha256(source).hexdigest() != plan["source"]["contentHash"]:
        fail("WORD_SOURCE_HASH_MISMATCH")
    if plan["source"]["format"] != "docx_effective" or plan["deliverable"] is not False:
        fail("WORD_PLAN_NOT_SUPPORTED")
    with zipfile.ZipFile(source_path) as original:
        infos = original.infolist()
        if len(infos) > MAX_SOURCE_PARTS or any(info.file_size > MAX_SOURCE_PART or info.file_size < 0 for info in infos) or \
           sum(info.file_size for info in infos) > MAX_SOURCE_EXPANDED:
            fail("WORD_SOURCE_SIZE_LIMIT")
        if len(set(original.namelist())) != len(original.namelist()):
            fail("WORD_DUPLICATE_ZIP_ENTRY")
        base_parts = {name: original.read(name) for name in original.namelist()}
        document = parse_xml(base_parts["word/document.xml"])
        revised_names = [name for name in base_parts if name.startswith("word/") and name.endswith(".xml") and
                         (name == "word/document.xml" or name.startswith(("word/header", "word/footer", "word/footnotes", "word/endnotes")))]
        def comment_references():
            return Counter((name, node.tag, node.get(Q("id"))) for name in revised_names
                           for node in parse_xml(base_parts[name]).iter()
                           if node.tag in (Q("commentReference"), Q("commentRangeStart"), Q("commentRangeEnd")))
        original_comments = comment_references()
        for name in revised_names:
            root = parse_xml(base_parts[name])
            normalize_old_revisions(root)
            base_parts[name] = etree.tostring(root, encoding="UTF-8", xml_declaration=True)
            if name == "word/document.xml":
                document = root
        if original_comments != comment_references():
            fail("WORD_EXISTING_COMMENT_ANCHOR_LOST")
        if "word/settings.xml" in base_parts:
            settings = parse_xml(base_parts["word/settings.xml"])
            for marker in settings.findall(Q("trackRevisions")):
                settings.remove(marker)
            base_parts["word/settings.xml"] = etree.tostring(settings, encoding="UTF-8", xml_declaration=True)
        positions = paragraph_map(document)
        previews = plan["textPreview"]
        if len(previews) != len(positions):
            fail("WORD_BASELINE_BLOCK_COUNT_MISMATCH")
        by_record = {}
        for preview in previews:
            ref = stable_ref(preview["locator"])
            paragraph = positions.get(ref)
            if paragraph is None or visible(paragraph) != preview["before"] or preview["recordId"] in by_record:
                fail("WORD_BASELINE_TEXT_MISMATCH")
            by_record[preview["recordId"]] = paragraph
        if len(by_record) != len(positions):
            fail("WORD_BASELINE_BLOCK_COUNT_MISMATCH")
        baseline_signature = document_signature(document)
        if baseline_path is not None:
            write_zip(baseline_path, original, dict(base_parts))
        for change in plan["replacements"]:
            preview = next((p for p in previews if p["recordId"] == change["recordId"]), None)
            if preview is None or stable_ref(change["locator"]) != stable_ref(preview["locator"]):
                fail("WORD_EDIT_ANCHOR_MISMATCH")
        for column in plan["columns"]:
            if column.get("requiresPhysicalGridValidation") is not True:
                fail("WORD_TABLE_GRID_UNSUPPORTED")
            for cell in column["cells"]:
                preview = next((p for p in previews if p["recordId"] == cell["anchorRecordId"]), None)
                if preview is None:
                    fail("WORD_TABLE_ANCHOR_MISMATCH")
                path = preview["locator"].get("path", [])
                if not path or path[0].get("table") != column["table"] or path[0].get("row") != cell["row"] or path[0].get("column") != column["afterColumn"]:
                    fail("WORD_TABLE_ANCHOR_MISMATCH")
        edits = {}
        for change in plan["replacements"]:
            edits.setdefault(change["recordId"], []).append(change)
        notes = plan.get("reviewNotes", [])
        generated_roots = {}
        for tracked, output in ((True, revision_path), (False, clean_path)):
            parts = dict(base_parts)
            root = parse_xml(base_parts["word/document.xml"])
            mapped = paragraph_map(root)
            rows = {p["recordId"]: mapped[stable_ref(p["locator"])] for p in previews}
            counter = max([int(item.get(Q("id"))) for item in root.iter() if item.tag in (Q("ins"), Q("del"), Q("moveTo"), Q("moveFrom")) and (item.get(Q("id")) or "").isdigit()], default=0) + 1

            def next_id():
                nonlocal counter
                value = counter
                counter += 1
                return value

            stamp = plan.get("_delivery_date")
            if not isinstance(stamp, str) or not stamp.endswith("Z"):
                fail("WORD_DELIVERY_DATE_MISSING")
            for record_id, changes in edits.items():
                apply_replacements(rows[record_id], changes, tracked, next_id, stamp)
            for preview in previews:
                if visible(rows[preview["recordId"]]) != preview["after"]:
                    fail("WORD_CLEAN_PREVIEW_MISMATCH")
            insert_columns(root, plan["columns"], tracked, next_id, stamp)
            add_comments(parts, root, notes, rows, tracked, next_id, stamp)
            parts["word/document.xml"] = etree.tostring(root, encoding="UTF-8", xml_declaration=True)
            if tracked:
                settings = parse_xml(parts.get("word/settings.xml", f'<w:settings xmlns:w="{W}"/>'.encode()))
                if settings.find(Q("trackRevisions")) is None:
                    settings.append(etree.Element(Q("trackRevisions")))
                parts["word/settings.xml"] = etree.tostring(settings, encoding="UTF-8", xml_declaration=True)
            write_zip(output, original, parts)
            generated_roots[tracked] = root
        accepted = copy.deepcopy(generated_roots[True])
        accept_own_revisions(accepted)
        if document_signature(accepted) != document_signature(generated_roots[False]):
            fail("WORD_ACCEPT_CLEAN_MISMATCH")
        rejected = copy.deepcopy(generated_roots[True])
        reject_own_revisions(rejected, plan["columns"])
        if document_signature(rejected) != baseline_signature:
            fail("WORD_REJECT_BASELINE_MISMATCH")
    return {"writer_version": WRITER_VERSION, "source_sha256": hashlib.sha256(source).hexdigest(), "baseline_hash": plan["baselineHash"],
            "plan_hash": plan["planHash"], "replacements": len(plan["replacements"]), "columns": len(plan["columns"]),
            "pending": len(notes), "revision_sha256": hashlib.sha256(Path(revision_path).read_bytes()).hexdigest(),
            "clean_sha256": hashlib.sha256(Path(clean_path).read_bytes()).hexdigest(),
            "effective_baseline_sha256": hashlib.sha256(Path(baseline_path).read_bytes()).hexdigest() if baseline_path is not None else None}


def main():
    if len(sys.argv) != 6:
        fail("WORD_WRITER_ARGUMENTS")
    source, plan_file, revision, clean, baseline = sys.argv[1:]
    plan = json.loads(Path(plan_file).read_text(encoding="utf-8"))
    try:
        print(json.dumps(build(source, plan, revision, clean, baseline), ensure_ascii=False))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from None
