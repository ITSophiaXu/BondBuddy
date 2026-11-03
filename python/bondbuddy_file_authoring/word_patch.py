"""Patch an uploaded Word package in place; never reconstruct a DOCX template."""
from __future__ import annotations

import copy
import hashlib
import io
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZipFile

from lxml import etree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}


def q(name):
    return '{' + W + '}' + name


def xml(raw):
    return ET.fromstring(raw, ET.XMLParser(resolve_entities=False, no_network=True))


def serialized(root):
    return ET.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True)


def paragraphs(node):
    return [node] if node.tag == q('p') else list(node.findall(q('p')))


def leaves(p):
    """Visible text only: field instructions, drawings and other stories are opaque."""
    result, pos = [], 0
    for leaf in p.iter():
        if leaf.tag not in {q('t'), q('tab'), q('br'), q('cr'), q('noBreakHyphen')} or leaf.getparent().tag != q('r'):
            continue
        ancestors = list(leaf.iterancestors())
        if next((a for a in ancestors if a.tag == q('p')), None) is not p:
            continue
        if any(a.tag in {q('del'), q('moveFrom')} for a in ancestors):
            continue
        if leaf.tag == q('t'):
            text = leaf.text or ''
        elif leaf.tag == q('tab'):
            text = '\t'
        elif leaf.tag == q('noBreakHyphen'):
            text = '\u2011'
        else:
            text = '\n' if leaf.get(q('type'), 'textWrapping') == 'textWrapping' else ''
        if text:
            result.append((leaf, text, pos, pos + len(text)))
            pos += len(text)
    return result


def paragraph_text(p):
    return ''.join(item[1] for item in leaves(p))


def paragraph_run_reference(p):
    """Use an existing run, or the empty paragraph's explicit mark formatting.

    An empty cell can store its font and size only in pPr/rPr. A new bare run
    does not inherit those mark properties, so copy them when no run exists.
    Keep normal style inheritance when neither source specifies properties.
    """
    runs = (run for run in p.iter(q('r'))
            if next((a for a in run.iterancestors() if a.tag == q('p')), None) is p)
    if not paragraph_text(p):
        # A comment/footnote symbol is not a typing-format reference. This
        # matters when continuing a previously annotated empty table cell.
        runs = (run for run in runs if all(child.tag in {q('rPr'), q('t')} for child in run))
    reference = next(runs, None)
    if reference is not None:
        return reference
    reference = ET.Element(q('r'))
    props = p.find(q('pPr') + '/' + q('rPr'))
    if props is not None:
        reference.append(copy.deepcopy(props))
    return reference


def run_with_text(run, text, deleted=False):
    r = ET.Element(q('r'), dict(run.attrib))
    props = run.find(q('rPr'))
    if props is not None:
        r.append(copy.deepcopy(props))
    # Preserve tabs and line breaks, without replacing paragraph boundaries.
    for i, line in enumerate(text.split('\n')):
        if i:
            r.append(ET.Element(q('br')))
        for j, part in enumerate(line.split('\t')):
            if j:
                r.append(ET.Element(q('tab')))
            if part:
                t = ET.SubElement(r, q('delText' if deleted else 't'))
                t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                t.text = part
    return r


def isolate_run(run):
    """Split only a touched run; preserve non-text children and their ordering."""
    children = [c for c in run if c.tag != q('rPr')]
    if len(children) <= 1:
        return
    parent, index = run.getparent(), run.getparent().index(run)
    props = run.find(q('rPr'))
    for offset, child in enumerate(children):
        r = ET.Element(q('r'), dict(run.attrib))
        if props is not None:
            r.append(copy.deepcopy(props))
        r.append(child)
        parent.insert(index + offset, r)
    parent.remove(run)


def text_diff(old, new):
    from difflib import SequenceMatcher
    return [{'type': 'equal' if tag == 'equal' else 'replace', 'old': old[a:b], 'new': new[c:d]}
            for tag, a, b, c, d in SequenceMatcher(None, old, new, autojunk=False).get_opcodes()]


class Patcher:
    def __init__(self, root, revision, author="BondBuddy"):
        self.author = author
        self.revision = revision
        # A non-revision replay never allocates revision IDs. An absolute XPath
        # on an attached paragraph walks its entire document, so doing this for
        # every edit made long prospectuses exceed the Word worker deadline.
        # Tracked editing still scans the document once to avoid ID collisions.
        self.next_id = (max([int(n) for n in ET.XPath('//@w:id', namespaces=NS)(root)
                            if n.isdigit()] + [0]) + 1) if revision else 1
        self.date = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    def revision_node(self, run, kind):
        wrapper = ET.Element(q(kind), {q('id'): str(self.next_id), q('author'): self.author, q('date'): self.date})
        self.next_id += 1
        wrapper.append(run)
        return wrapper

    def replace(self, p, start, end, new):
        mapping = leaves(p)
        touched = [x for x in mapping if x[2] < end and x[3] > start]
        if start == end:
            anchor = next((x for x in mapping if x[2] <= start < x[3]), mapping[-1] if mapping else None)
            touched = [anchor] if anchor else []
        for run in dict.fromkeys(x[0].getparent() for x in touched):
            if run.tag != q('r'):
                raise ValueError('该位置不是普通 Word 文字，无法安全修改并保留格式。')
            isolate_run(run)
        mapping = leaves(p)
        if start == end:
            anchor = next((x for x in mapping if x[2] <= start < x[3]), mapping[-1] if mapping else None)
            if anchor is None:
                added = run_with_text(paragraph_run_reference(p), new)
                p.append(self.revision_node(added, 'ins') if self.revision else added)
                return
            touched = [anchor]
        else:
            touched = [x for x in mapping if x[2] < end and x[3] > start]
        remaining = new
        for i, (leaf, text, a, b) in enumerate(touched):
            r = leaf.getparent()
            lo, hi = max(0, start - a), min(len(text), end - a)
            if start == end:
                lo = hi = start - a
            pieces = []
            if text[:lo]:
                pieces.append(run_with_text(r, text[:lo]))
            if text[lo:hi] and self.revision:
                pieces.append(self.revision_node(run_with_text(r, text[lo:hi], True), 'del'))
            # Keep distinct formatting inside a replaced value (e.g. mixed runs).
            inserted = remaining if i == len(touched)-1 else remaining[:hi-lo]
            remaining = remaining[len(inserted):]
            if inserted:
                added = run_with_text(r, inserted)
                pieces.append(self.revision_node(added, 'ins') if self.revision else added)
            if text[hi:]:
                pieces.append(run_with_text(r, text[hi:]))
            parent, index = r.getparent(), r.getparent().index(r)
            parent.remove(r)
            for offset, piece in enumerate(pieces):
                parent.insert(index + offset, piece)

    def patch(self, node, old, new):
        ps = paragraphs(node)
        before = '\n'.join(paragraph_text(p) for p in ps)
        if before != old:
            raise ValueError('原 Word 文字与修改位置不一致，已停止导出，避免覆盖错误位置。')
        if ET.XPath('.//w:ins | .//w:del | .//w:moveFrom | .//w:moveTo', namespaces=NS)(node):
            raise ValueError('拟修改位置含原有未处理修订，请先在 Word 中处理旧修订。')
        ranges, cursor = [], 0
        for p in ps:
            length = len(paragraph_text(p))
            ranges.append((p, cursor, cursor + length))
            cursor += length + 1
        operations, offset = [], 0
        for diff in text_diff(old, new):
            a, b = offset, offset + len(diff['old'])
            offset = b
            if diff['type'] == 'equal':
                continue
            target = next(((p, lo, hi) for p, lo, hi in ranges if lo <= a <= b <= hi), None)
            if target is None:
                raise ValueError('修改跨越了原 Word 的段落边界。为保留段落格式，请逐段修改。')
            p, lo, _ = target
            if '\n' in diff['new'] and '\n' not in diff['old']:
                raise ValueError('修改新增了换行。为保留原稿段落和表格格式，请在原段落内修改。')
            operations.append((p, a-lo, b-lo, diff['new']))
        for p, start, end, text in reversed(operations):
            self.replace(p, start, end, text)


def add_layout_comments(src, root, mapping, tasks, replacements):
    """Keep deferred structural changes visible in Word without changing table geometry."""
    import posixpath
    relns = 'http://schemas.openxmlformats.org/package/2006/relationships'
    ctns = 'http://schemas.openxmlformats.org/package/2006/content-types'
    relpath = 'word/_rels/document.xml.rels'
    rels = xml(src.read(relpath))
    comment_type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
    rel = next((r for r in rels if r.get('Type') == comment_type), None)
    if rel is None:
        comment_path = 'word/comments.xml'
        used = {r.get('Id') for r in rels}
        rid = 1
        while 'rId'+str(rid) in used:
            rid += 1
        ET.SubElement(rels, '{'+relns+'}Relationship', Id='rId'+str(rid), Type=comment_type, Target='comments.xml')
        replacements[relpath] = serialized(rels)
        comments = ET.Element(q('comments'), nsmap={'w':W})
        types = xml(src.read('[Content_Types].xml'))
        ET.SubElement(types, '{'+ctns+'}Override', PartName='/word/comments.xml', ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml')
        replacements['[Content_Types].xml'] = serialized(types)
    else:
        comment_path = posixpath.normpath(posixpath.join('word', rel.get('Target')))
        comments = xml(src.read(comment_path))
    ids = [int(v) for v in ET.XPath('//@w:id', namespaces=NS)(comments) if v.isdigit()]
    next_id = max(ids + [0]) + 1
    for task in tasks:
        match = mapping.get(task['target_id'])
        if not match:
            raise ValueError('表格列安排待办无法定位到原表，已停止导出。')
        ps = paragraphs(match[0])
        if not ps:
            raise ValueError('表格批注没有可用的原稿段落。')
        p, cid = ps[0], str(next_id)
        next_id += 1
        p.insert(1 if p.find(q('pPr')) is not None else 0, ET.Element(q('commentRangeStart'), {q('id'):cid}))
        p.append(ET.Element(q('commentRangeEnd'), {q('id'):cid}))
        ref = ET.SubElement(p, q('r'))
        ET.SubElement(ref, q('commentReference'), {q('id'):cid})
        comment = ET.SubElement(comments, q('comment'), {q('id'):cid,q('author'):'BondBuddy',q('date'):datetime.now(timezone.utc).isoformat()})
        cp = ET.SubElement(comment,q('p'))
        cr = ET.SubElement(cp,q('r'))
        ET.SubElement(cr,q('t')).text = task['text']
    replacements[comment_path] = serialized(comments)
