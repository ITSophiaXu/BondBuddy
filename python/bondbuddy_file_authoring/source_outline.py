"""Read effective DOCX headings independently of the model's edit log."""
from __future__ import annotations

import copy
import re
from difflib import SequenceMatcher

from .check import resolve_revisions
from .word_patch import paragraph_text, q, xml

NUM = r'一二三四五六七八九十百零〇两\d'
CHAPTER = re.compile(rf'^第[{NUM}]+\s*(?:章|节|篇|部分)\s*')
SECTION = re.compile(rf'^(?:[{NUM}]+[、．.]|[（(][{NUM}]+[）)])\s*')
STYLE_HEADING = re.compile(r'^(?:heading|标题)\s*([1-9])$', re.I)
STYLE_TOC = re.compile(r'^(?:toc|目录)\s*[1-9]?$', re.I)
BASIC_INFORMATION_LABELS = frozenset({
    '发行人名称', '法定代表人', '设立日期', '设立（工商注册）日期', '工商注册日期',
    '注册资本', '实缴资本', '统一社会信用代码', '社会统一信用编码',
    '注册地址', '邮政编码', '电话', '传真', '信息披露事务负责人', '联系地址',
})
BASIC_INFORMATION_ROW = re.compile(r'^(?:([0-9]{1,3})[、．.]|[（(]([0-9]{1,3})[）)])\s*([^:：]+)[:：]\s*(\S.*)$')


def basic_information_field(paragraph):
    if paragraph is None or paragraph.tag != q('p'):
        return None
    match = BASIC_INFORMATION_ROW.fullmatch(paragraph_text(paragraph).strip())
    if not match:
        return None
    number = int(match[1] or match[2])
    label = re.sub(r'\s+', '', match[3])
    return (number, label) if number > 0 and label in BASIC_INFORMATION_LABELS else None


def in_basic_information_block(paragraph):
    """Recognize consecutive fixed issuer fields, never arbitrary colon titles."""
    parent = paragraph.getparent()
    field = basic_information_field(paragraph)
    if parent is None or parent.tag != q('body') or field is None:
        return False
    for sibling, step in ((paragraph.getprevious(), -1), (paragraph.getnext(), 1)):
        adjacent = basic_information_field(sibling)
        if adjacent and adjacent[0] == field[0] + step and adjacent[1] != field[1]:
            return True
    return False


def style_map(parts):
    if 'word/styles.xml' not in parts:
        return {}
    return {n.get(q('styleId')): n for n in xml(parts['word/styles.xml']).findall(q('style'))}


def heading_role(paragraph, styles):
    """Resolve direct outline level, inherited styles and unstyled CN titles."""
    props = paragraph.find(q('pPr'))
    style = props.find(q('pStyle')) if props is not None else None
    key = style.get(q('val')) if style is not None else None
    chain, seen, names = [props], set(), []
    while key and key not in seen:
        seen.add(key)
        names.append(key)
        definition = styles.get(key)
        if definition is None:
            break
        name = definition.find(q('name'))
        if name is not None:
            names.append(name.get(q('val'), ''))
        chain.append(definition.find(q('pPr')))
        base = definition.find(q('basedOn'))
        key = base.get(q('val')) if base is not None else None
    if any(STYLE_TOC.fullmatch(name) for name in names):
        return {'kind': 'toc', 'level': None, 'recognition': 'style'}
    for prop in chain:
        level = prop.find(q('outlineLvl')) if prop is not None else None
        if level is not None:
            value = level.get(q('val'))
            return {'kind': 'heading', 'level': int(value), 'recognition': 'outline'} if value is not None and len(value) == 1 and value in '012345678' else None
    for name in names:
        match = STYLE_HEADING.fullmatch(name)
        if match:
            return {'kind': 'heading', 'level': int(match[1]) - 1, 'recognition': 'style'}
    text = paragraph_text(paragraph).strip()
    if len(text) <= 120 and CHAPTER.match(text):
        return {'kind': 'heading', 'level': 0, 'recognition': 'text_candidate'}
    if len(text) <= 80 and SECTION.match(text) and not re.search(r'[。；;！？!?]', text):
        # Explicit outline/style headings returned above always remain protected.
        # Unknown labels and isolated rows remain title candidates and fail closed.
        if in_basic_information_block(paragraph):
            return None
        return {'kind': 'heading', 'level': 1, 'recognition': 'text_candidate'}
    return None


def outline(parts):
    if 'word/document.xml' not in parts:
        return {'headings': [], 'toc': []}
    root = resolve_revisions(xml(parts['word/document.xml']), True)
    styles = style_map(parts)
    result = {'headings': [], 'toc': []}
    field_stack = []
    for index, p in enumerate(root.iter(q('p'))):
        # TOC fields often span multiple paragraphs without a TOC style.
        in_toc = any(field_stack)
        for n in p.iter():
            if n.tag == q('fldChar'):
                kind = n.get(q('fldCharType'))
                if kind == 'begin':
                    field_stack.append(False)
                elif kind == 'end' and field_stack:
                    field_stack.pop()
            elif n.tag == q('instrText') and re.match(r'^\s*TOC\b', n.text or '', re.I) and field_stack:
                field_stack[-1] = True
            elif n.tag == q('fldSimple') and re.match(r'^\s*TOC\b', n.get(q('instr'), ''), re.I):
                in_toc = True
            in_toc = in_toc or any(field_stack)
        if any(a.tag in {q('tc'), q('txbxContent')} for a in p.iterancestors()):
            continue
        text = paragraph_text(p).strip()
        if not text:
            continue
        role = heading_role(p, styles)
        if in_toc or (role and role['kind'] == 'toc'):
            # Page-number changes are pagination, not outline changes.
            text = re.sub(r'(?:\t+|[.．·…]{2,}|\s{2,})\s*(?:\d+|[ivxlcdm]+)\s*$', '', text, flags=re.I).strip()
            if text:
                result['toc'].append({'text': text})
        elif role:
            num = p.find(q('pPr') + '/' + q('numPr'))
            numbering = None if num is None else {
                c.tag.rsplit('}', 1)[-1]: c.get(q('val')) for c in num if c.tag in {q('numId'), q('ilvl')}}
            result['headings'].append({'text': text, 'level': role['level'], 'numbering': numbering,
                                       'paragraph': index, 'recognition': role['recognition']})
    return result


def compare_outlines(before, after):
    details = {}
    for kind in ('headings', 'toc'):
        old, new = before[kind], after[kind]
        def key(item):
            return (item['text'], item.get('level'), tuple(sorted((item.get('numbering') or {}).items())))
        matcher = SequenceMatcher(a=[key(n) for n in old], b=[key(n) for n in new], autojunk=False)
        changes = [{'change': op, 'before_start': a, 'after_start': c,
                    'before': copy.deepcopy(old[a:b]), 'after': copy.deepcopy(new[c:d])}
                   for op, a, b, c, d in matcher.get_opcodes() if op != 'equal']
        details[kind] = {'before_count': len(old), 'after_count': len(new), 'changes': changes}
    return {'status': 'changed' if any(v['changes'] for v in details.values()) else 'unchanged',
            'scope': 'effective_heading_text_order_level_and_toc', **details,
            'authorization_review': 'not_performed', 'visual_review': 'not_run'}
