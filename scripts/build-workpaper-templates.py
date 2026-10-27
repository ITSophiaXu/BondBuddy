"""Build format-only runtime templates from an explicitly supplied local library.

No original document, sample text, signature, image, comment or metadata is
published. Run with library directory and destination directory arguments.
"""
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from lxml import etree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
q = lambda x: '{'+W+'}'+x

def build(library, destination):
    library, destination = Path(library), Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    catalog = []
    for item in json.loads((library/'模板目录.json').read_text(encoding='utf8')):
        source = library/item['reference']
        assert hashlib.sha256(source.read_bytes()).hexdigest() == item['sha256']
        with ZipFile(source) as package:
            parts = {n: package.read(n) for n in package.namelist() if
                     n in ('[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml',
                           'word/fontTable.xml', 'word/settings.xml', 'word/numbering.xml', 'word/theme/theme1.xml')
                     or re.fullmatch(r'word/(header\d*|footer\d*)\.xml', n)
                     or re.fullmatch(r'word/_rels/(document|header\d*|footer\d*)\.xml.rels', n)}
        for name, raw in list(parts.items()):
            root = E.fromstring(raw, E.XMLParser(resolve_entities=False, no_network=True))
            if name.endswith('.rels'):
                from posixpath import normpath, join, dirname
                base = '' if name == '_rels/.rels' else 'word'
                for rel in list(root):
                    target = normpath(join(base, rel.get('Target', ''))).lstrip('/')
                    if rel.get('TargetMode') == 'External' or target not in parts:
                        root.remove(rel)
            elif name == '[Content_Types].xml':
                for node in list(root):
                    if node.get('PartName', '').lstrip('/') not in parts and node.tag.endswith('Override'):
                        root.remove(node)
            else:
                for node in list(root.iter()):
                    local = E.QName(node).localname
                    for attr in list(node.attrib):
                        if E.QName(attr).localname in ('author','date','initials') or E.QName(attr).localname.startswith('rsid'):
                            del node.attrib[attr]
                    if local in ('drawing','pict','object','commentRangeStart','commentRangeEnd','commentReference',
                                 'footnoteReference','endnoteReference','altChunk','docVars','mailMerge','attachedTemplate',
                                 'bookmarkStart','bookmarkEnd','del','delText','sdtPr','customXmlPr') and node.getparent() is not None:
                        node.getparent().remove(node)
                    if local == 'fldSimple':
                        node.set(q('instr'), ' PAGE ' if re.fullmatch(r'\s*PAGE\s*(?:\\\*\s*MERGEFORMAT\s*)?', node.get(q('instr'), ''), re.I) else '')
                    if local == 'hyperlink' and node.getparent() is not None:
                        parent=node.getparent();position=parent.index(node)
                        for child in list(node):
                            parent.insert(position,child);position+=1
                        parent.remove(node)
                for node in root.iter(q('instrText')):
                    node.text = ' PAGE ' if re.search(r'\bPAGE\b', node.text or '') else ''
                for index, p in enumerate(root.iter(q('p'))):
                    texts = list(p.iter(q('t')))
                    for t in texts:
                        t.text = ''
                    if texts:
                        texts[0].text = '1' if name.startswith('word/footer') else f'[[内容{index+1}]]'
            parts[name] = E.tostring(root, encoding='UTF-8', xml_declaration=True, standalone=True)
        target = destination/(item['id']+'.docx')
        with ZipFile(target, 'w', ZIP_DEFLATED) as z:
            for name, raw in sorted(parts.items()):
                info=ZipInfo(name,(2026,10,27,0,0,0));info.compress_type=ZIP_DEFLATED
                z.writestr(info, raw)
        profile=json.loads((library/item['profile']).read_text(encoding='utf8'))
        style={role:{k:v for k,v in values.items() if k in ('pPr','rPr')} for role,values in profile['roles'].items()}
        catalog.append(dict(format={'roles':style,'section':profile['sections'][-1]},id=item['id'],code=item['code'],title=re.sub(r'^\S+\s+|\.docx$', '', item['file']),
                            family=item['family'],sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                            source_sha256=item['sha256'],filename=target.name))
    (destination/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding='utf8')
    return catalog

if __name__ == '__main__':
    print(len(build(*sys.argv[1:3])))
