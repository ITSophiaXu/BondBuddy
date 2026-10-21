"""Create an integrity workpaper from host-verified observations; never infer clearance."""
import json
import sys
from pathlib import Path
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

STATUS = {'public_matches': '发现公开记录，主体及事项待核实', 'needs_manual': '待人工查询 / 补证', 'not_applicable': '不适用', 'query_failed': '未取得查询记录'}
CONCLUSION = {'records_found': '发现记录', 'no_records': '该次查询未发现记录', 'unresolved': '仍待核实'}

def generate(data, target):
    d = Document()
    section = d.sections[0]
    section.header.paragraphs[0].text = 'BondBuddy · 诚信核查底稿'
    normal = d.styles['Normal']
    normal.font.name = 'Arial'
    normal.font.size = Pt(11)
    normal.element.rPr.rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    normal.paragraph_format.space_after = Pt(6)
    for style_name in ['Title', 'Heading 1', 'Heading 2', 'Heading 3', 'Header']:
        style = d.styles[style_name]
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.name = 'Arial'
        style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), 'Microsoft YaHei')
    d.add_heading('诚信核查底稿', 0)
    info = data['input']
    d.add_paragraph(info['project_name'])
    d.add_paragraph('核查轮次：' + info['round_id'])
    d.add_paragraph('本底稿整理本轮已取得的公开搜索记录和明确标记的人工补充证据；未执行或未取得记录的项目逐项列明。公开搜索不替代网站登录后数据库查询；搜索无命中不代表无风险，同名主体、记录时点和内容均需核实。')
    d.add_paragraph('注册地不完整、登录、验证码或访问受限的项目保留待核实状态。人工证据为用户提交，未由系统独立核验。')
    if info['draft']['notes']:
        d.add_paragraph('本轮说明：' + info['draft']['notes'])
    d.add_heading('核查范围与汇总', 1)
    records = data['records']
    d.add_paragraph('核查对象 ' + str(len(info['draft']['subjects'])) + ' 个；网站 ' + str(len(info['draft']['site_ids'])) + ' 个；已记录公开搜索 ' + str(sum(bool(r['search_performed']) for r in records)) + ' 项。')
    for subject in info['draft']['subjects']:
        items = [r for r in records if r['subject_id'] == subject['id']]
        matches = sum(r['status'] == 'public_matches' for r in items)
        pending = sum(r['status'] in ['query_failed', 'needs_manual'] for r in items)
        d.add_paragraph(subject['name'] + '：公开线索 ' + str(matches) + ' 项，待查询或补证 ' + str(pending) + ' 项，不适用 ' + str(sum(r['status'] == 'not_applicable' for r in items)) + ' 项。公开线索仍需人工复核。')
    for kind, title in [('company', '企业诚信核查'), ('person', '人员诚信核查')]:
        subjects = [s for s in info['draft']['subjects'] if s['kind'] == kind]
        if not subjects:
            continue
        d.add_heading(title, 1)
        for subject in subjects:
            d.add_heading(subject['name'], 2)
            d.add_paragraph('角色：' + (subject['role'] or '待补充') + '；标识：' + (subject['identifier'] or '待补充') + '；注册地：' + (subject['province'] + subject['city'] or '未提供'))
            for r in [r for r in data['records'] if r['subject_id'] == subject['id']]:
                d.add_heading(r['site_name'], 3)
                d.add_paragraph(STATUS[r['status']] + '\n' + r['reason'])
                d.add_paragraph('时间（UTC）：' + r['checked_at'])
                for url in r['urls']:
                    d.add_paragraph('官网：' + url)
                d.add_paragraph('实际查询：' + (r['query'] or '未记录；需人工查询'))
                for source in r['sources']:
                    d.add_paragraph(source['title'] + '\n' + source['url'] + '\n引文：' + source['quote'])
                    d.add_paragraph('获取时间：' + source['retrieved_at'] + '；来源摘要 SHA-256：' + source['sha256'])
                for e in [e for e in data['evidence'] if e['record']['subject_id'] == subject['id'] and e['record']['site_id'] == r['site_id']]:
                    manual = e['record']
                    d.add_paragraph('人工补充证据（用户提交，未独立核验）：' + CONCLUSION[manual['conclusion']])
                    d.add_paragraph(manual['url'] + '\n查询时间：' + manual['queried_at'] + '\n说明：' + manual['note'])
                    if manual.get('registration'):
                        d.add_paragraph('补充证据对应注册地：' + manual['registration']['province'] + manual['registration']['city'])
                    d.add_paragraph('原始证据：' + e['filename'] + '\nSHA-256：' + manual['material']['sha256'])
                    path = Path(e['path'])
                    if e['media_type'].startswith('image/'):
                        try:
                            d.add_picture(str(path), width=Inches(5.8))
                        except Exception as exc:
                            raise ValueError('Evidence image cannot be rendered') from exc
                    else:
                        d.add_paragraph('PDF / Word 原始证据保存在本项目材料中，请结合原始文件查阅。')
    d.add_heading('归档与版本说明', 1)
    d.add_paragraph('本文件归档至项目文件 → 4 底稿文件 → 4.3 诚信核查。补充证据后重新导出会生成新成果，旧文件保留。同一轮补证及重新导出不重复收费；重新开始核查为新一轮。')
    d.add_heading('核查与复核签字', 1)
    d.add_paragraph('项目组成员：________________    日期：________________')
    d.add_paragraph('复核人：________________        日期：________________')
    d.add_paragraph('待核实事项处理及复核意见：')
    d.add_paragraph('________________________________________________________________')
    footer = section.footer.paragraphs[0]
    footer.text = 'BondBuddy | '
    field = OxmlElement('w:fldSimple')
    field.set(qn('w:instr'), 'PAGE')
    footer._p.append(field)
    d.save(target)

if __name__ == '__main__':
    generate(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')), sys.argv[2])
