"""Read the authorized RQ Q3 sample into a local, unapproved review worksheet.

No recalculation engine, external-link access, model call or fact write is used.
Output contains customer values: keep it outside Git and public issue comments.
"""
from pathlib import Path
import hashlib, json, zipfile, xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP
import re, argparse, io

ROOT=Path(__file__).resolve().parents[1]
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}

def verify_source(original, item):
    if len(original) != item['bytes'] or hashlib.sha256(original).hexdigest() != item['sha256']:
        raise ValueError('AUTHORIZED_SOURCE_HASH_OR_SIZE_MISMATCH')

def validate_outputs(root, paths):
    resolved = [path.expanduser().resolve() for path in paths]
    if len(set(resolved)) != len(resolved):
        raise ValueError('JSON and Markdown outputs must use different paths')
    for original, path in zip(paths, resolved):
        # A worktree has a .git file; an ordinary repository has a .git directory.
        # Check both lexical and resolved ancestors so symlink aliases cannot bypass this boundary.
        lexical = original.expanduser().absolute()
        if path.is_relative_to(root.resolve()) or any(
            (ancestor / '.git').exists()
            for candidate in (lexical, path)
            for ancestor in (candidate, *candidate.parents)
        ):
            raise ValueError('Customer-value outputs must be outside every Git repository/worktree')
    return resolved
def extract(root):
    manifest=json.loads((root/'tests/samples/2026-09-25/manifest.json').read_text(encoding='utf-8'))
    item=next(f for case in manifest['cases'] for f in case['files'] if f['file_id']=='rq-202509-02')
    source=root/'tests/samples/2026-09-25'/item['path']
    original=source.read_bytes()
    verify_source(original, item)
    with zipfile.ZipFile(io.BytesIO(original)) as z:
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            shared=[''.join(e.itertext()) for e in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('s:si',NS)]
        rels={e.attrib['Id']:e.attrib['Target'] for e in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        names={}
        for sh in ET.fromstring(z.read('xl/workbook.xml')).findall('s:sheets/s:sheet',NS):
            target=rels[sh.attrib['{'+NS['r']+'}id']]
            part=target.lstrip('/') if target.startswith('/') else 'xl/'+target
            names[sh.attrib['name']]= {c.attrib['r']:c for c in ET.fromstring(z.read(part)).findall('.//s:sheetData/s:row/s:c',NS)}
        def cell(sheet, pos):
            e=names[sheet].get(pos)
            if e is None: return {'cell':pos,'saved_value':None,'formula':None,'type':'missing'}
            val=e.findtext('s:v',default=None,namespaces=NS)
            kind=e.attrib.get('t','n')
            if kind=='s' and val is not None: val=shared[int(val)]
            if kind=='inlineStr': val=''.join(e.find('s:is',NS).itertext())
            return {'cell':pos,'saved_value':val,'formula':e.findtext('s:f',default=None,namespaces=NS),'type':kind}
        definitions=[
            ('合并','资产总计','01合并资产负债表','D78','A78','2025-09-30','D4'),
            ('母公司','资产总计','01母公司资产负债','D78','A78','2025-09-30','D4'),
            ('合并','营业收入','02合并利润表','D6','A6','2025-01-01 至 2025-09-30','D4'),
            ('母公司','营业收入','02母公司利润表','D6','A6','2025-01-01 至 2025-09-30','D4'),
            ('合并','净利润','02合并利润表','D44','A44','2025-01-01 至 2025-09-30','D4'),
            ('母公司','净利润','02母公司利润表','D44','A44','2025-01-01 至 2025-09-30','D4'),
            ('合并','经营活动现金流量净额','03合并现金流量表','C32','A32','2025-01-01 至 2025-09-30','C4'),
            ('母公司','经营活动现金流量净额','03母公司现金流量表','C32','A32','2025-01-01 至 2025-09-30','C4')]
        rows=[]
        for n,(scope,metric,sheet,pos,label,period,header) in enumerate(definitions,1):
            c=cell(sheet,pos)
            if not c['formula'] or c['saved_value'] is None or c['type'] != 'n':
                raise ValueError('AUTHORIZED_FORMULA_CACHE_SHAPE_MISMATCH')
            value=Decimal(c['saved_value'])
            external='[' in c['formula']
            upstream=[]; recalc=None; delta=None
            simple=re.fullmatch(r'([A-Z]+[0-9]+)([+-])([A-Z]+[0-9]+)',c['formula'])
            if simple:
                left,op,right=simple.groups()
                upstream=[cell(sheet,left),cell(sheet,right)]
                a,b=[Decimal(i['saved_value']) for i in upstream]
                recalc=a+b if op=='+' else a-b
                delta=value-recalc
            rows.append({'id':f'RQ-Q3-{n:02d}','scope':scope,'metric':metric,'sheet':sheet,'cell':pos,'period':period,'unit':'人民币元',
              'label':cell(sheet,label),'period_header':cell(sheet,'B3'),'column_header':cell(sheet,header),
              'saved_value':str(value),'formula':c['formula'],'external_reference':external,
              'upstream':upstream,'recalculated_from_saved_precedents':str(recalc) if recalc is not None else None,
              'difference_from_saved_precedents':str(delta) if delta is not None else None,
              'proposed_value':None,'review_status':'待人工确认','reviewer':None,'reviewed_at':None,'decision_basis':None})
    if source.read_bytes() != original:
        raise ValueError('AUTHORIZED_SOURCE_CHANGED_DURING_READ')
    return {'schema_version':'rq-financial-review-v1','source':{'file_id':item['file_id'],'path':item['path'],'bytes':item['bytes'],'sha256':item['sha256']},
            'rows':rows,'scope_note':'只读提取8个核心单元格；保存值不是已核验值；未重算原工作簿或外部链接；未执行模型或写入项目事实。'}

def markdown(data):
    def money(value):
        return format(Decimal(value).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP), ',.2f')

    lines = [
        '# 任丘九月：8 项财务数据核对表', '',
        '目标：上交所普通私募公司债；全文报告期为 2023、2024 年度及 2025 年 1—9 月。本表仅核对 2025 年新增一期的 8 个指标。', '',
        '**金额单位：人民币元；展示保留两位小数。以下均为原报表保存的公式结果，目前未确认，也未写入项目事实。**', '',
        '请逐项选择“采用保存值”“改为其他值”或“暂不确认”，并说明核对依据。资产为 2025 年 9 月 30 日时点；收入、净利润和经营现金流为 2025 年 1—9 月累计。合并与母公司分开确认。', '',
        '| 编号 | 口径／指标 | 原表／单元格 | 保存值（元） | 公式及待核事项 | 你的决定／依据 |',
        '| --- | --- | --- | ---: | --- | --- |',
    ]
    for row in data['rows']:
        note = '引用外部试算表，原始外部工作簿未提供' if row['external_reference'] else '用直接上游保存值计算，两位小数一致；全链及缓存时点仍待核'
        lines.append(f"| {row['id']} | {row['scope']}／{row['metric']} | {row['sheet']}!{row['cell']} | {money(row['saved_value'])} | `{row['formula']}`；{note} | 待填写 |")
    lines.extend([
        '', '## 核对说明', '',
        '- 8 格均有公式，不能因报表能显示数值就将其自动标为已核验。2 格营业收入直接引用外部试算表；其余 6 格仅核对了直接上游的保存值。没有重新计算整个工作簿或访问外部链接。',
        '- 6 个简单算式的精确小数差异均小于 0.01 元，保留两位小数一致，属于保存值精度差异，不据此认定财务报表错报；上游保存值是否最新仍未验证。',
        '- 母公司三张表的期间标题自身也有公式。本次记录同时保存标题值与公式，不能把标题缓存视为独立确认。',
        '- 你的确认可成为后续核对记录的依据；开发仍需把确认者、时间、证据及精确材料版本接入系统。确认不会自动变成“已经审计”，也不会在本表生成时扣费或启动更新。',
        '- 暂不确认的字段保留具体缺口；其他有依据的内容继续更新。后续如补源材料或修改数值，新增版本并保留这次核对历史。', '',
        '## 可直接复制的回复格式', '',
        'RQ-Q3-01：采用保存值／改为……元／暂不确认；依据：……', '',
        '其余各项同上。若全部同意，请同时写清核对的报表版本、合并／母公司口径及依据。', '',
        '## 原件与直接上游证据', '',
        f"原件：`{data['source']['path']}`；{data['source']['bytes']} 字节。", '',
        f"SHA-256：`{data['source']['sha256']}`。生成本表前后原件字节一致。旁边的 JSON 保留 XML 原始精度、表头、公式、直接上游及空白决定字段。", '',
        '| 编号 | 直接上游保存值与公式 | 保存值减直接算式结果（元，未舍入） |',
        '| --- | --- | ---: |',
    ])
    for row in data['rows']:
        upstream = '；'.join(f"{v['cell']}={v['saved_value']}（公式：{v['formula'] or '无'}）" for v in row['upstream']) or '外部工作簿未提供'
        lines.append(f"| {row['id']} | {upstream} | {row['difference_from_saved_precedents'] or '无法计算'} |")
    return '\n'.join(lines) + '\n'


if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--output',type=Path,required=True)
    p.add_argument('--markdown',type=Path,help='Optional local review table; contains customer values')
    args=p.parse_args()
    outputs=[args.output, *([args.markdown] if args.markdown else [])]
    try:
        outputs=validate_outputs(ROOT, outputs)
    except ValueError as error:
        p.error(str(error))
    args.output=outputs[0]
    if args.markdown:
        args.markdown=outputs[1]
    data=extract(ROOT)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if args.markdown:
        args.markdown.parent.mkdir(parents=True,exist_ok=True)
        args.markdown.write_text(markdown(data),encoding='utf-8')
    print(json.dumps({'rows':len(data['rows']),'external_direct':sum(r['external_reference'] for r in data['rows']),
       'internal_recalculated':sum(r['recalculated_from_saved_precedents'] is not None for r in data['rows']),
       'nonzero_difference':sum(r['difference_from_saved_precedents'] is not None and Decimal(r['difference_from_saved_precedents'])!=0 for r in data['rows']),
       'source_sha256':data['source']['sha256'],'source_unchanged':True},ensure_ascii=False))
