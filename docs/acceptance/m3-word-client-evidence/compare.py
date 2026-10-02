"""Compare semantic OOXML after an actual Word open/save/close/reopen."""
import collections
import hashlib
import json
import sys
import zipfile
from pathlib import Path

repo, root = (Path(value).resolve() for value in sys.argv[1:3])
sys.path.insert(0, str(repo / 'python'))
from bondbuddy_word_delivery.writer import Q, parse_xml, paragraph_map, document_signature, visible

def inspect(path):
    with zipfile.ZipFile(path) as package:
        document = parse_xml(package.read('word/document.xml'))
        comments = parse_xml(package.read('word/comments.xml')) if 'word/comments.xml' in package.namelist() else []
        ranges = collections.defaultdict(list)
        refs = collections.Counter()
        for locator, paragraph in paragraph_map(document).items():
            offset = 0
            starts = {}
            def walk(node):
                nonlocal offset
                tag = node.tag
                if tag == Q('del'):
                    return
                if tag == Q('commentRangeStart'):
                    starts[node.get(Q('id'))] = offset
                elif tag == Q('commentRangeEnd'):
                    comment_id = node.get(Q('id'))
                    ranges[comment_id].append({'locator': locator, 'start': starts.get(comment_id), 'end': offset})
                elif tag == Q('commentReference'):
                    refs[node.get(Q('id'))] += 1
                elif tag == Q('t'):
                    offset += len(node.text or '')
                elif tag in (Q('tab'), Q('br'), Q('cr')):
                    offset += 1
                for child in node:
                    walk(child)
            walk(paragraph)
        notes = [{'author': comment.get(Q('author')), 'date': comment.get(Q('date')),
                  'paragraphs': [visible(p) for p in comment.iter(Q('p'))],
                  'ranges': ranges[comment.get(Q('id'))], 'references': refs[comment.get(Q('id'))]} for comment in comments]
        revisions = [{'kind': node.tag.rsplit('}', 1)[-1], 'author': node.get(Q('author')), 'date': node.get(Q('date')),
                      'text': ''.join(node.itertext()) if node.tag == Q('del') else visible(node)}
                     for node in document.iter() if node.tag in (Q('ins'), Q('del'), Q('cellIns'))]
        relation_ok = not notes or b'/comments' in package.read('word/_rels/document.xml.rels')
        content_type_ok = not notes or b'wordprocessingml.comments+xml' in package.read('[Content_Types].xml')
        sort = lambda items: sorted(items, key=lambda item: json.dumps(item, ensure_ascii=False, sort_keys=True))
        body_children = [node for node in document.find(Q('body')) if node.tag != Q('sectPr')]
        return {'body': document_signature(document), 'ends_in_table': bool(body_children and body_children[-1].tag == Q('tbl')),
                'ends_in_table_and_empty_paragraph': bool(len(body_children) >= 2 and body_children[-2].tag == Q('tbl') and body_children[-1].tag == Q('p') and not visible(body_children[-1])),
                'comments': sort(notes), 'revisions': sort(revisions),
                'native_comments_relationship': relation_ok, 'native_comments_content_type': content_type_ok}

manifest = json.loads((root / 'manifest.json').read_text())
rows = []
for fixture in manifest['fixtures']:
    source, saved = root / fixture['name'], root / 'word-roundtrip' / fixture['name']
    before, after = inspect(source), inspect(saved)
    exact_body = before['body'] == after['body']
    terminal_empty = (before['ends_in_table'] and after['ends_in_table_and_empty_paragraph']
                      and after['body'][0] == before['body'][0] + [''] and after['body'][1] == before['body'][1])
    checks = {name: before[name] == after[name] for name in ('comments', 'revisions')}
    checks['body_content_and_table_shape'] = exact_body or terminal_empty
    checks.update(native_relationship=after['native_comments_relationship'], content_type=after['native_comments_content_type'],
                  source_unchanged=hashlib.sha256(source.read_bytes()).hexdigest() == fixture['sha256'])
    row = {'name': fixture['name'], 'checks': checks, 'pass': all(checks.values()), 'body_exact': exact_body,
           'observed_normalizations': ['Word added exactly one empty terminal paragraph after the final table.'] if terminal_empty else [],
           'source_sha256': fixture['sha256'], 'word_saved_sha256': hashlib.sha256(saved.read_bytes()).hexdigest(),
           'before': before, 'after': after}
    rows.append(row)
    print(json.dumps({'name': row['name'], 'checks': checks, 'comments': len(before['comments']), 'revisions': len(before['revisions'])}, ensure_ascii=False))
(root / 'ooxml-comparison.json').write_text(json.dumps({'synthetic': True, 'cases': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
sys.exit(0 if all(row['pass'] for row in rows) else 1)
