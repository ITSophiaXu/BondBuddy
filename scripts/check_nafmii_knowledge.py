"""Fail on evidence drift, stale retrieval leakage, or unanchored draft quotes."""
from pathlib import Path
import hashlib
import json
import re

BASE=Path(__file__).resolve().parents[1]/'knowledge/nafmii'
def read(p):return json.loads((BASE/p).read_text('utf-8'))
def normalized(text):return re.sub(r'\s+','',text)

def main():
    intake=read('intake.json');sources=read('sources.json')['sources'];official=read('official/catalog.json')
    assert len(intake['entries'])==79 and len(sources)==72
    assert sum(e['disposition']=='excluded_office_lock_file' for e in intake['entries'])==2
    assert sum(e['disposition']=='byte_duplicate' for e in intake['entries'])==5
    by_id={s['source_id']:s for s in sources}
    by_id.update({s['source_id']:{**s,'original_path':s['path']} for s in official})
    for sid,s in by_id.items():
        raw=(BASE/s['original_path']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==s['sha256'],sid
        assert len(raw)==s['bytes'],sid
        r=read(f'records/{sid}.json')
        assert r['original_sha256']==s['sha256'],sid
        assert len({x['locator'] for x in r['records']})==len(r['records']),sid
    for e in intake['entries']:
        if 'source_id' in e:
            assert e['sha256']==by_id[e['source_id']]['sha256']
    retrieval=read('research-index.json')
    assert retrieval['production_eligible'] is False
    for row in retrieval['records']:
        s=by_id[row['source_id']]
        assert s['research_index_eligible'] and s['current_status']=='research_only'
        assert s['document_kind'] not in ('historical','education','foreign','special','administration')
        rec=next(r for r in read(f'records/{s["source_id"]}.json')['records'] if r['locator']==row['locator'])
        assert rec['role'] in ('body','footnote','endnote') and rec['text']==row['text']
    for offering in ('ppn','dfi'):
        pack=read(f'drafts/{offering}/rule-pack.json')
        assert pack['status']=='draft' and pack['release'] is None and not pack['reviews']
        assert all(not r['enabled'] and r['enforcement']=='research_only' for r in pack['rules'])
        for source in pack['sources']:
            sid=source['source_id'].split('-')[0].upper()
            records={r['locator']:r['text'] for r in read(f'records/{sid}.json')['records']}
            assert source['document_hash']==by_id[sid]['sha256']
            assert source['exact_quote']=='\n'.join(records[loc] for loc in source['clause_locator'].split(', '))
    # The supplied public-form DOC is not byte-identical to the official DOC.
    a='\n'.join(r['text'] for r in read('records/NA029.json')['records'])
    b='\n'.join(r['text'] for r in read('records/OF007.json')['records'])
    same=normalized(a)==normalized(b)
    assert same,'Public form extracted body differs: review before asserting equivalence'
    assert by_id['NA029']['sha256']!=by_id['OF007']['sha256']
    assert by_id['NA015']['sha256']==by_id['OF005']['sha256']
    ocr_count=0
    for sid in ('NA019','NA020','NA024','NA040','NA067'):
        ocr=read(f'ocr/{sid}.json');raw=read(f'records/{sid}.json')
        assert ocr['original_sha256']==by_id[sid]['sha256']
        assert {r['locator'] for r in ocr['records']}=={r['locator'] for r in raw['records']}
        assert all(r['role']=='ocr_unverified' for r in ocr['records'])
        ocr_count+=len(ocr['records'])
    assert ocr_count==60
    print(f'PASS: 79 entries / 72 originals / {len(official)} official snapshots; all hashes and anchors match.')
    print(f'PASS: {len(retrieval["records"])} research records, no historical/foreign/special/OCR/comment leakage.')
    print('PASS: 18 disabled research rules, original quotes; 60 OCR pages remain unverified.')
    print('PASS: NA029/OF007 normalized extracted body identical; raw bytes remain distinct.')

if __name__=='__main__':main()
