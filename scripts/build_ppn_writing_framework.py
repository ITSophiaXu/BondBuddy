"""Build the PPN writing snapshot from reviewed, reusable template content.

--source re-extracts only the pinned template version. The original and full
issuer examples remain outside Git; normal rebuild/check uses curated JSON.
No model calls, registry approval, database writes or deployment.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
from ppn_template_source import extract

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'knowledge/nafmii/drafts/ppn/writing-20261013'
VERSION = 'ppn-writing-2026.10.13-v1'
SOURCE_NAME = '20261013-PPN债务融资工具定向募集说明书.docx'
SOURCE_SHA = '91c22882815f78bf1d9fb1dc9cf14a488bd505bbe6690eb1de20e52ebf513944'
CHAPTERS = [
    (4, '封面'), (26, '声明与承诺'), (39, '目录'), (120, '重要提示'),
    (222, '第一章 释义'), (273, '第二章 风险提示'), (452, '第三章 发行条款'),
    (553, '第四章 募集资金运用'), (714, '第五章 发行人基本情况'),
    (1945, '第六章 发行人主要财务状况'), (4949, '第七章 企业资信状况'),
    (5047, '第八章 债务融资工具信用增进'), (5241, '第九章 定向信息披露安排'),
    (5305, '第十章 持有人会议机制'), (5407, '第十一章 受托管理人机制'),
    (5410, '第十二章 投资者保护条款'), (5412, '第十三章 主动债务管理'),
    (5473, '第十四章 违约、风险情形及处置'), (5516, '第十五章 发行有关机构'),
    (5610, '第十六章 备查文件'), (5633, '附录 基本财务指标计算公式'), (5661, '盖章页'),
]
# Reusable standard language only. Issuer business/financial examples are excluded.
CLAUSE_RANGES = [(26, 37), (120, 221), (273, 287), (349, 450), (453, 456),
                 (528, 552), (693, 702), (807, 818), (5241, 5515)]
REPLACEMENTS = {
    'XXXXX公司': '【发行人全称】', 'XXX公司': '【发行人全称】',
    '光大证券股份有限公司': '【簿记管理人全称】',
    '2026年': '【发行年度】年', '2025年': '【最近年度】年', '2024年': '【前一年度】年',
}
# Source-specific people, contacts and governance roles must not enter the pack.
PARAGRAPH_OVERRIDES = {
    5250: '【信息披露负责部门】负责【实际职责】，按公司制度管理信息披露事项。',
    5252: '公司信息披露事务负责人由【职务】【姓名】担任，负责组织和协调债务融资工具信息披露相关工作，接受投资者问询，维护投资者关系。',
    5253: '信息披露事务负责人：【姓名】', 5254: '职务：【职务】',
    5255: '电话：【电话】', 5256: '传真：【传真】', 5257: '邮箱：【邮箱】', 5258: '地址：【地址】',
    5263: '3、【发行人全称】【报告期各年度】经审计的合并及母公司财务报告，及本期适用的一期财务报告（如有）；',
    5321: '机构名称：【召集人全称】', 5322: '联络人姓名：【姓名】',
    5323: '联系方式：【联系方式】', 5324: '联系地址：【地址】', 5325: '邮箱：【邮箱】',
    5355: '（六）【提议渠道】持有人、受托管理人、发行人或增进机构认为有需要召开持有人会议的，应当将书面提议发送至【召集人邮箱】或寄送至召集人【地址、联系人及联系方式】，或通过“NAFMII综合业务和信息服务平台存续期服务系统”（以下简称“系统”）发送给召集人。',
    212: '1.【重组并变更登记要素】发行人和持有人可协商调整本期债务融资工具的基本偿付条款。选择召开持有人会议的，适用第十章“持有人会议机制”中特别议案的表决比例。生效决议将约束本期债项下所有持有人。如约定同意征集机制的，亦可选择适用第十三章“主动债务管理”中的“同意征集机制”实施重组。',
    693: '二、发行人承诺', 700: '三、募集资金管理',
    812: '（三）机构独立情况', 814: '（四）财务独立情况', 816: '（五）业务独立情况',
}


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def chapter(locator):
    number = int(locator[1:])
    return next(title for start, title in reversed(CHAPTERS) if number >= start)


def generic(text):
    for old, new in REPLACEMENTS.items():
        text = text.replace(old, new)
    return text


def curate(source):
    data = extract(source)
    if data['sha256'] != SOURCE_SHA:
        raise ValueError('Source version differs; review a new template before updating the pinned framework')
    if (len(data['paragraphs']), len(data['tables']), len(data['comments'])) != (5668, 90, 108):
        raise ValueError('Unexpected template structure')
    comments = []
    for c in data['comments']:
        if len(c.get('references', [])) != 1:
            raise ValueError(f"Comment {c['id']} is not anchored exactly once")
        comments.append({k: v for k, v in c.items() if k != 'selected_text'} |
                        {'chapter': chapter(c['references'][0])})
    clauses = []
    for p in data['paragraphs']:
        number = int(p['locator'][1:])
        if not p['text'] or not any(a <= number <= b for a, b in CLAUSE_RANGES):
            continue
        value = generic(PARAGRAPH_OVERRIDES.get(number, p['text'])).strip()
        # Broken citation suffixes in the source are not source references.
        value = re.sub(r'-[1236](?:-[1236])*(?=[。；，]|$)', '', value)
        clauses.append({'locator': p['locator'], 'chapter': chapter(p['locator']), 'text': value,
                        'source_text_sha256': sha(p['text']), 'adapted': value != p['text']})
    # Header fields and standard financial statement row names, never data rows.
    row_label_tables = {26, 27, 28, 29, 30, 31, 32, 33, 34, 43, 45, 49, 52, 53,
                        60, 64, 66, 67, 69, 70, 72, 73}
    subheader_tables = {9, 11, 13, 14, 15, 22, 33, 34, 36, 39, 45, 52, 53, 60,
                        64, 67, 70, 72, 73, 75}
    tables = []
    for i, table in enumerate(data['tables'], 1):
        fields = ([r[0] for r in table['rows'] if r and r[0]] if i in {1, 2, 4, 89}
                  else table['rows'][0])
        fields = [generic(f).replace('任丘经发', '发行人简称') for f in fields]
        captions = [p['text'] for p in data['paragraphs'][:int(table['start'][1:]) - 1]
                    if not p['in_table'] and p['text'].startswith(('表：', '表:', '图表'))]
        title = {1: '封面字段', 2: '释义', 3: '各行业负债相关指标数据表', 4: '主要发行条款',
                 85: '担保人股权结构', 86: '担保人主要业务数据', 87: '担保人财务数据',
                 88: '担保人信用评级', 89: '发行有关机构', 90: '基本财务指标的计算公式'}.get(i)
        title = generic(title or (captions[-1] if captions else table['id']))
        t = {'id': table['id'], 'title': title, 'locator': table['start'], 'chapter': chapter(table['start']),
             'fields': fields, 'source_rows': len(table['rows'])}
        if i in subheader_tables:
            t['subfields'] = ([f'【计划第{n}年】' for n in (1, 2, 3)] if i == 22
                              else [generic(f) for f in table['rows'][1] if f])
        if i in row_label_tables:
            t['row_labels'] = [generic(r[0]) for r in table['rows'][1:] if r and r[0]]
        if i == 90:
            t['formulas'] = table['rows'][1:]
        if i == 3:
            t['reference_only_rows'] = table['rows'][1:]
            t['limitation'] = '统计来源与期间未明确，不能直接作为本期行业平均；C33/C34比较口径仍须核实。'
        tables.append(t)
    return {'schema_version': 'ppn-writing-source-v1', 'version': VERSION,
            'source': {'filename': SOURCE_NAME, 'sha256': SOURCE_SHA, 'bytes': data['bytes'],
                       'paragraphs': 5668, 'tables': 90, 'comments': 108,
                       'range_comments': sum(c['anchor_kind'] == 'range' for c in comments),
                       'point_comments': sum(c['anchor_kind'] == 'point' for c in comments),
                       'original_storage': 'local_only', 'issuer_examples': 'excluded_from_runtime',
                       'tracked_insertions': data['tracked_insertions'], 'tracked_deletions': data['tracked_deletions']},
            'chapters': [{'title': title, 'locator': f'P{start:05d}'} for start, title in CHAPTERS],
            'comments': comments, 'clauses': clauses, 'tables': tables}


def render(data, method):
    result = [method.strip(), '\n## 来源版本\n',
              f"原文件：{SOURCE_NAME}；SHA-256：`{SOURCE_SHA}`；678927字节。",
              '正文5668段（含表格单元格），90个表格，108条批注（97条单点、11条范围）；未检测到修订插入或删除。',
              '以下C编号为原Word批注ID，P编号为document.xml全部段落的顺序定位（含空段与表格），不是页码。',
              '\n## 标准条文及风险措辞\n',
              '按上文方法选用。以下仍包含分支提示及待选择参数，必须完成取舍和替换；案例判断和“未设置”必须核对本期事实。',
              '发行人及联系人已改为占位符，跨章编号已订正；其他改写记录见curated-source.json。不得把定位编号或编制说明写入募集说明书正文。']
    current = None
    for clause in data['clauses']:
        if clause['chapter'] != current:
            current = clause['chapter']
            result.append('\n### ' + current + '\n')
        result.append(f"\n[{clause['locator']}] {clause['text']}")
    result += ['\n## 表格框架和指标公式\n',
               '90张表为结构清单，不要求无相关业务的企业机械填写全部表格。使用实际期间及单位，增删列、更新标题与合计。下列不含源企业财务数据行。']
    for table in data['tables']:
        result.append(f"\n### {table['id']} {table['title']} {table['locator']}\n")
        result.append('字段：' + '；'.join(table['fields']))
        if 'subfields' in table:
            result.append('下层字段（按上层期间／持股／余额分组）：' + '；'.join(table['subfields']))
        if 'row_labels' in table:
            result.append('行项目：' + '；'.join(table['row_labels']))
        if 'formulas' in table:
            result.extend('；'.join(row) for row in table['formulas'])
        if 'reference_only_rows' in table:
            result.append(table['limitation'])
            result.append('原表参考值（不代表已核实的本期行业水平）：')
            result.extend('；'.join(row) for row in table['reference_only_rows'])
    result += ['\n## 原Word批注全文及锚点\n',
               '完整保留108条方法批注，不把批注作者身份当作专业签认。歧义和冲突按本文件前部的明确处理说明执行。']
    for c in data['comments']:
        anchor = '范围 ' + c['start'] + '–' + c['end'] if c['anchor_kind'] == 'range' else '单点 ' + c['references'][0]
        result.append(f"\n### C{c['id']} {c['chapter']} {anchor}\n\n{c['text']}")
    return '\n'.join(result).strip() + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', help='Verify or intake the exact source DOCX')
    parser.add_argument('--check', action='store_true', help='Fail on drift; write nothing')
    args = parser.parse_args()
    curated_path = BASE / 'curated-source.json'
    data = curate(args.source) if args.source else json.loads(curated_path.read_text('utf-8'))
    curated = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    output = render(data, (BASE / 'method.md').read_text('utf-8'))
    output_path = BASE / 'writing-framework.md'
    if args.check:
        if curated_path.read_bytes() != curated.encode('utf-8') or output_path.read_bytes() != output.encode('utf-8'):
            raise ValueError('PPN writing snapshot drift; rebuild and review')
        print(f'PASS: {VERSION}; 108 anchored comments, 90 table frameworks; SHA-256 {sha(output)}')
    else:
        curated_path.write_bytes(curated.encode('utf-8'))
        output_path.write_bytes(output.encode('utf-8'))
        print(f'Built {VERSION}: {len(output)} characters; SHA-256 {sha(output)}')


if __name__ == '__main__':
    main()
