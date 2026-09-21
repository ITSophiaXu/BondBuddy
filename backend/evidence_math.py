"""Resolve routine numeric review markers against verified original-file citations.

This is a bounded verification pass, not a replacement for the agent's subject,
scope and accounting checks. It never removes a stated conflict or missing item.
"""
from __future__ import annotations

import ast
import copy
import re
from datetime import datetime
from decimal import Decimal, DecimalException

NUMBER = r'(?<![\d.])[-+]?\d[\d,]*(?:\.\d+)?[%％]?'
FORMULA = re.compile(r'(?<![\d.])([\d.,+\-*/×÷()（）\s]{3,160})[=＝]\s*([-+]?\d[\d,]*(?:\.\d+)?[%％]?)')
CONFLICT = re.compile(
    r'冲突|矛盾|不一致|不匹配|缺少|缺失|未提供|未上传|无.{0,8}材料|无依据|待补充|'
    r'无法核[对实]|未能核[对实]|尚未核[对实]|未核实|'
    r'口径.{0,12}(?:不明|不同|差异|待确认)|(?:确认|核对).{0,8}口径|'
    r'(?:计算基准|统计口径|合并范围|主体身份|审计状态|科目分类|计算方法).{0,12}(?:待确认|需确认|不明|差异|需核对|待核对)|'
    r'审计状态.{0,8}(?:待|不明)|扫描|OCR|原页|'
    r'表.{0,12}(?:未更新|仍为)|工商|新增.{0,6}列|列安排|'
    r'数据.{0,12}(?:异常|有误)|(?:尚未|未).{0,6}(?:完成|核对)|待决定', re.I)
GENERIC_SUFFIX = '【待确认：请核对本处修改及依据】'


def compact(text):
    return re.sub(r'\s+', '', str(text))


def decimals(text):
    values = set()
    for token in re.findall(NUMBER, text):
        try:
            values.add(Decimal(token.replace(',', '').rstrip('%％')))
        except DecimalException:
            pass
    return values


def formula_values(reason, evidence):
    """Evaluate explicit equations only; every operand must come from evidence.

    Unit/percentage scaling constants are allowed only as multiplication/division
    factors in an explicitly labelled conversion. A wrong RHS proves nothing.
    """
    results = set()
    for match in FORMULA.finditer(reason):
        expression = match[1].strip().replace(',', '').translate(str.maketrans('×÷（）', '*/()'))
        if not re.search(r'[+*/-]', expression):
            continue
        try:
            tree = ast.parse(expression, mode='eval')
            if len(list(ast.walk(tree))) > 60:
                continue

            def evaluate(node, parent=None):
                if isinstance(node, ast.Expression):
                    return evaluate(node.body)
                if isinstance(node, ast.Constant) and type(node.value) in (int, float):
                    value = Decimal(ast.get_source_segment(expression, node))
                    scaling = isinstance(parent, (ast.Mult, ast.Div)) and (
                        value in {Decimal(10000), Decimal(100000000)} and re.search(r'换算|单位|万元|亿元', reason)
                        or value == 100 and re.search(r'比率|占比|百分|[%％]', reason))
                    if value not in evidence and not scaling:
                        raise ValueError('uncited operand')
                    return value
                if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                    if isinstance(node.operand, ast.Constant):
                        signed = Decimal(ast.get_source_segment(expression, node))
                        if signed in evidence:
                            return signed
                    value = evaluate(node.operand, parent)
                    return -value if isinstance(node.op, ast.USub) else value
                if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)):
                    left, right = evaluate(node.left, node.op), evaluate(node.right, node.op)
                    value = (left + right if isinstance(node.op, ast.Add) else left - right if isinstance(node.op, ast.Sub)
                             else left * right if isinstance(node.op, ast.Mult) else left / right)
                    if abs(value) > Decimal('1e24'):
                        raise ValueError('unbounded arithmetic')
                    return value
                raise ValueError('unsupported expression')

            value = evaluate(tree)
            rhs = match[2].replace(',', '').rstrip('%％')
            precision = len(rhs.split('.')[1]) if '.' in rhs else 0
            if abs(value - Decimal(rhs)) <= Decimal(10) ** -precision / 2:
                results.add(value)
                results.add(Decimal(rhs))
        except (ValueError, SyntaxError, DecimalException, TypeError):
            continue
    return results


def unwrap_review(text):
    text = text.replace(GENERIC_SUFFIX, '')
    text = re.sub(r'【(?:待确认|待核对)[：:]\s*([^【】]+)】', lambda m: m[1].strip(), text)
    return None if '【' in text or '】' in text else text


def periods(text):
    """Extract explicit month periods, excluding numeric formula operands."""
    text = re.sub(r'(20\d{2})-(\d{1,2})-(\d{1,2})', r'\1年\2月\3日', text)
    result = set()
    for match in re.finditer(r'(20\d{2})年\s*(?:1\s*[-—至~～]\s*)?(\d{1,2})月', text):
        year, month = map(int, match.groups())
        if 1 <= month <= 12:
            result.add((year, month))
    return result


def invalid_dates(text):
    text = re.sub(r'(20\d{2})-(\d{1,2})-(\d{1,2})', r'\1年\2月\3日', text)
    for match in re.finditer(r'(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日', text):
        try:
            datetime(*map(int, match.groups()))
        except ValueError:
            return True
    return False

