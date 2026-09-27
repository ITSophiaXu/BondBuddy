"""Offline extraction of pinned #20 companion sources; never publishes rules.

Requires pypdf/pdfplumber for the CSRC attachment. HTML scripts are never run.
Only whitespace is removed when comparing labels; punctuation remains evidence.
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
DEST = ROOT / 'knowledge/exchange-bonds/verification/2026-09-27-companion'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
EXPECTED = {
    'originals/csrc-industry-2024.pdf': '407e8f6f7cee18a68783da6ff1b06bf723149f889a25f7a86232ac0ab27ea507',
    'originals/sse-suitability-2023.docx': '344c48bad2b7a8551d53c75538340f113e83b97801f748f5d63ab1b15470e6cd',
    'notices/sse-suitability-2023.html': '9990dcd5cbe5cb002838680802b1f6f42837aa1b19d198d4d437790bb03d865d',
    'notices/company-law-2023.html': 'c079ac6a9e3f3dabeb447e7dcd3fb443e8ae257fb531dddb049060d5e43c4c18',
}


def verified_bytes(path, expected):
    raw = path.read_bytes()
    if sha256(raw).hexdigest() != expected:
        raise ValueError(f'Source changed: {path.name}; review a new version')
    return raw


def compact(value):
    return re.sub(r'\s+', '', value or '')


class Paragraphs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.current = None
        self.paragraphs = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        if tag == 'p' and not self.skip:
            self.current = []

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip -= 1
        if tag == 'p' and self.current is not None:
            text = ''.join(self.current).strip()
            if text:
                self.paragraphs.append(text)
            self.current = None

    def handle_data(self, value):
        if self.current is not None and not self.skip:
            self.current.append(value)


def cn_number(text):
    digits = dict(zip('零一二三四五六七八九', range(10)))
    result = current = 0
    for char in text:
        if char in digits:
            current = digits[char]
        else:
            result += (current or 1) * {'十': 10, '百': 100}[char]
            current = 0
    return result + current


def articles(paragraphs, expected_count):
    result = []
    active = None
    for i, text in enumerate(paragraphs, 1):
        match = re.match(r'^第([零一二三四五六七八九十百]+)条\s*', text)
        if match:
            number = cn_number(match[1])
            if number != len(result) + 1:
                raise ValueError(f'Missing/duplicate article {number}')
            active = {'number': number, 'anchor': f'article-{number:03}', 'paragraphs': []}
            result.append(active)
        # Chapter/section headings belong to the source view, not the previous article.
        if active and not re.match(r'^第[一二三四五六七八九十]+[章节]', text):
            active['paragraphs'].append({'paragraph': i, 'text': text})
    if len(result) != expected_count:
        raise ValueError(f'Incomplete article count: {len(result)} != {expected_count}')
    return result


def extract_industry(pdf_path):
    import pdfplumber
    rows, nodes = [], []
    section = division = None
    levels = ('section', 'manufacturing_subsection', 'division', 'group')
    with pdfplumber.open(pdf_path) as pdf:
        if len(pdf.pages) != 48:
            raise ValueError('Unexpected CSRC page count')
        # Table 2 alone: PDF pages 8-42, printed pages 2-36. Appendices are not codes.
        for pi in range(7, 42):
            for ti, table in enumerate(pdf.pages[pi].extract_tables(), 1):
                if len(table[0]) != 6:
                    continue
                for ri, cells in enumerate(table, 1):
                    anchor = f'PAGE{pi+1:03}-T{ti:02}-R{ri:03}'
                    rows.append({'anchor': anchor, 'cells': cells})
                    codes = [(i, compact(v)) for i, v in enumerate(cells[:4]) if v
                             and re.fullmatch(r'(?:[A-S]|C[A-J]|\d{2,3})', compact(v))]
                    if not codes:
                        if any(compact(v) for v in cells[:4]) and compact(cells[0]) not in ('代码', '门类'):
                            raise ValueError(f'Unrecognized code row: {anchor}')
                        # A continuation with text but no code must not be silently lost.
                        if not any(compact(v) for v in cells[:4]) and any(compact(v) for v in cells[4:]):
                            raise ValueError(f'Unreviewed continuation row: {anchor}')
                        continue
                    if len(codes) != 1:
                        raise ValueError(f'Unreviewed merged code row: {anchor}')
                    col, code = codes[0]
                    if col == 0:
                        section, division = code, None
                    elif col == 1:
                        division = None
                    elif col == 2:
                        division = code
                    if col == 3 and (not division or not code.startswith(division)):
                        raise ValueError(f'Invalid group parent: {anchor}')
                    nodes.append({'code': code, 'level': levels[col], 'name': compact(cells[4]),
                                  'description': compact(cells[5]), 'anchor': anchor,
                                  'parent_code': division if col == 3 else section if col > 0 else None})
    expected = dict(section=19, manufacturing_subsection=10, division=91, group=456)
    if Counter(n['level'] for n in nodes) != expected or len({n['code'] for n in nodes}) != 576:
        raise ValueError('Incomplete/duplicate industry table')
    return rows, nodes


def compare_industry(nodes, capco):
    older = {n['code']: n for n in capco}
    newer = {n['code']: n for n in nodes}
    if older.keys() != newer.keys():
        raise ValueError('Code-set relationship needs new review')
    differences = []
    for code in sorted(older):
        changes = []
        for field in ('level', 'parent_code', 'name', 'description'):
            if compact(older[code][field]) != compact(newer[code][field]):
                changes.append({'field': field, 'capco_2023': older[code][field], 'csrc_2024': newer[code][field]})
        if changes:
            differences.append({'code': code, 'capco_anchor': older[code]['source']['anchor'],
                                'csrc_anchor': newer[code]['anchor'], 'differences': changes})
    return {'schema_version': 'industry-document-comparison-v1', 'status': 'documentary_comparison_only',
            'production_eligible': False, 'professional_review': None, 'code_count': len(nodes),
            'code_sets_equal': True, 'normalization': 'whitespace_only; punctuation preserved',
            'differences': differences,
            'legal_equivalence_established': False, 'replaces_capco_2023_established': False}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')


def source_view(title, original, paras, rule_articles):
    lines = [f'# {title}', '', f'原件：[{original}](../{original})；SHA-256 `{EXPECTED[original]}`。',
             '', '以下为离线提取；段落顺序和条号可核对，不代表专业签认或生产发布。', '']
    anchors = {a['paragraphs'][0]['paragraph']: a['anchor'] for a in rule_articles}
    for i, p in enumerate(paras, 1):
        if i in anchors:
            lines += [f'<a id="{anchors[i]}"></a>', '']
        lines += [f'<a id="p{i:04}"></a>', '', p, '']
    return '\n'.join(lines).rstrip() + '\n'


def build(dest=DEST):
    for rel, digest in EXPECTED.items():
        verified_bytes(dest / rel, digest)
    (dest / 'sources').mkdir(exist_ok=True)
    with ZipFile(dest / 'originals/sse-suitability-2023.docx') as z:
        doc = ET.fromstring(z.read('word/document.xml'))
    paras = [''.join(t.text or '' for t in p.findall('.//w:t', NS)).strip()
             for p in doc.findall('.//w:p', NS)]
    # Preserve blank source paragraphs as well, so Pnnnn is the original OOXML index.
    suit = articles(paras, 30)
    write_json(dest / 'suitability-articles.json', suit)
    (dest / 'sources/sse-suitability-2023.md').write_text(source_view(
        '上交所债券市场投资者适当性管理办法（2023年修订）', 'originals/sse-suitability-2023.docx', paras, suit), encoding='utf-8', newline='\n')
    parser = Paragraphs()
    parser.feed((dest / 'notices/company-law-2023.html').read_text(encoding='utf-8'))
    law = articles(parser.paragraphs, 266)
    write_json(dest / 'company-law-articles.json', law)
    (dest / 'sources/company-law-2023.md').write_text(source_view(
        '公司法（2023修订）政府网站转载全文', 'notices/company-law-2023.html', parser.paragraphs, law), encoding='utf-8', newline='\n')
    from pypdf import PdfReader
    reader = PdfReader(dest / 'originals/csrc-industry-2024.pdf')
    lines = ['# JR/T 0020—2024 全文', '', '物理PDF页码包含封面及空白页；保留原件，不把页号当条号。', '']
    for i, page in enumerate(reader.pages, 1):
        lines += [f'<a id="page{i:03}"></a>', '', f'## PDF第{i}页', '', page.extract_text().strip(), '']
    (dest / 'sources/csrc-industry-2024.md').write_text('\n'.join(lines).rstrip()+'\n', encoding='utf-8', newline='\n')
    rows, nodes = extract_industry(dest / 'originals/csrc-industry-2024.pdf')
    write_json(dest / 'industry-table-rows.json', rows)
    write_json(dest / 'industry-codes.json', nodes)
    # Compare against the pinned original, not a potentially edited generated catalog.
    from build_capco_industry_evidence import DEST as CAPCO_DEST, read_rows, extract_nodes
    capco_nodes = extract_nodes(read_rows(CAPCO_DEST / 'originals/capco-industry-codes.docx'))
    write_json(dest / 'industry-comparison.json', compare_industry(nodes, capco_nodes))
    return {'suitability_articles': len(suit), 'company_law_articles': len(law), 'industry_codes': len(nodes)}


if __name__ == '__main__':
    print(json.dumps(build(), ensure_ascii=False))
