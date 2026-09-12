"""Local, source-styled Word review. HTML is generated from allowlisted OOXML only.

The browser uses its own line layout; DOCX export retains the original package.
No uploaded HTML, external resource, macro or embedded instruction is executed.
"""
from __future__ import annotations

import base64
import copy
import io
import re
from html import escape

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

from .docx_fidelity import source_bytes, patch_docx, q, target_nodes, paragraph_text


def attr(node, name='val', default=None):
    return node.get(q(name), default) if node is not None else default


def val(node, child, name='val', default=None):
    return attr(node.find(q(child)), name, default) if node is not None else default


def number(value, factor=1):
    try:
        return f'{float(value) / factor:g}'
    except (TypeError, ValueError):
        return '0'


def color(value):
    return '#' + value if value and re.fullmatch('[0-9a-fA-F]{6}', value) else None


def on(value):
    return value not in {'0', 'false', 'off'}


def css_string(css):
    return ';'.join(f'{k}:{v}' for k, v in css.items() if v is not None)


def styled(css):
    return ' style="' + escape(css_string(css), quote=True) + '"'


def border_css(node):
    kind = attr(node)
    if kind in {'nil', 'none'}:
        return 'none'
    if not kind:
        return None
    line = 'double' if kind == 'double' else 'dashed' if 'dash' in kind.lower() else 'dotted' if kind == 'dotted' else 'solid'
    return f'{number(attr(node, "sz", "4"), 8)}pt {line} {color(attr(node, "color")) or "#000000"}'


class Preview:
    def __init__(self, raw, file, changes, view):
        self.doc = Document(io.BytesIO(raw))
        self.file, self.view = file, view
        self.changes = {c['target_id']: c for c in changes if c['status'] != 'rejected'}
        self.mapping = {node: (tid, entry) for tid, (node, entry) in target_nodes(self.doc.element, file).items()}
        self.styles = {s.style_id: s.element for s in self.doc.styles}
        from docx.enum.style import WD_STYLE_TYPE
        default_style = self.doc.styles.default(WD_STYLE_TYPE.PARAGRAPH)
        self.default_style_id = default_style.style_id if default_style is not None else 'Normal'
        self.style_cache = {}
        self.theme_fonts = {}
        from .docx_fidelity import xml
        theme_rel = next((r for r in self.doc.part.rels.values() if r.reltype.endswith('/theme') and not r.is_external), None)
        if theme_rel is not None:
            theme = xml(theme_rel.target_part.blob)
            a = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
            for kind in ['major','minor']:
                font = theme.find('.//'+a+kind+'Font')
                if font is None:
                    continue
                latin, east = font.find(a+'latin'), font.find(a+'ea')
                fallback = next((n.get('typeface') for n in font.findall(a+'font') if n.get('script')=='Hans'), None)
                self.theme_fonts[kind+'HAnsi'] = latin.get('typeface') if latin is not None else None
                self.theme_fonts[kind+'Ascii'] = self.theme_fonts[kind+'HAnsi']
                self.theme_fonts[kind+'EastAsia'] = (east.get('typeface') if east is not None else None) or fallback
        self.default = self.doc.styles.element.find(q('docDefaults'))
        self.default_p = self.default.find(q('pPrDefault') + '/' + q('pPr')) if self.default is not None else None
        self.default_r = self.default.find(q('rPrDefault') + '/' + q('rPr')) if self.default is not None else None
        self.numbering = self.doc.part.numbering_part.element
        self.counters = {}
        self.current_p = {}

    def chain(self, style_id, seen=None):
        if seen is None and style_id in self.style_cache:
            return self.style_cache[style_id]
        seen = set() if seen is None else seen
        if not style_id or style_id in seen or style_id not in self.styles:
            return []
        seen.add(style_id)
        style = self.styles[style_id]
        result = self.chain(val(style, 'basedOn'), seen) + [style]
        self.style_cache[style_id] = result
        return result

    def properties(self, p, kind='pPr', r=None):
        default = self.default_p if kind == 'pPr' else self.default_r
        props = [default] if default is not None else []
        # Word inherits table and paragraph styles before direct formatting.
        tbl = next((a for a in p.iterancestors() if a.tag == q('tbl')), None)
        if tbl is not None:
            for style in self.chain(val(tbl.find(q('tblPr')), 'tblStyle')):
                props.append(style.find(q(kind)))
                tc = next((a for a in p.iterancestors() if a.tag == q('tc')), None)
                tr = tc.getparent() if tc is not None else None
                look = tbl.find(q('tblPr') + '/' + q('tblLook'))
                if tr is not None and tr is tbl.find(q('tr')) and attr(look, 'firstRow', '0') == '1':
                    props.extend(x.find(q(kind)) for x in style.findall(q('tblStylePr')) if attr(x, 'type') == 'firstRow')
        for style in self.chain(val(p.find(q('pPr')), 'pStyle', default=self.default_style_id)):
            props.append(style.find(q(kind)))
        if kind == 'pPr':
            props.append(p.find(q('pPr')))
        else:
            if r is not None:
                for style in self.chain(val(r.find(q('rPr')), 'rStyle')):
                    props.append(style.find(q('rPr')))
                props.append(r.find(q('rPr')))
        return [x for x in props if x is not None]

    def run_css(self, props):
        css = {}
        families = {}
        for pr in props:
            fonts = pr.find(q('rFonts'))
            if fonts is not None:
                for k in ['ascii','hAnsi','eastAsia','cs']:
                    face = self.theme_fonts.get(attr(fonts,k+'Theme')) or attr(fonts,k)
                    if face:
                        families[k] = face
            for prop, field, yes, no in [('b','font-weight','bold','normal'), ('i','font-style','italic','normal'),
                                         ('caps','text-transform','uppercase','none'), ('smallCaps','font-variant','small-caps','normal')]:
                node = pr.find(q(prop))
                if node is not None:
                    css[field] = yes if on(attr(node)) else no
            for prop, field in [('sz', 'font-size'), ('spacing', 'letter-spacing')]:
                value = val(pr, prop)
                if value is not None:
                    css[field] = number(value, 2 if prop == 'sz' else 20) + 'pt'
            if val(pr, 'color') is not None:
                css['color'] = color(val(pr, 'color')) or '#000000'
            deco = []
            if val(pr, 'u') not in {None, 'none', '0'}:
                deco.append('underline')
            if pr.find(q('strike')) is not None and on(val(pr, 'strike')):
                deco.append('line-through')
            if deco:
                css['text-decoration'] = ' '.join(deco)
            shd = pr.find(q('shd'))
            if shd is not None:
                css['background-color'] = color(attr(shd, 'fill'))
            highlights = {'yellow':'#ffff00','green':'#00ff00','cyan':'#00ffff','magenta':'#ff00ff','blue':'#0000ff','red':'#ff0000','darkGray':'#808080','lightGray':'#c0c0c0'}
            if val(pr, 'highlight') in highlights:
                css['background-color'] = highlights[val(pr, 'highlight')]
            va = val(pr, 'vertAlign')
            if va in {'superscript', 'subscript'}:
                css['vertical-align'] = 'super' if va == 'superscript' else 'sub'
                css['font-size'] = '.75em'
            if pr.find(q('vanish')) is not None:
                css['display'] = 'none' if on(val(pr, 'vanish')) else 'inline'
        if families:
            names = list(dict.fromkeys(families[k] for k in ['ascii','hAnsi','eastAsia','cs'] if k in families))
            css['font-family'] = ','.join('"' + re.sub(r'[";{}<>\\]', '', n) + '"' for n in names)
        return css

    def paragraph_css(self, p):
        css = self.run_css(self.properties(p, 'rPr'))
        css.update({'margin':'0', 'white-space':'pre-wrap', 'min-height':'1em'})
        for pr in self.properties(p):
            jc = val(pr, 'jc')
            if jc in {'both','distribute','start','end','left','right','center'}:
                css['text-align'] = {'both':'justify','distribute':'justify','start':'left','end':'right'}.get(jc, jc)
            sp = pr.find(q('spacing'))
            if sp is not None:
                for key, field in [('before','margin-top'),('after','margin-bottom')]:
                    if attr(sp, key) is not None:
                        css[field] = number(attr(sp, key), 20) + 'pt'
                if attr(sp, 'line') is not None:
                    rule = attr(sp, 'lineRule', 'auto')
                    css['line-height'] = number(attr(sp, 'line'), 240) if rule == 'auto' else number(attr(sp, 'line'), 20) + 'pt'
            ind = pr.find(q('ind'))
            if ind is not None:
                for key, field in [('left','margin-left'),('right','margin-right'),('firstLine','text-indent')]:
                    if attr(ind, key) is not None:
                        css[field] = number(attr(ind, key), 20) + 'pt'
                if attr(ind, 'hanging') is not None:
                    css['text-indent'] = '-' + number(attr(ind, 'hanging'), 20) + 'pt'
                for key, field in [('leftChars','margin-left'),('rightChars','margin-right'),('firstLineChars','text-indent')]:
                    if attr(ind, key) is not None:
                        css[field] = number(attr(ind, key), 100) + 'em'
                if attr(ind, 'hangingChars') is not None:
                    css['text-indent'] = '-' + number(attr(ind, 'hangingChars'), 100) + 'em'
            for prop, field in [('keepNext','break-after'),('keepLines','break-inside'),('pageBreakBefore','break-before')]:
                node = pr.find(q(prop))
                if node is not None and on(attr(node)):
                    css[field] = 'page' if prop == 'pageBreakBefore' else 'avoid'
            borders = pr.find(q('pBdr'))
            if borders is not None:
                for side in ['top', 'bottom', 'left', 'right']:
                    css['border-' + side] = border_css(borders.find(q(side)))
            if val(pr, 'shd', 'fill'):
                css['background-color'] = color(val(pr, 'shd', 'fill'))
        return css

    def target_attr(self, node):
        if node not in self.mapping:
            return ''
        tid, _ = self.mapping[node]
        if self.file.get('role') == 'source':
            return f' id="src-{escape(tid)}" class="word-source-target"'
        c = self.changes.get(tid)
        classes = ['word-target']
        if c:
            classes.append('word-awaiting' if c.get('origin') == 'scan' else 'word-review' if c.get('needs_review') else 'word-changed')
        return f' id="doc-{escape(tid)}" data-target="{escape(tid)}" tabindex="0" role="button" title="查看修改与来源" class="{" ".join(classes)}"'

    def inline(self, node, p, part):
        name = node.tag.rsplit('}', 1)[-1]
        if name in {'pPr','rPr','instrText','fldChar','bookmarkStart','bookmarkEnd','commentRangeStart','commentRangeEnd','commentReference'}:
            return ''
        if name in {'t','delText'}:
            # No source text is treated as HTML or CSS.
            return escape(node.text or '')
        if name == 'tab':
            return '\t'
        if name == 'noBreakHyphen':
            return '\u2011'
        if name in {'br','cr'}:
            return '<br>' if attr(node, 'type', 'textWrapping') == 'textWrapping' else '<span class="word-page-break"></span>'
        if name == 'drawing':
            blips = node.xpath('.//a:blip')
            extent = node.xpath('.//wp:extent')
            if blips:
                rid = blips[0].get(qn('r:embed'))
                rel = part.rels.get(rid)
                if rel is not None and not rel.is_external:
                    image = rel.target_part
                    mime = image.content_type
                    if mime in {'image/png','image/jpeg','image/gif','image/webp','image/bmp'}:
                        dims = {'width':number(extent[0].get('cx'), 12700)+'pt', 'height':number(extent[0].get('cy'), 12700)+'pt'} if extent else {}
                        return '<img alt="原稿图片"' + styled(dims) + ' src="data:' + mime + ';base64,' + base64.b64encode(image.blob).decode() + '">'
            return '<span class="word-object-note">【原稿图片：请在 Word 原文件中查看】</span>'
        if name in {'pict','object'}:
            return '<span class="word-object-note">【原稿嵌入对象：Word 导出保留】</span>'
        if name in {'footnoteReference','endnoteReference'}:
            return '<sup>' + escape(attr(node, 'id', '')) + '</sup>'
        inner = ''.join(self.inline(c, p, part) for c in node)
        if name == 'r':
            return '<span' + styled(self.run_css(self.properties(p, 'rPr', node))) + '>' + inner + '</span>'
        if name in {'ins','del'}:
            if self.view != 'revision':
                return inner if name == 'ins' else ''
            return '<' + name + ' class="word-' + name + '">' + inner + '</' + name + '>'
        return inner

    def numbering_label(self, p):
        num_id, ilvl = None, '0'
        for pr in self.properties(p):
            num = pr.find(q('numPr'))
            if num is not None:
                num_id = val(num, 'numId', default=num_id)
                ilvl = val(num, 'ilvl', default=ilvl)
        if not num_id or num_id == '0':
            return ''
        num = next((n for n in self.numbering.findall(q('num')) if attr(n, 'numId') == num_id), None)
        aid = val(num, 'abstractNumId')
        abstract = next((n for n in self.numbering.findall(q('abstractNum')) if attr(n, 'abstractNumId') == aid), None)
        if abstract is None:
            return ''
        level = next((n for n in abstract.findall(q('lvl')) if attr(n, 'ilvl') == ilvl), None)
        if level is None:
            return ''
        key = (num_id, ilvl)
        self.counters[key] = self.counters.get(key, int(val(level, 'start', default='1'))-1) + 1
        label = val(level, 'lvlText', default='')
        for index in range(9):
            label = label.replace('%'+str(index+1), str(self.counters.get((num_id, str(index)), 1)))
        return '<span class="word-number">' + escape(label) + '</span>\t'

    def paragraph(self, p, part):
        content = self.numbering_label(p) + ''.join(self.inline(n, p, part) for n in p)
        return '<p' + self.target_attr(p) + styled(self.paragraph_css(p)) + '>' + (content or '<br>') + '</p>'

    def table(self, node, part):
        table = Table(node, self.doc)
        pr = node.find(q('tblPr'))
        css = {'border-collapse':'collapse'}
        all_pr = [s.find(q('tblPr')) for s in self.chain(val(pr, 'tblStyle'))] + [pr]
        cell_defaults, borders = {}, {}
        for prop in (x for x in all_pr if x is not None):
            width, typ = val(prop, 'tblW', 'w'), val(prop, 'tblW', 'type')
            if typ == 'dxa':
                css['width'] = number(width, 20) + 'pt'
            elif typ == 'pct':
                css['width'] = number(width, 50) + '%'
            jc = val(prop, 'jc')
            if jc == 'center':
                css.update({'margin-left':'auto','margin-right':'auto'})
            elif jc == 'right':
                css['margin-left'] = 'auto'
            if val(prop, 'tblInd', 'w') is not None:
                css['margin-left'] = number(val(prop, 'tblInd', 'w'), 20) + 'pt'
            if val(prop, 'tblLayout', 'type') == 'fixed':
                css['table-layout'] = 'fixed'
            margins = prop.find(q('tblCellMar'))
            if margins is not None:
                for side in ['top','bottom','left','right','start','end']:
                    if val(margins, side, 'w') is not None:
                        cell_defaults['padding-' + {'start':'left','end':'right'}.get(side,side)] = number(val(margins, side, 'w'),20)+'pt'
            bs = prop.find(q('tblBorders'))
            if bs is not None:
                for side in ['top','bottom','left','right','insideH','insideV']:
                    b = bs.find(q(side))
                    if b is not None:
                        borders[side] = border_css(b)
        grid = node.find(q('tblGrid'))
        columns = '' if grid is None else '<colgroup>' + ''.join('<col' + styled({'width':number(attr(c,'w'),20)+'pt'}) + '>' for c in grid) + '</colgroup>'
        positions = {}
        for ri, row in enumerate(table.rows):
            for ci, cell in enumerate(row.cells):
                positions.setdefault(cell._tc, []).append((ri,ci))
        rows, seen = [], set()
        for ri, row in enumerate(table.rows):
            cells = []
            for ci, cell in enumerate(row.cells):
                tc = cell._tc
                if tc in seen:
                    continue
                seen.add(tc)
                coords = positions[tc]
                rowspan = max(r for r,c in coords)-ri+1
                colspan = max(c for r,c in coords)-ci+1
                cc = dict(cell_defaults)
                for side in ['top','bottom','left','right']:
                    inner = (side=='top' and ri>0) or (side=='bottom' and ri+rowspan<len(table.rows)) or (side=='left' and ci>0) or (side=='right' and ci+colspan<len(row.cells))
                    cc['border-'+side] = borders.get('insideH' if side in {'top','bottom'} else 'insideV') if inner else borders.get(side)
                tp = tc.find(q('tcPr'))
                cc['vertical-align'] = {'center':'middle','top':'top','bottom':'bottom'}.get(val(tp,'vAlign'),'top')
                if val(tp,'tcW','type') == 'dxa':
                    cc['width'] = number(val(tp,'tcW','w'),20)+'pt'
                if val(tp,'shd','fill'):
                    cc['background-color'] = color(val(tp,'shd','fill'))
                for side in ['top','bottom','left','right']:
                    b = tp.find(q('tcBorders')+'/'+q(side)) if tp is not None else None
                    if b is not None:
                        cc['border-'+side] = border_css(b)
                    margins = tp.find(q('tcMar')) if tp is not None else None
                    if val(margins,side,'w') is not None:
                        cc['padding-'+side] = number(val(margins,side,'w'),20)+'pt'
                inner = ''.join(self.block(child,part) for child in tc if child.tag in {q('p'),q('tbl')})
                cells.append(f'<td rowspan="{rowspan}" colspan="{colspan}"' + self.target_attr(tc) + styled(cc) + '>' + inner + '</td>')
            height = row._tr.find(q('trPr')+'/'+q('trHeight'))
            rows.append('<tr' + styled({'height':number(attr(height),20)+'pt'} if height is not None else {}) + '>'+''.join(cells)+'</tr>')
        return '<table class="word-table"' + styled(css) + '>' + columns + ''.join(rows) + '</table>'

    def block(self, node, part):
        if node.tag == q('p'):
            return self.paragraph(node,part)
        if node.tag == q('tbl'):
            return self.table(node,part)
        if node.tag in {q('sdt'),q('sdtContent')}:
            return ''.join(self.block(c,part) for c in node)
        return ''

    def render(self):
        chunks, current = [], []
        sections = list(self.doc.sections)
        section_index = 0
        for node in self.doc.element.body:
            if node.tag == q('sectPr'):
                continue
            current.append(self.block(node,self.doc.part))
            if node.find(q('pPr')+'/'+q('sectPr')) is not None:
                chunks.append((sections[min(section_index,len(sections)-1)], ''.join(current)))
                section_index += 1
                current = []
        if current:
            chunks.append((sections[min(section_index,len(sections)-1)], ''.join(current)))
        html = []
        for sec, content in chunks:
            def pts(length, default):
                return f'{length.pt:g}pt' if length is not None else default
            css = {'width':pts(sec.page_width,'595pt'), 'min-height':pts(sec.page_height,'842pt'),
                   'padding-top':pts(sec.top_margin,'72pt'), 'padding-bottom':pts(sec.bottom_margin,'72pt'),
                   'padding-left':pts(sec.left_margin,'72pt'), 'padding-right':pts(sec.right_margin,'72pt')}
            header = sec.first_page_header if sec.different_first_page_header_footer else sec.header
            footer = sec.first_page_footer if sec.different_first_page_header_footer else sec.footer
            # Do not create missing header/footer parts as a side effect of preview.
            h = ''.join(self.block(n,header.part) for n in header._element) if header._has_definition else ''
            f = ''.join(self.block(n,footer.part) for n in footer._element) if footer._has_definition else ''
            html.append('<section class="word-section"'+styled(css)+'><div class="word-header">'+h+'</div>'+content+'<div class="word-footer">'+f+'</div></section>')
        return ''.join(html)


def word_preview(file, changes, view='final', original_bytes=None):
    raw = source_bytes(file, original_bytes)
    patched = patch_docx(file, changes, view, raw, preview=True)
    return {'html':Preview(patched,file,changes,view).render(), 'format':'source-word-styles',
            'notice':'按历史 Word 的字体、段落和表格样式显示。网页换行、分页可能与 Word 不同；导出直接保留原 Word 格式。'}
