"""Reference-derived integrity workpaper from verified product observations."""
import json
import sys
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.shared import Pt, Emu
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from docx.table import Table
from PIL import Image

TEMPLATE = Path(__file__).parent / 'templates' / 'integrity-workpaper.docx'
PICTURE_WIDTH = 5274310
STATUS = {'public_matches': '检索到相关记录，待核实', 'no_public_results': '本次检索未见相关记录', 'needs_manual': '待核实', 'not_applicable': '不适用', 'query_failed': '查询未完成'}
CONCLUSION = {'records_found': '发现记录', 'no_records': '该次查询未发现记录', 'unresolved': '仍待核实'}

def beijing(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=8))).strftime('%Y年%m月%d日 %H:%M:%S')
    except (ValueError, AttributeError):
        return value

def set_text(p, text):
    """Keep the source paragraph and first run formatting."""
    rpr = deepcopy(p.runs[0]._r.rPr) if p.runs and p.runs[0]._r.rPr is not None else None
    p.clear()
    r = p.add_run(text)
    if rpr is not None:
        r._r.insert(0, rpr)
    return p

def generate(data, target):
    d = Document(TEMPLATE)
    info = data['input']
    subjects = info['draft']['subjects']
    records = data['records']
    title = (subjects[0]['name'] if len(subjects) == 1 else info['project_name']) + '诚信信息汇总清单及查询记录'
    patterns = {p.text: deepcopy(p._p) for p in d.paragraphs}
    table_pattern = deepcopy(d.tables[0]._tbl)
    body = d._element.body
    for child in list(body):
        if child.tag != qn('w:sectPr'):
            body.remove(child)

    def para(text, pattern='{{body}}', *, small=False, keep=False, page=False):
        element = deepcopy(patterns[pattern])
        body.insert(len(body) - 1, element)
        p = set_text(Paragraph(element, d._body), text)
        p.paragraph_format.keep_with_next = keep
        p.paragraph_format.page_break_before = page
        if pattern == '{{body}}':
            # Source intro rhythm with no extra paragraph-before gap for flowing notes.
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(6)
            spacing = p._p.get_or_add_pPr().find(qn('w:spacing'))
            if spacing is not None:
                for attr in ['beforeLines', 'afterLines']:
                    spacing.attrib.pop(qn('w:' + attr), None)
        if small:
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            p.paragraph_format.first_line_indent = Pt(0)
            p.paragraph_format.line_spacing = 1.2
            for run in p.runs:
                run.font.size = Pt(9)
        return p

    def picture(path):
        with Image.open(path) as im:
            width, height = im.size
        # Embed the original screen bytes without cropping, decoration or a drawn timestamp.
        size = min(PICTURE_WIDTH, int(6800000 * width / height))
        p = para('', '{{picture}}')
        p.paragraph_format.left_indent = Pt(0)
        p.paragraph_format.right_indent = Pt(0)
        p.paragraph_format.line_spacing = 1
        p.paragraph_format.space_after = Pt(6)
        p.add_run().add_picture(str(path), width=Emu(size))
        return p

    para(title, '{{title}}')
    pending = sum(r['status'] in ['needs_manual', 'query_failed'] for r in records)
    matches = sum(r['status'] == 'public_matches' for r in records)
    no_results = sum(r['status'] == 'no_public_results' for r in records)
    intro = f'本次查询涉及{len(info["draft"]["site_ids"])}项网站及栏目。'
    counts = []
    if no_results: counts.append(f'{no_results}项本次检索未见相关记录')
    if matches: counts.append(f'{matches}项检索到相关记录，主体及事项待核实')
    if pending: counts.append(f'{pending}项未完成或待核实')
    if counts: intro += '其中，' + '；'.join(counts) + '。'
    intro += '具体核查情况如下：'
    para(intro, '{{intro}}')
    if info['draft'].get('notes'):
        para(info['draft']['notes'], small=True)
    para('汇总清单', '汇总清单', keep=True)
    for subject in subjects:
        items = [r for r in records if r['subject_id'] == subject['id']]
        element = deepcopy(table_pattern)
        body.insert(len(body) - 1, element)
        table = Table(element, d._body)
        row_pattern = deepcopy(table.rows[1]._tr)
        element.remove(table.rows[1]._tr)
        for cell, text in zip(table.rows[0].cells, ['公司名称' if subject['kind'] == 'company' else '人员姓名', subject['name']]):
            set_text(cell.paragraphs[0], text)
        for item in items:
            row = deepcopy(row_pattern)
            element.append(row)
            for cell, text in zip(table.rows[-1].cells, [item['site_name'], STATUS[item['status']]]):
                set_text(cell.paragraphs[0], text)
        for row in table.rows:
            for h in row._tr.xpath('./w:trPr/w:trHeight'):
                h.getparent().remove(h)
            row._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
        para('', small=True)
    para('查询记录', '查询记录', keep=True)
    para('公开搜索不替代专项数据库查询。以下结果仅限本次查询词、查询时点及已取得的页面；同名主体、记录事项和影响仍需核实。', small=True)
    seen_limitations = set()
    for subject in subjects:
        if len(subjects) > 1:
            para(subject['name'], keep=True)
        if subject['kind'] == 'person':
            para('角色：' + (subject.get('role') or '待补充') + '；身份标识：' + (subject.get('identifier') or '待补充'), small=True)
        for index, r in enumerate([r for r in records if r['subject_id'] == subject['id']], 1):
            p = para(f'{index}、{r["site_name"]}', keep=True)
            p.paragraph_format.first_line_indent = Pt(0)
            confirmed = r.get('browser', {}).get('outcome') in ['results', 'no_results']
            label = '查询词：' if confirmed else '尝试查询词：' if r['search_performed'] else '拟查询词：'
            para(label + (r['query'] or '未完成查询'), small=True, keep=True)
            # A click, query form, challenge or blank page is not result evidence.
            # Blockers remain in private diagnostic storage, but never illustrate a completed query.
            automatic = [a for a in data.get('automatic', []) if confirmed and a['subject_id'] == subject['id'] and a['site_id'] == r['site_id'] and a.get('metadata', {}).get('kind') in ['result', 'detail']]
            for a in automatic:
                meta = a['metadata']
                para(('搜索结果页面' if meta['kind'] == 'result' else '搜索结果对应正文') + (f' 第{meta["page"]}页' if meta.get('page') and meta['kind'] == 'result' else ''), small=True, keep=True)
                picture(a['path']).paragraph_format.keep_with_next = True
                p = para('查询网址：', small=True, keep=True)
                # Full query URL remains clickable without pages of percent-encoded text.
                u = urlsplit(meta['url'])
                label = urlunsplit((u.scheme, u.netloc, u.path, '', ''))
                link = OxmlElement('w:hyperlink')
                link.set(qn('r:id'), p.part.relate_to(meta['url'], RT.HYPERLINK, is_external=True))
                run = deepcopy(p.runs[0]._r)
                run.find(qn('w:t')).text = label if len(label) <= 140 else u.netloc + ' 查询页面'
                link.append(run)
                p._p.append(link)
                para('采集日志时间（北京时间）：' + beijing(meta['captured_at']), small=True)
            if not automatic:
                para('本次未取得可确认的搜索结果截图，详见查询状态与原因。' if r['status'] != 'not_applicable' else r['reason'])
                para('访问时间（北京时间）：' + beijing(r['checked_at']), small=True)
            para('核查情况：' + r['reason'])
            for source in r.get('sources', []):
                para('查询记录载明：“' + source['quote'] + '”。')
                para('来源：' + source['title'] + ' ' + source['url'], small=True)
            if r.get('browser'):
                para('查询范围：' + r['browser']['scope'], small=True)
                limitation = r['browser']['limitation']
                if limitation not in seen_limitations:
                    para('覆盖限制（相同限制后文不再重复）：' + limitation, small=True)
                    seen_limitations.add(limitation)
            for e in [e for e in data.get('evidence', []) if e['record']['subject_id'] == subject['id'] and e['record']['site_id'] == r['site_id']]:
                manual = e['record']
                para('人工补充证据（用户提交，未独立核验）：' + CONCLUSION[manual['conclusion']])
                para(manual['note'])
                para('查询时间：' + beijing(manual['queried_at']) + '\n查询网址：' + manual['url'] + '\n证据文件：' + e['filename'], small=True)
                if manual.get('registration'):
                    para('补证对应注册地：' + manual['registration']['province'] + manual['registration']['city'], small=True)
                if e['media_type'].startswith('image/'):
                    picture(e['path'])
                else:
                    para('原始证据保存在本项目材料中，请结合原始文件查阅。', small=True)
    para('本页无正文，为《' + title + '》的签字页', '{{signature}}', page=True)
    para('')
    para('')
    para('项目组成员：________________    ________________    ________________', '{{members}}')
    para('')
    para('')
    para('项目负责人：________________', '{{leader}}')
    para('')
    para('')
    para('承做部门（团队）负责人：________________', '{{department}}')
    para('')
    para('')
    para('年    月    日', '{{date}}')
    d.core_properties.title = title
    d.core_properties.author = 'BondBuddy'
    d.core_properties.last_modified_by = 'BondBuddy'
    d.save(target)

if __name__ == '__main__':
    generate(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig')), sys.argv[2])
