"""Resolve actual OOXML paragraph outline levels without guessing from style names."""
from __future__ import annotations

from typing import Any
from docx.oxml.ns import qn


def _outline(ppr: Any) -> tuple[bool, str | None]:
    nodes = ppr.findall(qn("w:outlineLvl")) if ppr is not None else []
    if not nodes:
        return False, None
    if len(nodes) != 1:
        return True, None
    value = nodes[0].get(qn("w:val"))
    if value not in tuple(str(level) for level in range(10)):
        return True, None
    # OOXML 0..8 are heading levels 1..9; 9 explicitly means body text.
    return True, "body" if value == "9" else str(int(value) + 1)


class ParagraphOutlineResolver:
    def __init__(self, styles: Any):
        self.styles: dict[str, Any] = {}
        self.duplicates: set[str] = set()
        defaults = []
        for style in styles.findall(qn("w:style")):
            identity = style.get(qn("w:styleId"))
            if identity in self.styles:
                self.duplicates.add(identity)
            if identity:
                self.styles[identity] = style
            if style.get(qn("w:type")) == "paragraph" and style.get(qn("w:default")) in {"1", "true", "on"}:
                defaults.append(identity)
        self.default_style = defaults[0] if len(defaults) == 1 else None
        self.ambiguous_default = len(defaults) > 1 or (bool(defaults) and not defaults[0])
        self.default_ppr = styles.find("./" + qn("w:docDefaults") + "/" + qn("w:pPrDefault") + "/" + qn("w:pPr"))
        self.cache: dict[str, tuple[bool, str | None]] = {}

    def _style(self, identity: str, seen: set[str]) -> tuple[bool, str | None]:
        if len(seen) >= 128 or identity in seen or identity in self.duplicates or identity not in self.styles:
            return True, None
        if identity in self.cache:
            return self.cache[identity]
        style = self.styles[identity]
        if style.get(qn("w:type")) != "paragraph":
            return True, None
        result = _outline(style.find(qn("w:pPr")))
        if not result[0]:
            bases = style.findall(qn("w:basedOn"))
            if len(bases) > 1:
                result = True, None
            elif bases:
                parent = bases[0].get(qn("w:val"))
                result = self._style(parent, seen | {identity}) if parent else (True, None)
            if not result[0] and style.find("./" + qn("w:pPr") + "/" + qn("w:numPr")) is not None:
                # Numbering-level paragraph properties are outside this resolver.
                result = True, None
        self.cache[identity] = result
        return result

    def resolve(self, paragraph: Any) -> str | None:
        ppr = paragraph.find(qn("w:pPr"))
        found, value = _outline(ppr)
        if found:
            return value
        references = ppr.findall(qn("w:pStyle")) if ppr is not None else []
        if len(references) > 1 or (not references and self.ambiguous_default):
            return None
        identity = references[0].get(qn("w:val")) if references else self.default_style
        if references and not identity:
            return None
        if identity:
            found, value = self._style(identity, set())
            if found:
                return value
        if ppr is not None and ppr.find(qn("w:numPr")) is not None:
            return None
        found, value = _outline(self.default_ppr)
        # No outline property in a complete chain is the OOXML body-text default.
        return value if found else "body"
