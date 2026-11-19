"""Read-only recognition of a single, source-bound raster image paragraph.

This deliberately does not enable editing fields, OLE, SmartArt, linked images,
text boxes or mixed image/text runs. It returns XML nodes only to trusted replay.
"""
from __future__ import annotations
import hashlib
import posixpath
from .word_patch import paragraph_text, q, xml

REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
IMAGE_TYPE = R + '/image'
BLOCKED = {q(x) for x in ('fldChar', 'instrText', 'fldSimple', 'pict', 'object', 'sdt',
                          'ins', 'del', 'moveFrom', 'moveTo', 'sectPr')}


def single_image(parts, part, paragraph):
    def fail():
        raise ValueError('WORD_EDIT_IMAGE_UNSUPPORTED')
    if part != 'word/document.xml' or paragraph.tag != q('p') or paragraph_text(paragraph) != '':
        fail()
    if any(n.tag in BLOCKED for n in paragraph.iter()):
        fail()
    drawings = list(paragraph.iter(q('drawing')))
    if len(drawings) != 1:
        fail()
    drawing = drawings[0]
    run = drawing.getparent()
    if run.tag != q('r') or run.getparent() is not paragraph or any(n.tag not in {q('rPr'), q('drawing')} for n in run):
        fail()
    if any(n.tag not in {q('pPr'), q('r'), q('bookmarkStart'), q('bookmarkEnd'), q('proofErr')} for n in paragraph):
        fail()
    graphic = list(drawing.iter('{' + A + '}graphicData'))
    blips = list(drawing.iter('{' + A + '}blip'))
    if len(graphic) != 1 or graphic[0].get('uri') != PIC or len(blips) != 1:
        fail()
    pictures = graphic[0].findall('{' + PIC + '}pic')
    if len(pictures) != 1 or pictures[0] not in tuple(blips[0].iterancestors()):
        fail()
    blip = blips[0]
    rid = blip.get('{' + R + '}embed')
    if not rid or any(k.startswith('{' + R + '}') and (n is not blip or k != '{' + R + '}embed')
                      for n in drawing.iter() for k in n.attrib):
        fail()
    relpath = posixpath.dirname(part) + '/_rels/' + posixpath.basename(part) + '.rels'
    if relpath not in parts:
        fail()
    rels = xml(parts[relpath])
    if rels.tag != '{' + REL + '}Relationships':
        fail()
    relations = [n for n in rels if n.get('Id') == rid]
    if len(relations) != 1 or relations[0].tag != '{' + REL + '}Relationship' or relations[0].get('Type') != IMAGE_TYPE or relations[0].get('TargetMode'):
        fail()
    target = relations[0].get('Target', '')
    if not target or target.startswith('/') or '\\' in target or '..' in target.split('/'):
        fail()
    media = posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
    raw = parts.get(media)
    if not media.startswith('word/media/') or not raw or len(raw) > 10 * 1024 * 1024:
        fail()
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        media_type = 'image/png'
    elif raw.startswith(b'\xff\xd8\xff'):
        media_type = 'image/jpeg'
    else:
        fail()
    return run, {'relationship_id': rid, 'image_part': media,
                 'sha256': hashlib.sha256(raw).hexdigest(), 'byte_size': len(raw),
                 'media_type': media_type, 'supported_operation': 'remove_image'}


def describe_image(parts, part, paragraph):
    if not any(n.tag in {q('drawing'), q('pict'), q('object')} for n in paragraph.iter()):
        return None
    try:
        _, profile = single_image(parts, part, paragraph)
        return {'supported': True, **profile}
    except ValueError:
        return {'supported': False, 'reason': 'WORD_EDIT_IMAGE_UNSUPPORTED'}
