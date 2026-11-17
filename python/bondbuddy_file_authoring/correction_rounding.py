"""Conservative guard for corrections justified only by rounded displayed sums.

This never certifies an amount as correct. It preserves the submitted amount when
both values fit the rounding uncertainty of the cited operands, for human review.
"""
from decimal import Decimal, ROUND_HALF_UP, localcontext
import re

AMOUNT = re.compile(r'(?<![A-Za-z0-9_.,])([+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,12})?)\s*(亿元|万元|元|[%％])')
AGGREGATE = re.compile(r'合计|加总|分项|相加|求和|汇总|尾差|round', re.I)
LIMITATION = '核对依据中的分项显示值存在累计舍入区间，该差额不足以证明原文金额错误。保留原文；请核对未舍入原始金额、单位和合计口径后确认。'


def amounts(text):
    result = []
    for match in AMOUNT.finditer(text or ''):
        raw = match[1].replace(',', '').replace('−', '-')
        if len(raw) > 64:
            return None
        value = Decimal(raw)
        result.append((value, match[2].replace('％', '%'), Decimal(1).scaleb(value.as_tuple().exponent)))
        if len(result) > 128:
            return None
    return result


def rounded_sum_limitation(original, replacement, evidence):
    if not AGGREGATE.search(evidence or ''):
        return ''
    before, after, cited = amounts(original), amounts(replacement), amounts(evidence)
    if before is None or after is None or cited is None:
        return '汇总依据中的数值超出自动舍入核对范围，保留原文并待人工核对。'
    if len(before) != len(after):
        return ''
    with localcontext() as context:
        context.prec = 100
        for old, new in zip(before, after):
            value, unit, quantum = old
            proposed, new_unit, new_quantum = new
            if value == proposed or unit != new_unit:
                continue
            operands = [amount for amount in cited if amount[1] == unit]
            # Bound work and avoid combinatorial subset selection: only a cited
            # consecutive sum of at least two operands is recognizable evidence.
            for start in range(len(operands)):
                total, radius = Decimal(0), quantum / 2
                for end in range(start, min(len(operands), start + 32)):
                    operand, _, precision = operands[end]
                    total += operand
                    radius += precision / 2
                    if end == start:
                        continue
                    if (total.quantize(new_quantum, rounding=ROUND_HALF_UP) == proposed
                            and abs(total - value) <= radius):
                        return LIMITATION
    return ''
