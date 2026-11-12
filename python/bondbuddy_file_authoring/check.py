"""Independent verification of CLI-authored files. Never execute model-created code."""
from __future__ import annotations
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as ET
from bondbuddy_word_delivery.writer import Q, parse_xml, normalize_old_revisions

REV = {Q(x) for x in ('ins', 'del', 'moveFrom', 'moveTo', 'cellIns', 'cellDel', 'cellMerge',
    'pPrChange', 'rPrChange', 'tblPrChange', 'tblGridChange', 'trPrChange', 'tcPrChange', 'sectPrChange', 'numberingChange')}
STORY = re.compile(r'word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$')
sha = lambda b: hashlib.sha256(b).hexdigest()

def fail(code):
    raise ValueError(code)

def package(path, *, parsed_xml=None):
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 100*1024*1024:
        fail('WORD_FILE_INVALID')
    with ZipFile(path) as z:
        info = z.infolist()
        if len(info)>2048 or sum(i.file_size for i in info)>128*1024*1024 or any(i.file_size>32*1024*1024 for i in info):
            fail('WORD_PACKAGE_TOO_LARGE')
        names=[i.filename for i in info]
        if len(set(names))!=len(names) or any('..' in n.split('/') or n.startswith('/') for n in names):
            fail('WORD_PACKAGE_INVALID')
        parts={i.filename:z.read(i) for i in info}
    if not {'[Content_Types].xml','word/document.xml','_rels/.rels'}.issubset(parts):
        fail('WORD_PACKAGE_INVALID')
    validated_trees = {} if parsed_xml is not None else None
    for name,data in parts.items():
        if name.endswith(('.xml','.rels')):
            if b'<!DOCTYPE' in data or b'<!ENTITY' in data: fail('WORD_XML_UNSAFE')
            root = parse_xml(data)
            # Optional readback of trees that have already passed every package
            # and XML check. Never accept caller-supplied trees as validation.
            if validated_trees is not None:
                validated_trees[name] = root
    if parsed_xml is not None:
        parsed_xml.update(validated_trees)
    return parts

def unwrap(node):
    parent=node.getparent()
    if parent is None:return
    index=parent.index(node)
    for child in list(node):
        node.remove(child);parent.insert(index,child);index+=1
    parent.remove(node)

def resolve_revisions(root, accept, only_new=False):
    def selected(n):return not only_new or n.get(Q('author'))==only_new
    # Grid changes have no author in OOXML. For author-filtered resolution,
    # associate them with that table's inserted-cell markers before removing cells.
    selected_grids = set()
    for table in root.iter(Q('tbl')):
        cells = [cell for row in table.findall(Q('tr')) for cell in row.findall(Q('tc'))]
        markers = [marker for cell in cells for marker in cell.findall(Q('tcPr')+'/'+Q('cellIns'))]
        if any(selected(marker) for marker in markers):
            grid = table.find(Q('tblGrid'))
            changes = grid.findall(Q('tblGridChange')) if grid is not None else []
            if (not accept and len(changes) != 1) or any(not selected(marker) for marker in markers):
                # Do not resolve another author's grid or guess a missing snapshot.
                fail('WORD_REVISION_UNSUPPORTED')
            selected_grids.update(changes)
    for cell in list(root.iter(Q('tc'))):
        markers = cell.findall(Q('tcPr')+'/'+Q('cellIns'))
        if not accept and any(selected(marker) for marker in markers) and cell.getparent() is not None:
            cell.getparent().remove(cell)
    # Structural row/paragraph insertions/deletions must be resolved before run wrappers.
    for container,prop in [('tr','trPr'),('p','pPr/rPr')]:
        path='/'.join(Q(v) for v in prop.split('/'))
        for node in list(root.iter(Q(container))):
            props=node.find(path)
            if props is None:continue
            remove=next((n for n in props if n.tag==Q('del' if accept else 'ins') and selected(n)),None)
            if remove is not None and node.getparent() is not None:node.getparent().remove(node)
    for table in list(root.iter(Q('tbl'))):
        if not table.findall(Q('tr')) and table.getparent() is not None:table.getparent().remove(table)
    for node in list(root.iter(*REV)):
        if node.getparent() is None or not (selected(node) or node in selected_grids):continue
        local=ET.QName(node).localname
        if local.endswith('Change'):
            if not accept:
                parent=node.getparent();old=next(iter(node),None)
                if old is None:fail('WORD_REVISION_INVALID')
                parent.attrib.clear();parent.attrib.update(old.attrib)
                for child in list(parent):parent.remove(child)
                for child in list(old):parent.append(copy.deepcopy(child))
            else:node.getparent().remove(node)
        elif local == 'cellIns':
            if node.getparent().tag != Q('tcPr'):fail('WORD_REVISION_INVALID')
            node.getparent().remove(node)
        elif local in ('ins','moveTo','del','moveFrom'):
            # Property-level revision markers are not text wrappers.
            if node.getparent().tag in {Q('rPr'),Q('trPr'),Q('tcPr')}:
                node.getparent().remove(node);continue
            keep=(local in ('ins','moveTo'))==accept
            if keep:
                for t in node.iter(Q('delText')):t.tag=Q('t')
                unwrap(node)
            else:node.getparent().remove(node)
        else:
            # Cell deletion/merge semantics still require explicit support.
            fail('WORD_REVISION_UNSUPPORTED')
    return root

def signature(root):
    # Ignore run splits introduced by genuine text revisions; preserve paragraph order,
    # tables/cell merges, section properties and every embedded drawing/object reference.
    def text(n):return ''.join((e.text or '') if e.tag==Q('t') else '\t' if e.tag==Q('tab') else '\n'
        for e in n.iter() if e.tag in {Q('t'),Q('tab'),Q('br'),Q('cr')} )
    paragraphs=[text(p) for p in root.iter(Q('p'))]
    tables=[[(len(r.findall(Q('tc'))),[text(c) for c in r.findall(Q('tc'))]) for r in t.findall(Q('tr'))] for t in root.iter(Q('tbl'))]
    structure=[]
    for n in root.iter():
        if n.tag in {Q('gridSpan'),Q('vMerge'),Q('gridCol'),Q('sectPr'),Q('drawing'),Q('pict'),Q('object')}:
            structure.append(ET.tostring(n,method='c14n'))
    return paragraphs,tables,structure

def stories(parts,accept=None,only_new=False):
    result={}
    for name,raw in parts.items():
        if STORY.fullmatch(name):
            root=parse_xml(raw)
            if accept is not None:resolve_revisions(root,accept,only_new)
            # Old revisions remain historic evidence; compare their displayed accepted text.
            if only_new:normalize_old_revisions(root)
            result[name]=signature(root)
    return result

def clean(source,dest):
    parts=package(Path(source))
    with ZipFile(dest,'w',ZIP_DEFLATED) as z:
        for name,data in parts.items():
            if STORY.fullmatch(name):
                data=ET.tostring(resolve_revisions(parse_xml(data),True),encoding='UTF-8',xml_declaration=True,standalone=True)
            z.writestr(name,data)

def check(input_path):
    root=input_path.parent;data=json.loads(input_path.read_text(encoding='utf-8'))
    paths={key:root/value for key,value in data['output'].items()}
    tracked,clean_parts,baseline=[package(paths[key]) for key in ('tracked','clean','baseline')]
    if any(n.tag in REV for name,raw in clean_parts.items() if STORY.fullmatch(name) for n in parse_xml(raw).iter()):fail('WORD_CLEAN_HAS_REVISIONS')
    if stories(tracked,True)!=stories(clean_parts):fail('WORD_ACCEPT_MISMATCH')
    if not any(t.strip() for t in stories(clean_parts)['word/document.xml'][0]):fail('WORD_EMPTY_MANUSCRIPT')
    revisions=[n for name,raw in tracked.items() if STORY.fullmatch(name) for n in parse_xml(raw).iter() if n.tag in REV and n.get(Q('author'))==data['revision_author']]
    kind=data['baseline_kind'];source=data.get('baseline_path')
    if kind=='none':
        if revisions or stories(tracked)!=stories(baseline):fail('WORD_FALSE_BASELINE')
    else:
        if kind in ('uploaded_source','project_output'):
            if (root/source).read_bytes()!=paths['baseline'].read_bytes():fail('WORD_BASELINE_CHANGED')
        if not revisions:fail('WORD_NO_REVISIONS')
        if stories(tracked,False,data['revision_author'])!=stories(baseline,True):fail('WORD_REJECT_MISMATCH')
        if stories(clean_parts)==stories(baseline,True):fail('WORD_NO_CHANGES')
        for name,raw in baseline.items():
            if name.startswith(('word/media/','word/embeddings/','word/fonts/')) and tracked.get(name)!=raw:fail('WORD_BASELINE_ASSET_LOST')
    delivery=paths['delivery']
    if delivery.is_symlink() or not 0<delivery.stat().st_size<=256*1024:fail('WORD_DELIVERY_NOTE_REQUIRED')
    note=delivery.read_text(encoding='utf-8')
    pending=[{'record_id':'delivery','message':line.strip()[:2000]} for line in note.splitlines() if '待人工确认' in line][:100]
    raw={k:p.read_bytes() for k,p in paths.items() if k!='delivery'}
    return {'writer_version':'codex-file-word-1.0.0','baseline_kind':kind,
        'source_sha256':sha((root/source).read_bytes()) if source else None,
        'baseline_hash':sha(raw['baseline']) if source else None,'effective_baseline_sha256':sha(raw['baseline']),
        'revision_sha256':sha(raw['tracked']),'clean_sha256':sha(raw['clean']),
        'plan_hash':sha((data['input_hash']+sha(raw['tracked'])+sha(raw['clean'])).encode()),
        'replacements':len(revisions),'columns':0,'pending':len(pending),'pending_review':pending}

def main():
    try:
        if sys.argv[1]=='clean':clean(sys.argv[2],sys.argv[3])
        else:print(json.dumps(check(Path(sys.argv[1])),ensure_ascii=False))
    except Exception as error:
        code=str(error) if isinstance(error,ValueError) and re.fullmatch(r'WORD_[A-Z_]+',str(error)) else 'WORD_CHECK_FAILED'
        print(code,file=sys.stderr);return 1
    return 0

if __name__=='__main__':sys.exit(main())
