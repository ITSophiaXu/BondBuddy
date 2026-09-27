"""Offline source extraction for #20 -> #19. Does not approve/enable a taxonomy.

Only the pinned official DOCX is supported. Paragraphs inside merged table cells
are preserved; known multi-code rows are split using explicit original anchors.
No model, network, public enum, issuer inference or production registry writes.
"""
from collections import Counter
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'knowledge/exchange-bonds/verification/2026-09-27-industry'
DOCX_SHA = 'c8c16f572f40a5028331d6914b6d32d45581d701d4fbab3f9b903fe68ba7fff7'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
LEVELS = ('section', 'manufacturing_subsection', 'division', 'group')
PATTERNS = (r'[A-S]', r'C[A-J]', r'\d{2}', r'\d{3}')


class GuidelineParser(HTMLParser):
    """Extract paragraphs only inside the official article's #zoom element."""
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.skip = 0
        self.current = None
        self.paragraphs = []

    def handle_starttag(self, tag, attrs):
        if tag == 'div':
            if self.depth:
                self.depth += 1
            elif dict(attrs).get('id') == 'zoom':
                self.depth = 1
        if self.depth and tag in ('script', 'style'):
            self.skip += 1
        if self.depth and tag == 'p' and not self.skip:
            self.current = []

    def handle_endtag(self, tag):
        if self.depth and tag in ('script', 'style'):
            self.skip -= 1
        if self.depth and tag == 'p' and self.current is not None:
            value = ''.join(self.current).strip()
            if value:
                self.paragraphs.append(value)
            self.current = None
        if self.depth and tag == 'div':
            self.depth -= 1

    def handle_data(self, data):
        if self.depth and not self.skip and self.current is not None:
            self.current.append(data)


def read_rows(path):
    if sha256(path.read_bytes()).hexdigest() != DOCX_SHA:
        raise ValueError('Official code table hash changed; review a new version before extraction')
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
    rows = []
    for ti, table in enumerate(root.findall('.//w:tbl', NS), 1):
        for ri, row in enumerate(table.findall('./w:tr', NS), 1):
            cells = [
                [''.join(t.text or '' for t in p.findall('.//w:t', NS))
                 for p in cell.findall('./w:p', NS)]
                for cell in row.findall('./w:tc', NS)
            ]
            rows.append({'anchor': f'T{ti:02d}-R{ri:03d}', 'table': ti, 'row': ri, 'cells': cells})
    return rows


def split_row(row):
    """Return column, code, name, description, and 1-based paragraph positions."""
    cells = [[p.strip() for p in c] for c in row['cells']]
    if row['anchor'] == 'T01-R014':
        # The original row contains division 02 plus groups 021/022. Adjacent
        # blank continuation rows are not additional industry records.
        assert cells[2] == ['02'] and cells[3] == ['', '021', '022']
        return [(2, '02', cells[4][0], cells[5][0], 1, 1, 1),
                (3, '021', cells[4][1], cells[5][1], 2, 2, 2),
                (3, '022', cells[4][2], cells[5][2], 3, 3, 3)]
    if row['anchor'] == 'T02-R144':
        # A blank paragraph in code/name columns has no matching blank in the
        # description column. Zipping paragraphs by index would lose code 278.
        assert cells[3] == ['277', '', '278']
        return [(3, '277', cells[4][0], cells[5][0], 1, 1, 1),
                (3, '278', cells[4][2], cells[5][1], 3, 3, 2)]
    if not any(p for cell in cells for p in cell):
        return []
    if cells[0] in (['代    码'], ['门类']):
        return []
    if len(cells) != 6:
        raise ValueError(f'Unexpected cell structure: {row["anchor"]}')
    codes = [(col, p, pi) for col in range(4)
             for pi, p in enumerate(cells[col], 1) if p]
    if len(codes) != 1:
        raise ValueError(f'Unreviewed multi-code row: {row["anchor"]}')
    col, code, pi = codes[0]
    return [(col, code, '\n'.join(cells[4]).strip(), '\n'.join(cells[5]).strip(), pi, 1, 1)]


def extract_nodes(rows):
    nodes = []
    section = subsection = division = None
    seen = set()
    for row in rows:
        for col, code, name, description, cp, np, dp in split_row(row):
            if not re.fullmatch(PATTERNS[col], code) or code in seen or not name:
                raise ValueError(f'Invalid/duplicate code or blank label: {code}')
            seen.add(code)
            if col == 0:
                section, subsection, division = code, None, None
                parent = None
            elif col == 1:
                if section != 'C':
                    raise ValueError('Manufacturing subsection outside C')
                subsection, division, parent = code, None, section
            elif col == 2:
                division, parent = code, section
            else:
                if not division or not code.startswith(division):
                    raise ValueError(f'Group lacks matching division: {code}')
                parent = division
            nodes.append({
                'code': code, 'level': LEVELS[col], 'name': name, 'description': description,
                'parent_code': parent, 'section_code': section,
                # A manufacturing subsection is auxiliary, not a replacement
                # for the official section/division/group three-level tree.
                'manufacturing_subsection_code': subsection,
                'division_code': division,
                'source': {'file': 'originals/capco-industry-codes.docx', 'sha256': DOCX_SHA,
                           'anchor': row['anchor'],
                           'code_locator': f'{row["anchor"]}/C{col+1}/P{cp}',
                           'name_locator': f'{row["anchor"]}/C5/P{np}',
                           'description_locator': f'{row["anchor"]}/C6/P{dp}'},
            })
    return nodes


def selector_mapping(nodes):
    """Candidate handoff only. Broad/auxiliary codes never pick a child."""
    return [{
        'source_code': n['code'], 'source_level': n['level'],
        'selector_code': n['division_code'] if n['level'] in ('division', 'group') else None,
        'reason': ('exact_division' if n['level'] == 'division' else
                   'unique_parent_division' if n['level'] == 'group' else 'insufficient_granularity'),
    } for n in nodes]


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + '\n'


def artifacts():
    rows = read_rows(DEST / 'originals/capco-industry-codes.docx')
    nodes = extract_nodes(rows)
    parser = GuidelineParser()
    parser.feed((DEST / 'originals/capco-guideline.html').read_text(encoding='utf8'))
    if len([p for p in parser.paragraphs if re.match(r'^第[一二三四五六七八九十]+条', p)]) != 19:
        raise ValueError('Expected all 19 articles in the official guideline')
    common = {'standard_id': 'capco-listed-company-industry', 'standard_version': '2023-05-01',
              'definition_sha256': DOCX_SHA, 'status': 'source_extracted_candidate_only',
              'production_eligible': False, 'industry_review': None}
    catalog = {**common, 'schema_version': 1, 'counts': dict(Counter(n['level'] for n in nodes)),
               'nodes': nodes}
    mapping = {**common, 'mapping_version': 'sse-private-capco-division-candidate-v1',
               'selector_field': 'industry', 'selector_level': 'division',
               'scope': {'market': 'sse', 'offering': 'private'},
               'runtime_binding': 'not_installed',
               'entries': selector_mapping(nodes)}
    article_md = ['# 协会行业统计分类指引：官方正文摘录', '',
                  '仅提取官方网页 #zoom 正文段落，含19条及附件链接。P编号为提取段落，不是页码。', '',
                  '原字节及URL见 [retrieval.json](retrieval.json)。来源提取不等于专业审核或生产发布。', '']
    for i, p in enumerate(parser.paragraphs, 1):
        article_md += [f'<a id="p{i:03d}"></a>', f'## P{i:03d}', '', p, '']
    code_md = ['# 分类结构和代码表：逐行来源', '',
               'T为OOXML表编号，R为表内行编号，C为单元格，P为单元格内段落；均从1开始，不是打印页码。', '',
               '保留所有原始行，包括表头、合并行、空行。完整代码及辅助次类见 [catalog.json](catalog.json)。', '']
    for row in rows:
        code_md += [f'<a id="{row["anchor"].lower()}"></a>', f'## {row["anchor"]}', '']
        for ci, paras in enumerate(row['cells'], 1):
            for pi, value in enumerate(paras, 1):
                if value.strip():
                    code_md.append(f'- C{ci}/P{pi}: {value.strip()}')
        code_md.append('')
    followup_md = ['# 后续标准线索与分类结果：官方网页摘录', '',
                   '原字节及抓取结果见 [followup-retrieval.json](followup-retrieval.json)。', '',
                   '协会转载不等于已取得证监会标准正文；分类结果不是分类标准修订。', '']
    for key in ('capco-csrc-standard-2024', 'capco-classification-result-2025h2'):
        evidence = GuidelineParser()
        evidence.feed((DEST / f'originals/{key}.html').read_text(encoding='utf8'))
        followup_md += [f'<a id="{key}"></a>', f'## {key}', '']
        for i, paragraph in enumerate(evidence.paragraphs, 1):
            followup_md += [f'<a id="{key}-p{i:03d}"></a>', f'P{i:03d}：{paragraph}', '']
    return {'catalog.json': json_text(catalog), 'selector-mapping.json': json_text(mapping),
            'table-rows.json': json_text(rows), 'guideline.md': '\n'.join(article_md),
            'code-table.md': '\n'.join(code_md), 'followup-sources.md': '\n'.join(followup_md)}


if __name__ == '__main__':
    output = artifacts()
    for filename, content in output.items():
        (DEST / filename).write_text(content, encoding='utf8', newline='\n')
    catalog = json.loads(output['catalog.json'])
    print(json.dumps({'generated': len(output), 'counts': catalog['counts']}, ensure_ascii=False))
