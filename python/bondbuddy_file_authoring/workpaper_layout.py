"""Host-owned, text-preserving pagination for repeated Word table headers."""
import copy
import hashlib
import json
import math
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

def _ignore_allowed(root, allowed_paragraphs, allowed_rows):
    root=copy.deepcopy(root)
    for i,paragraph in enumerate(root.iter(W+'p')):
        if i not in allowed_paragraphs:continue
        props=paragraph.find(W+'pPr')
        if props is not None:
            for node in list(props.findall(W+'keepNext')):
                props.remove(node)
            if not len(props) and not props.attrib and not (props.text or '').strip():
                paragraph.remove(props)
    body=root.find(W+'body')
    if body is not None:
        for ti,table in enumerate(body.findall(W+'tbl')):
            for ri,row in enumerate(table.findall(W+'tr')):
                if (ti,ri) not in allowed_rows:continue
                props=row.find(W+'trPr')
                if props is not None:
                    for node in list(props.findall(W+'trHeight')):props.remove(node)
                    if not len(props) and not props.attrib and not (props.text or '').strip():row.remove(props)
    return E.tostring(root,method='c14n')


def _merged_header_height(table, row):
    """Reserve text height in the origin row of a constrained merged header.

    Repeated vMerge cells can ignore the combined row height in LibreOffice.
    Use only explicit grid widths, font sizes and margins from this package;
    unknown shapes are left unchanged. This is a conservative layout bound,
    never a content or typography replacement.
    """
    height=row.find('./'+W+'trPr/'+W+'trHeight')
    if height is None or not (height.get(W+'val','').isdigit()):return None
    columns=table.findall('./'+W+'tblGrid/'+W+'gridCol')
    if not columns or any(not c.get(W+'w','').isdigit() or int(c.get(W+'w'))<=0 for c in columns):return None
    widths=[int(c.get(W+'w')) for c in columns]
    if row.find('./'+W+'trPr/'+W+'gridBefore') is not None or row.find('./'+W+'trPr/'+W+'gridAfter') is not None:return None
    position=0;minimum=0
    for cell in row.findall(W+'tc'):
        span=cell.find('./'+W+'tcPr/'+W+'gridSpan');n=span.get(W+'val','1') if span is not None else '1'
        if not n.isdigit() or int(n)<1 or position+int(n)>len(widths):return None
        width=sum(widths[position:position+int(n)]);position+=int(n)
        merge=cell.find('./'+W+'tcPr/'+W+'vMerge')
        if merge is None or merge.get(W+'val')!='restart':continue
        if cell.find(W+'tbl') is not None or cell.find('.//'+W+'drawing') is not None or cell.find('.//'+W+'object') is not None:continue
        margins={}
        for side in ('left','right'):
            value=cell.find('./'+W+'tcPr/'+W+'tcMar/'+W+side)
            if value is None:value=table.find('./'+W+'tblPr/'+W+'tblCellMar/'+W+side)
            if value is None or value.get(W+'type','dxa')!='dxa' or not value.get(W+'w','').isdigit():break
            margins[side]=int(value.get(W+'w'))
        if len(margins)!=2:continue
        available=width-sum(margins.values())
        if available<=0:continue
        required=0;max_font=0;known=True
        for paragraph in cell.findall(W+'p'):
            text=_text(paragraph)
            if not text:continue
            sizes=[]
            for run in paragraph.findall(W+'r'):
                if next(run.iter(W+'t'),None) is None:continue
                size=run.find('./'+W+'rPr/'+W+'sz')
                if size is None:size=paragraph.find('./'+W+'pPr/'+W+'rPr/'+W+'sz')
                if size is None or not size.get(W+'val','').isdigit():known=False;break
                sizes.append(int(size.get(W+'val'))*10)
            if not known or not sizes or len(text)>160:known=False;break
            font=max(sizes);max_font=max(max_font,font)
            spacing=paragraph.find('./'+W+'pPr/'+W+'spacing')
            if spacing is not None and spacing.get(W+'lineRule','auto')!='auto':known=False;break
            factor=max(1.25,int(spacing.get(W+'line','240'))/240 if spacing is not None and spacing.get(W+'line','240').isdigit() else 1.25)
            lines=max(1,math.ceil(len(text)*font/available))
            required+=lines*font*factor
            if spacing is not None:
                required+=sum(int(spacing.get(W+k,'0')) for k in ('before','after') if spacing.get(W+k,'0').isdigit())
        if known and max_font:minimum=max(minimum,math.ceil((required+max_font/4)/20)*20)
    if minimum<=int(height.get(W+'val')) or minimum>2160:return None
    return height,minimum

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
    original=copy.deepcopy(root)
    paragraphs=list(root.iter(W+'p'))
    indices={p:i for i,p in enumerate(paragraphs)}
    changes=[];row_changes=[]
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
                sizing=_merged_header_height(table,row)
                if sizing is not None:
                    height,minimum=sizing;old=height.get(W+'val');height.set(W+'val',str(minimum));height.set(W+'hRule','atLeast')
                    row_changes.append({'table':list(body.findall(W+'tbl')).index(table),'row':rows.index(row),'before_twips':old,'minimum_twips':minimum})
                for cell in row.findall(W+'tc'):
                    for p in cell.findall(W+'p'):keep(p,'header')
            previous=table.getprevious()
            for _ in range(3):
                if previous is None or not _caption(previous):break
                keep(previous,'caption');previous=previous.getprevious()
    allowed_paragraphs={c['paragraph'] for c in changes};allowed_rows={(c['table'],c['row']) for c in row_changes}
    if _ignore_allowed(root,allowed_paragraphs,allowed_rows)!=_ignore_allowed(original,allowed_paragraphs,allowed_rows):
        raise ValueError('WORKPAPER_LAYOUT_CONTENT_CHANGED')
    if changes or row_changes:
        parts['word/document.xml']=E.tostring(root,encoding='UTF-8',xml_declaration=True,standalone=True)
        with ZipFile(output,'w') as z:
            z.comment=archive_comment
            for info in infos:z.writestr(info,parts[info.filename])
    else:
        output.write_bytes(before)
    after=output.read_bytes()
    return {'version':METHOD,'input_sha256':hashlib.sha256(before).hexdigest(),'output_sha256':hashlib.sha256(after).hexdigest(),
            'changed_paragraphs':len(changes),'changes':changes,'changed_header_rows':len(row_changes),'row_height_changes':row_changes,'content_unchanged':True}

if __name__=='__main__':
    import sys
    Path(sys.argv[3]).write_text(json.dumps(normalize_workpaper_layout(sys.argv[1],sys.argv[2])),encoding='utf8')
