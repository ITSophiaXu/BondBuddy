"""Narrow source-derived formatting corrections, with a reversible property plan.

No model-supplied styles, page numbers, amounts, table IDs or font defaults.
Ambiguous tables and unavailable numeric donors are recorded, never guessed.
"""
from __future__ import annotations
import copy
import re
from lxml import etree as ET
from .template_manifest import build_nodes, capability_limits, sha
from .word_patch import paragraph_text, q, xml

VERSION = 'source-derived-format-plan-v1'
NUMBER = re.compile(r'^[+-]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?%?$')
PERIOD = re.compile(r'^(?:19|20)\d{2}年(?:度|末|\d{1,2}(?:[-—–－]\d{1,2})?月(?:末|/\d{1,2}月末)?)?$')
CAPTION = re.compile(r'^表\s*[0-9一二三四五六七八九十]+\s*[-－—.．]\s*\d+\s*\S+')
LABELS = {'项目', '科目', '指标', '名称'}
SUBHEADERS = {'金额', '占比', '比例', '余额', '期末余额', '账面余额', '账面价值'}
SUMMARY = re.compile(r'(?:合计|总计|小计|总额|净额)$')
SECTION = re.compile(r'^(?:[一二三四五六七八九十]+[、．.]|[（(][一二三四五六七八九十]+[）)])')
ORDER = {
 'pPr': ['pStyle','keepNext','keepLines','pageBreakBefore','framePr','widowControl','numPr','suppressLineNumbers','pBdr','shd','tabs','suppressAutoHyphens','kinsoku','wordWrap','overflowPunct','topLinePunct','autoSpaceDE','autoSpaceDN','bidi','adjustRightInd','snapToGrid','spacing','ind','contextualSpacing','mirrorIndents','suppressOverlap','jc','textDirection','textAlignment','textboxTightWrap','outlineLvl','divId','cnfStyle','rPr','sectPr','pPrChange'],
 'trPr': ['cnfStyle','divId','gridBefore','gridAfter','wBefore','wAfter','cantSplit','trHeight','tblHeader','tblCellSpacing','jc','hidden','ins','del','trPrChange'],
}

def compact(text): return re.sub(r'\s+', '', text or '')
def numeric(text): return bool(NUMBER.fullmatch(compact(text)))
def raw(node): return ET.tostring(node, encoding='unicode') if node is not None else None
def signature(node):
    return None if node is None else (node.tag, tuple(sorted(node.attrib.items())), node.text or '', tuple(signature(c) for c in node))
def true(node): return node is not None and node.get(q('val'), '1') not in {'0','false','off'}

def set_property(props, name, value=None):
    existing = props.find(q(name))
    if existing is not None: props.remove(existing)
    if value is False: return
    child = ET.Element(q(name)) if value is None else copy.deepcopy(value)
    order = ORDER[ET.QName(props).localname]
    position = order.index(name)
    index = next((i for i,c in enumerate(props) if ET.QName(c).localname in order and order.index(ET.QName(c).localname)>position),len(props))
    props.insert(index,child)

def row_cells(row): return row.findall(q('tc'))
def cell_paragraph(cell):
    ps = cell.findall(q('p'))
    return ps[0] if len(ps)==1 and not cell.findall(q('tbl')) else None
def label(row):
    cells = row_cells(row)
    return compact('\n'.join(paragraph_text(p) for p in cells[0].iter(q('p')))) if cells else ''
def detail(row):
    text = label(row)
    return bool(text) and text not in LABELS and not SUMMARY.search(text) and not SECTION.match(text) and not text.endswith(('：',':'))


def styles_allow_ascii_projection(parts):
    """Conservative proof for default-style inheritance, not a style resolver."""
    data=parts.get('word/styles.xml')
    if data is None: return False
    styles=xml(data)
    # Even unused forced complex-script styles disable this optimization. We do
    # not infer which conditional/table/linked style Word will choose.
    if any(n.tag in {q('rtl'),q('cs'),q('bidi')} and true(n) for n in styles.iter()): return False
    for kind in ('paragraph','character','table'):
        defaults=[n for n in styles.findall(q('style')) if n.get(q('type'))==kind and n.get(q('default')) in {'1','true','on'}]
        if len(defaults)!=1 or defaults[0].find(q('basedOn')) is not None: return False
    return True


def plain_style_context(p):
    if p.find(q('pPr')+'/'+q('pStyle')) is not None or next(p.iter(q('rStyle')),None) is not None: return False
    if any(n.tag in {q('rtl'),q('cs'),q('bidi')} and true(n) for n in p.iter()): return False
    return not any(a.tag==q('tbl') and a.find(q('tblPr')+'/'+q('tblStyle')) is not None for a in p.iterancestors())


def numeric_reference_signature(p, props, allow_ascii_projection=False):
    """Compare proven ASCII glyph formatting, never rewrite source properties.

    For ordinary ASCII numbers with the same explicit ascii/hAnsi face and no
    theme override or forced RTL/complex-script mode, language spellchecking
    metadata and the ambiguous-character font hint do not select the glyphs.
    Otherwise every direct property remains part of reference equivalence.
    The chosen donor is still copied intact, including its original metadata.
    """
    fonts=props.find(q('rFonts')) if props is not None else None
    if (not allow_ascii_projection or not plain_style_context(p)
            or fonts is None or not fonts.get(q('ascii')) or fonts.get(q('ascii'))!=fonts.get(q('hAnsi'))
            or fonts.get(q('asciiTheme')) or fonts.get(q('hAnsiTheme'))
            or any(true(props.find(q(tag))) for tag in ('rtl','cs'))
            or true(p.find(q('pPr')+'/'+q('bidi')))):
        return signature(props)
    projected=copy.deepcopy(props)
    for lang in list(projected.findall(q('lang'))): projected.remove(lang)
    projected.find(q('rFonts')).attrib.pop(q('hint'),None)
    return signature(projected)

def visible_style(p, allow_ascii_projection=False):
    if p is None or not numeric(paragraph_text(p)) or capability_limits(p): return None
    runs = [r for r in p.iter(q('r')) if any((t.text or '').strip() for t in r.findall(q('t')))]
    if not runs or any(any(c.tag not in {q('rPr'),q('t')} for c in r) for r in runs): return None
    signatures = {repr(numeric_reference_signature(p,r.find(q('rPr')),allow_ascii_projection)) for r in runs}
    if len(signatures)!=1: return None
    # Matching paragraph style is mandatory: copying an incomplete run override
    # between different inherited paragraph styles does not prove equal glyphs.
    style = p.find(q('pPr')+'/'+q('pStyle'))
    jc = p.find(q('pPr')+'/'+q('jc'))
    return {'paragraph_style':signature(style),'alignment':raw(jc),'run_properties':raw(runs[0].find(q('rPr'))),
            'comparison_key':(signature(style),signature(jc),numeric_reference_signature(p,runs[0].find(q('rPr')),allow_ascii_projection))}

def compatible(p, donor):
    return donor is not None and signature(p.find(q('pPr')+'/'+q('pStyle')))==donor['paragraph_style']

def numeric_donor(source_p, source_ids, allow_ascii_projection=False):
    allow_ascii_projection=allow_ascii_projection and plain_style_context(source_p)
    cell = source_p.getparent()
    if cell.tag!=q('tc') or cell_paragraph(cell) is not source_p: return None,'complex_cell'
    row = cell.getparent(); table = row.getparent()
    if row.tag!=q('tr') or table.tag!=q('tbl') or capability_limits(table): return None,'complex_table'
    cells = row_cells(row); col = cells.index(cell)
    if col==0: return None,'label_column'
    peers=[]
    for other in cells[1:]:
        p=cell_paragraph(other)
        if p is source_p: continue
        value=visible_style(p,allow_ascii_projection)
        if compatible(source_p,value): peers.append((p,value))
    if peers:
        if len({repr(v['comparison_key']) for _,v in peers})!=1: return None,'same_row_visible_styles_disagree'
        p,value=peers[0]
        return {'donor_node_id':source_ids[p],**value},'same_row_visible_period'
    if not detail(row): return None,'summary_or_section_without_visible_peer'
    # A bounded same-column fallback needs two agreeing visible detail rows.
    # Never cross a subtotal or section boundary, or infer from another table.
    rows=table.findall(q('tr')); at=rows.index(row); candidates=[]
    for direction in (-1,1):
        for distance in range(1,5):
            ri=at+direction*distance
            if not 0<=ri<len(rows): break
            other=rows[ri]
            if not detail(other): break
            other_cells=row_cells(other)
            if len(other_cells)!=len(cells): break
            p=cell_paragraph(other_cells[col]); value=visible_style(p,allow_ascii_projection)
            if compatible(source_p,value): candidates.append((p,value))
    if len(candidates)<2: return None,'insufficient_visible_same_column_references'
    if len({repr(v['comparison_key']) for _,v in candidates})!=1: return None,'same_column_visible_styles_disagree'
    p,value=candidates[0]
    return {'donor_node_id':source_ids[p],'corroborating_node_ids':[source_ids[p] for p,_ in candidates],**value},'same_column_two_agreeing_detail_rows'

def header_count(table):
    rows=table.findall(q('tr'))
    if len(rows)<2 or capability_limits(table): return None
    cells=row_cells(rows[0]); first=[compact(paragraph_text(cell_paragraph(c))) if cell_paragraph(c) is not None else '' for c in cells]
    if len(first)<2 or first[0] not in LABELS or not all(PERIOD.fullmatch(v) for v in first[1:]): return None
    second=[compact(paragraph_text(cell_paragraph(c))) if cell_paragraph(c) is not None else '' for c in row_cells(rows[1])]
    count=2 if len(second)==len(first) and second[0] in LABELS|{''} and all(v in SUBHEADERS for v in second[1:]) else 1
    if len(rows)<=count: return None
    data=row_cells(rows[count])
    if len(data)!=len(cells) or label(rows[count]) in LABELS or not any(numeric(paragraph_text(p)) for c in data[1:] if (p:=cell_paragraph(c)) is not None): return None
    return count

def build_plan(editor):
    source_roots={name:xml(data) for name,data in editor.parts.items() if name in editor.roots}
    originals=build_nodes(source_roots)
    source_ids={node:key for key,(_,node) in originals.items()}
    changes={}; fonts=[]; unresolved=[]; table_notes=[]
    allow_ascii_projection=styles_allow_ascii_projection(editor.parts)
    def change(key,prop,tag,value=None):
        part,node=editor.nodes[key]
        base=originals.get(key)
        # New rows are already structural insertions and need no property rollback.
        old=(base[1] if base else node).find(q(prop))
        entry=changes.setdefault((key,prop),{'node_id':key,'part':part,'property':prop,'before_present':old is not None,'before_xml':raw(old),'source_node':key if base else None,'after':copy.deepcopy(old) if old is not None else ET.Element(q(prop))})
        set_property(entry['after'],tag,value)
    targets=editor.touched|set(editor.format_origins)
    for key in sorted(targets):
        origin=editor.format_origins.get(key,key)
        if key not in editor.nodes: continue
        if origin not in originals:
            if numeric(paragraph_text(editor.nodes[key][1])):
                unresolved.append({'node_id':key,'reason':'immutable_source_origin_unavailable','action':'preserve_source_format_without_guessing'})
            continue
        part,source_p=originals[origin];final=editor.nodes[key][1]
        if source_p.tag!=q('p') or compact(paragraph_text(source_p)) or not numeric(paragraph_text(final)): continue
        donor,reason=numeric_donor(source_p,source_ids,allow_ascii_projection)
        if donor is None:
            unresolved.append({'node_id':key,'reason':reason,'action':'preserve_source_format_without_guessing'})
            continue
        fonts.append({'node_id':key,'part':part,'source_node_id':origin,'reference_reason':reason,**donor})
        jc=xml(donor['alignment'].encode()) if donor['alignment'] else False
        change(key,'pPr','jc',jc)
    inverse={node:key for key,(_,node) in editor.nodes.items()}
    for part in sorted(editor.changed_parts):
        for table in editor.roots[part].iter(q('tbl')):
            before=table.getprevious();chain=[]
            while before is not None and before.tag==q('p') and len(chain)<3:
                text=paragraph_text(before).strip()
                if CAPTION.match(text): chain.append(before);break
                if not text or compact(text).startswith('单位：'): chain.append(before);before=before.getprevious();continue
                break
            if not chain or not CAPTION.match(paragraph_text(chain[-1]).strip()): continue
            if any(capability_limits(p) for p in chain):
                table_notes.append({'node_id':inverse.get(table),'status':'caption_contains_unsupported_content_no_change'});continue
            count=header_count(table)
            if count is None:
                table_notes.append({'node_id':inverse.get(table),'status':'header_boundary_unresolved_no_change'});continue
            rows=table.findall(q('tr'))
            # Only the consecutive header block at the start has repeating-header
            # semantics in Word. Preserve unrelated flags beyond the first gap.
            marked_prefix=next((ri for ri,row in enumerate(rows) if not true(row.find(q('trPr')+'/'+q('tblHeader')))),len(rows))
            table_notes.append({'node_id':inverse[table],'status':'recognized','header_rows':count})
            for p in chain:
                if p in inverse: change(inverse[p],'pPr','keepNext')
            for ri,row in enumerate(rows):
                if row not in inverse: continue
                key=inverse[row]
                if ri<count:
                    change(key,'trPr','tblHeader');change(key,'trPr','cantSplit')
                    for p in row.iter(q('p')):
                        if p in inverse: change(inverse[p],'pPr','keepNext')
                else:
                    if ri<marked_prefix: change(key,'trPr','tblHeader',False)
                    if ri==count: change(key,'trPr','cantSplit')
    properties=[]
    for entry in changes.values():
        after=entry.pop('after')
        original=xml(entry['before_xml'].encode()) if entry['before_xml'] else None
        if original is None and not len(after) and not after.attrib: continue
        if signature(after)==signature(original): continue
        entry['after_xml']=raw(after);properties.append(entry)
    return {'version':VERSION,'baseline_sha256':editor.data.get('baseline_sha256'),'input_hash':editor.data['input_hash'],'properties':properties,'numeric_fonts':fonts,'numeric_references_unresolved':unresolved,'tables':table_notes,'visual_review':'not_run'}

def apply_plan(plan,part,destinations,patcher,inserted_keys):
    for entry in plan['properties']:
        if entry['part']!=part: continue
        node=destinations[entry['node_id']];prop=entry['property'];existing=node.find(q(prop))
        after=xml(entry['after_xml'].encode())
        if entry['node_id'] in inserted_keys and existing is not None:
            if prop=='trPr':
                for child in existing:
                    if child.tag in {q('ins'),q('del')}: after.append(copy.deepcopy(child))
            elif prop=='pPr':
                marker_parent=existing.find(q('rPr'))
                if marker_parent is not None:
                    for child in marker_parent:
                        if child.tag in {q('ins'),q('del')}:
                            target=after.find(q('rPr'))
                            if target is None: target=ET.SubElement(after,q('rPr'))
                            target.append(copy.deepcopy(child))
        if entry['source_node'] is not None:
            old=xml(entry['before_xml'].encode()) if entry['before_xml'] else ET.Element(q(prop))
            marker=patcher.revision_node(old,prop+'Change')
            after.append(marker)
        if existing is not None: node.replace(existing,after)
        else: node.insert(0,after)
    for entry in plan['numeric_fonts']:
        if entry['part']!=part: continue
        p=destinations[entry['node_id']]
        for run in p.iter(q('r')):
            if not any((t.text or '').strip() for t in run.findall(q('t'))): continue
            if not any(a.tag==q('ins') and a.get(q('author'))==patcher.author for a in run.iterancestors()):
                raise ValueError('WORD_NUMERIC_FORMAT_UNTRACKED_TEXT')
            old=run.find(q('rPr'))
            if old is not None: run.remove(old)
            if entry['run_properties']: run.insert(0,xml(entry['run_properties'].encode()))

def restore_absent_property_shells(root,plan,part):
    """Only remove originally absent, now-empty property shells in trusted replay.

    Standard Word property-change XML represents absent properties as an empty
    old property group. Keep the general canonical comparator strict; scope the
    structural absence restoration to exact source IDs in the derived plan.
    """
    nodes=build_nodes({part:root})
    for entry in plan['properties']:
        if entry['part']!=part or entry['before_present'] or not entry['source_node']: continue
        found=nodes.get(entry['source_node'])
        if found is None: raise ValueError('WORD_FORMAT_REJECT_SOURCE_NODE_MISSING')
        node=found[1];props=node.find(q(entry['property']))
        if props is not None:
            if len(props) or props.attrib or (props.text or '').strip(): raise ValueError('WORD_FORMAT_REJECT_PROPERTY_NOT_EMPTY')
            node.remove(props)

def plan_summary(plan):
    return {'version':plan['version'],'property_changes':len(plan['properties']),'numeric_fonts':len(plan['numeric_fonts']),'numeric_references_unresolved':plan['numeric_references_unresolved'],'tables':plan['tables'],'visual_review':'not_run'}
