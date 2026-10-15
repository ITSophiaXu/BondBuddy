"""Distill authorized case files into versioned, fact-free OOXML layout templates.

Raw cases remain outside the repository. Only reviewed headings, formatting and
explicit content slots enter the bundle; embedded objects/media are never copied.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import re
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from lxml import etree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = {'w': W}
qn = lambda s: '{' + W + '}' + s
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'knowledge/material-drafting/2026-10-15'
VERSION = 'case-templates-20261015-v1'

# Reviewed generic labels from the SSE opinion. Automatic Word numbering is
# stored in pPr, so these headings cannot be identified by their text prefix.
SSE_NUMBERED_HEADINGS = {
    '发行人为高速公路、地铁线路等相关资产折旧政策较为特殊的政府还贷公路企业和轨道交通企业的核查情况',
    '报告期内发生重大会计政策/会计估计变更且对财务状况或经营成果产生重大影响的相关情况的核查',
    '报告期内更换会计师事务所情况的核查', '审计报告被出具保留意见情形的核查',
    '评级结果差异性情况的核查', '公司债券审核及后续过程中发生中止或终止情形的核查',
    '中国证监会、证券交易所要求核查的其他内容以及主承销商认为需要反映的其他内容',
    '内核关注的主要问题及解决情况',
}
SSE_TERM_LABELS = set('发行主体|债券名称|注册文件|发行规模|债券期限|债券利率和其确定方式|票面金额及发行价格|发行方式|发行对象|承销方式|发行方式及配售原则|向公司股东配售的安排|债券形式|起息日|付息方式|利息登记日|付息日|兑付方式|兑付金额|兑付登记日|本金兑付日|增信措施|信用级别及资信评级机构|主承销商、簿记管理人、债券受托管理人|联席主承销商|拟登记流通场所|募集资金用途|偿付顺序|质押式回购安排|税务提示'.split('|'))
SSE_TABLE_LABELS = set('注册名称|实缴资本|设立（工商注册）日期|住所（注册地）|所属行业|电话及传真号码|信息披露事务负责人及其职位与联系方式|发行人历史沿革信息|发生时间|事件类型|基本情况|产品类别|借款主体|证券简称|到期日期|当前余额(亿元)|拟使用募集资金|文件名称|文件中关于地方政府债务管理的有关规定|文件中关于为政府垫资的有关规定|主承销商核查结论|受重要影响的报表项目|影响金额（万元）|备注|级次|子公司名称|注册地|持股比例（%）|取得方式|被担保方|担保类型|担保余额|担保起始日|担保到期日|是否有反担保措施|时间|类型|投资主体|投资内容|回收方式及周期|法定代表人或授权代表：|债务融资业务负责人：|内核负责人：|项目负责人：|本次债券|募集说明书|指'.split('|'))

def text(e):
    return ''.join(e.xpath('.//w:t/text()', namespaces=NS)).strip()

def xml(e):
    return E.tostring(e, encoding='UTF-8', xml_declaration=True, standalone=True)

def paragraph(source, value, keep_section=True):
    p = E.Element(qn('p'))
    props = source.find(qn('pPr'))
    if props is not None:
        props = deepcopy(props)
        if not keep_section:
            for s in props.findall(qn('sectPr')): props.remove(s)
        p.append(props)
    run = E.SubElement(p, qn('r'))
    runs = source.xpath('./w:r[w:t]', namespaces=NS)
    if runs:
        rp = max(runs, key=lambda r: len(text(r))).find(qn('rPr'))
        if rp is not None: run.append(deepcopy(rp))
    E.SubElement(run, qn('t'), {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'}).text = value
    return p

def heading(value):
    if len(value) > 120 or re.search(r'[。；;]|\d{4}年.*(?:增加|减少|万元|亿元)', value): return False
    return bool(re.match(r'^(?:第[一二三四五六七八九十百]+[章节]|[一二三四五六七八九十百]+[、．.]|[（(][一二三四五六七八九十百]+[）)]|\d{1,2}[、.．]|[（(]\d{1,2}[）)]|[A-Z]、)', value)
                or re.fullmatch(r'声\s*明|释\s*义|目\s*录', value))

def heading_paragraph(source, value, keep_section=True):
    p = paragraph(source, value, keep_section)
    props = p.find(qn('pPr'))
    if props is None:
        props = E.Element(qn('pPr')); p.insert(0,props)
    # Reflowing shorter slot content must not split a title across pages or
    # strand it at the page foot. Font/spacing/indent still come from the case.
    for name in ['keepNext','keepLines']:
        existing = props.find(qn(name))
        if existing is not None: props.remove(existing)
    offset = 1 if props.find(qn('pStyle')) is not None else 0
    for i,name in enumerate(['keepNext','keepLines']):
        props.insert(offset+i,E.Element(qn(name)))
    return p

def clean_heading(value, index):
    prefix_match=re.match(r'^(?:[（(]\d{1,2}[）)]|\d{1,2}[、.．])',value)
    generic={'基本情况','发行人基本情况','历史沿革','发行人历史沿革','发行人股权结构','控股股东、实际控制人情况',
             '控股股东及实际控制人基本情况','股东持有发行人股权的质押情况','主营业务收入','主营业务成本','主营业务毛利润','主营业务毛利率',
             '公司经营范围及主营业务','公司报告期内营业收入、毛利润及毛利率情况','公司报告期内主营业务情况',
             '发行人经营范围','发行人财务状况','概况','存续债券情况','在手批文情况','报告期内申报情况',
             '资产结构分析','负债结构分析','货币资金','应收账款','预付款项','其他应收款','存货','其他非流动金融资产',
             '投资性房地产','在建工程','短期借款','应付票据','应付账款','合同负债','其他应付款','一年内到期的非流动负债','长期借款',
             '地方政府债务核查','受限资产情况','关于行政监管措施及其整改情况','关于行政处罚及其整改情况','关于纪律处分及其整改情况','对证券业务开展的影响',
             '重组基本情况','重大资产重组对发行人公司治理可能产生的影响','历次变更情况'}
    # Subordinate numbered case-specific risks, business segments, named
    # institutions and factual conclusions are variable titles, never defaults.
    if prefix_match and value[prefix_match.end():].strip() not in generic:
        return prefix_match.group()+'{{事项标题_'+str(index)+'}}'
    value = re.sub(r'光大证券(?:股份有限公司)?', '{{主承销商}}', value)
    value=value.replace('发行人属于投资控股型企业，经营成果主要来自子公司','投资控股型企业适用性核查')
    value=value.replace('发行人首次申请发行公司债券','首次申请发行公司债券的适用性核查')
    return value

def safe_cell(value):
    # Keep only non-factual column/row labels, never infer that a cell is safe
    # merely because it happens to contain no digits.
    labels = {'项目','科目','指标','单位','合计','资产总计','负债合计','所有者权益合计','营业收入','营业成本','净利润','总资产',
              '注册资本','实收资本','法定代表人','公司名称','企业名称','成立日期','注册地址','办公地址','邮政编码','联系电话',
              '经营范围','统一社会信用代码','币种','资产负债率','流动比率','速动比率','现金流量','债券简称','债券余额',
              '序号','名称','股东名称','持股比例','担保方式','到期日','起息日','利率','金额','占比','余额','比例',
              '债券名称','发行规模','发行期限','募集资金用途','货币资金','应收账款','其他应收款','存货','短期借款','长期借款'}
    v = re.sub(r'\s+', '', value)
    return value if v in labels or v in (':','：') else '{{填写}}' if v else ''

def derive(path, ident, market, offering, kind, default):
    raw = path.read_bytes()
    with ZipFile(path) as z:
        source_parts=[{'part':n,'sha256':sha256(z.read(n)).hexdigest()} for n in z.namelist() if not n.endswith('/')]
        source = E.fromstring(z.read('word/document.xml'))
        body = source.find(qn('body'))
        styles=E.fromstring(z.read('word/styles.xml'))
        style_names={s.get(qn('styleId')):s.find(qn('name')).get(qn('val'),'') for s in styles.findall(qn('style')) if s.find(qn('name')) is not None}
        ps = body.findall(qn('p'))
        nonempty = [p for p in ps if text(p)]
        out = deepcopy(source)
        outbody = out.find(qn('body'))
        for e in list(outbody): outbody.remove(e)
        slots, headings = [], []
        body_open = False
        slot_idx = 0
        title_count = 0
        table_idx = 0
        current = '引言'
        signature_open = False
        for idx, e in enumerate(body):
            if e.tag == qn('sectPr'):
                outbody.append(deepcopy(e)); continue
            if e.tag == qn('tbl'):
                table_idx += 1
                table = deepcopy(e)
                rows = table.findall(qn('tr'))
                first_cell = text(rows[0].find(qn('tc')))
                fixed_rows = ident == 'sse-private-underwriter' and first_cell in {'注册名称', '法定代表人或授权代表：'}
                # Retain a header and two editable rows, with exact grid/merges.
                # The original row counts are evidence, not a limit on new data.
                retained = len(rows) if fixed_rows else 4 if first_cell == '发行人历史沿革信息' else 3
                for row in rows[retained:]: table.remove(row)
                for ri, row in enumerate(table.findall(qn('tr'))):
                    for cell in row.findall(qn('tc')):
                        width = cell.find('./'+qn('tcPr')+'/'+qn('tcW'))
                        narrow = width is not None and width.get(qn('type')) == 'dxa' and int(width.get(qn('w'),'0')) < 1000
                        for p in list(cell.findall(qn('p'))):
                            value = safe_cell(text(p))
                            if ident == 'sse-private-underwriter' and text(p) in SSE_TABLE_LABELS:
                                value = text(p)
                            # Empty/separator cells and compact numeric columns
                            # stay blank; long markers must not distort the grid.
                            if narrow and value == '{{填写}}': value = ''
                            new = paragraph(p, value, False)
                            cell.replace(p, new)
                for nested in table.xpath('.//w:tc/w:tbl', namespaces=NS): nested.getparent().remove(nested)
                outbody.append(table)
                slots.append({'id': f'table-{table_idx}', 'part':'word/document.xml', 'source_body_index':idx, 'kind':'table', 'section':current, 'source_rows':len(rows), 'retained_rows':retained, 'rule':'按当前事实填写空白数据格和占位格并增删数据行；表头期间按目标报告期填写，保留列宽、合并与样式。签署栏只留待真实签认，不生成签字。'})
                body_open = False
                continue
            if e.tag != qn('p'): continue
            value = text(e)
            style=e.find('./'+qn('pPr')+'/'+qn('pStyle'))
            if style is not None and style_names.get(style.get(qn('val')),'').lower().startswith('toc'):
                continue
            section = e.find('./' + qn('pPr') + '/' + qn('sectPr'))
            if not value:
                # Preserve section boundaries, not source pagination/blank runs.
                # The SSE opinion has a separate formatted cover, including
                # intentional spacing before the issuer and signature details.
                if section is not None or (ident == 'sse-private-underwriter' and title_count < 8):
                    outbody.append(paragraph(e, ''))
                continue
            if title_count < (4 if kind=='recommendation' else 8 if kind=='underwriter' else 3):
                if heading(value): title_count = 99
                else:
                    if kind == 'application':
                        value = ['{{发行人全称}}', '关于非公开发行公司债券挂牌转让的申请' if market=='sse' else '关于本次债券挂牌条件确认的申请书', '上海证券交易所：' if market=='sse' else '深圳证券交易所：'][title_count]
                    elif kind == 'underwriter':
                        if market == 'sse':
                            value = ['{{主承销商全称}}关于','{{发行人全称}}',
                                     '{{发行年份}}年面向专业投资者非公开发行公司债券的核查意见',
                                     '发行人：{{发行人全称}}','（住所：{{发行人住所}}）',
                                     '联席主承销商：{{联席主承销商}}','住所：{{主承销商住所}}',
                                     '签署日期：{{签署日期}}'][title_count]
                        else:
                            value = ['{{主承销商全称}}','关于{{发行人全称}}','{{发行年份}}年面向专业投资者','非公开发行公司债券','之','主承销商核查意见','主承销商','{{签署年月}}'][title_count]
                    else:
                        # The first case splits its title over two paragraphs.
                        if title_count == 0: value = '{{主承销商}}文件'
                        elif title_count == 1: value = '{{文号}}'
                        elif '协会' in value: value = '中国银行间市场交易商协会：'
                        elif ident.endswith('-letter'):
                            value='关于推荐{{发行人}}' if title_count==2 else '申请发行定向债务融资工具的函'
                        else: value = '关于推荐{{发行人}}注册发行' + ('定向债务融资工具' if offering=='ppn' else '中期票据') + '的函'
                    outbody.append(paragraph(e, value))
                    slots.append({'id':f'title-{title_count}', 'part':'word/document.xml','source_body_index':idx,'kind':'title','text':value})
                    title_count += 1
                    continue
            if re.fullmatch(r'(?:中国银行间市场交易商协会|上海证券交易所|深圳证券交易所)[:：]', value):
                outbody.append(paragraph(e,value)); body_open=False; continue
            numbered = e.find('./'+qn('pPr')+'/'+qn('numPr')) is not None
            term = re.match(r'^(\d{1,2}、)([^：]+)：', value) if ident == 'sse-private-underwriter' else None
            if term and term[2] in SSE_TERM_LABELS:
                name = '发行条款_' + term[2]
                value = term[1] + term[2] + '：{{' + name + '}}'
                outbody.append(paragraph(e, value))
                slots.append({'id':name,'part':'word/document.xml','source_body_index':idx,'kind':'body','section':current,'rule':'保留条款序号与名称；仅按本次发行方案填写，不沿用案例条件。'})
                body_open = False
                continue
            if ident == 'sse-private-underwriter' and value.startswith('（本页无正文'):
                signature_open = True
                value = '（本页无正文，为{{主承销商全称}}关于{{发行人全称}}{{发行年份}}年非公开发行公司债券的核查意见之签署页）'
                signature = paragraph(e,value)
                props = signature.find(qn('pPr'))
                if props is None:
                    props = E.Element(qn('pPr')); signature.insert(0,props)
                E.SubElement(props,qn('pageBreakBefore'))
                outbody.append(signature); continue
            elif ident == 'sse-private-underwriter' and signature_open:
                value = '{{签署日期}}' if re.search(r'\d{4}年',value) else '{{主承销商全称}}'
            if signature_open:
                outbody.append(paragraph(e,value)); continue
            if heading(value) or (ident == 'sse-private-underwriter' and numbered and value in SSE_NUMBERED_HEADINGS):
                value = clean_heading(value,idx)
                # A source TOC is rebuilt from real headings by the renderer.
                if re.fullmatch(r'目\s*录',value): continue
                # TOC field paragraphs contain cached page numbers, not headings.
                if e.xpath('./w:pPr/w:pStyle[starts-with(@w:val,"TOC") or starts-with(@w:val,"toc")]', namespaces=NS): continue
                current = value
                make_heading = heading_paragraph if ident == 'sse-private-underwriter' else paragraph
                headings.append({'text':value,'source_body_index':idx,'paragraph_xml':xml(make_heading(e,value,False)).decode('utf-8')})
                outbody.append(make_heading(e, value)); body_open=False
            elif not body_open or section is not None or numbered:
                slot_idx += 1
                value = '{{内容_' + str(slot_idx) + '}}'
                outbody.append(paragraph(e, value))
                slots.append({'id':f'内容_{slot_idx}','part':'word/document.xml','source_body_index':idx,'kind':'body','section':current,'rule':'仅填写本项目材料有依据的内容；缺项标明待核，不沿用案例事实、签署或结论。'})
                body_open = section is None and not numbered
        # The SSE source ends in an image-only signature section. Keep its page
        # geometry but replace the removed image with an editable signature slot.
        if ident == 'sse-private-application':
            outbody.insert(len(outbody)-1, paragraph(nonempty[-1], '{{签署页}}', False))
            slots.append({'id':'签署页','part':'word/document.xml','kind':'body','section':'签署页','rule':'填写本项目发行人、签署日期占位；不得生成签章或伪造签字。'})
        # Keep source styles, page geometry, numbering and font definitions. Build
        # an allowlisted package, removing all private/opaque source containers.
        parts = {'word/document.xml':xml(out)}
        for name in ['word/styles.xml','word/numbering.xml','word/fontTable.xml','word/theme/theme1.xml']:
            if name in z.namelist(): parts[name]=z.read(name)
        rels = E.Element('Relationships', nsmap={None:'http://schemas.openxmlformats.org/package/2006/relationships'})
        def rel(ident,typ,target):
            E.SubElement(rels,'Relationship',Id=ident,Type=R+'/'+typ,Target=target)
        for i,name in enumerate(list(parts)[1:]):
            rel('bundle'+str(i), {'styles.xml':'styles','numbering.xml':'numbering','fontTable.xml':'fontTable','theme1.xml':'theme'}[name.split('/')[-1]],name.removeprefix('word/'))
        source_rels=E.fromstring(z.read('word/_rels/document.xml.rels'))
        for r in source_rels:
            typ=r.get('Type','').split('/')[-1]
            if typ not in ('header','footer'): continue
            target=r.get('Target').lstrip('/')
            name=target if target.startswith('word/') else 'word/'+target
            if name not in z.namelist(): continue
            part=E.fromstring(z.read(name))
            for p in list(part.findall(qn('p'))):
                clean=paragraph(p,'')
                # Preserve page fields only, remove issuer names, stamps and links.
                if p.xpath('.//w:instrText[contains(.,"PAGE")]',namespaces=NS):
                    field=E.SubElement(clean,qn('fldSimple'),{qn('instr'):' PAGE '})
                    rr=E.SubElement(field,qn('r'));E.SubElement(rr,qn('t')).text='1'
                part.replace(p,clean)
            for child in list(part):
                if child.tag != qn('p'): part.remove(child)
            parts[name]=xml(part);rel(r.get('Id'),typ,name.removeprefix('word/'))
        settings=E.Element(qn('settings'),nsmap={'w':W})
        E.SubElement(settings,qn('updateFields'),{qn('val'):'true'})
        parts['word/settings.xml']=xml(settings);rel('bundleSettings','settings','settings.xml')
        parts['word/_rels/document.xml.rels']=xml(rels)
        pkg=E.Element('Relationships',nsmap={None:'http://schemas.openxmlformats.org/package/2006/relationships'})
        E.SubElement(pkg,'Relationship',Id='rId1',Type=R+'/officeDocument',Target='word/document.xml')
        parts['_rels/.rels']=xml(pkg)
        ct=E.Element('Types',nsmap={None:'http://schemas.openxmlformats.org/package/2006/content-types'})
        E.SubElement(ct,'Default',Extension='rels',ContentType='application/vnd.openxmlformats-package.relationships+xml')
        E.SubElement(ct,'Default',Extension='xml',ContentType='application/xml')
        original_ct=E.fromstring(z.read('[Content_Types].xml'))
        for item in original_ct:
            if item.get('PartName','').lstrip('/') in parts: ct.append(deepcopy(item))
        parts['[Content_Types].xml']=xml(ct)
    dest=DEST/'templates'/f'{ident}.docx';dest.parent.mkdir(parents=True,exist_ok=True)
    with ZipFile(dest,'w',ZIP_DEFLATED) as z:
        for name, data in sorted(parts.items()):
            info=ZipInfo(name,(2026,10,15,0,0,0));info.compress_type=ZIP_DEFLATED;z.writestr(info,data)
    evidence={'id':ident,'version':VERSION,'market':market,'offering':offering,'document_type':kind,'default':default,
              'source_sha256':sha256(raw).hexdigest(),'source_format':'docx','template_sha256':sha256(dest.read_bytes()).hexdigest(),
              'template_path':dest.relative_to(ROOT).as_posix(),'headings':headings,'slots':slots,
              'sections':[xml(s).decode() for s in out.xpath('.//w:sectPr',namespaces=NS)],
              'deviations':['去除案例事实、公司名称、数字、签署、批注、图片、嵌入文件与元数据。','连续正文缩为可扩展槽位；数据表保留表头和样式行，窄数据格留白以免占位符撑高；目录随实际生成正文重建。']+(['原图像签署页改为可编辑签署占位，保留原分节。'] if ident=='sse-private-application' else [])+(['保留自动编号标题、30项发行条款名称、完整发行人信息表及签署角色行；所有事实与签署均改为占位。标题设置与下段同页及段中不分页，签署页独立分页，避免正文缩短后出现孤立标题或签署页混入正文。'] if ident=='sse-private-underwriter' else []),
              'source_parts':[{**entry,'policy':'source-derived formatting' if entry['part'] in parts else 'removed'} for entry in source_parts]}
    (DEST/'templates'/f'{ident}.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    return {k:v for k,v in evidence.items() if k in ('id','version','market','offering','document_type','default','source_sha256','template_sha256','template_path')}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source-dir',type=Path,required=True);args=ap.parse_args()
    specs=[('上交所的申请书','芜湖','sse-private-application','sse','private','application',True),
           ('上交所主承销商核查意见','芜湖','sse-private-underwriter','sse','private','underwriter',True),
           ('深交所的申请书','河北','szse-private-application','szse','private','application',True),
           ('深交所的申请书','徐州','szse-private-application-alt','szse','private','application',False),
           ('深交所主承销商核查意见','河北','szse-private-underwriter','szse','private','underwriter',True),
           ('深交所主承销商核查意见','徐州','szse-private-underwriter-alt','szse','private','underwriter',False),
           ('定向债务融资工具PPN和中期票据的推荐函','沧州','nafmii-ppn-recommendation','nafmii','ppn','recommendation',True),
           ('定向债务融资工具PPN和中期票据的推荐函','滨州','nafmii-ppn-recommendation-alt','nafmii','ppn','recommendation',False),
           ('定向债务融资工具PPN和中期票据的推荐函','任丘','nafmii-ppn-recommendation-letter','nafmii','ppn','recommendation',False),
           ('定向债务融资工具PPN和中期票据的推荐函','青岛','nafmii-mtn-recommendation','nafmii','mtn','recommendation',True),
           ('定向债务融资工具PPN和中期票据的推荐函','山东','nafmii-mtn-recommendation-alt','nafmii','mtn','recommendation',False)]
    entries=[]
    for folder,keyword,*spec in specs:
        paths=[p for p in (args.source_dir/folder).glob('*.docx') if keyword in p.name]
        if len(paths)!=1:raise ValueError(f'Ambiguous source: {folder}/{keyword}')
        entries.append(derive(paths[0],*spec))
    (DEST/'catalog.json').write_text(json.dumps({'version':VERSION,'templates':entries},ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    summaries=[]
    for entry in entries:
        evidence=json.loads((DEST/'templates'/f"{entry['id']}.json").read_text(encoding='utf-8'))
        label='基础版' if entry['default'] else '参考版二' if entry['id'].endswith('-alt') else 'Letter 版'
        summaries.append({k:entry[k] for k in ('id','market','offering','document_type','default')}|{'label':label,'headings':[h['text'] for h in evidence['headings']]})
    (ROOT/'packages/contracts/src/m4-case-template-catalog.ts').write_text('// Generated by scripts/build_material_case_templates.py; contains no case facts.\nexport const M4_CASE_TEMPLATES = '+json.dumps(summaries,ensure_ascii=False,indent=2)+' as const;\n',encoding='utf-8',newline='\n')
    print(f'Distilled {len(entries)} case templates; originals unchanged.')

if __name__=='__main__':main()
