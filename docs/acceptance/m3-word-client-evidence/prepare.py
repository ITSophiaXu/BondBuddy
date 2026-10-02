"""Synthetic compatibility fixtures reuse the repository's tests, never user files."""
import hashlib
import json
import sys
from pathlib import Path
from docx import Document
from lxml import etree

repo = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
sys.path[:0] = [str(repo / 'python'), str(repo / 'python' / 'tests')]
from test_review_word import ReviewWordTests
from test_word_delivery import HistoricalWordWriterTest
from bondbuddy_word_delivery.review import annotate, write_report
from bondbuddy_word_delivery.writer import Q, build

review = ReviewWordTests()
review.setUp()
writer = HistoricalWordWriterTest()
writer.setUp()
try:
    report = review.report()
    report['findings'][0]['target_refs'].append(review.report('90万元', 'docx:t001:r001:c001:p0001')['findings'][0]['target_refs'][0])
    placed, missing = annotate(review.source, out / 'native-comments.docx', report)
    assert len(placed) == 2 and not missing
    first = review.root / 'existing.docx'
    annotate(review.source, first, review.report())
    overlapping = review.report()
    overlapping['findings'].append({**overlapping['findings'][0], 'finding_id': 'F002'})
    placed, missing = annotate(first, out / 'existing-comments.docx', overlapping)
    assert len(placed) == 2 and not missing
    doc = Document()
    p = doc.add_paragraph()
    ins = etree.SubElement(p._p, Q('ins'))
    ins.set(Q('id'), '17'); ins.set(Q('author'), 'Original'); ins.set(Q('date'), '2026-10-02T00:00:00Z')
    etree.SubElement(etree.SubElement(ins, Q('r')), Q('t')).text = '100万元'
    doc.save(review.source)
    placed, missing = annotate(review.source, out / 'comments-existing-revision.docx', review.report())
    assert len(placed) == 1 and not missing
    plan = writer.plan()
    build(writer.source, plan, out / 'tracked-revision.docx', out / 'clean-revision.docx')
    write_report(out / 'review-report.docx', report, [])
    (out / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    artifacts = [{'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size} for path in sorted(out.glob('*.docx'))]
    (out / 'manifest.json').write_text(json.dumps({'synthetic': True, 'fixtures': artifacts}, indent=2), encoding='utf-8')
    print(json.dumps(artifacts, indent=2))
finally:
    review.doCleanups()
    writer.tearDown()
