"""Capture explicitly listed public official sources, preserving response bytes."""
from pathlib import Path
import hashlib
import json
import urllib.request
from html.parser import HTMLParser
from intake_nafmii_archive import BASE, extract, write_json

URLS = [
 ('OF001','https://www.nafmii.org.cn/zlgl/zlgz/hxgll/202312/t20231201_316423.html'),
 ('OF002','https://www.nafmii.org.cn/zlgl/zlgz/hxgll/202312/P020231201504225239165.pdf'),
 ('OF003','https://www.nafmii.org.cn/ggtz/tz/202509/t20250915_323316.html'),
 ('OF004','https://www.nafmii.org.cn/ggtz/tz/202603/t20260323_325023.html'),
 ('OF005','https://www.nafmii.org.cn/zlgl/zlgz/zcfxl_1059/zcl/202310/P020231019522511188092.pdf'),
 ('OF006','https://www.nafmii.org.cn/ggtz/gg/202103/P020220117435173619426.docx'),
 ('OF007','https://www.nafmii.org.cn/ggtz/gg/202004/P020220117435116098799.doc'),
]
PINNED_HASHES={
 'OF001':'5084136335d5861aa4ebbbb460662fb5ecf5824f5af7a920c43362655418e4a9',
 'OF002':'cca3cfaed55d9c3a81b3b2fa12480bd325b8bf920af1c437148b34e56a2780da',
 'OF003':'d900473b28ad3cc97c5aa3373fba8fe5db25d6606ffa9ceccea4f6861c5c25d0',
 'OF004':'f181fbce7e69ffa5724f74d58ea04816549d5b3b36e3aa00af99964d7368bd99',
 'OF005':'869d244620462616ec5e4a1fa9a9c2c929054e150ab990ad9a2449d1bfc1f959',
 'OF006':'c945af5d28b06bab33b4100160945793bae013d745151fde438df19cdef4ea05',
 'OF007':'bc07230ee3368b5ee22ec421e6755c6170ed24fe906b9213b53545c4bf0a531c',
}

class TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts=[]
        self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style'): self.skip+=1
    def handle_endtag(self,tag):
        if tag in ('script','style'): self.skip=max(0,self.skip-1)
    def handle_data(self,data):
        if not self.skip and data.strip(): self.parts.append(data.strip())

def main():
    catalog=[]
    for sid,url in URLS:
        path=BASE/'official'/f'{sid}{Path(url).suffix}'
        path.parent.mkdir(parents=True,exist_ok=True)
        if not path.exists():
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(req,timeout=50) as r:
                raw=r.read()
                if r.status != 200:
                    raise ValueError((url,r.status))
            path.write_bytes(raw)
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=PINNED_HASHES[sid]:
            raise ValueError(f'{sid}: official response changed; preserve as a new reviewed source, do not overwrite this snapshot')
        if path.suffix=='.html':
            parser=TextParser()
            parser.feed(raw.decode('utf-8'))
            text='\n'.join(parser.parts)
            records=[{'locator':f'L{i:05d}','role':'body','text':t} for i,t in enumerate(text.splitlines(),1)]
            status='html_text_extracted'
        else:
            records,status,_=extract(path)
        h=hashlib.sha256(raw).hexdigest()
        write_json(BASE/'records'/f'{sid}.json',{'source_id':sid,'original_sha256':h,'extraction_status':status,'records':records})
        catalog.append({'source_id':sid,'url':url,'path':path.relative_to(BASE).as_posix(),'bytes':len(raw),'sha256':h,'captured_on':'2026-09-27','legal_review':None})
        print(sid,len(raw),h)
    write_json(BASE/'official'/'catalog.json',catalog)

if __name__=='__main__':main()
