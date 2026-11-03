"""Check explicit current glossary definitions against complete locked intent.

This narrow guard never derives financial periods from source values or certifies
financial facts. Unsupported targets, grammar and scope remain needs_review.
"""
from __future__ import annotations

import calendar
from datetime import date
import re

from .template_manifest import node_text, sha
from .word_patch import q

TERM = re.compile(r'(?:报告期(?:末)?|(?:最近|近)([一二三四五六七八九十两]|10|[1-9])年(?:及|和)一期(?:末)?)')
CN_COUNT = dict(zip('一二三四五六七八九十', range(1, 11))) | {'两': 2}
GLOSSARY_TITLE = re.compile(r'(?:第[一二三四五六七八九十百\d]+[章节])?释义')
CURRENT_INTRO = re.compile(r'在?本募集(?:说明)?书中[，,]?(?:除非文中另有所指[，,]?)?下列词语具有如下含义[：:]?')
CURRENT_PREFIX = re.compile(r'^(?:在)?本募集(?:说明)?书中[，,]?')


def compact(value):
    return re.sub(r'\s+', '', value)


def locked_window(data):
    """Only the explicit target field is authoritative; never fall back to source."""
    target = data.get('target')
    details = target.get('details') if isinstance(target, dict) else None
    entries = details.get('target_reporting_periods') if isinstance(details, dict) else None
    if not isinstance(entries, list) or not 2 <= len(entries) <= 30:
        return None
    scopes = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get('status') != 'user_asserted' or entry.get('scope') not in ('consolidated', 'parent'):
            return None
        try:
            start, end = date.fromisoformat(entry['start']), date.fromisoformat(entry['end'])
        except (KeyError, TypeError, ValueError):
            return None
        if start.isoformat() != entry['start'] or end.isoformat() != entry['end'] or start != date(end.year, 1, 1):
            return None
        kind = entry.get('period_kind')
        if kind == 'annual':
            if end != date(end.year, 12, 31):
                return None
        elif kind == 'interim':
            if end.month not in (3, 6, 9) or end.day != calendar.monthrange(end.year, end.month)[1]:
                return None
        else:
            return None
        value = (start.isoformat(), end.isoformat(), kind)
        values = scopes.setdefault(entry['scope'], [])
        if value in values:
            return None
        values.append(value)
    windows = [sorted(values) for values in scopes.values()]
    if not windows or any(values != windows[0] for values in windows[1:]):
        return None
    values = windows[0]
    annual = [value for value in values if value[2] == 'annual']
    interim = [value for value in values if value[2] == 'interim']
    if len(interim) != 1 or not 1 <= len(annual) <= 10 or values[-1] != interim[0]:
        return None
    final_year = int(interim[0][1][:4])
    if [int(value[1][:4]) for value in annual] != list(range(final_year - len(annual), final_year)):
        return None
    if details.get('reporting_cutoff') not in (None, interim[0][1]):
        return None
    return {'flow': [(value[0], value[1]) for value in values],
            'stock': [value[1] for value in values], 'annual_count': len(annual),
            'authority': 'locked_target_intent_only'}


def definition_candidates(root):
    """Current scope needs an explicit prospectus intro; a heading alone is weak."""
    body = root.find(q('body'))
    if body is None:
        return []
    paragraphs = {node: index for index, node in enumerate(root.iter(q('p')))}
    rows = {node: index for index, node in enumerate(root.iter(q('tr')))}
    candidates = []
    state = None

    def add(node, term, definition, current, shape=True):
        text = node_text(node)
        candidates.append({'part': 'word/document.xml', 'kind': 'row' if node.tag == q('tr') else 'paragraph',
                           'index': rows[node] if node.tag == q('tr') else paragraphs[node],
                           'term': term, 'definition': definition, 'text_sha256': sha(text.encode()),
                           'current_scope_explicit': current, 'shape_supported': shape})

    for child in body:
        if child.tag == q('p'):
            text = compact(node_text(child))
            if not text:
                continue
            if GLOSSARY_TITLE.fullmatch(text):
                state = 'awaiting_intro'
                continue
            if state == 'awaiting_intro' and CURRENT_INTRO.fullmatch(text):
                state = 'current_definitions'
                continue
            prefix = CURRENT_PREFIX.match(text)
            candidate_text = text[prefix.end():] if prefix else text
            match = re.fullmatch(r'(' + TERM.pattern + r')(?:指|是|[：:])(.*)', candidate_text)
            if match:
                term = match.group(1)
                definition = match.group(3)
                add(child, term, definition, bool(prefix) or state == 'current_definitions')
                if prefix:
                    state = None
            else:
                state = None
        elif child.tag == q('tbl'):
            for row in child.findall(q('tr')):
                cells = row.findall(q('tc'))
                if len(cells) < 2:
                    continue
                term = compact(node_text(cells[0]))
                if not TERM.fullmatch(term):
                    continue
                definitions = [node_text(cell) for cell in cells[1:] if compact(node_text(cell)) not in ('', '指', '是')]
                shape = len(definitions) == 1 and not any(cell.find('.//' + q('tbl')) is not None for cell in cells)
                add(row, term, '\n'.join(definitions), state == 'current_definitions', shape)
        elif child.tag != q('sectPr'):
            state = None
    return candidates


def parse_values(text, stock):
    text = compact(text)
    if not text or len(text) > 1024:
        return None
    if text.endswith('。'):
        text = text[:-1]
    tokens = re.split(r'[、，,]|和|及', text)
    result = []
    for token in tokens:
        try:
            if stock:
                annual = re.fullmatch(r'(\d{4})年末', token)
                monthly = re.fullmatch(r'(\d{4})年(\d{1,2})月末', token)
                daily = re.fullmatch(r'(\d{4})年(\d{1,2})月(\d{1,2})日', token)
                if annual:
                    value = date(int(annual[1]), 12, 31)
                elif monthly:
                    year, month = map(int, monthly.groups())
                    value = date(year, month, calendar.monthrange(year, month)[1])
                elif daily:
                    value = date(*map(int, daily.groups()))
                    if value.day != calendar.monthrange(value.year, value.month)[1]:
                        return None
                else:
                    return None
                result.append(value.isoformat())
            else:
                annual = re.fullmatch(r'(\d{4})年度', token)
                interim = re.fullmatch(r'(\d{4})年1[-—–－~至](\d{1,2})月', token)
                if annual:
                    year, month = int(annual[1]), 12
                elif interim:
                    year, month = map(int, interim.groups())
                    if month not in (3, 6, 9):
                        return None
                else:
                    return None
                result.append((date(year, 1, 1).isoformat(), date(year, month, calendar.monthrange(year, month)[1]).isoformat()))
        except ValueError:
            return None
    return result if len(result) == len(set(result)) else None


def check_definitions(data, root):
    window = locked_window(data)
    definitions = definition_candidates(root)
    report = {'version': 'explicit-period-definition-v1', 'status': 'needs_review',
              'target_resolved': window is not None, 'definitions': [], 'conflicts': [],
              'financial_acceptance': 'not_run',
              'limitations': ['Only explicit current glossary definitions and complete calendar targets are comparable.',
                              'Unknown grammar, missing definitions and ambiguous scope remain needs_review.',
                              'History, ordinary body dates and financial facts are outside this guard.']}
    compared = 0
    for candidate in definitions:
        item = {**candidate, 'status': 'needs_review'}
        count = TERM.fullmatch(candidate['term']).group(1)
        count = CN_COUNT.get(count, int(count) if count and count.isdigit() else None)
        stock = candidate['term'].endswith('末')
        values = parse_values(candidate['definition'], stock) if candidate['shape_supported'] else None
        if not window:
            item['reason'] = 'target_not_resolved'
        elif not candidate['current_scope_explicit']:
            item['reason'] = 'current_scope_not_explicit'
        elif count is not None and count != window['annual_count']:
            item['reason'] = 'term_window_not_bound'
        elif values is None or len(values) != len(window['stock']):
            item['reason'] = 'definition_shape_not_bound'
        else:
            expected = window['stock' if stock else 'flow']
            compared += 1
            item.update(actual_periods=values, expected_periods=expected, reason='compared_to_locked_target',
                        status='consistent_in_scope' if sorted(values) == sorted(expected) else 'conflict')
            if item['status'] == 'conflict':
                report['conflicts'].append(item)
        report['definitions'].append(item)
    report['compared_count'] = compared
    if report['conflicts']:
        report['status'] = 'conflict'
    elif definitions and all(item['status'] == 'consistent_in_scope' for item in report['definitions']):
        report['status'] = 'consistent_in_scope'
    return report
