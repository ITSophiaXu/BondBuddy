"""Conservative, deterministic checks. Ambiguous context is reported as unchecked."""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .check import package, parse_xml
from bondbuddy_word_delivery.writer import Q

VERSION = 'direct-financial-v1'
METRICS = {'资产总计': 'assets', '资产合计': 'assets', '负债合计': 'liabilities',
           '所有者权益合计': 'equity', '股东权益合计': 'equity', '营业收入': 'revenue',
           '净利润': 'net_profit', '经营活动产生的现金流量净额': 'operating_cash_flow'}
REQUIRED = set(METRICS.values())
NUMBER = re.compile(r'^[-−]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:[.．]\d+)?$')
INLINE_NUMBER = re.compile(r'(?<![\d,.，．])[-−]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:[.．]\d+)?(?![\d,.，．])')
PERIOD = re.compile(r'(20\d{2})年(?:(?:\d{1,2}\s*[-—–至]\s*)?(\d{1,2})月|度|末)')
CELL = re.compile(r'^([A-Z]+)([1-9]\d*)$')


def number(text):
    value = str(text).strip().replace('，', ',').replace('．', '.').replace('−', '-')
    if not NUMBER.fullmatch(value):
        return None
    try:
        return Decimal(value.replace(',', ''))
    except InvalidOperation:
        return None


def metric(text):
    value = re.sub(r'[\s：:]', '', re.split(r'[（(]', str(text), 1)[0])
    value = re.sub(r'^(?:[一二三四五六七八九十]+[、.]|其中)', '', value)
    return METRICS.get(value)


def period(text):
    found = PERIOD.search(str(text))
    return f'{found.group(1)}-{int(found.group(2) or 12):02d}' if found else None


def context(text):
    text = str(text)
    scope = 'consolidated' if '合并' in text and '母公司' not in text else 'parent' if '母公司' in text and '合并' not in text else None
    units = [name for name in ('亿元', '万元', '元') if re.search(r'(?:单位|金额单位)[：:]?\s*(?:人民币)?' + name, text)]
    unit = units[0] if len(units) == 1 else None
    return scope, unit


def multiplier(unit):
    return {'元': Decimal(1), '万元': Decimal(10000), '亿元': Decimal(100000000)}[unit]


def amount(text, unit):
    parsed = number(text)
    if parsed is None:
        return None
    scale = multiplier(unit)
    # A displayed amount is rounded to its last shown digit. Treat differences
    # within the combined rounding intervals as unconfirmed, not errors.
    tolerance = scale * Decimal(10) ** parsed.as_tuple().exponent / 2
    return parsed * scale, tolerance


def measured(item):
    if isinstance(item, Decimal):
        return item, Decimal(0)
    return item[0], item[1] if len(item) > 1 and isinstance(item[1], Decimal) else Decimal(0)


def xlsx_facts(materials, issuer):
    facts = defaultdict(list)
    for material in materials:
        if material.get('role') not in ('audit', 'financial', 'interimFinancial') or material.get('media_type') != 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
            continue
        sheets = defaultdict(dict)
        for record in material.get('records', []):
            if record.get('locator_type') != 'xlsx_cell' or record.get('uncertainty') or record.get('formatting', {}).get('sheet_state') != 'visible':
                continue
            locator = record.get('locator') or {}
            match = CELL.fullmatch(str(locator.get('cell', '')))
            if match:
                column = 0
                for letter in match.group(1):
                    column = column * 26 + ord(letter) - 64
                sheets[str(locator.get('sheet', ''))][(int(match.group(2)), column)] = str(record.get('literal_quote', ''))
        for title, grid in sheets.items():
            head = ' '.join(value for (row, _), value in grid.items() if row <= 20)
            if issuer not in head:
                continue
            scope, unit = context(title + ' ' + head)
            if not scope or not unit:
                continue
            current_period = next((period(value) for (row, _), value in grid.items() if row <= 4 and period(value)), None)
            columns = {}
            for (row, col), value in grid.items():
                if row <= 6 and (found := period(value)):
                    columns[col] = found
                elif row <= 6 and current_period and value.strip() in ('期末余额', '本期金额'):
                    columns[col] = current_period
            for (row, col), label in grid.items():
                key = metric(label) if col <= 3 else None
                if not key:
                    continue
                for value_col, report_period in columns.items():
                    parsed = amount(grid.get((row, value_col), ''), unit)
                    if parsed is not None:
                        facts[(scope, report_period, key)].append((*parsed, material.get('material_id'), title))
    return facts


def text(node):
    return ''.join(node.itertext()).strip()


def docx_facts(path, issuer):
    root = parse_xml(package(path)['word/document.xml'])
    body = root.find(Q('body'))
    all_text = text(body)
    facts = defaultdict(list)
    citations = defaultdict(list)
    if issuer not in all_text:
        return facts, citations, ['target_issuer_unconfirmed']
    preceding = []
    for child in body:
        if child.tag == Q('p'):
            value = text(child)
            if value:
                preceding = (preceding + [value])[-8:]
                key = next((name for label, name in METRICS.items() if label in value), None)
                report_period = period(value)
                scope, unit = context(' '.join(preceding))
                # The cell validator is anchored; prose needs an unanchored matcher.
                numbers = INLINE_NUMBER.findall(PERIOD.sub('', value))
                if key and report_period and scope and unit and len(numbers) == 1:
                    parsed = amount(numbers[0], unit)
                    if parsed is not None:
                        citations[(scope, report_period, key)].append(parsed)
        elif child.tag == Q('tbl'):
            rows = [[text(cell) for cell in row.findall(Q('tc'))] for row in child.findall(Q('tr'))]
            caption = ' '.join(preceding[-5:]) + ' ' + ' '.join(' '.join(row) for row in rows[:3])
            scope, unit = context(caption)
            if not scope or not unit:
                continue
            columns = {}
            for row in rows[:4]:
                for col, value in enumerate(row):
                    if (found := period(value)):
                        columns[col] = found
            for row in rows:
                key = next((metric(value) for value in row[:2] if metric(value)), None)
                if not key:
                    continue
                for col, report_period in columns.items():
                    parsed = amount(row[col], unit) if col < len(row) else None
                    if parsed is not None:
                        facts[(scope, report_period, key)].append(parsed)
    return facts, citations, []


def verify(path, data):
    issuer = data.get('issuer_name')
    if not isinstance(issuer, str) or not issuer.strip():
        return {'version': VERSION, 'status': 'not_checked', 'compared': 0, 'issues': [], 'unchecked': ['issuer_unconfirmed']}
    source = xlsx_facts(data.get('materials', []), issuer.strip())
    target, citations, unchecked = docx_facts(path, issuer.strip())
    unchecked.extend(str(item) for item in data.get('source_unchecked', []) if isinstance(item, str))
    issues = []
    compared = 0
    unique = {}
    for key in sorted(source.keys() & target.keys()):
        before = {measured(item) for item in source[key]}
        after = {measured(item) for item in target[key]}
        if len(before) != 1 or len(after) != 1:
            unchecked.append('ambiguous_' + '_'.join(key))
            continue
        (original, original_tolerance), (revised, revised_tolerance) = next(iter(before)), next(iter(after))
        compared += 1
        if abs(original - revised) > original_tolerance + revised_tolerance + Decimal('0.01'):
            issues.append({'code': 'STATEMENT_VALUE_MISMATCH', 'scope': key[0], 'period': key[1], 'metric': key[2],
                           'source': str(original), 'document': str(revised)})
        for citation in citations.get(key, []):
            cited, cited_tolerance = measured(citation)
            compared += 1
            if abs(cited - revised) > cited_tolerance + revised_tolerance + Decimal('0.01'):
                issues.append({'code': 'BODY_CITATION_MISMATCH', 'scope': key[0], 'period': key[1], 'metric': key[2],
                               'table': str(revised), 'body': str(cited)})
        unique[key] = (revised, revised_tolerance)
    for scope, report_period in {(key[0], key[1]) for key in unique}:
        a = unique.get((scope, report_period, 'assets'))
        l = unique.get((scope, report_period, 'liabilities'))
        e = unique.get((scope, report_period, 'equity'))
        if a is not None and l is not None and e is not None:
            compared += 1
            if abs(a[0] - l[0] - e[0]) > a[1] + l[1] + e[1] + Decimal('0.01'):
                issues.append({'code': 'BALANCE_SHEET_TOTAL_MISMATCH', 'scope': scope, 'period': report_period})
    if not source or not target:
        unchecked.append('statement_context_unconfirmed')
    contexts = {(key[0], key[1]) for key in source}
    complete = bool(contexts) and source.keys() <= unique.keys() and all(
        (scope, report_period, metric_name) in unique
        for scope, report_period in contexts for metric_name in REQUIRED)
    if not complete:
        unchecked.append('main_statement_coverage_incomplete')
    return {'version': VERSION, 'status': 'mismatch' if issues else 'passed' if complete and not unchecked else 'not_checked',
            'compared': compared, 'issues': issues[:100], 'unchecked': sorted(set(unchecked))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--clean', type=Path, required=True)
    parser.add_argument('--input', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.clean, json.loads(args.input.read_text(encoding='utf-8'))), ensure_ascii=False))


if __name__ == '__main__':
    main()
