"""Host-owned, text-preserving pagination for repeated Word table headers."""
import copy
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile
from lxml import etree as E

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
METHOD = 'workpaper-pagination-v1'

def _enabled(node):
    return node is not None and node.get(W+'val', '1').lower() not in ('0', 'false', 'off')

def _text(node):
    return ''.join(node.xpath('.//w:t/text()', namespaces={'w': W[1:-1]}))

def _caption(node):
    if node.tag != W+'p' or node.find('.//'+W+'sectPr') is not None or any(n.get(W+'type')=='page' for n in node.iter(W+'br')):
        return False
    text = _text(node).strip()
    if not text or len(text)>160 or any(c in text for c in '\n\r。！？；;'):
        return False
    style=node.find('./'+W+'pPr/'+W+'pStyle')
    align=node.find('./'+W+'pPr/'+W+'jc')
    return text.startswith(('单位：','单位:')) or (style is not None and style.get(W+'val','').lower() in ('caption','题注')) or (align is not None and align.get(W+'val')=='center')

def _ignore_allowed(root):
    root=copy.deepcopy(root)
    for paragraph in root.iter(W+'p'):
        props=paragraph.find(W+'pPr')
        if props is not None:
            for node in list(props.findall(W+'keepNext')):
                props.remove(node)
            if not len(props) and not props.attrib and not (props.text or '').strip():
                paragraph.remove(props)
    return E.tostring(root,method='c14n')

def normalize_workpaper_layout(source, output):
    source, output=Path(source),Path(output)
    before=source.read_bytes()
    if len(before)>100*1024*1024:
        raise ValueError('FILE_TEXT_TOO_LARGE')
    with ZipFile(source) as z:
        infos=z.infolist()
        if len(infos)>10000 or len({i.filename for i in infos})!=len(infos) or sum(i.file_size for i in infos)>128*1024*1024:
            raise ValueError('WORKPAPER_LAYOUT_PACKAGE_UNSAFE')
        parts={i.filename:z.read(i) for i in infos}
        archive_comment=z.comment
    if 'word/document.xml' not in parts or len(parts['word/document.xml'])>32*1024*1024:
        raise ValueError('WORKPAPER_LAYOUT_PACKAGE_UNSAFE')
    root=E.fromstring(parts['word/document.xml'],E.XMLParser(resolve_entities=False,no_network=True))
    original=_ignore_allowed(root)
    paragraphs=list(root.iter(W+'p'))
    indices={p:i for i,p in enumerate(paragraphs)}
    changes=[]
    def keep(paragraph,kind):
        props=paragraph.find(W+'pPr')
        if props is None:
            props=E.Element(W+'pPr');paragraph.insert(0,props)
        nodes=props.findall(W+'keepNext')
        if len(nodes)==1 and _enabled(nodes[0]):
            return
        for n in nodes:props.remove(n)
        pos=1 if len(props) and props[0].tag==W+'pStyle' else 0
        node=E.Element(W+'keepNext');node.set(W+'val','1');props.insert(pos,node)
        changes.append({'paragraph':indices[paragraph],'kind':kind})
    body=root.find(W+'body')
    if body is not None:
        for table in body.findall(W+'tbl'):
            if table.find('./'+W+'tblPr/'+W+'tblpPr') is not None:
                continue
            rows=table.findall(W+'tr');headers=[]
            for row in rows:
                if not _enabled(row.find('./'+W+'trPr/'+W+'tblHeader')):break
                headers.append(row)
            if not headers or len(headers)==len(rows):continue
            # Only the heading chain joins the FIRST data row. Data rows never
            # get keepNext, so a long financial statement remains splittable.
            for row in headers:
                for cell in row.findall(W+'tc'):
                    for p in cell.findall(W+'p'):keep(p,'header')
            previous=table.getprevious()
            for _ in range(3):
                if previous is None or not _caption(previous):break
                keep(previous,'caption');previous=previous.getprevious()
    if _ignore_allowed(root)!=original:
        raise ValueError('WORKPAPER_LAYOUT_CONTENT_CHANGED')
    if changes:
        parts['word/document.xml']=E.tostring(root,encoding='UTF-8',xml_declaration=True,standalone=True)
        with ZipFile(output,'w') as z:
            z.comment=archive_comment
            for info in infos:z.writestr(info,parts[info.filename])
    else:
        output.write_bytes(before)
    after=output.read_bytes()
    return {'version':METHOD,'input_sha256':hashlib.sha256(before).hexdigest(),'output_sha256':hashlib.sha256(after).hexdigest(),
            'changed_paragraphs':len(changes),'changes':changes,'content_unchanged':True}

if __name__=='__main__':
    import sys
    Path(sys.argv[3]).write_text(json.dumps(normalize_workpaper_layout(sys.argv[1],sys.argv[2])),encoding='utf8')
