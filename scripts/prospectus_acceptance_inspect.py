"""Read private acceptance artifacts independently; never create review evidence.

Locators retain physical OOXML coordinates. Header geometry uses logical grid
intervals, and scope comes from a table row, its adjacent caption, or a bounded
section introduction. No content is rewritten to accommodate this reader.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

from openpyxl import load_workbook
from pypdf import PdfReader

from bondbuddy_file_authoring.check import package, resolve_revisions
from bondbuddy_file_authoring.source_outline import heading_role, outline, style_map
from bondbuddy_file_authoring.word_patch import paragraph_text, q, xml

LOCATOR = re.compile(
    r'(word/(?:document|header[0-9]+|footer[0-9]+|footnotes|endnotes)\.xml)'
    r'(?://w:p\[([1-9][0-9]*)\]|#table=([1-9][0-9]*),row=([1-9][0-9]*),cell=([1-9][0-9]*))'
)
PERIOD = r'20[0-9]{2}年[0-9]{1,2}(?:[-—–至][0-9]{1,2})?月(?:[0-9]{1,2}日|末)?|20[0-9]{2}-[0-9]{2}-[0-9]{2}'
NUMBER = r'-?[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?'
MONEY_UNIT = {'元': 'CNY', '万元': 'CNY_10K', '亿元': 'CNY_100M'}
STOCK = ('total_assets', 'total_liabilities', 'net_assets')
ALIASES = {
    'total_assets': ('总资产', '资产总额', '资产合计', '资产总计'),
    'total_liabilities': ('总负债', '负债总额', '负债合计', '负债总计'),
    'net_assets': ('净资产', '所有者权益', '所有者权益合计', '股东权益', '股东权益合计',
                   '所有者权益(或股东权益)合计'),
    'net_profit': ('净利润',),
    'nonoperating_expenses': ('营业外支出',),
    'operating_cash_flow': ('经营活动产生的现金流量净额', '经营活动现金流量净额', '经营性现金流量净额'),
}
HYPOTHETICAL = re.compile(r'备考|模拟|假设|发行后|预测')
UNITS = re.compile(r'单位[：:](?:人民币)?(?:元|万元|亿元)(?:[、,，/／](?:%|％))*')
CAPTION = re.compile(r'表[0-9一二三四五六七八九十]+(?:[-－—.．][0-9一二三四五六七八九十]+)*[：:]?.+')
OCCURRENCE_POLICY = 'rq-202509-occurrences-v1'
# Original-source coordinates define roles only. Clean-document coordinates are
# discovered from captions, structured ancestors and metric clauses below.
RQ_TABLE_ROLES = (
    (44, 26, 'consolidated', 'total_assets'), (44, 48, 'consolidated', 'total_liabilities'),
    (44, 59, 'consolidated', 'net_assets'), (45, 25, 'consolidated', 'net_profit'),
    (46, 12, 'consolidated', 'operating_cash_flow'), (47, 24, 'parent', 'total_assets'),
    (47, 43, 'parent', 'total_liabilities'), (47, 50, 'parent', 'net_assets'),
    (48, 24, 'parent', 'net_profit'), (49, 12, 'parent', 'operating_cash_flow'),
    (54, 2, 'consolidated', 'total_assets'), (54, 3, 'consolidated', 'total_liabilities'),
    (54, 5, 'consolidated', 'net_assets'), (54, 9, 'consolidated', 'net_profit'),
    (54, 10, 'consolidated', 'operating_cash_flow'), (55, 5, 'consolidated', 'total_assets'),
    (79, 5, 'consolidated', 'total_liabilities'), (98, 15, 'consolidated', 'net_profit'),
    (45, 22, 'consolidated', 'nonoperating_expenses'), (48, 21, 'parent', 'nonoperating_expenses'),
)
RQ_NARRATIVE_ROLES = (
    (46, 'consolidated', 'operating_cash_flow'), (285, 'consolidated', 'operating_cash_flow'),
    (4816, 'consolidated', 'total_assets'), (6865, 'consolidated', 'total_liabilities'),
    (7967, 'consolidated', 'net_profit'), (8017, 'consolidated', 'operating_cash_flow'),
    (7931, 'consolidated', 'nonoperating_expenses'),
)


def compact(value):
    return re.sub(r'\s+', '', value).replace('（', '(').replace('）', ')')


def number(value):
    return Decimal(str(value).replace(',', '').strip())


def metric_ok(value, metric, *, cell=False):
    value = compact(value)
    if cell:
        value = re.sub(r'^(?:[一二三四五六七八九十]+|[0-9]+)[、.．]', '', value)
        if metric == 'net_profit':
            value = re.sub(r'\(净?亏损[^()]*\)$', '', value)
        if metric == 'nonoperating_expenses':
            value = re.sub(r'^减[：:]', '', value)
        return value in ALIASES[metric]
    return bool(metric_mentions(value, metric))


def metric_mentions(value, metric):
    """Return whole metric mentions, excluding attribution and ratio labels."""
    value = compact(value)
    result = []
    for alias in sorted(ALIASES[metric], key=len, reverse=True):
        for match in re.finditer(re.escape(alias), value):
            prefix = value[:match.start()]
            suffix = value[match.end():]
            if re.search(r'(?:非?流动|固定|金融|其他|长期|短期|少数|净|归属于母公司|母公司|负债和|负债及)$', prefix):
                continue
            if re.match(r'(?:的)?(?:率|收益率|比率|增长率|占比|比例|比重)', suffix):
                continue
            if metric == 'net_profit' and re.search(r'(?:持续经营|终止经营|归属(?:于)?.{0,16})$', prefix):
                continue
            result.append(match.span())
    return result


def period_ok(value, metric, *, cell=False):
    value = compact(value)
    if cell:
        # A combined header explicitly names both the flow and stock period.
        # Do not accept inconsistent suffixes or choose a convenient substring.
        if re.fullmatch(r'2025年1[-—–至]9月[/／](?:2025年)?9月(?:末|30日)', value):
            return True
        periods = [value]
    else:
        periods = re.findall(PERIOD, value)
    if len(periods) != 1:
        return False
    if metric in STOCK:
        return periods[0] in ('2025年9月末', '2025年9月30日', '2025-09-30')
    return re.fullmatch(r'2025年1[-—–至]9月', periods[0]) is not None


def ordered_periods(value, metric):
    """Parse the complete real list, never a caller-declared period index."""
    tokens = re.split(r'[、,，]|和|及', compact(value))
    if not 2 <= len(tokens) <= 6 or any(not token for token in tokens):
        raise ValueError('ordered_period_list_required')
    result = []
    for token in tokens:
        annual = re.fullmatch(r'(20[0-9]{2})年(末|度)', token)
        stock = re.fullmatch(r'(20[0-9]{2})年([0-9]{1,2})月(末|[0-9]{1,2}日)', token)
        flow = re.fullmatch(r'(20[0-9]{2})年1[-—–至]([0-9]{1,2})月', token)
        if annual and annual[2] == ('末' if metric in STOCK else '度'):
            year = int(annual[1])
            end = date(year, 12, 31)
            start = end if metric in STOCK else date(year, 1, 1)
        elif stock and metric in STOCK:
            year, month = int(stock[1]), int(stock[2])
            if stock[3] == '末':
                # The fixed acceptance case supports real calendar quarter ends.
                if month not in (3, 6, 9, 12):
                    raise ValueError('unsupported_stock_period')
                day = 31 if month in (3, 12) else 30
            else:
                day = int(stock[3][:-1])
            start = end = date(year, month, day)
        elif flow and metric not in STOCK:
            year, month = int(flow[1]), int(flow[2])
            if month not in (3, 6, 9, 12):
                raise ValueError('unsupported_flow_period')
            start = date(year, 1, 1)
            end = date(year, month, 31 if month in (3, 12) else 30)
        else:
            raise ValueError('unambiguous_period_list_required')
        result.append((start.isoformat(), end.isoformat()))
    if any(left[1] >= right[1] for left, right in zip(result, result[1:])):
        raise ValueError('period_list_order_or_duplicate')
    return result


class Reader:
    def __init__(self, *, source=None, issuer=''):
        self.packages = {}
        self.roots = {}
        self.grids = {}
        self.occurrence_documents = {}
        self.issuer = compact(issuer)
        self.authorized_source = None
        self.compatible_caption = None
        if source is not None:
            manifest = json.loads((Path(__file__).resolve().parents[1] / 'tests/samples/2026-09-25/manifest.json').read_text(encoding='utf-8'))
            case = next(c for c in manifest['cases'] if c['case_id'] == 'rq-202509')
            baseline = next(f for f in case['files'] if f['file_id'] == 'rq-202509-01')
            if issuer == case['issuer'] and hashlib.sha256(Path(source).read_bytes()).hexdigest() == baseline['sha256']:
                self.authorized_source = str(source)
                # This one authorized source caption omits 发 in 发行人. Preserve
                # its exact text; never make 行人 a generic issuer/scope alias.
                expected = '表5-10最近两年及一期行人合并报表口径主要财务指标'
                original = self.node(str(source), 'word/document.xml#table=54,row=1,cell=1')
                if compact(paragraph_text(self.caption(original['table']))) == expected:
                    self.compatible_caption = (54, expected)

    def parts(self, path):
        if path not in self.packages:
            self.packages[path] = package(Path(path))
        return self.packages[path]

    def node(self, path, locator):
        match = LOCATOR.fullmatch(locator)
        if not match:
            raise ValueError('word_locator')
        story = match[1]
        key = (path, story)
        if key not in self.roots:
            self.roots[key] = resolve_revisions(xml(self.parts(path)[story]), True)
        root = self.roots[key]
        if match[2]:
            node = list(root.iter(q('p')))[int(match[2]) - 1]
            return {'story': story, 'root': root, 'node': node, 'table': None,
                    'text': paragraph_text(node)}
        table = list(root.iter(q('tbl')))[int(match[3]) - 1]
        row, cell = int(match[4]) - 1, int(match[5]) - 1
        node = table.findall(q('tr'))[row].findall(q('tc'))[cell]
        return {'story': story, 'root': root, 'node': node, 'table': table, 'table_index': int(match[3]), 'row': row, 'cell': cell,
                'text': ' '.join(paragraph_text(p) for p in node.iter(q('p')))}

    def anchor(self, path, spec, *, whole=False):
        result = self.node(path, spec['locator'])
        if not spec['quote'] or result['text'].count(spec['quote']) != 1:
            raise ValueError('anchor_not_unique')
        if whole and compact(result['text']) != compact(spec['quote']):
            raise ValueError('whole_anchor_required')
        return result

    def grid(self, table):
        if table in self.grids:
            return self.grids[table]
        width = len(table.findall(q('tblGrid') + '/' + q('gridCol')))
        if not width:
            raise ValueError('table_grid_required')
        rows = []
        for row in table.findall(q('tr')):
            before = row.find(q('trPr') + '/' + q('gridBefore'))
            after = row.find(q('trPr') + '/' + q('gridAfter'))
            start = int(before.get(q('val'))) if before is not None else 0
            trailing = int(after.get(q('val'))) if after is not None else 0
            if start < 0 or trailing < 0:
                raise ValueError('table_grid_invalid')
            cells = []
            for node in row.findall(q('tc')):
                span = node.find(q('tcPr') + '/' + q('gridSpan'))
                size = int(span.get(q('val'))) if span is not None else 1
                if size < 1:
                    raise ValueError('table_grid_invalid')
                cells.append((start, start + size, node))
                start += size
            if start + trailing != width:
                raise ValueError('table_grid_invalid')
            rows.append(cells)
        self.grids[table] = rows
        return rows

    def interval(self, location):
        return self.grid(location['table'])[location['row']][location['cell']][:2]

    @staticmethod
    def same_table(left, right):
        return left['story'] == right['story'] and left['table'] is not None and left['table'] is right['table']

    @staticmethod
    def scope_text(value, row):
        value = compact(value)
        scope, other = ('合并', '母公司') if row['scope'] == 'consolidated' else ('母公司', '合并')
        if scope not in value or other in value or HYPOTHETICAL.search(value):
            raise ValueError('scope_anchor')
        families = ('资产负债表', '利润表', '现金流量表')
        expected = '资产负债表' if row['metric'] in STOCK else '利润表' if row['metric'] in ('net_profit', 'nonoperating_expenses') else '现金流量表'
        if any(family in value for family in families) and expected not in value:
            raise ValueError('scope_statement_kind')

    def issuer_scope(self, value, amount=None, *, analysis_caption=False):
        value = compact(value)
        if re.search(r'子公司|其他公司|其他企业|被投资企业|关联方', value):
            raise ValueError('other_entity_scope')
        if amount is not None and amount['story'] == 'word/document.xml' and self.compatible_caption == (amount['table_index'], value):
            return
        if self.issuer:
            value = value.replace(self.issuer, '发行人')
        # A standalone issuer marker is not enough when an unknown named entity
        # occurs between it and the scope. Recognize the actual caption grammar.
        if amount is not None:
            number = r'[0-9一二三四五六七八九十]+(?:[-－—.．][0-9一二三四五六七八九十]+)*'
            period = r'(?:(?:最近|近)?[一二三四五六七八九十两0-9]+年(?:及|和)[一二三四五六七八九十两0-9]+期末?)?'
            if analysis_caption:
                # Neutral analysis captions inherit scope, never entity identity.
                tail = r'(?:资产结构情况|负债结构情况表?|主要盈利能力指标|现金流量(?:情况|分析)|主要财务指标)'
            else:
                tail = r'(?:合并|母公司)(?:资产负债表|利润表|现金流量表|报表口径主要财务指标)'
            if re.fullmatch(r'表' + number + r'[：:]?' + period + r'发行人' + period + tail, value):
                return
        elif re.match(r'^发行人管理层(?:结合|根据|依据)', value):
            return
        raise ValueError('explicit_issuer_scope_required')

    @staticmethod
    def transparent(node):
        if node.tag in (q('bookmarkStart'), q('bookmarkEnd'), q('proofErr')):
            return True
        if node.tag != q('p'):
            return False
        if any(n.tag in (q('drawing'), q('object'), q('pict')) for n in node.iter()):
            return False
        value = compact(paragraph_text(node))
        return not value or UNITS.fullmatch(value) is not None

    def caption(self, table):
        # No intervening table, heading, or substantive paragraph may be crossed.
        node = table.getprevious()
        for _ in range(16):
            if node is None:
                break
            if not self.transparent(node):
                if node.tag == q('p') and CAPTION.fullmatch(compact(paragraph_text(node))):
                    return node
                break
            node = node.getprevious()
        raise ValueError('adjacent_table_caption_required')

    def table_scope(self, path, spec, amount, row):
        scope = self.anchor(path, spec['scope_anchor'], whole=True)
        self.scope_text(scope['text'], row)
        if self.same_table(amount, scope):
            if scope['row'] >= amount['row']:
                raise ValueError('table_scope_geometry')
            title = compact(scope['text'])
            if not re.fullmatch(r'(?:合并|母公司)(?:(?:财务)?报表(?:口径)?|口径|资产负债表|利润表|现金流量表)?', title):
                raise ValueError('explicit_table_scope_required')
            for _, _, node in self.grid(amount['table'])[scope['row']]:
                text = compact(' '.join(paragraph_text(p) for p in node.iter(q('p'))))
                if text and node is not scope['node']:
                    raise ValueError('ambiguous_table_scope_row')
            other = '母公司' if row['scope'] == 'consolidated' else '合并'
            for cells in self.grid(amount['table'])[scope['row'] + 1:amount['row']]:
                for _, _, node in cells:
                    text = compact(' '.join(paragraph_text(p) for p in node.iter(q('p'))))
                    if re.match(r'(?:合并|母公司)(?:(?:财务)?报表(?:口径)?|口径|资产负债表|利润表|现金流量表)?$', text) and other in text:
                        raise ValueError('overridden_table_scope')
                    if HYPOTHETICAL.search(text):
                        raise ValueError('hypothetical_table_scope')
            return
        if scope['story'] != amount['story'] or scope['table'] is not None:
            raise ValueError('same_story_scope_required')
        caption = self.caption(amount['table'])
        if 'scope_section_anchor' not in spec:
            if scope['node'] is not caption:
                raise ValueError('adjacent_caption_scope_required')
            self.issuer_scope(scope['text'], amount)
            return
        title = self.anchor(path, spec['table_caption'], whole=True)
        section = self.anchor(path, spec['scope_section_anchor'], whole=True)
        if title['story'] != amount['story'] or title['node'] is not caption or HYPOTHETICAL.search(title['text']):
            raise ValueError('table_caption_binding')
        self.issuer_scope(title['text'], amount, analysis_caption=True)
        # Even with section inheritance a caption cannot contradict the scope.
        other = '母公司' if row['scope'] == 'consolidated' else '合并'
        if other in title['text']:
            raise ValueError('conflicting_caption_scope')
        parent = amount['table'].getparent()
        if section['story'] != amount['story'] or section['node'].getparent() is not parent or scope['node'].getparent() is not parent:
            raise ValueError('scope_section_parent')
        styles = style_map(self.parts(path))
        role = heading_role(section['node'], styles)
        if not role or role['kind'] != 'heading' or role['recognition'] not in ('outline', 'style'):
            raise ValueError('structured_scope_section_required')
        siblings = list(parent)
        begin, intro, end = siblings.index(section['node']), siblings.index(scope['node']), siblings.index(amount['table'])
        if not begin < intro < end:
            raise ValueError('scope_section_order')
        if any(not self.transparent(node) for node in siblings[begin + 1:intro]):
            raise ValueError('scope_must_be_section_introduction')
        value = compact(scope['text'])
        self.issuer_scope(value)
        if not re.match(r'(?:发行人|公司)?管理层(?:结合|根据|依据).{0,80}(?:合并|母公司)财务报表', value) or '分析' not in value:
            raise ValueError('explicit_section_scope_required')
        for node in siblings[intro + 1:end]:
            if node.tag != q('p'):
                continue
            value = compact(paragraph_text(node))
            boundary = heading_role(node, styles)
            if boundary and boundary['kind'] == 'heading':
                if boundary['recognition'] in ('outline', 'style') and boundary['level'] <= role['level']:
                    raise ValueError('scope_section_boundary')
                if other in value or HYPOTHETICAL.search(value):
                    raise ValueError('conflicting_scope_heading')
            if re.search(other + r'(?:财务报表|报表口径|口径|资产负债表|利润表|现金流量表)', value):
                raise ValueError('conflicting_scope_context')

    def table_geometry(self, path, spec, amount, row):
        period = self.anchor(path, spec['period_anchor'], whole=True)
        metric = self.anchor(path, spec['metric_anchor'], whole=True)
        if not self.same_table(amount, period) or not self.same_table(amount, metric):
            raise ValueError('same_table_anchors_required')
        a, b = self.interval(amount)
        pa, pb = self.interval(period)
        ma, mb = self.interval(metric)
        if b - a != 1 or not pa <= a < b <= pb or period['row'] >= amount['row'] or metric['row'] != amount['row'] or mb > a:
            raise ValueError('table_header_geometry')
        if any(location['node'].find(q('tcPr') + '/' + q('vMerge')) is not None for location in (amount, period, metric)):
            raise ValueError('vertical_merged_financial_anchor_unsupported')
        if not period_ok(period['text'], row['metric'], cell=True):
            raise ValueError('cell_period_anchor')
        if not metric_ok(metric['text'], row['metric'], cell=True):
            raise ValueError('cell_metric_anchor')
        # A broad merged period does not make its percentage subcolumn money.
        # A later period header overrides the earlier one in the same grid column.
        for cells in self.grid(amount['table'])[period['row'] + 1:amount['row']]:
            for start, finish, node in cells:
                if start <= a < b <= finish:
                    value = compact(' '.join(paragraph_text(p) for p in node.iter(q('p'))))
                    if re.search(r'比例|占比|比重|百分比|[%％]', value) or re.search(PERIOD, value):
                        raise ValueError('overridden_or_percentage_header')
        self.table_scope(path, spec, amount, row)

    def bounded_introduction(self, path, section, intro, target, row):
        parent = target['node'].getparent()
        if target['story'] != 'word/document.xml' or any(n['story'] != target['story'] or n['node'].getparent() is not parent for n in (section, intro)):
            raise ValueError('period_context_parent')
        styles = style_map(self.parts(path))
        role = heading_role(section['node'], styles)
        if not role or role['kind'] != 'heading' or role['recognition'] not in ('outline', 'style'):
            raise ValueError('structured_period_section_required')
        siblings = list(parent)
        begin, middle, end = [siblings.index(n['node']) for n in (section, intro, target)]
        if not begin < middle < end or any(not self.transparent(node) for node in siblings[begin + 1:middle]):
            raise ValueError('first_period_introduction_required')
        self.scope_text(intro['text'], row)
        self.issuer_scope(intro['text'])
        other = '母公司' if row['scope'] == 'consolidated' else '合并'
        for node in siblings[middle + 1:end]:
            if node.tag != q('p'):
                continue
            text = compact(paragraph_text(node))
            boundary = heading_role(node, styles)
            if boundary and boundary['kind'] == 'heading':
                if boundary['recognition'] in ('outline', 'style') and boundary['level'] <= role['level']:
                    raise ValueError('period_section_boundary')
                if other in text or HYPOTHETICAL.search(text):
                    raise ValueError('conflicting_period_scope')
            if re.search(other + r'(?:财务报表|报表口径|口径|资产负债表|利润表|现金流量表)', text):
                raise ValueError('conflicting_period_context')
            if re.search(r'(?:本节|本段|下文|以下).{0,8}(?:报告期|报告期间|期间)(?:为|是|采用|改为|调整为)', text):
                raise ValueError('local_period_redefinition_unsupported')

    def defined_periods(self, path, spec, location, expression, row):
        definition = spec['reporting_period_definition']
        section = self.anchor(path, definition['section_anchor'], whole=True)
        term = self.anchor(path, definition['term_anchor'], whole=True)
        values = self.anchor(path, definition['definition_anchor'], whole=True)
        expected_term = '最近两年及一期末' if row['metric'] in STOCK else '最近两年及一期'
        if compact(section['text']) != '释义' or compact(term['text']) != expected_term:
            raise ValueError('actual_glossary_term_required')
        if not self.same_table(term, values) or term['row'] != values['row'] or term['cell'] >= values['cell']:
            raise ValueError('glossary_definition_geometry')
        if location['story'] != 'word/document.xml' or term['story'] != location['story'] or section['story'] != location['story']:
            raise ValueError('main_story_glossary_required')
        parent = term['table'].getparent()
        if section['node'].getparent() is not parent or location['node'].getparent() is not parent:
            raise ValueError('glossary_section_parent')
        styles = style_map(self.parts(path))
        role = heading_role(section['node'], styles)
        if not role or role['kind'] != 'heading' or role['level'] != 0 or role['recognition'] not in ('outline', 'style'):
            raise ValueError('actual_glossary_heading_required')
        siblings = list(parent)
        begin, end = siblings.index(section['node']), siblings.index(term['table'])
        if begin >= end:
            raise ValueError('glossary_section_order')
        body = [node for node in siblings[begin + 1:end] if not self.transparent(node)]
        declaration = '在本募集说明书中，除非文中另有所指，下列词语具有如下含义：'
        if not body or body[0].tag != q('p') or compact(paragraph_text(body[0])) != declaration:
            raise ValueError('actual_glossary_declaration_required')
        for node in body:
            boundary = heading_role(node, styles) if node.tag == q('p') else None
            if boundary and boundary['kind'] == 'heading' and boundary['recognition'] in ('outline', 'style') and boundary['level'] == 0:
                raise ValueError('glossary_section_boundary')
        for index, (start, finish, node) in enumerate(self.grid(term['table'])[term['row']]):
            text = compact(' '.join(paragraph_text(p) for p in node.iter(q('p'))))
            if finish - start != 1 or node.find(q('tcPr') + '/' + q('vMerge')) is not None:
                raise ValueError('simple_glossary_row_required')
            if index not in (term['cell'], values['cell']) and text not in ('', '指'):
                raise ValueError('ambiguous_glossary_definition')
        if expression == expected_term:
            if 'period_context' in spec:
                raise ValueError('unexpected_period_context')
        elif expression == '报告期内' and row['metric'] not in STOCK:
            context = spec['period_context']
            heading = self.anchor(path, context['section_anchor'], whole=True)
            intro = self.anchor(path, context['introduction_anchor'], whole=True)
            self.bounded_introduction(path, heading, intro, location, row)
            if compact(intro['text']).count(expected_term) != 1 or '最近两年及一期末' in compact(intro['text']):
                raise ValueError('defined_term_in_section_required')
        else:
            raise ValueError('explicit_defined_period_reference_required')
        return ordered_periods(values['text'], row['metric'])

    def narrative_list_span(self, path, spec, location, row):
        quote = spec['quote']
        other = '母公司' if row['scope'] == 'consolidated' else '合并'
        index = location['text'].index(quote)
        before, after = location['text'][:index].rstrip(), location['text'][index + len(quote):].lstrip()
        terminators = '。；;！？!?'
        if before and before[-1] not in terminators or quote.rstrip()[-1] not in terminators and after and after[0] not in terminators:
            raise ValueError('complete_actual_clause_boundaries_required')
        # A document-wide default cannot override an explicit local context.
        # Later attribution/comparison clauses do not change this clause's scope.
        context = before + quote
        if other in context or HYPOTHETICAL.search(context) or re.search(r'子公司|担保人|其他公司|其他企业|被投资企业|关联方', context):
            raise ValueError('competing_narrative_entity_or_scope')
        if quote.count('分别为') != 1 or location['table'] is not None or any(a.tag == q('tc') for a in location['node'].iterancestors()):
            raise ValueError('single_metric_list_clause_required')
        head, tail = quote.split('分别为')
        comma = re.fullmatch(r'(.+?)[，,]([^，,]+)', head)
        if not comma:
            raise ValueError('complete_period_and_metric_clause_required')
        expression, label = compact(comma[1]), compact(comma[2])
        label = re.sub(r'^(?:发行人|公司|本公司)(?:的)?', '', label)
        scope_label = re.match(r'^(合并|母公司)(?:口径)?', label)
        if scope_label:
            if scope_label[1] != ('合并' if row['scope'] == 'consolidated' else '母公司'):
                raise ValueError('narrative_list_scope')
            label = label[scope_label.end():]
        if not metric_ok(label, row['metric'], cell=True):
            raise ValueError('single_exact_list_metric_required')
        if expression in ('最近两年及一期', '最近两年及一期末', '报告期内'):
            periods = self.defined_periods(path, spec, location, expression, row)
        else:
            if 'reporting_period_definition' in spec or 'period_context' in spec:
                raise ValueError('unexpected_period_definition')
            periods = ordered_periods(expression, row['metric'])
        token = rf'{NUMBER}\s*(?:亿元|万元|元)'
        ending = r'(?:[。；;]|，明细如下：)?' if row['metric'] == 'nonoperating_expenses' else r'[。；;]?'
        if not re.fullmatch(rf'\s*{token}(?:\s*[、,，及和]\s*{token})+\s*{ending}\s*', tail):
            raise ValueError('complete_uniform_money_list_required')
        amounts = list(re.finditer(rf'(?P<amount>{NUMBER})\s*(?P<unit>亿元|万元|元)', tail))
        if len(periods) != len(amounts):
            raise ValueError('period_amount_count_mismatch')
        for match in amounts:
            text = match['amount'].replace(',', '')
            places = len(text.split('.')[1]) if '.' in text else 0
            if MONEY_UNIT[match['unit']] != row['output']['unit'] or places != row['output']['decimal_places']:
                raise ValueError('list_unit_or_precision_mismatch')
        target = ('2025-09-30' if row['metric'] in STOCK else '2025-01-01', '2025-09-30')
        if periods.count(target) != 1:
            raise ValueError('unique_target_list_period_required')
        selected = amounts[periods.index(target)]
        offset = len(head) + len('分别为')
        return offset + selected.start('amount'), offset + selected.end('amount')

    def output_value(self, path, spec, row):
        if not isinstance(spec, dict):
            raise ValueError('precise_output_location_required')
        location = self.node(path, spec['locator'])
        value = location['text']
        if 'quote' in spec:
            scope = self.anchor(path, spec['scope_anchor'])
            default_scope = '本募集说明书其他章节中若无特殊说明，则财务数据及财务指标均为合并口径。'
            if (spec.get('narrative_list') and spec['scope_anchor']['quote'] == default_scope
                    and scope['story'] == 'word/document.xml' and scope['node'].getparent().tag == q('body')
                    and scope['node'].getparent() is location['node'].getparent()
                    and row['scope'] == 'consolidated'):
                if sum(paragraph_text(p).count(default_scope) for p in scope['root'].iter(q('p')) if p.getparent().tag == q('body')) != 1:
                    raise ValueError('unique_global_scope_clause_required')
                self.scope_text(default_scope, row)
            else:
                self.scope_text(scope['text'], row)
            quote, start, end = spec['quote'], spec['start'], spec['end']
            if value.count(quote) != 1:
                raise ValueError('unique_quote_required')
            if not spec.get('narrative_list') and (not period_ok(quote, row['metric']) or not metric_ok(quote, row['metric'])):
                raise ValueError('precise_period_context')
            if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(quote):
                raise ValueError('amount_span')
            if spec.get('narrative_list'):
                if (start, end) != self.narrative_list_span(path, spec, location, row):
                    raise ValueError('target_list_amount_span')
            else:
                periods = list(re.finditer(PERIOD, quote))
                amounts = [m for m in re.finditer(NUMBER, quote) if not any(m.start() < p.end() and p.start() < m.end() for p in periods)]
                if len(amounts) != 1 or (start, end) != amounts[0].span():
                    raise ValueError('ambiguous_amount_span')
            amount = quote[start:end]
            if not re.fullmatch(NUMBER, amount) or start and quote[start - 1] in '0123456789,.' or end < len(quote) and quote[end] in '0123456789,.':
                raise ValueError('partial_amount')
            if quote[end:].lstrip().startswith(('%', '％')):
                raise ValueError('percentage_is_not_amount')
            if quote[:start].rstrip().endswith(('(', '（')) and quote[end:].lstrip().startswith((')', '）')):
                raise ValueError('parenthesized_amount_unsupported')
            identity = (spec['locator'], value.index(quote) + start, value.index(quote) + end)
        else:
            amount = value.strip()
            if location['table'] is None or not re.fullmatch(NUMBER, amount):
                raise ValueError('single_numeric_cell_required')
            self.table_geometry(path, spec, location, row)
            identity = (spec['locator'], 'whole_cell')
        if number(amount) != number(row['output']['value']):
            raise ValueError('output_value')
        return identity

    def occurrence_document(self, path):
        """Use actual structured ancestors, excluding TOC/text-only candidates."""
        if path in self.occurrence_documents:
            return self.occurrence_documents[path]
        root = self.node(path, 'word/document.xml//w:p[1]')['root']
        body = root.find(q('body'))
        if body is None:
            raise ValueError('occurrence_body_required')
        paragraphs, tables = list(root.iter(q('p'))), list(root.iter(q('tbl')))
        p_indices = {node: index for index, node in enumerate(paragraphs)}
        t_indices = {node: index + 1 for index, node in enumerate(tables)}
        roles = {h['paragraph']: h for h in outline(self.parts(path))['headings']
                 if h['recognition'] in ('outline', 'style')}
        contexts, stack = {}, []
        for node in body:
            heading = roles.get(p_indices.get(node)) if node.tag == q('p') else None
            if heading:
                while stack and stack[-1][0] >= heading['level']:
                    stack.pop()
                stack.append((heading['level'], compact(heading['text'])))
            contexts[node] = tuple(stack)
        result = {'root': root, 'body': body, 'paragraphs': paragraphs, 'tables': tables,
                  'paragraph_indices': p_indices, 'table_indices': t_indices, 'contexts': contexts}
        self.occurrence_documents[path] = result
        return result

    @staticmethod
    def metric_list_clauses(value, metric):
        """Locate the complete source-shaped metric clause, independent of evidence."""
        result = []
        for match in re.finditer(r'[^。；;！？!?]+(?:[。；;！？!?]|$)', value):
            clause = match[0]
            if clause.count('分别为') != 1:
                continue
            head = clause.split('分别为')[0]
            comma = re.fullmatch(r'(.+?)[，,]([^，,]+)', head)
            if not comma:
                continue
            expression, label = compact(comma[1]), compact(comma[2])
            label = re.sub(r'^(?:发行人|公司|本公司)(?:的)?', '', label)
            label = re.sub(r'^(?:合并|母公司)(?:口径)?', '', label)
            if not metric_ok(label, metric, cell=True):
                continue
            if expression not in ('最近两年及一期', '最近两年及一期末', '报告期内'):
                try:
                    ordered_periods(expression, metric)
                except ValueError:
                    continue
            result.append((match.start(), match.end()))
        return result

    @staticmethod
    def unsupported_metric_lists(value, metric):
        """Retained monetary lists cannot disappear through parser rejection.

        This intentionally recognizes a wider shape than the validated list
        grammar. An unknown connector or reporting-period expression needs
        review; a nearby supported copy cannot replace that retained clause.
        """
        supported = set(Reader.metric_list_clauses(value, metric))
        result = []
        for match in re.finditer(r'[^。；;！？!?]+(?:[。；;！？!?]|$)', value):
            if (match.start(), match.end()) in supported:
                continue
            clause = compact(match[0])
            for _, end in metric_mentions(clause, metric):
                tail = clause[end:]
                amounts = [m for m in re.finditer(NUMBER, tail)
                           if not tail[m.end():].startswith(('%', '％', '年', '月'))]
                if len(amounts) >= 2 and re.search(NUMBER + r'(?:亿元|万元|元)', tail):
                    result.append((match.start(), match.end()))
                    break
        return result

    def target_amount_candidates(self, path, document, table, metric, source_interval):
        """Find the current amount under its real header in the retained grid slot."""
        candidates = []
        grid = self.grid(table)
        for ri, cells in enumerate(grid):
            if not cells or not metric_ok(' '.join(paragraph_text(p) for p in cells[0][2].iter(q('p'))), metric, cell=True):
                continue
            for ci, (a, b, node) in enumerate(cells):
                amount = ' '.join(paragraph_text(p) for p in node.iter(q('p'))).strip()
                if (a, b) != source_interval or b - a != 1 or not re.fullmatch(NUMBER, amount):
                    continue
                if node.find(q('tcPr') + '/' + q('vMerge')) is not None:
                    continue
                valid_header = False
                for pr, headers in enumerate(grid[:ri]):
                    for pa, pb, header in headers:
                        value = ' '.join(paragraph_text(p) for p in header.iter(q('p')))
                        if not pa <= a < b <= pb or not period_ok(value, metric, cell=True):
                            continue
                        if header.find(q('tcPr') + '/' + q('vMerge')) is not None:
                            continue
                        overridden = any(
                            re.search(r'比例|占比|比重|百分比|[%％]', text) or re.search(PERIOD, text)
                            for lower in grid[pr + 1:ri] for la, lb, cell in lower if la <= a < b <= lb
                            for text in [compact(' '.join(paragraph_text(p) for p in cell.iter(q('p'))))])
                        if not overridden:
                            valid_header = True
                if valid_header:
                    loc = f'word/document.xml#table={document["table_indices"][table]},row={ri + 1},cell={ci + 1}'
                    candidates.append((loc, 'whole_cell'))
        return candidates

    def required_occurrence_targets(self, clean):
        if self.authorized_source is None:
            raise ValueError('authorized_occurrence_source_required')
        source = self.occurrence_document(self.authorized_source)
        output = self.occurrence_document(clean)
        required = []
        for table_number, row_number, scope, metric in RQ_TABLE_ROLES:
            role = f'table:{table_number}:{scope}:{metric}'
            table = source['tables'][table_number - 1]
            source_location = self.node(self.authorized_source,
                f'word/document.xml#table={table_number},row={row_number},cell=2')
            if table not in source['contexts'] or not metric_ok(
                    paragraph_text(table.findall(q('tr'))[row_number - 1].findall(q('tc'))[0].find(q('p'))), metric, cell=True):
                raise ValueError('authorized_occurrence_table_shape_changed')
            caption = compact(paragraph_text(self.caption(table)))
            context = source['contexts'][table]
            tables = []
            for candidate in output['tables']:
                if output['contexts'].get(candidate) != context:
                    continue
                try:
                    if compact(paragraph_text(self.caption(candidate))) == caption:
                        tables.append(candidate)
                except ValueError:
                    continue
            candidates = []
            if len(tables) == 1:
                candidates = self.target_amount_candidates(clean, output, tables[0], metric, self.interval(source_location))
            required.append({'role': role, 'scope': scope, 'metric': metric, 'kind': 'table',
                             'candidates': candidates, 'ambiguous': len(tables) > 1 or len(candidates) > 1})
        for paragraph_number, scope, metric in RQ_NARRATIVE_ROLES:
            paragraph = source['paragraphs'][paragraph_number - 1]
            if paragraph not in source['contexts'] or len(self.metric_list_clauses(paragraph_text(paragraph), metric)) != 1:
                raise ValueError('authorized_occurrence_narrative_shape_changed')
            context = source['contexts'][paragraph]
            candidates = []
            unsupported = []
            for candidate in output['body']:
                if candidate.tag != q('p') or output['contexts'].get(candidate) != context:
                    continue
                text = paragraph_text(candidate)
                unsupported.extend(self.unsupported_metric_lists(text, metric))
                for start, end in self.metric_list_clauses(text, metric):
                    loc = f'word/document.xml//w:p[{output["paragraph_indices"][candidate] + 1}]'
                    candidates.append((loc, start, end))
            required.append({'role': f'narrative:{paragraph_number}:{scope}:{metric}',
                             'scope': scope, 'metric': metric, 'kind': 'narrative_list',
                             'candidates': candidates, 'ambiguous': len(candidates) > 1,
                             'unsupported': bool(unsupported)})
        return required

    def occurrence_coverage(self, clean, verified):
        required_count = len(RQ_TABLE_ROLES) + len(RQ_NARRATIVE_ROLES)
        result = {'policy': OCCURRENCE_POLICY, 'status': 'failed', 'required_count': required_count,
                  'located_count': 0, 'covered_count': 0, 'covered_role_ids': [], 'failures': []}
        try:
            targets = self.required_occurrence_targets(clean)
        except (ValueError, KeyError, IndexError, TypeError):
            result['failures'].append({'code': 'authorized_source_roles_unavailable'})
            return result
        used = set()
        for target in targets:
            role, candidates = target['role'], target['candidates']
            if target.get('unsupported'):
                result['failures'].append({'role': role, 'code': 'unsupported_occurrence_clause'})
                continue
            if target['ambiguous'] or len(candidates) != 1:
                result['failures'].append({'role': role, 'code': 'ambiguous_or_missing_occurrence'})
                continue
            result['located_count'] += 1
            candidate = candidates[0]
            matches = []
            for record in verified:
                identity = record['identity']
                if (record['scope'], record['metric'], record['kind']) != (target['scope'], target['metric'], target['kind']):
                    continue
                if target['kind'] == 'table':
                    matches_role = identity == candidate
                else:
                    matches_role = (identity[0] == candidate[0] and len(identity) == 3
                                    and candidate[1] <= identity[1] < identity[2] <= candidate[2])
                if matches_role:
                    matches.append(identity)
            if len(matches) != 1 or matches[0] in used:
                result['failures'].append({'role': role, 'code': 'required_occurrence_not_independently_checked'})
                continue
            used.add(matches[0])
            result['covered_role_ids'].append(role)
        result['covered_count'] = len(result['covered_role_ids'])
        if len(targets) == result['located_count'] == result['covered_count'] == required_count and not result['failures']:
            result['status'] = 'passed'
        return result


def inspect(source_path, pdfs, data):
    source = outline(package(Path(source_path)))
    chapters = ['preamble'] + ['p:' + str(h['paragraph']) + ':' + hashlib.sha256(h['text'].encode()).hexdigest()
                               for h in source['headings'] if h['level'] == 0]
    pages = [len(PdfReader(p).pages) for p in pdfs]
    reader, books, failures, verified = Reader(source=source_path, issuer=data.get('issuer', '')), {}, [], []
    try:
        for index, row in enumerate(data['financial_checks']):
            try:
                src = row['source']
                path = data['materials'][src['file_id']]
                if not path.lower().endswith('.xlsx'):
                    raise ValueError('unsupported_financial_source')
                sheet, cell = src['locator'].rsplit('!', 1)
                if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]*', cell):
                    raise ValueError('cell_locator')
                if path not in books:
                    books[path] = load_workbook(path, data_only=True, read_only=True)
                if number(books[path][sheet][cell].value) != number(src['value']):
                    raise ValueError('source_value')
                seen = set()
                for locator in row['output']['locators']:
                    identity = reader.output_value(data['clean'], locator, row)
                    if identity in seen:
                        raise ValueError('duplicate_amount_span')
                    seen.add(identity)
                    verified.append({'scope': row['scope'], 'metric': row['metric'], 'identity': identity,
                                     'kind': 'narrative_list' if locator.get('narrative_list') is True else 'table' if 'quote' not in locator else 'narrative'})
            except Exception:
                failures.append(index)
    finally:
        for book in books.values():
            book.close()
    return {'chapter_ids': chapters, 'pages': pages, 'financial_failures': failures,
            'fixed_occurrence_coverage': reader.occurrence_coverage(data['clean'], verified)}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1], sys.argv[2:], json.load(sys.stdin))))
