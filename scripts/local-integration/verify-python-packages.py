"""Verify mirrored wheels against the release hashes published by official PyPI."""
import json
import urllib.request

with open('/opt/venv/install-report.json') as source:
    report = json.load(source)
for package in report['install']:
    name, version = package['metadata']['name'], package['metadata']['version']
    with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=30) as response:
        release = json.load(response)
    digest = package['download_info']['archive_info']['hashes']['sha256']
    if digest not in {item['digests']['sha256'] for item in release['urls']}:
        raise RuntimeError(f'Official PyPI digest mismatch: {name} {version}')
    print(f'Official PyPI SHA256 verified: {name} {version}')
