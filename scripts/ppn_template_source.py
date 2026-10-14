"""Read the supplied PPN DOCX without modifying it or publishing issuer examples.

Point comments (w:commentReference without a range) are valid Word comments.
The local extraction includes all body/table paragraphs; reusable assets are
curated separately so source-company facts never become target-company facts.
"""
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import argparse
import hashlib
import json

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}


def q(name):
    return '{' + W + '}' + name


def text(element):
    return ''.join(n.text or '' for n in element.iter(q('t')))


def extract(path):
    raw = Path(path).read_bytes()
    with ZipFile(path) as archive:
        document = ET.fromstring(archive.read('word/document.xml'))
        comment_root = ET.fromstring(archive.read('word/comments.xml'))
    parents = {child: parent for parent in document.iter() for child in parent}
    paragraphs = list(document.iter(q('p')))
    locations = {p: f'P{i:05d}' for i, p in enumerate(paragraphs, 1)}

    def paragraph_of(node):
        while node is not None and node.tag != q('p'):
            node = parents.get(node)
        return node

    def inside_table(p):
        while p is not None:
            if p.tag == q('tbl'):
                return True
            p = parents.get(p)
        return False

    rows = []
    for p in paragraphs:
        style = p.find('w:pPr/w:pStyle', NS)
        rows.append({'locator': locations[p], 'text': text(p),
                     'style': style.get(q('val')) if style is not None else None,
                     'in_table': inside_table(p)})
    anchors, active = {}, {}
    for node in document.iter():
        cid = node.get(q('id'))
        loc = locations.get(paragraph_of(node))
        if node.tag == q('commentRangeStart'):
            anchors.setdefault(cid, {})['start'] = loc
            active[cid] = []
        elif node.tag == q('t'):
            for fragments in active.values():
                fragments.append(node.text or '')
        elif node.tag == q('commentRangeEnd'):
            anchors.setdefault(cid, {})['end'] = loc
            anchors[cid]['selected_text'] = ''.join(active.pop(cid, []))
        elif node.tag == q('commentReference'):
            anchors.setdefault(cid, {}).setdefault('references', []).append(loc)
    comments = []
    for comment in comment_root.findall('w:comment', NS):
        cid = comment.get(q('id'))
        anchor = anchors.get(cid, {})
        comments.append({'id': cid, 'text': '\n'.join(text(p) for p in comment.iter(q('p'))),
                         'anchor_kind': 'range' if anchor.get('start') else 'point', **anchor})
    tables = []
    for i, table in enumerate(document.iter(q('tbl')), 1):
        tables.append({'id': f'T{i:03d}', 'start': locations.get(table.find('.//w:p', NS)),
                       'rows': [[' / '.join(text(p) for p in cell.findall('w:p', NS))
                                 for cell in row.findall('w:tc', NS)]
                                for row in table.findall('w:tr', NS)]})
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
            'paragraphs': rows, 'tables': tables, 'comments': comments,
            'tracked_insertions': len(list(document.iter(q('ins')))),
            'tracked_deletions': len(list(document.iter(q('del'))))}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('--out', required=True, help='Local evidence JSON, not a runtime knowledge asset')
    args = parser.parse_args()
    result = extract(args.source)
    destination = Path(args.out)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"Extracted {len(result['paragraphs'])} paragraphs, {len(result['tables'])} tables, "
          f"{len(result['comments'])} comments; SHA-256 {result['sha256']}")
