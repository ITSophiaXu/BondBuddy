"""Resolve exact quotations using explicit, source-verified location anchors.

No fuzzy matches, guessed page numbers, first-occurrence selection or preference
for a numeric cell over prose. Repeated quotes need a unique section/table scope.
"""
import re

from .word_patch import paragraph_text, q


SECTION = re.compile(r'^第[一二三四五六七八九十百零〇\d]+[章节]')
QUOTED = re.compile(r'[「“《]([^」”》]+)[」”》]')


def compact(value):
    # Only location labels tolerate layout whitespace. Quotes stay byte-exact.
    return re.sub(r'\s+', '', value)


def embedded_caption(table):
    grid, first = table.find(q('tblGrid')), table.find(q('tr'))
    cells = first.findall(q('tc')) if first is not None else []
    if grid is None or len(grid) < 2 or len(cells) != 1:
        return None
    cell = cells[0]
    span = cell.find(f"{q('tcPr')}/{q('gridSpan')}")
    if span is None or span.get(q('val')) != str(len(grid)) or cell.find(f"{q('tcPr')}/{q('vMerge')}") is not None or cell.find(q('tbl')) is not None:
        return None
    labels = [re.sub(r'^表[：:]', '', compact(paragraph_text(p))) for p in cell.findall(q('p'))]
    labels = [v for v in labels if v and not re.match(r'^单位[：:]', v)]
    return labels[0] if len(labels) == 1 and len(labels[0]) <= 80 else None


class CorrectionLocator:
    def __init__(self, root):
        self.paragraphs = [(f'p{i}', p, paragraph_text(p)) for i, p in enumerate(root.iter(q('p')))]
        self.blocks = list(root.find(q('body')))
        self.sections, self.tables = [], []
        for index, block in enumerate(self.blocks):
            if block.tag == q('p'):
                text = paragraph_text(block)
                label = compact(text)
                # TOC entries are not section starts. A full, exact title is
                # checked against the report below, including its section number.
                if SECTION.match(label) and len(label) <= 120 and '\t' not in text and not list(block.iter(q('fldChar'))):
                    self.sections.append((index, label))
            elif block.tag == q('tbl'):
                # Word often stores caption + unit in a full-width first row.
                # Require the actual grid span; do not treat a data cell as a title.
                caption = embedded_caption(block)
                if caption:
                    self.tables.append((index, block, caption))
                    continue
                # A caption must immediately precede the table, apart from units
                # and empty paragraphs. Never use a distant heading as a caption.
                for preceding in reversed(self.blocks[max(0, index - 4):index]):
                    if preceding.tag != q('p'):
                        break
                    label = compact(paragraph_text(preceding))
                    if not label or re.match(r'^单位[：:]', label):
                        continue
                    label = re.sub(r'^表[：:]', '', label)
                    if len(label) <= 80:
                        self.tables.append((index, block, label))
                    break

    def unique(self, original, nodes=None):
        matches = [(identity, text.count(original)) for identity, node, text in self.paragraphs
                   if original and (nodes is None or node in nodes) and original in text]
        return matches[0][0] if len(matches) == 1 and matches[0][1] == 1 else None

    def locate(self, original, location=''):
        direct = self.unique(original)
        if direct or not original or not location:
            return direct
        labels = [compact(v) for v in QUOTED.findall(location)]
        normalized = compact(re.sub(r'[「」“”《》]', '', location))
        marker = re.search(r'第[一二三四五六七八九十百零〇\d]+[章节]', normalized)
        start, end = 0, len(self.blocks)
        section_labels = set()
        if marker:
            sections = [(i, label) for i, label in self.sections
                        if label.startswith(marker[0]) and label in normalized]
            if len(sections) != 1:
                return None
            start, section = sections[0]
            end = next((i for i, _ in self.sections if i > start), end)
            section_labels = {section, SECTION.sub('', section)}
        candidates = [(block, caption) for i, block, caption in self.tables
                      if start <= i < end and caption and caption in labels]
        if candidates:
            if len(candidates) != 1:
                return None
            table, caption = candidates[0]
            nodes = set(table.iter(q('p')))
            # Additional quoted row/column labels must also exist in this table.
            table_labels = {compact(paragraph_text(p)) for p in nodes}
            if any(label not in section_labels | {caption} | table_labels for label in labels):
                return None
            return self.unique(original, nodes)
        if marker and all(label in section_labels for label in labels):
            nodes = {p for block in self.blocks[start:end] for p in block.iter(q('p'))}
            return self.unique(original, nodes)
        return None
