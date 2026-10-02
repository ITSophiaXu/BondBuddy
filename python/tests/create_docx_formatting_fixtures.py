"""Synthetic native DOCX fixtures shared by parser/worker integration checks."""
from pathlib import Path
import sys
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt


def field(paragraph, kind: str, result: str = "第一章 总则\t1"):
    if kind in {"simple", "empty", "dirty", "locked", "deleted"}:
        node = OxmlElement("w:fldSimple")
        node.set(qn("w:instr"), ' TOC \\o "1-3" \\h ')
        if kind in {"dirty", "locked"}:
            node.set(qn("w:dirty" if kind == "dirty" else "w:fldLock"), "true")
        if kind != "empty":
            run = OxmlElement("w:r")
            text = OxmlElement("w:t")
            text.text = result
            run.append(text)
            node.append(run)
        if kind == "deleted":
            wrapper = OxmlElement("w:del")
            wrapper.append(node)
            node = wrapper
        paragraph._p.append(node)
    elif kind in {"complex", "broken"}:
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        paragraph.add_run()._r.append(begin)
        for fragment in (' TO', 'C \\o "1-3" '):
            instruction = OxmlElement("w:instrText")
            instruction.text = fragment
            paragraph.add_run()._r.append(instruction)
        separate = OxmlElement("w:fldChar")
        separate.set(qn("w:fldCharType"), "separate")
        paragraph.add_run()._r.append(separate)
        paragraph.add_run(result)
        if kind != "broken":
            end = OxmlElement("w:fldChar")
            end.set(qn("w:fldCharType"), "end")
            paragraph.add_run()._r.append(end)


def create(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    for kind in ("simple", "empty", "complex", "broken", "plain", "dirty", "locked", "deleted", "missing_header", "missing_style", "theme", "section_link", "header_field", "first_page", "even_page", "inactive_variant", "hansi", "complex_script", "complex_flag", "alt_chunk"):
        document = Document()
        if kind != "theme":
            for node in document.styles.element.iter(qn("w:rFonts")):
                for name in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
                    node.attrib.pop(qn("w:" + name), None)
        normal = document.styles["Normal"]
        normal.font.size = Pt(12)
        normal.font.name = "Arial"
        normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "宋体")
        document.add_paragraph("合成正文，仅用于测试。")
        paragraph = document.add_paragraph("目录")
        field(paragraph, kind)
        if kind == "alt_chunk":
            paragraph._p.addnext(OxmlElement("w:altChunk"))
        if kind != "missing_header":
            header = document.sections[0].header.paragraphs[0]
            header.text = "合成保密页眉"
            if kind == "missing_style":
                header._p.get_or_add_pPr().get_or_add_pStyle().val = "NonexistentHeaderStyle"
            if kind == "header_field":
                node = OxmlElement("w:fldSimple")
                node.set(qn("w:instr"), " PAGE ")
                header._p.append(node)
            if kind == "section_link":
                document.add_section()  # Inherited header linkage is deliberately unresolved by this parser.
            if kind == "first_page":
                document.sections[0].different_first_page_header_footer = True
            if kind == "even_page":
                document.settings.odd_and_even_pages_header_footer = True
            if kind == "inactive_variant":
                document.sections[0].first_page_header.paragraphs[0].text = "非活动首页页眉"
            if kind == "hansi":
                header.runs[0]._r.get_or_add_rPr().get_or_add_rFonts().set(qn("w:hAnsi"), "Times New Roman")
            if kind == "complex_script":
                header.add_run("مرحبا")
            if kind == "complex_flag":
                header.runs[0]._r.get_or_add_rPr().append(OxmlElement("w:cs"))
        document.save(directory / (kind + ".docx"))


if __name__ == "__main__":
    create(Path(sys.argv[1]))
