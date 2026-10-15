"""Fill explicit case-template slots without replacing typography or package parts.

Usage: python render_template.py TEMPLATE.docx CONTENT.json OUTPUT.docx
CONTENT is {"发行人全称":"...", "内容_1":["paragraph one", "paragraph two"]}.
Unprovided slots remain visible for the author to resolve; unknown keys fail.
"""
from copy import deepcopy
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as E

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS={'w':W}
TOKEN=re.compile(r'\{\{([^{}]+)\}\}')

def fill(template: Path, values: dict, output: Path):
    if template.resolve()==output.resolve(): raise ValueError('Template is immutable')
    with ZipFile(template) as z:
        parts={name:z.read(name) for name in z.namelist()}
    root=E.fromstring(parts['word/document.xml'])
    available={m.group(1) for node in root.xpath('//w:t',namespaces=NS) for m in TOKEN.finditer(node.text or '')}
    if set(values)-available: raise ValueError('Unknown template slots: '+', '.join(sorted(set(values)-available)))
    for p in list(root.xpath('//w:p',namespaces=NS)):
        for t in p.xpath('./w:r/w:t',namespaces=NS):
            original=t.text or ''
            match=TOKEN.fullmatch(original)
            if match and isinstance(values.get(match.group(1)),list):
                lines=values[match.group(1)]
                if not all(isinstance(line,str) for line in lines): raise ValueError('Paragraphs must be strings')
                for line in lines:
                    copy=deepcopy(p)
                    copy.xpath('./w:r/w:t',namespaces=NS)[0].text=line
                    # Keep a section boundary only once, on the original paragraph.
                    for s in copy.xpath('./w:pPr/w:sectPr',namespaces=NS):s.getparent().remove(s)
                    p.addprevious(copy)
                if p.xpath('./w:pPr/w:sectPr',namespaces=NS):t.text=''
                else:p.getparent().remove(p)
                break
            def replace(m):
                value=values.get(m.group(1),m.group(0))
                if not isinstance(value,str):raise ValueError('Inline slot must be a string')
                return value
            t.text=TOKEN.sub(replace,original)
    parts['word/document.xml']=E.tostring(root,encoding='UTF-8',xml_declaration=True,standalone=True)
    output.parent.mkdir(parents=True,exist_ok=True)
    with ZipFile(output,'w',ZIP_DEFLATED) as z:
        for name,data in parts.items():z.writestr(name,data)

if __name__=='__main__':
    fill(Path(sys.argv[1]),json.loads(Path(sys.argv[2]).read_text(encoding='utf-8')),Path(sys.argv[3]))
