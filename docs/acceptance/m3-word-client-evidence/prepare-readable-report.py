import hashlib
import json
import sys
from pathlib import Path
repo, out = (Path(arg).resolve() for arg in sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)
sys.path[:0] = [str(repo / 'python'), str(repo / 'python' / 'tests')]
from test_review_word import ReviewWordTests
from bondbuddy_word_delivery.review import write_report
fixture = ReviewWordTests()
fixture.setUp()
try:
    report = fixture.report()
    report['findings'][0]['target_refs'].append(fixture.report('90万元', 'docx:t001:r001:c001:p0001')['findings'][0]['target_refs'][0])
    path = out / 'review-report.docx'
    write_report(path, report, [])
    manifest = {'synthetic': True, 'fixtures': [{'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}]}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps(manifest))
finally:
    fixture.doCleanups()
