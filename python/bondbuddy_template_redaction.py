"""Build structure-only preview copies; never publish customer text with a CSS mask.

This is deliberately an allowlist, not a claim that regex can find every identity.
Only individually reviewed, generic field/heading labels may survive. All other
populated values, text, media, field instructions and metadata are removed.
The originals and the generation template assets are never edited.
"""
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import re,posixpath
from urllib.parse import unquote
from lxml import etree as E

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R='http://schemas.openxmlformats.org/package/2006/relationships'
NS={'w':W}
LABELS=set('''项目名称 项目组成员 项目负责人 复核人 核查人员 核查日期 企业名称
公司名称 发行人名称 发行人 法定代表人 注册资本 实收资本 成立日期 注册地址 办公地址
联系地址 邮政编码 联系人 联系电话 电话 传真 电子邮箱 网址 姓名 职务 任期 性别 年龄
董事 监事 高级管理人员 经办人员 签字 签章 日期 序号 核查内容 核查方式 核查情况
核查结果 核查结论 备注 是否适用 适用性 核查人员签名 核查人员签字 复核人员签字
发行人基本情况 核查记录 核查文件 情况说明 发行人说明 核查意见 目录 重要提示 释义
第一节 第二节 第三节 第四节 第五节 公司基本情况 公司及相关中介机构简介 公司债券事项
财务报告 财务情况 财务信息 财务指标 资产总计 负债合计 所有者权益 营业收入 净利润
公司治理 债券基本信息 债券名称 债券简称 债券代码 债券余额 发行金额 发行规模 期限
单位 金额 比例 持股比例 持股数量 股东名称 出资人 关联关系 关联方名称 担保金额
担保余额 主承销商 受托管理人 律师事务所 会计师事务所 评级机构 核查依据 核查事项
核查程序 结论 本次发行 批准与授权 主体资格 发行条件 募集资金用途 募集资金运用
发行人历史沿革与股权结构 发行人基本情况的核查记录 发行人沿革与股权结构的核查记录
尽调结论 尽职调查记录 立项申请报告 主承销商核查意见 公司债券年度报告 法律意见书
发行申请书 风险因素 发行人信用情况 经营范围 主营业务 总资产 总负债 净资产
项目组意见 复核意见 负责人意见 经营活动产生的现金流量净额 发行方案 主要财务数据
'''.split())
PERSON_LABELS={'项目组成员','项目负责人','复核人','核查人员','核查人员签字','姓名','法定代表人','联系人','经办人员','签字','核查人员签名','复核人员签字'}
DROP_TAGS={'drawing','pict','object','altChunk','subDoc','contentPart','sym','del','moveFrom','commentRangeStart','commentRangeEnd','commentReference','bookmarkStart','bookmarkEnd','instrText','delInstrText','fldChar','dataBinding','attachedTemplate','mailMerge','docVars'}
BLOCKED_PREFIXES=('word/media/','word/embeddings/','word/activeX/','customXml/','docProps/')
BLOCKED_NAMES=('comments','people','vbaProject','printerSettings')

def generic_text(text, allowed=LABELS):
    text=re.sub(r'\s+','',text)
    if not text:return ''
    # Exact complete labels only; unknown aliases, digits, addresses, names,
    # paragraphs and identity-bearing values never pass through.
    label=text.strip('：:')
    heading=re.sub(r'^(?:第[一二三四五六七八九十\d]+[章节]|[（(]?[一二三四五六七八九十\d]+[）)、.．])','',label)
    if label in allowed:return label+('：【人员信息】' if label in PERSON_LABELS and text.endswith(('：',':')) else '：【本项信息】' if text.endswith(('：',':')) else '')
    if heading in allowed:return heading
    # A recognized field followed by a populated value becomes label + slot.
    first=re.split('[：:]',text,maxsplit=1)
    if len(first)==2 and first[0] in allowed:return first[0]+('：【人员信息】' if first[0] in PERSON_LABELS else '：【本项信息】')
    return '【本项目内容】'

def sanitize_docx(raw, title, allowed=LABELS):
    source=ZipFile(BytesIO(raw));result=BytesIO();preview=[];title_set=False
    names={n for n in source.namelist() if n.endswith(('.xml','.rels')) and not n.startswith(BLOCKED_PREFIXES) and not any(k in n for k in BLOCKED_NAMES)}
    with ZipFile(result,'w',ZIP_DEFLATED) as out:
        for name in sorted(names):
            data=source.read(name)
            if not name.endswith(('.xml','.rels')):
                # Fonts and opaque/custom/binary parts are not necessary for a
                # preview and could carry an embedded original or personal data.
                continue
            tree=E.fromstring(data,E.XMLParser(resolve_entities=False,no_network=True))
            if name.endswith('.rels'):
                for rel in list(tree):
                    target=rel.get('Target','')
                    base='' if name=='_rels/.rels' else posixpath.dirname(posixpath.dirname(name))
                    resolved=unquote(target).lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(base,unquote(target)))
                    if rel.get('TargetMode')=='External' or resolved not in names or any(v in rel.get('Type','') for v in ('image','oleObject','package','customXml','comments','extended-properties','core-properties','vbaProject','printerSettings','font')):
                        tree.remove(rel)
            elif name=='[Content_Types].xml':
                for el in list(tree):
                    part=el.get('PartName','').lstrip('/')
                    if part and (part not in names or not part.endswith(('.xml','.rels'))):tree.remove(el)
            else:
                for el in list(tree.iter()):
                    # Strip drawing/VML/custom vocabularies even outside a normal
                    # w:drawing wrapper. Only Word structure and text can render.
                    if (E.QName(el).localname in DROP_TAGS or E.QName(el).namespace not in {W,None}) and el.getparent() is not None:el.getparent().remove(el)
                for el in list(tree.iter()):
                    if E.QName(el).localname in {'fldSimple','hyperlink'} and el.getparent() is not None:
                        parent=el.getparent();index=parent.index(el)
                        for child in list(el):parent.insert(index,child);index+=1
                        parent.remove(el)
                for el in list(tree.iter()):
                    if E.QName(el).localname=='sdt' and el.getparent() is not None:
                        parent=el.getparent();index=parent.index(el);content=el.find('w:sdtContent',NS)
                        if content is not None:
                            for child in list(content):parent.insert(index,child);index+=1
                        parent.remove(el)
                for el in tree.iter():
                    for attr in list(el.attrib):
                        if E.QName(attr).localname=='author':el.attrib[attr]='已脱敏'
                        elif E.QName(attr).localname in {'initials','instr','descr','title','anchor','history'}:del el.attrib[attr]
                for p in tree.findall('.//w:p',NS):
                    texts=p.findall('.//w:t',NS)
                    old=''.join(t.text or '' for t in texts)
                    value=generic_text(old,allowed)
                    # Long placeholders would stretch narrow serial/value cells
                    # and obscure the very table format the user is previewing.
                    if value=='【本项目内容】' and any(a.tag==f'{{{W}}}tc' for a in p.iterancestors()):value='—'
                    if name=='word/document.xml' and old.strip() and not title_set:
                        value=title;title_set=True
                    for i,t in enumerate(texts):t.text=value if i==0 else ''
                    if name=='word/document.xml' and value and (not preview or preview[-1]!=value):preview.append(value)
                # w:t outside a paragraph (unusual fields/controls) is also closed.
                for t in tree.findall('.//w:t',NS):
                    if not any(a.tag==f'{{{W}}}p' for a in t.iterancestors()):t.text='【本项目内容】'
                for tag in ('delText','instrText'):
                    for t in tree.findall(f'.//w:{tag}',NS):t.text=''
            out.writestr(name,E.tostring(tree,xml_declaration=True,encoding='UTF-8',standalone=True))
    return result.getvalue(),'\n'.join(preview)

def assert_safe_preview(raw, allowed=LABELS, title=''):
    """Independently verify all renderable text is from the approved vocabulary."""
    with ZipFile(BytesIO(raw)) as z:
        assert not any(n.startswith(BLOCKED_PREFIXES) for n in z.namelist())
        for name in z.namelist():
            if name.endswith('.xml'):
                root=E.fromstring(z.read(name))
                for node in root.findall('.//w:t',NS):
                    s=node.text or ''
                    assert not s or s==title or s in allowed or s in {'【本项目内容】','—'} or any(s==label+suffix for label in allowed for suffix in ('：【人员信息】','：【本项信息】')),f'Unapproved preview text in {name}'
                assert not any(E.QName(e).localname in DROP_TAGS for e in root.iter())
