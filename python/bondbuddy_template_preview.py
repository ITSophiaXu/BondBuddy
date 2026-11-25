"""Render only an allowlisted, de-identified derivative, never the original."""
import argparse,os,shutil,subprocess,sys,tempfile
from pathlib import Path
from bondbuddy_template_redaction import sanitize_docx,assert_safe_preview

def render(source:Path,destination:Path):
    safe,_=sanitize_docx(source.read_bytes(),'文件模板');assert_safe_preview(safe,title='文件模板')
    executable=os.environ.get('BB_TEMPLATE_LIBREOFFICE') or shutil.which('libreoffice') or shutil.which('soffice')
    if not executable:raise RuntimeError('TEMPLATE_RENDERER_UNAVAILABLE')
    with tempfile.TemporaryDirectory(prefix='bb-redacted-preview-') as name:
        root=Path(name);doc=root/'template.docx';doc.write_bytes(safe)
        subprocess.run([executable,'-env:UserInstallation='+ (root/'profile').as_uri(),'--headless','--convert-to','pdf','--outdir',str(root),str(doc)],check=True,timeout=45,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        pdf=root/'template.pdf'
        if not pdf.exists() or pdf.stat().st_size>16*1024*1024:raise RuntimeError('TEMPLATE_PREVIEW_FAILED')
        from pypdf import PdfReader,PdfWriter
        reader=PdfReader(str(pdf));writer=PdfWriter()
        if len(reader.pages)>500:raise RuntimeError('TEMPLATE_PREVIEW_PAGE_LIMIT')
        for page in reader.pages:
            if '/Annots' in page:del page['/Annots']
            writer.add_page(page)
        writer.add_metadata({'/Title':'文件模板（已脱敏）','/Author':'','/Subject':''})
        with destination.open('wb') as f:writer.write(f)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('destination',type=Path);args=p.parse_args()
    try:render(args.source,args.destination)
    except Exception as error:
        print('TEMPLATE_RENDERER_UNAVAILABLE' if str(error)=='TEMPLATE_RENDERER_UNAVAILABLE'
              else 'TEMPLATE_PREVIEW_FAILED',file=sys.stderr)
        raise SystemExit(1)
