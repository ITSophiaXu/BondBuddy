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
FINANCIAL_FORMULA_LABELS = frozenset({
    '毛利润', '毛利率', '全部债务', '流动比率', '速动比率', '资产负债率', '债务资本比率',
    '营业毛利率', '平均总资产收益率', '加权平均净资产收益率', '总资产周转率',
    '应收账款周转率', '存货周转率', 'EBITDA，即息税折旧摊销前利润', 'EBITDA利息保障倍数',
})
FINANCIAL_FORMULA_ROW = re.compile(r'^((?:([0-9]{1,3})[、．.]|[（(]([0-9]{1,3})[）)]))\s*([^=＝]+)[=＝]\s*(\S.*)$')
FORMULA_TOKEN = re.compile(r'[A-Za-z0-9\u4e00-\u9fff.%％]+|[()（）+\-−/×÷]')
FORMULA_NOTE = re.compile(r'(?:（[^()（）=＝+\-−/×÷*^∗·∙／－＋。；;！？!?]+）|\([^()（）=＝+\-−/×÷*^∗·∙／－＋。；;！？!?]+\))')


def financial_formula_note(text):
    return FORMULA_NOTE.fullmatch(text) is not None and re.search(r'[\u4e00-\u9fff]', text) is not None


def arithmetic_expression(text):
    """A bounded operand/operator grammar, not any sentence containing '='."""
    tokens = FORMULA_TOKEN.findall(text)
    if ''.join(tokens) != text:
        return False
    stack, operand, operations = [], True, 0
    for token in tokens:
        if token in ('(', '（'):
            if not operand:
                return False
            stack.append(token)
        elif token in (')', '）'):
            if operand or not stack or stack.pop() != {')': '(', '）': '（'}[token]:
                return False
        elif token in ('+', '-', '−', '/', '×', '÷'):
            if operand:
                return False
            operand = True
            operations += 1
        else:
            if not operand:
                return False
            operand = False
    return not operand and not stack and operations > 0


def financial_formula_field(paragraph):
    if paragraph is None or paragraph.tag != q('p'):
        return None
    match = FINANCIAL_FORMULA_ROW.fullmatch(paragraph_text(paragraph).strip())
    if not match:
        return None
    number, label = int(match[2] or match[3]), re.sub(r'\s+', '', match[4])
    expression = re.sub(r'\s+', '', match[5])
    if number <= 0 or label not in FINANCIAL_FORMULA_LABELS:
        return None
    valid = arithmetic_expression(expression)
    if not valid:
        # A trailing prose note is distinct from a parenthesized arithmetic term.
        note = next((m for m in FORMULA_NOTE.finditer(expression) if m.end() == len(expression)), None)
        valid = note is not None and financial_formula_note(note[0]) and arithmetic_expression(expression[:note.start()])
    if not valid:
        return None
    return {'number': number, 'marker': match[1], 'label': label, 'expression': expression}


def in_financial_formula_block(paragraph):
    parent = paragraph.getparent()
    field = financial_formula_field(paragraph)
    if parent is None or parent.tag != q('body') or field is None:
        return False
    for sibling, step in ((paragraph.getprevious(), -1), (paragraph.getnext(), 1)):
        adjacent = financial_formula_field(sibling)
        if adjacent and adjacent['number'] == field['number'] + step and adjacent['label'] != field['label']:
            return True
    return False


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
        if in_basic_information_block(paragraph) or in_financial_formula_block(paragraph):
            return None
        return {'kind': 'heading', 'level': 1, 'recognition': 'text_candidate'}
    return None


def _outline(parts):
    if 'word/document.xml' not in parts:
        return {'headings': [], 'toc': [], 'formulas': []}
    root = resolve_revisions(xml(parts['word/document.xml']), True)
    styles = style_map(parts)
    result = {'headings': [], 'toc': [], 'formulas': []}
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
        elif in_financial_formula_block(p):
            # Retain formulas independently of the heading exemption, including
            # an appended note that takes a line beyond the title length limit.
            result['formulas'].append({**financial_formula_field(p), 'paragraph': index,
                                       'heading_index': len(result['headings']) - 1})
    return result


def outline(parts):
    result = _outline(parts)
    return {kind: result[kind] for kind in ('headings', 'toc')}


def compare_financial_formulas(before, after):
    """Protect source formula identity/order/RHS; only append a prose note."""
    old, new = _outline(before)['formulas'], _outline(after)['formulas']
    changes = []
    for index in range(max(len(old), len(new))):
        a, b = old[index] if index < len(old) else None, new[index] if index < len(new) else None
        same_identity = a is not None and b is not None and all(
            a[key] == b[key] for key in ('number', 'marker', 'label', 'heading_index'))
        same_expression = False
        if same_identity:
            original, current = a['expression'], b['expression']
            same_expression = current == original or (
                current.startswith(original) and financial_formula_note(current[len(original):]))
        if not same_expression:
            changes.append({'formula_index': index, 'before': a, 'after': b})
    return {'status': 'changed' if changes else 'unchanged', 'before_count': len(old),
            'after_count': len(new), 'changes': changes,
            'factual_accuracy': 'not_verified'}


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
