"""Read-only, source-bound DOCX structure and formatting inventory."""
from __future__ import annotations

import hashlib
import copy
import re
from pathlib import Path

from lxml import etree as ET

from .check import STORY, package
from .source_outline import outline
from .word_patch import paragraph_text, q, xml

VERSION = 'word-template-manifest-v1'
KINDS = {q('p'): 'paragraph', q('tbl'): 'table', q('tr'): 'row', q('tc'): 'cell'}
OPAQUE = {q(v) for v in ('fldChar', 'instrText', 'fldSimple', 'drawing', 'pict', 'object', 'sdt')}
REVISION = {q(v) for v in ('ins', 'del', 'moveFrom', 'moveTo', 'pPrChange', 'rPrChange',
                         'trPrChange', 'tcPrChange', 'tblPrChange', 'tblGridChange', 'cellIns', 'cellDel', 'cellMerge')}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def property_xml(node):
    if node is None:
        return None
    node = copy.deepcopy(node)
    ET.cleanup_namespaces(node)
    return ET.tostring(node, encoding='unicode')


def node_text(node):
    if node.tag == q('p'):
        return paragraph_text(node)
    return '\n'.join(paragraph_text(p) for p in node.iter(q('p')))


def build_nodes(roots):
    nodes = {}
    for part, root in roots.items():
        counts = {}
        for node in root.iter():
            kind = KINDS.get(node.tag)
            if kind is None:
                continue
            counts[kind] = counts.get(kind, 0) + 1
            # The whole baseline hash binds all formatting. Node IDs only need
            # the original story, ordinal and source text fingerprint; hashing
            # every table's full descendant XML is costly on long prospectuses.
            digest = sha((kind + ':' + node_text(node)).encode('utf-8'))[:16]
            nodes[f'{part}#{kind}:{counts[kind]}:{digest}'] = (part, node)
    return nodes


def capability_limits(node):
    limits = []
    if any(n.tag in REVISION for n in node.iter()):
        limits.append('existing_revisions')
    if any(n.tag in OPAQUE for n in node.iter()):
        limits.append('fields_or_embedded_objects')
    if node.tag in {q('tr'), q('tc'), q('tbl')} and any(
            n.tag in {q('gridSpan'), q('vMerge'), q('hMerge'), q('gridBefore'), q('gridAfter')}
            for n in node.iter()):
        limits.append('merged_or_irregular_grid')
    if node.tag == q('p') and node.find(q('pPr') + '/' + q('sectPr')) is not None:
        limits.append('section_break')
    return limits


def describe_node(node_id, part, node, ids=None, formats=None, parts=None):
    ids = ids or {}
    def property_ref(value):
        raw = property_xml(value)
        if raw is None or formats is None:
            return raw
        key = sha(raw.encode('utf-8'))[:24]
        formats.setdefault(key, raw)
        return key
    result = {'node_id': node_id, 'part': part, 'kind': KINDS[node.tag],
              'text': node_text(node), 'limitations': capability_limits(node)}
    if formats is not None and len(result['text']) > 2000:
        result['text_length'] = len(result['text'])
        result['text'] = result['text'][:2000]
        result['text_truncated'] = True
    result['parent_node_id'] = next((ids[id(a)] for a in node.iterancestors() if id(a) in ids), None)
    if node.tag == q('p'):
        props = node.find(q('pPr'))
        style = props.find(q('pStyle')) if props is not None else None
        outline = props.find(q('outlineLvl')) if props is not None else None
        result.update(style_id=style.get(q('val')) if style is not None else None,
                      outline_level=outline.get(q('val')) if outline is not None else None,
                      paragraph_properties=property_xml(props))
        # A template manifest interns properties and combines adjacent formatting
        # spans. Inspect still returns the requested node's full run details.
        if formats is not None:
            raw_props = result.pop('paragraph_properties')
            key = sha(raw_props.encode('utf-8'))[:24] if raw_props is not None else None
            if key is not None:
                formats.setdefault(key, raw_props)
            result['paragraph_properties_ref'] = key
        runs = []
        for run in node.iter(q('r')):
            if next((a for a in run.iterancestors() if a.tag == q('p')), None) is not node:
                continue
            raw_props = property_xml(run.find(q('rPr')))
            text = ''.join(run.itertext())
            if formats is None:
                runs.append({'text': text, 'properties': raw_props})
            else:
                key = sha(raw_props.encode('utf-8'))[:24] if raw_props is not None else None
                if key is not None:
                    formats.setdefault(key, raw_props)
                if runs and runs[-1]['properties_ref'] == key:
                    runs[-1]['text_length'] += len(text)
                    runs[-1]['run_count'] += 1
                else:
                    runs.append({'properties_ref': key, 'text_length': len(text), 'run_count': 1})
        result['runs'] = runs
        if parts is not None:
            from .embedded_images import describe_image
            image = describe_image(parts, part, node)
            if image is not None:
                result['image_edit'] = image
    elif node.tag == q('tbl'):
        rows = node.findall(q('tr'))
        result.update(properties=property_ref(node.find(q('tblPr'))),
                      grid=property_ref(node.find(q('tblGrid'))), rows=len(rows),
                      first_row=[node_text(c) for c in rows[0].findall(q('tc'))] if rows else [])
    elif node.tag == q('tr'):
        result.update(properties=property_ref(node.find(q('trPr'))),
                      cells=[ids.get(id(c)) for c in node.findall(q('tc'))])
    else:
        result['properties'] = property_ref(node.find(q('tcPr')))
    if formats is not None:
        for key in ['properties', 'grid']:
            if key in result:
                result[key + '_ref'] = result.pop(key)
    return result


def describe_nodes(nodes, formats=None, selected=None, parts=None):
    ids = {id(node): node_id for node_id, (_, node) in nodes.items()}
    selected = nodes if selected is None else selected
    return [describe_node(node_id, part, node, ids, formats, parts) for node_id, (part, node) in selected.items()]


def build_manifest(source: Path):
    source = Path(source)
    parts = package(source)
    roots = {part: xml(raw) for part, raw in parts.items() if STORY.fullmatch(part)}
    nodes = build_nodes(roots)
    styles = {}
    defaults = None
    if 'word/styles.xml' in parts:
        style_root = xml(parts['word/styles.xml'])
        defaults = property_xml(style_root.find(q('docDefaults')))
        for node in style_root.findall(q('style')):
            key = node.get(q('styleId'))
            base = node.find(q('basedOn'))
            styles[key] = {'type': node.get(q('type')), 'based_on': base.get(q('val')) if base is not None else None,
                           'properties': property_xml(node)}
    for style in styles.values():
        chain, seen, base = [], set(), style['based_on']
        while base in styles and base not in seen:
            seen.add(base)
            chain.append(base)
            base = styles[base]['based_on']
        style['inheritance_chain'] = chain
    formats = {}
    described = describe_nodes(nodes, formats, parts=parts)
    numbering = {}
    if 'word/numbering.xml' in parts:
        for node in xml(parts['word/numbering.xml']):
            if node.tag in {q('abstractNum'), q('num')}:
                kind = ET.QName(node).localname
                numbering[f'{kind}:{node.get(q(kind + "Id"))}'] = property_xml(node)
    try:
        source_structure = outline(parts)
    except ValueError:
        source_structure = {'status': 'unsupported', 'reason': 'Effective outline requires unsupported revision handling'}
    return {'version': VERSION, 'baseline_sha256': sha(source.read_bytes()),
            'source_structure': source_structure,
            'offset_unit': 'unicode_code_points', 'nodes': described, 'styles': styles, 'property_formats': formats,
            'document_defaults': defaults, 'numbering_definitions': numbering,
            'headings': [{'node_id': n['node_id'], 'text': n['text'], 'style_id': n.get('style_id'),
                          'outline_level': n.get('outline_level'),
                          'recognition': 'explicit' if n.get('outline_level') is not None else 'style_or_text_candidate'}
                         for n in described if n['kind'] == 'paragraph' and
                         (n.get('outline_level') is not None or
                          re.match(r'(?i)(heading|标题)', n.get('style_id') or '') or
                          re.match(r'^第[一二三四五六七八九十百\d]+[章节]', n['text']))],
            'sections': [{'part': part, 'properties': property_xml(section)}
                         for part, root in roots.items() for section in root.iter(q('sectPr'))],
            'resources': [{'part': part, 'sha256': sha(raw), 'byte_size': len(raw)} for part, raw in parts.items()],
            'supported_operations': ['replace_text', 'replace_cell_text', 'insert_paragraph', 'insert_row', 'insert_column',
                                     'insert_table', 'delete_table', 'add_comment', 'remove_image'],
            'unsupported_operations': ['change_cell_merges', 'move_section', 'edit_field'],
            'visual_review': 'not_run'}
