"""Bounded native header/TOC metadata. Auxiliary text never leaves this module."""
from __future__ import annotations

import hashlib
import re
import zipfile
from typing import Any, Iterator
from lxml import etree
from docx.oxml.ns import qn


def _sha(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def _flag(node: Any, name: str) -> bool | None:
    value = node.get(qn("w:" + name))
    return False if value is None or value in {"0", "false", "off"} else True if value in {"1", "true", "on"} else None


def _effective(root: Any) -> Iterator[Any]:
    for node in root.iter():
        if not any(parent.tag in {qn("w:del"), qn("w:moveFrom")} for parent in (node, *node.iterancestors())):
            yield node


def _text(root: Any) -> str:
    return "".join(node.text or "" if node.tag == qn("w:t") else "\t" if node.tag == qn("w:tab") else "\n"
                   for node in _effective(root) if node.tag in {qn("w:t"), qn("w:tab"), qn("w:br"), qn("w:cr")})


class _Fonts:
    def __init__(self, styles: Any):
        self.styles: dict[str, Any] = {}
        self.duplicates: set[str] = set()
        self.defaults: dict[str, list[str]] = {"paragraph": [], "character": []}
        for style in styles.findall(qn("w:style")):
            identity = style.get(qn("w:styleId"))
            if identity in self.styles:
                self.duplicates.add(identity)
            if identity:
                self.styles[identity] = style
                kind = style.get(qn("w:type"))
                if kind in self.defaults and style.get(qn("w:default")) in {"1", "true", "on"}:
                    self.defaults[kind].append(identity)
        self.default_rpr = styles.find("./" + qn("w:docDefaults") + "/" + qn("w:rPrDefault") + "/" + qn("w:rPr"))

    def layers(self, properties: Any, kind: str) -> list[Any] | None:
        refs = properties.findall(qn("w:pStyle" if kind == "paragraph" else "w:rStyle")) if properties is not None else []
        if len(refs) > 1 or not refs and len(self.defaults[kind]) > 1:
            return None
        identity = refs[0].get(qn("w:val")) if refs else next(iter(self.defaults[kind]), None)
        if refs and not identity:
            return None
        seen: set[str] = set()
        result = []
        while identity:
            if identity in seen or identity in self.duplicates or identity not in self.styles or len(seen) >= 128:
                return None
            seen.add(identity)
            style = self.styles[identity]
            if style.get(qn("w:type")) != kind:
                return None
            result.append(style.find(qn("w:rPr")))
            bases = style.findall(qn("w:basedOn"))
            if len(bases) > 1 or bases and not bases[0].get(qn("w:val")):
                return None
            identity = bases[0].get(qn("w:val")) if bases else None
        return result

    def runs(self, paragraph: Any) -> list[dict[str, Any]]:
        p_layers = self.layers(paragraph.find(qn("w:pPr")), "paragraph")
        result = []
        for run in _effective(paragraph):
            if run.tag != qn("w:r") or not _text(run).strip():
                continue
            rpr = run.find(qn("w:rPr"))
            r_layers = self.layers(rpr, "character")
            resolved = p_layers is not None and r_layers is not None and not any(parent.tag == qn("w:tbl") for parent in run.iterancestors())
            layers = [rpr, *(r_layers or []), *(p_layers or []), self.default_rpr]
            values: dict[str, Any] = {"resolved": resolved, "characters": len(_text(run))}
            for key, tag, attr in (("latin_font", "rFonts", "ascii"), ("east_asia_font", "rFonts", "eastAsia"),
                                   ("half_points", "sz", "val"), ("latin_theme", "rFonts", "asciiTheme"),
                                   ("east_asia_theme", "rFonts", "eastAsiaTheme")):
                values[key] = None
                for layer in layers:
                    nodes = layer.findall(qn("w:" + tag)) if layer is not None else []
                    if len(nodes) > 1:
                        values["resolved"] = False
                        break
                    value = nodes[0].get(qn("w:" + attr)) if nodes else None
                    if value is not None:
                        if not value or len(value) > 200 or key == "half_points" and not re.fullmatch(r"[1-9]\d{0,3}", value):
                            values["resolved"] = False
                        else:
                            values[key] = value
                        break
            # A single ascii attribute cannot establish hAnsi/complex-script font selection.
            hansi = None
            hansi_theme = None
            for layer in layers:
                node = layer.find(qn("w:rFonts")) if layer is not None else None
                if node is not None:
                    hansi = hansi if hansi is not None else node.get(qn("w:hAnsi"))
                    hansi_theme = hansi_theme if hansi_theme is not None else node.get(qn("w:hAnsiTheme"))
                if layer is not None and any(_flag(layer.find(qn("w:" + name)), "val") is not False
                                              or layer.find(qn("w:" + name)).get(qn("w:val")) is None
                                              for name in ("cs", "rtl") if layer.find(qn("w:" + name)) is not None):
                    values["resolved"] = False
            if hansi_theme or hansi is not None and hansi != values["latin_font"] or re.search(r"[\u0590-\u08ff]", _text(run)) or hansi is None and re.search(r"[\u00c0-\u024f]", _text(run)):
                values["resolved"] = False
            result.append(values)
        return result


def _toc(root: Any, unresolved_revisions: bool) -> dict[str, Any]:
    paragraphs = {node: index for index, node in enumerate(root.iter(qn("w:p")), 1)}
    fields: list[dict[str, Any]] = []
    stack: list[dict[str, Any]] = []
    unresolved = unresolved_revisions
    sequence = 0

    def paragraph_of(node: Any) -> int:
        return next((paragraphs[p] for p in node.iterancestors() if p in paragraphs), 0)

    def finish(frame: dict[str, Any], end: int, complete: bool) -> None:
        nonlocal unresolved
        instruction = "".join(frame["instruction"])
        if not re.match(r"^\s*TOC(?:\s|$)", instruction, flags=re.IGNORECASE):
            return
        result = "".join(frame["result"]).strip()
        if len(fields) >= 1000 or not frame["start"] or not end:
            unresolved = True
            return
        fields.append({"field_index": frame["index"], "kind": frame["kind"], "start_paragraph": frame["start"],
                       "end_paragraph": max(frame["start"], end), "complete": complete, "instruction_sha256": _sha(instruction),
                       "result_sha256": _sha(result), "result_characters": len(result), "dirty": frame["dirty"], "locked": frame["locked"]})
        unresolved = unresolved or not complete or frame["dirty"] is None or frame["locked"] is None

    for count, node in enumerate(_effective(root), 1):
        if count > 500_000:
            unresolved = True
            break
        if node.tag in {qn("w:altChunk"), "{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent"}:
            unresolved = True
        if node.tag == qn("w:fldSimple"):
            sequence += 1
            instruction = node.get(qn("w:instr")) or ""
            finish({"index": sequence, "kind": "simple", "start": paragraph_of(node), "instruction": [instruction], "result": [_text(node)],
                    "dirty": _flag(node, "dirty"), "locked": _flag(node, "fldLock")}, paragraph_of(node), True)
        elif node.tag == qn("w:fldChar"):
            kind = node.get(qn("w:fldCharType"))
            if kind == "begin":
                sequence += 1
                if len(stack) >= 128:
                    unresolved = True
                    break
                stack.append({"index": sequence, "kind": "complex", "start": paragraph_of(node), "instruction": [], "result": [], "separate": False,
                              "dirty": _flag(node, "dirty"), "locked": _flag(node, "fldLock")})
            elif kind == "separate":
                if not stack or stack[-1]["separate"]:
                    unresolved = True
                else:
                    stack[-1]["separate"] = True
            elif kind == "end":
                if not stack:
                    unresolved = True
                else:
                    frame = stack.pop()
                    finish(frame, paragraph_of(node), frame["separate"])
            else:
                unresolved = True
        elif node.tag == qn("w:instrText"):
            if stack and not stack[-1]["separate"]:
                stack[-1]["instruction"].append(node.text or "")
            else:
                unresolved = True
        elif node.tag == qn("w:t"):
            for frame in stack:
                if frame["separate"]:
                    frame["result"].append(node.text or "")
    if stack:
        unresolved = True
        for frame in stack:
            finish(frame, len(paragraphs), False)
    return {"status": "unresolved" if unresolved else "complete", "fields": sorted(fields, key=lambda f: f["field_index"])}


def document_formatting(path: Any, root: Any, styles: Any, settings: Any, auxiliary: list[dict[str, Any]],
                        max_part_bytes: int, unresolved_revisions: bool) -> dict[str, Any]:
    parts = []
    unresolved = unresolved_revisions
    fonts = _Fonts(styles)
    headers = {target["part_name"]: target for target in auxiliary
               if target["kind"] == "header" or target["part_name"].startswith("word/header")
               or any(r["relationship_type"] == "header" for r in target["scope"]["relationships"])}
    references = list(root.iter(qn("w:headerReference")))
    # This bounded checker supports explicit default headers only. Variant activation and
    # linked/inherited first/even-page scope needs a separate layout-aware resolver.
    unresolved = unresolved or any(_flag(node, "val") is not False or node.get(qn("w:val")) is None for node in root.iter(qn("w:titlePg")))
    unresolved = unresolved or any(_flag(node, "val") is not False or node.get(qn("w:val")) is None for node in settings.iter(qn("w:evenAndOddHeaders")))
    unresolved = unresolved or any(node.get(qn("w:type")) != "default" for node in references)
    mapped_refs: set[tuple[int, str]] = set()
    with zipfile.ZipFile(path) as archive:
        body_hash = _sha(archive.read("word/document.xml"))
        for name, target in headers.items():
            scope = target["scope"]
            if len(parts) >= 100 or not re.fullmatch(r"word/header\d+\.xml", name) or not target["parseable"] or scope["status"] != "resolved" or scope["truncated"] or not scope["relationship_part_sha256"]:
                unresolved = True
                continue
            try:
                info = archive.getinfo(name)
                if info.file_size > max_part_bytes:
                    unresolved = True
                    continue
                with archive.open(info) as member:
                    raw = member.read(max_part_bytes + 1)
                if len(raw) > max_part_bytes or _sha(raw) != target["part_sha256"] or re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw, re.I):
                    unresolved = True
                    continue
                header = etree.fromstring(raw, parser=etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False))
            except (KeyError, OSError, RuntimeError, ValueError, etree.XMLSyntaxError, zipfile.BadZipFile):
                unresolved = True
                continue
            paragraphs = [p for p in _effective(header) if p.tag == qn("w:p")]
            text = "\n".join(_text(p) for p in paragraphs)
            runs = [r for p in paragraphs for r in fonts.runs(p)]
            complete = header.tag == qn("w:hdr") and len(runs) <= 10000 and not any(node.tag in {
                qn("w:fldChar"), qn("w:fldSimple"), qn("w:drawing"), qn("w:pict"), qn("w:txbxContent"), qn("w:sdt"),
                qn("w:rPrChange"), qn("w:pPrChange"), qn("w:sectPrChange"), qn("w:altChunk"),
                "{http://schemas.openxmlformats.org/markup-compatibility/2006}AlternateContent"} for node in header.iter())
            sections = [{"section_index": s["section_index"], "reference_type": s["reference_type"]} for s in scope["section_references"]]
            if len({(s["section_index"], s["reference_type"]) for s in sections}) != len(sections):
                unresolved = True
                continue
            if not sections or any(s["reference_type"] not in {"default", "first", "even"} for s in sections):
                unresolved = True
                continue
            mapped_refs.update((s["section_index"], s["reference_type"]) for s in sections)
            parts.append({"part_name": name, "part_sha256": target["part_sha256"], "text_sha256": _sha(text),
                          "paragraph_count": len(paragraphs), "status": "complete" if complete else "unresolved",
                          "relationship_part_sha256": scope["relationship_part_sha256"], "sections": sections, "runs": runs[:10000]})
            unresolved = unresolved or not complete
    # Missing/unparseable relationships must never be interpreted as absence of a header.
    unresolved = unresolved or len(mapped_refs) != len(references)
    return {"schema_version": "docx-formatting-v1", "body_part_sha256": body_hash,
            "headers": {"status": "unresolved" if unresolved else "complete", "parts": parts},
            "toc": _toc(root, unresolved_revisions)}
