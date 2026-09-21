import json
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Inches, RGBColor
from docx_locations import walk_blocks
from annotate_docx import split_at

def tracked(source, payload, output, result):
    doc = Document(source)
    locations = dict(walk_blocks(doc))
    edits = json.loads(Path(payload).read_text(encoding='utf-8'))['edits']
    ids = [int(e.get(qn('w:id'))) for e in doc.element.iter() if e.get(qn('w:id'), '').isdigit()]
    next_id = max(ids, default=0) + 1
    applied, skipped = [], []
    groups = {}
    for edit in edits: groups.setdefault(edit['locator'], []).append(edit)
    for loc, changes in groups.items():
        paragraph = locations.get(loc)
        if paragraph is None:
            skipped.extend({'id':e['id'],'reason':'位置不存在'} for e in changes)
            continue
        # Fail closed for drawings, hyperlinks, fields, pre-existing revisions/comments.
        if any(c.tag not in (qn('w:pPr'), qn('w:r')) for c in paragraph._p) or any(c.tag not in (qn('w:rPr'), qn('w:t')) for r in paragraph.runs for c in r._r):
            skipped.extend({'id':e['id'],'reason':'含复杂域、已有修订或批注，需人工处理'} for e in changes)
            continue
        original = paragraph.text
        valid=[]
        for e in changes:
            if not e['quote'] or original.count(e['quote']) != 1:
                skipped.append({'id':e['id'],'reason':'原文锚点不唯一或不匹配'})
            else: valid.append((original.index(e['quote']), e))
        occupied=[]
        for start,e in sorted(valid, key=lambda v:v[0], reverse=True):
            end=start+len(e['quote'])
            if any(start<b and end>a for a,b in occupied):
                skipped.append({'id':e['id'],'reason':'与其他修改范围重叠'})
                continue
            occupied.append((start,end))
            split_at(paragraph,end); split_at(paragraph,start)
            cursor=0; selected=[]
            for run in paragraph.runs:
                length=len(run.text)
                if length and cursor>=start and cursor+length<=end: selected.append(run)
                cursor+=length
            if not selected:
                skipped.append({'id':e['id'],'reason':'无法确定修订范围'}); continue
            deletion=OxmlElement('w:del'); insertion=OxmlElement('w:ins')
            for node in (deletion,insertion):
                node.set(qn('w:id'),str(next_id)); next_id+=1
                node.set(qn('w:author'),'BondBuddy'); node.set(qn('w:date'),datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
            selected[0]._r.addprevious(deletion)
            for run in selected:
                old=deepcopy(run._r)
                for text in old.iter(qn('w:t')): text.tag=qn('w:delText')
                deletion.append(old)
                paragraph._p.remove(run._r)
            if e['replacement']:
                new=OxmlElement('w:r')
                props=selected[0]._r.find(qn('w:rPr'))
                if props is not None: new.append(deepcopy(props))
                for i,part in enumerate(e['replacement'].split('\n')):
                    if i: new.append(OxmlElement('w:br'))
                    text=OxmlElement('w:t'); text.set(qn('xml:space'),'preserve'); text.text=part; new.append(text)
                insertion.append(new); deletion.addnext(insertion)
            applied.append(e['id'])
    if doc.settings.element.find(qn('w:trackRevisions')) is None: doc.settings.element.append(OxmlElement('w:trackRevisions'))
    doc.save(output)
    Path(result).write_text(json.dumps({'applied':applied,'skipped':skipped},ensure_ascii=False),encoding='utf-8')

def report(payload,output):
    data=json.loads(Path(payload).read_text(encoding='utf-8'))
    doc=Document()
    section=doc.sections[0]; section.top_margin=section.bottom_margin=Inches(.8)
    section.left_margin=section.right_margin=Inches(.85)
    for name in ('Normal','Title','Heading 1','Heading 2','Heading 3'):
        style=doc.styles[name]; style.font.name='Microsoft YaHei'
        style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
        style.font.color.rgb=RGBColor(0,0,0)
    doc.styles['Normal'].font.size=Pt(10.5)
    doc.styles['Normal'].paragraph_format.space_after=Pt(7)
    doc.add_paragraph(data['title'],style='Title')
    for line in data['body'].splitlines():
        if not line.strip(): continue
        if line.startswith('# '): continue
        if line.startswith('### '): doc.add_heading(line[4:],level=2)
        elif line.startswith('## '): doc.add_heading(line[3:],level=1)
        elif line.startswith('- '): doc.add_paragraph(line[2:],style='List Bullet')
        else: doc.add_paragraph(line.replace('**',''))
    doc.save(output)

if __name__=='__main__':
    if sys.argv[1]=='tracked': tracked(*sys.argv[2:6])
    elif sys.argv[1]=='report': report(*sys.argv[2:4])
    else: raise ValueError('Unknown operation')
