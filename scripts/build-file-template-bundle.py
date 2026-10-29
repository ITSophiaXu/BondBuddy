"""Build a private immutable bundle from an explicitly reviewed local intake.

No customer bytes or filenames belong in Git. Install the output as a private
read-only directory and point BB_FILE_TEMPLATE_BUNDLE at it on API hosts.
"""
import argparse,hashlib,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--intake',required=True);p.add_argument('--root',required=True);p.add_argument('--catalogue',required=True);p.add_argument('--out',required=True);p.add_argument('--version',required=True)
def build(args):
    intake=json.loads(Path(args.intake).read_text(encoding='utf8'));root=Path(args.root).resolve();out=Path(args.out)
    if out.exists():raise ValueError('Output already exists; use a new version directory')
    out.mkdir(parents=True);(out/'assets').mkdir()
    titles={r['cells'][0].strip():r['cells'][1].split('（')[0][:58] for r in intake['catalogue'][0]['rows'][1:]}
    records=[]
    def asset(relative,sha):
        source=(root/relative).resolve()
        if not source.is_relative_to(root):raise ValueError('Unsafe intake path')
        raw=source.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=sha:raise ValueError('Original changed')
        target='assets/'+sha+'.docx';(out/target).write_bytes(raw);return target
    for i,w in enumerate(intake['workpapers']):
        code=re.match(r'\d+(?:-\d+)*',w['name']);code=code.group() if code else ''
        role='发行人说明' if '说明' in w['name'] else '访谈记录' if '访谈' in w['name'] else '培训底稿' if '培训' in w['name'] else '核查记录' if '记录' in w['name'] else '核查文件'
        title=titles.get(code,role)
        records.append(dict(id=f'wp-{i+1:03}',path=asset(w['relative'],w['sha256']),sha256=w['sha256'],code=code,role=role,document_type='workpaper',name=f'{code} {title} · {role}',match_title=title))
    general={'annual_report':('annual','年度报告'),'underwriter':('underwriter','主承销商核查意见'),'application':('application','发行申请书'),'legal_opinion':('legal','法律意见书'),'project_initiation':('init','立项报告')}
    for key,(kind,title) in general.items():
        w=intake['general'][key];records.append(dict(id='doc-'+kind,path=asset(w['relative'],w['sha256']),sha256=w['sha256'],code='',role=title,document_type=kind,name=title,match_title=title))
    cat=Path(args.catalogue).read_bytes();sha=hashlib.sha256(cat).hexdigest();(out/'catalogue.xlsx').write_bytes(cat)
    result=dict(version=args.version,name='光大证券模板',catalogue=dict(path='catalogue.xlsx',sha256=sha),records=records)
    (out/'manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(dict(records=len(records),unique_assets=len(set(r['sha256'] for r in records)),version=args.version)))
if __name__=='__main__':build(p.parse_args())
