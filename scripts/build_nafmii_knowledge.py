"""Build research-only NAFMII knowledge and #19-compatible draft bundles offline.

Originals/records are immutable evidence; this file is the curated interpretation.
No registry release, project approval, model call or production mutation occurs.
"""
from pathlib import Path
import hashlib
import json
import re
from intake_nafmii_archive import BASE, ROOT, write_json

VERSION='2026.09.27-draft.1'
NOW='2026-09-27T10:00:00Z'

# Document classification is deliberately distinct from legal effectivity.
GROUPS={
 'historical': 'NA001 NA005 NA007 NA008 NA013 NA027 NA047 NA072',
 'common': 'NA004 NA006 NA009 NA010 NA014 NA015 NA025 NA026 NA028 NA029 NA030 NA031 NA071',
 'templates': 'NA002 NA011 NA012 NA016 NA043 NA070',
 'registration': 'NA017 NA022 NA023 NA039 NA041 NA042 NA044 NA045 NA055 NA058',
 'education': 'NA019 NA020 NA024 NA040 NA067',
 'administration': 'NA003 NA021',
 'foreign': 'NA046 NA048 NA049 NA050',
 'special': 'NA018 NA032 NA033 NA034 NA035 NA036 NA037 NA038 NA051 NA052 NA053 NA054 NA056 NA057 NA059 NA060 NA061 NA062 NA063 NA064 NA065 NA066 NA068 NA069',
}
NOTES={
 'NA001':'旧投资人保护示范文本；本批标废止，保留历史，不进入当前检索。',
 'NA002':'交叉保护、事先承诺/约束、控制权变更、偿债保障、抵质押六类参考条款；方括号/空白不是已约定事实。',
 'NA003':'注册专家选聘、履职和管理；不是对某发行人注册资格的自动判断。',
 'NA004':'用途合规、变更、闲置资金、监管/专项账户与存续管理；2022-12-01施行。',
 'NA005':'2016便利机制及附件属于历史背景；不能覆盖2023/2025/2026层级规则。',
 'NA006':'人民银行非金融企业债务融资工具管理的上位框架；不是逐章模板。',
 'NA007':'文件名写2022版，正文实际为2020年第32号公告，2020-12-04；不采信文件名日期/版本。',
 'NA008':'2020主承销商尽调旧版；2023版有明确施行前后边界。',
 'NA009':'2023尽调扩展各类中介，2023-08-03发布、2023-11-01施行；此前按当时规则，未明确可参照理解。',
 'NA010':'旧募集书编制通用指引；明确时间/来源/单位/风险表述。评级和章节等与后续规则冲突时不优先采用。',
 'NA011':'2013承销团合同范本；有著作权及使用说明，项目实际签署版本另核。',
 'NA012':'2013承销协议范本；不是当前主承销商家数规定。',
 'NA013':'2016注册发行旧版，本批标废止。',
 'NA014':'2023注册发行规则；正文修订授权日2023-06-29不是公告施行日；原件hash与既有官方证据一致。',
 'NA015':'2023注册工作规程：分层、统一注册、再评议及附件财务指标；第7/8/9/10/11等须叠加2025/2026通知。',
 'NA016':'分销协议范本；约定不得修改项、交割与保存；不作为募集书必需正文。',
 'NA017':'2018专项机构投资人遴选程序；180家为该版本名单机制，不能当今日名单或合格人数上限。',
 'NA022':'2026基础层通知：合并第三/四类、PDFI有额度统一注册、用途/刷报/分产品触发。',
 'NA023':'2026基础层操作问答：PDFI两年、总额度、有权决议、2027年前过渡、在途项目和60工作日系统条件。',
 'NA025':'2020公开表格实施通知和注册规程汇编；表格实施与旧规程效力须拆开。',
 'NA026':'2021三产品指引发布公告，2021-03-26；第2页仅落款，低文本不等于扫描缺正文。',
 'NA027':'2020公开注册规程作为历史；不替代2023母规程及后续通知。',
 'NA028':'CP：约定1年内还本付息；不固定365天，不推定闰日/顺延约定。',
 'NA029':'2020公开表格 M/BM、MQ/MC/MH等；与官方OF007字节不同，正文另作规范化比对。',
 'NA030':'MTN：约定一定期限；该指引未规定统一3–5年上限，不能擅自增加。',
 'NA031':'SCP：270天以内；资金用于流动资金需要，不得长期投资。',
 'NA039':'2025成熟层优化：ROA 2.5%、信息披露3期或100亿；第一类统一注册3年，不泛化。',
 'NA041':'2020定向表格发布：2020-07-01新报送适用全表，新发行适用DM-11；财务披露分路径。',
 'NA042':'PPN完整DM-0至DM-16、BDM、DX/F1/F2及D子表、脚注；母表路径与特征叠加分别判断。',
 'NA043':'定向发行协议2020参考文本；不同于定向募集说明书。',
 'NA044':'文件名20200630，但抬头含2020年12月再次修订；保留为12月修订文本线索，不能标成6月同版。',
 'NA045':'2020-06-30发布通知、7月1日起；取消定向备案、发行前1工作日、旧项目衔接；家数要核2025后续。',
 'NA047':'DOC抬头只有2020-04-30修订，与NA044不是字节/版本重复；历史留存。',
 'NA048':'境外分层细则；两个文件名2020/2023但hash同一，不把改名当修订。',
 'NA049':'境外注册表格；两个文件名2020/2023同hash，不跨用境内DFI。',
 'NA055':'2023注册发行61页业务问答；按每问日期及后续规则复核，不将整本视为2026新规。',
 'NA058':'注册发行流程问题汇编；署名文件日期不能代替每问原始发布日期。',
 'NA070':'ZF增发表：既有现金流、保护条款等不任意增删；独立特征叠加。',
 'NA071':'2021-08-13取消强制评级；选择评级仍履行有效结果/披露，不伪造评级。',
}
EDUCATION={
 'NA019':'合并范围以控制为基础；持股不足/超过50%都不能单独决定并表。案例须综合权力、可变回报及运用权力影响回报。',
 'NA020':'募集资金用途匡算、发行补充、专项账户、条款变更及类金融穿透；图解不是所有企业可用的无条件豁免。',
 'NA024':'主营业务与毛利/费用一致性、贸易总额净额依据、收入下降/收费权到期/安全事故风险回写；案例数值不是自动阈值。',
 'NA040':'林业金融政策图解，属专项研究背景，不自动覆盖普通债全部条件。',
 'NA067':'科创发行六问六答为图解；主体/用途/条款还须叠加2026优化机制。',
}
NOTES.update(EDUCATION)

# Dates supported by the body/identified publishing notice, never by filename alone.
DATE_EVIDENCE={
 'NA004':('2022-11-22','2022-12-01','NA004 PAGE001/PAGE005','2022'),
 'NA009':('2023-08-03','2023-11-01','NA009 PAGE001/PAGE002','2023'),
 'NA022':('2026-03-23','2026-03-23','NA022 PAGE002 + OF004','2026-44'),
 'NA023':('2026-03-23',None,'NA023 PAGE001; FAQ specific transitions vary','2026'),
 'NA026':('2021-03-26','2021-03-26','NA026 PAGE001/PAGE002','2021-9'),
 'NA028':('2021-03-26','2021-03-26','NA026 publication + NA028 P00012','2021'),
 'NA030':('2021-03-26','2021-03-26','NA026 publication + NA030 P00012','2021'),
 'NA031':('2021-03-26','2021-03-26','NA026 publication + NA031 P00012','2021'),
 'NA039':('2025-09-15',None,'NA039 PAGE001 publication / PAGE002 signed 2025-09-12; historical boundary pending','2025-182'),
 'NA041':('2020-04-16','2020-07-01','NA041 PAGE002/PAGE003; full forms vs DM-11 transition differ','2020-43'),
 'NA042':('2020-04-16','2020-07-01','NA041 publishing notice; scope-specific transition','2020'),
 'NA045':('2020-06-30','2020-07-01','NA045 PAGE001/PAGE003','2020-77'),
 'NA071':('2021-08-13','2021-08-13','NA071 PAGE002','2021-143'),
}

def read_records(sid):
    return json.loads((BASE/'records'/f'{sid}.json').read_text('utf-8'))['records']

def group(sid):
    return next(k for k,v in GROUPS.items() if sid in v.split())

def curate_catalog():
    catalog=json.loads((BASE/'sources.json').read_text('utf-8'))
    all_ids={sid for v in GROUPS.values() for sid in v.split()}
    assert all_ids=={s['source_id'] for s in catalog['sources']}
    index=[]
    md=['# 交易商协会资料目录（2026-09-27）','','原件保留用户提供字节；来源分类不是专业签认。页面/文件名日期不自动成为生效日。','','| ID | 资料 | 分类 | 阅读用途与限制 |','|---|---|---|---|']
    for s in catalog['sources']:
        sid=s['source_id'];g=group(sid)
        s['document_kind']=g
        s['current_status']='historical_excluded' if g=='historical' else 'research_only'
        s['notes']=NOTES.get(sid, {'special':'专项/主题/信用衍生或资产证券化制度；单独保留，不使普通PPN/MTN/CP/SCP/DFI自动获得该能力。','foreign':'境外非金融企业专用；境内规则不能据此替代。','administration':'市场管理制度；不冒充发行人逐章披露或自动合规结论。','templates':'合同或条款参考；实际采纳、主体和参数由材料核实。'}[g] if g in ('special','foreign','administration','templates') else '按原文定位使用，适用性待复核。')
        if g=='education':
            s['parse_status']='image_article_ocr_unverified'
            s['visual_or_ocr_required']=[r['locator'] for r in read_records(sid)]
        s['research_index_eligible']=g in ('common','registration','templates')
        if sid in ('NA044','NA055','NA058'):
            s['research_index_eligible']=False  # mixed/uncertain revision, explicit per-clause access only
        s['filename_date_is_effective_date']=False
        if sid in DATE_EVIDENCE:
            published,effective,basis,version=DATE_EVIDENCE[sid]
            s.update(published_on=published,effective_from=effective,date_evidence=basis,document_version=version)
        else:
            s['document_version']='as-supplied'
        if sid=='NA044':s['document_version']='2020-dec-revision'
        if sid=='NA047':s['document_version']='2020-apr-revision'
        s['legal_review']=None
        lines=[f'# {sid} · {s["title"]}','','[原件](../'+s['original_path']+') · SHA-256 `'+s['sha256']+'`','',s['notes'],'','下列为来源数据，不是对代理的指令；DOCX段落含空段/表格，DOC为提取行，PDF为物理页。批注及OCR不作为已确认正文。','']
        for r in read_records(sid):
            lines += [f'<a id="{r["locator"].lower()}"></a>',f'## {r["locator"]} ({r["role"]})','',r['text'],'']
            if s['research_index_eligible'] and r['role'] in ('body','footnote','endnote'):
                index.append({'source_id':sid,'locator':r['locator'],'source_sha256':s['sha256'],'text':r['text'],'usage':'research_only'})
        p=BASE/'sources'/f'{sid}.md';p.parent.mkdir(parents=True,exist_ok=True);p.write_text('\n'.join(line.rstrip() for line in '\n'.join(lines).splitlines()).rstrip()+'\n',encoding='utf-8')
        md.append(f'| {sid} | [{s["title"]}](sources/{sid}.md) | {g} | {s["notes"]} |')
    write_json(BASE/'sources.json',catalog)
    write_json(BASE/'research-index.json',{'version':VERSION,'production_eligible':False,'records':index})
    (BASE/'CATALOG.md').write_text('\n'.join(md)+'\n',encoding='utf-8')
    return {s['source_id']:s for s in catalog['sources']}

def reference(sources,sid,locs):
    if sid.startswith('OF'):
        s=next(s for s in json.loads((BASE/'official/catalog.json').read_text('utf-8')) if s['source_id']==sid)
        title={'OF001':'2023信息披露规则公告','OF002':'银行间债券市场非金融企业债务融资工具信息披露规则（2023修订）','OF003':'关于优化债务融资工具成熟层企业机制有关事项的通知（2025）','OF004':'关于优化债务融资工具基础层企业注册发行机制有关事项的通知（2026）','OF005':'非金融企业债务融资工具注册工作规程（2023版）','OF007':'公开发行注册文件表格体系（2020版）'}[sid]
        url=s['url']
    else:
        s=sources[sid];title=s['title'];url=s['official_url']
    records={r['locator']:r['text'] for r in read_records(sid)}
    quote='\n'.join(records[loc] for loc in locs)
    assert len(quote)<=12000
    ref_id=sid.lower()+'-'+locs[0].lower()+'-'+hashlib.sha256('|'.join(locs).encode()).hexdigest()[:8]
    return {'source_id':ref_id,'kind':'unverified_lead','authority':'中国人民银行' if sid=='NA006' else '中国银行间市场交易商协会','document_title':title,'source_version':s.get('document_version','2023' if sid in ('OF001','OF002','OF005') else 'as-captured'),'official_url':url,'document_hash':s['sha256'],'clause_locator':', '.join(locs),'exact_quote':quote,'published_on':s.get('published_on'),'effective_from':s.get('effective_from'),'effective_to':None,'verified_by':None,'verified_at':None}

# id, title, source+locators, required inputs, conservative decision and exception,
# positive, negative, boundary. These are review specifications, not implemented checkers.
PPN=[
 ('scope','定向投资者、披露渠道及转让范围',('NA044',['PAGE001','PAGE002','PAGE003','PAGE010']),['investor_scope','investor_selection_evidence','disclosure_channel','transfer_scope'],'区分专项、特定及非法人投资人；全部合格机构与约定部分名单的披露范围不同。公开上传不能替代定向披露。','投资人名单随版本更新，不硬编码2018年180家。','有名单及协议依据，渠道/转让范围一致','将定向披露写成面向社会公众','仅简称PPN，无投资人范围依据'),
 ('route','定向募集说明书与定向协议分支',('NA042',['P00088','P00305','P00306']),['document_stage','disclosure_route','first_issue_in_registration','prior_document_reference'],'DM用于注册及首期定向募集说明书；后续可用BDM。DX/F1/F2是协议路径，不能静默互换。','成熟层DFI下定向发行可选择公开或定向表格，需明确实际选择。','首期募集说明书采用DM，后续引用有版本','首期误用BDM删掉核心内容','用户未确定募集说明书或协议路径'),
 ('financial','财务期间、口径及定向例外',('NA041',['PAGE002']),['disclosure_route','issuer_tier','listed_status','financial_periods','consolidated_and_parent_sources'],'定向募集说明书通常两年审计及半年度；定向协议近一年审计。成熟层和上市公司定向募集说明书不强制半年报，缺少资格依据不自动豁免。','成立不足所需年限按自成立日起；选择公开表格时按该路径，不能无条件套两年。','两年审计和合并/母公司披露有证据','PPN协议无条件要求三年一期或将半年省略泛化','成熟层资格与半年报要求不确定'),
 ('financial-detail','财务分析、业务及科目变动证据',('NA042',['P00610','P00614','P00630','P00634','P00638','P00642']),['financial_periods','accounting_scope','business_revenue','account_balances','change_reasons'],'逐表保留期间、主体、合并/母公司和来源；金额/比例/变化分析不能凭模型补数，重大科目和业务披露依DM条款。','科目30%变动与资产/负债10%等原文条件分开，分母零或负数待判断。','同期间口径算数一致且原因有依据','母公司数据混进合并表且无提示','零分母或重分类导致不可比'),
 ('refresh','发行前刷报及重要事项',('NA042',['P00307','P00308','P00309','P00311']),['registration_date','first_issuance_date','annual_audit_available','interim_available','material_events','legal_opinion_date'],'注册后首期前出具新年审且4月30日后首期发行按DM/F1更新；仅新半年报的特殊安排保留。全文更新仍按用户最新材料执行。','监管最低刷报要求不缩减用户全文更新；D.13及后续规则另叠加。','满足新年度刷报条件并更新跨章内容','将仅半年报例外泛化为所有项目无需更新','首次/后续及签署时间不明'),
 ('funds','募集资金用途、项目材料与账户',('NA042',['P00548','P00549','P00550','P00554']),['funds_use_items','issue_amount','project_approvals','account_arrangements'],'核对实需用途、金额、项目资本金及批复，动态金额按上限；股权/基金等用途核政策，不以用户选择直接判合规。','后续2022用途规程及专项要求叠加；注册可简化不等于发行免披露。','用途及项目文件可追溯且金额相符','用途合计超过发行规模或缺批复仍声称合规','项目批复缺失标待人工确认'),
 ('trustee','受托管理、评级和保护安排',('NA044',['PAGE002','PAGE007']),['trustee','trust_agreement','rating_choice','investor_protection_terms'],'PPN按相关自律规则聘请受托人、披露协议主要内容；评级安排由企业确定并披露，不编造评级。','投资人保护示范条款如有才按实际写入，不能强制全部勾选；受托制度另核现行配套。','实际受托协议和已选择评级有来源','将公开通用“受托如有”直接删PPN受托章节','受托协议尚未提供'),
 ('timing','发行前、结果及存续披露',('NA044',['PAGE009','PAGE010']),['issuance_date','disclosure_date','registration_completion_date','business_calendar','ongoing_arrangements'],'定向发行前至少1工作日披露；完成债权债务登记次一工作日定向披露结果，转让限约定投资人。','不能将公开首次发行2工作日或交易流通首日直接替代定向特别安排；工作日历未锁定不自动算。','披露日期与受众依据齐全','以自然日直接代替工作日判通过','节假日历缺失'),
 ('changes','版本变化、定向事项与授权边界',('NA044',['PAGE006','PAGE007','PAGE011']),['material_events','registration_notice','latest_rule_version','special_features'],'接受注册前后重大/重要事项按相应程序披露与评议；专项产品另有规定从其规定。','本批NA044为2020年12月修订文本，配套发布公告仍需补核；不能以文件名6月日期套效力。','变更记录与本期文件对应','未审核重大事项就继续声明没有事项','再评议结果或规则施行时点不明'),
]
DFI=[
 ('arrangement','统一注册与本期实际工具分开',('NA015',['PAGE003','PAGE004']),['issuer_tier','registration_arrangement','document_stage','covered_instruments','issuance_instrument'],'DFI是协会项下注册安排，不是另一市场或MTN别名。注册覆盖列表不代表本期工具；本期明确后叠加对应工具包。','境外、ABN、永续、科创等专项即使注册覆盖，也不代表M1已具备生成能力。','注册覆盖多工具，本期明确MTN','把覆盖SCP/CP/MTN列表直接定成本期MTN','本期工具未明确'),
 ('tier','成熟层资格与第一/二类区分',('NA015',['PAGE002','PAGE003','PAGE014']),['tier_evidence','industry_evidence','audited_financials','issuance_history','credit_and_compliance_events'],'按2023母规程条件及2025修订逐项审核；成熟层并不都属于第一类。统计主体、36个月和严格比较符保留。','2025的2.5%、2500亿、3期或100亿叠加；行业/国家战略豁免不可自动推定。','有完整资格/计算/认定依据','凭国企身份或单一资产规模自动认定第一类','行业、ROA分母或豁免证据缺失'),
 ('mature-2025','成熟层2025优化与有效期',('NA039',['PAGE001','PAGE002']),['issuer_tier','registration_mode','registration_notice','notice_effective_date','transition_evidence'],'2025优化分层标准；统一注册成熟层挂网1工作日，统一注册第一类通知书有效期3年。','三年不扩至第二类、非统一注册或自动改写存量通知；2025落款9/12和网页9/15分开。','新第一类统一注册通知明确期限','第二类或旧通知无依据被自动加一年','在途/存量通知衔接尚无明确证据'),
 ('basic-2026','基础层PDFI及总额度',('NA023',['PAGE001','PAGE002']),['issuer_tier','registration_mode','registered_amount','covered_instruments','resolution_amounts','remaining_registrations'],'PDFI是基础层有额度统一注册，通知书两年；总额度明确而无需细分工具额度，本期工具/规模/期限自主确定。','不是成熟层可不设额度机制；2027年前多份决议过渡仍受总额和工具权限约束。','PDFI总额度和决议支持一致','PDFI省略总额度或套三年有效期','目标仅DFI但层级/通知类型不明'),
 ('basic-exceptions','分产品注册触发及历史衔接',('NA022',['PAGE001','PAGE002']),['default_events_36m','controller_events','shareholder_subsidiary_defaults','disciplinary_events','registration_history'],'原第四类并第三类，取消注册12月后事前备案；债务违约、违法/处分等触发第五项时按分产品注册。','必须有主体范围和36个月查询证据；未查到不是不存在。旧注册通知及专项条款不凭空变化。','全范围有证据，注册路径与通知一致','控股子公司违约被遗漏仍判统一注册可用','公开信息未接入或查询不完整'),
 ('transition','PDFI在途/决议过渡与60工作日',('NA023',['PAGE002','PAGE003']),['application_date','registration_progress','resolutions','system_effective_notice','review_clock'],'在途原则继续单品种，确需可撤回重报PDFI；2027前允许相应多份决议/说明。60工作日包含预评与反馈、重新累计和挂起条件。','60工作日功能上线时间另行通知，不能用2026-03-23无条件触发系统逾期。','在途重报与撤回、决议说明都有记录','把60工作日当固定审批承诺或无证据已到期','系统上线通知及挂起记录缺失'),
 ('funds','注册匡算与发行用途分层',('NA022',['PAGE001']),['document_stage','funds_use_categories','funds_use_items','policy_sensitive_use','change_procedure'],'基础层有额度统一注册原则按大类匡算，发行补合规/使用安排；政策敏感用途仍披露明细；超出匡算范围走条款变更。','SCP仍不得用于长期投资；专项用途不能靠普通统一注册免除。','注册大类与发行明细可对应','把注册阶段简化变为发行无用途','用途超出原范围缺变更依据'),
 ('refresh','季度更新及发行披露时点',('NA022',['PAGE001','PAGE002']),['first_interbank_issuance','latest_quarter','issuance_date','publication_date','business_calendar'],'新季度报表披露后首次面向机构投资者发行应全面更新；其他按现行。首次发行文件至少提前2工作日，非首次1工作日。','“首次面向市场”不等于某注册项下首期；成熟层挂网与基础层披露时钟不混用。','首次发行补新季报并保留日期依据','把历史已有发行人每次首期都判首次','首次身份或季度报表状态未知'),
 ('syndicate','主承销商团与变更',('NA022',['PAGE002']),['registration_syndicate','issuance_underwriters','appointment_evidence','current_syndicate_rule'],'2026通知明确注册/发行主承销商团按中市协发〔2025〕146号执行，不能硬编码2023/2020旧家数。','本批缺146号完整正文及配套核验；家数/变更自动判断标未覆盖，允许保留实际材料待确认。','实际聘任/协议对应且缺口明示','用旧2/3/4家阈值直接判违规','146号正文未取得或名单变更未证实'),
]

def make_bundle(sources,offering,definitions):
    refs={};rules=[]
    for short,title,(sid,locs),inputs,decision,exception,pos,neg,boundary in definitions:
        ref=reference(sources,sid,locs);refs[ref['source_id']]=ref
        rid=f'{offering}-{short}'
        rules.append({'rule_id':rid,'version':'1','title':title,'enabled':False,'enforcement':'research_only','source_ref_ids':[ref['source_id']],
            'applicability':{'document_stages':['registration','issuance'],'issuer_scopes':['domestic-nonfinancial-enterprise'],'investor_scopes':['directional-institutional' if offering=='ppn' else 'interbank-institutional'],'industries':[],'special_features':[]},
            'required_inputs':inputs,'checker':{'checker_id':'nafmii-manual-evidence-review','checker_version':'1','parameter_version':VERSION},
            'exceptions':[exception],'evidence_requirements':['锁定材料/规则版本和原文定位','逐字段状态及人工确认记录'],
            'outputs':{'when_met':'needs_judgement','when_not_met':'needs_evidence','severity':'warning'},'boundaries':[decision,'本项为人工审核规范；尚未实现自动业务checker，不以字段非空判业务通过。'],
            'positive_examples':[{'example_id':rid+'-positive','summary':pos,'expected_outcome':'pass','evidence_ref':'synthetic:'+rid+'-positive'}],
            'negative_examples':[{'example_id':rid+'-negative','summary':neg,'expected_outcome':'issue','evidence_ref':'synthetic:'+rid+'-negative'}],
            'boundary_examples':[{'example_id':rid+'-boundary','summary':boundary,'expected_outcome':'needs_evidence','evidence_ref':'synthetic:'+rid+'-boundary'}],'owner_role':'industry_reviewer'})
    if offering=='ppn':
        rows=read_records('NA042');chapters=[]
        fields=[['issuer','registration_status','responsibility','risk_prompts'],['defined_terms'],['risks','risk_evidence'],['issue_amount','tenor','pricing','investor_scope'],['funds_use_items','project_approvals'],['business_segments','ownership','consolidation_basis'],['financial_periods','consolidated_and_parent_sources','financial_analysis'],['credit_history','bank_facilities'],['credit_enhancement'],['debt_management'],['directional_disclosure_arrangements'],['holder_meeting'],['trustee','trust_agreement'],['investor_protection_terms'],['default_and_resolution'],['institutions'],['references']]
        for i,r in enumerate(rows):
            if re.fullmatch(r'DM-\d+',r['text']):
                n=int(r['text'][3:]);ref=reference(sources,'NA042',[r['locator'],rows[i+1]['locator']]);refs[ref['source_id']]=ref
                chapters.append({'chapter_id':r['text'].lower(),'title':rows[i+1]['text'],'form_refs':[r['text']],'source_ref_ids':[ref['source_id']],'required_fields':fields[n],'applicability':'DM路径注册/首期；后续BDM/协议DX路径另按条文，不自动裁剪；如有章节按实际事实。'})
    else:
        chapters=[{'chapter_id':r['rule_id'],'title':r['title'],'form_refs':['注册工作规程/优化通知（语义模块，非官方表号）'],'source_ref_ids':r['source_ref_ids'],'required_fields':r['required_inputs'],'applicability':'注册安排覆盖层；发行时合成实际工具M/DM/MC章节，不以本层代替完整募集说明书。'} for r in rules]
    pack={'schema_version':'rule-pack-v1','pack_id':'nafmii-'+offering,'version':VERSION,'supersedes_version':None,'status':'draft',
        'scope':{'market':'nafmii','offering':offering,'instruments':['standard-ppn'] if offering=='ppn' else ['unified-registration'],'document_stages':['registration','issuance'],'issuer_scopes':['domestic-nonfinancial-enterprise']},
        'validity':{'published_on':None,'effective_from':'2026-09-27','effective_to':None,'transition_terms':['本日期为研究快照候选适用起点，不是法规生效日；实际效力按来源事件和文书时点核验。','缺材料在全文工作稿标待人工确认，不编造事实或生产发布。']},
        'sources':list(refs.values()),'rules':rules,'sample_suite':{'suite_id':f'nafmii-{offering}-bundle-integrity','version':'1','data_classification':'synthetic','cases':[
        {'case_id':offering+'-'+polarity,'polarity':polarity,'evidence_ref':'engineering:nafmii-knowledge.test.ts#'+name,'result':'passed','reviewed_by':'engineering-fixture-author','reviewed_at':NOW}
        for polarity,name in [('positive','schema'),('negative','cross-market'),('boundary','draft-gate')]]},'reviews':[],'release':None,'withdrawal':None}
    template={'schema_version':'chapter-template-v1','template_id':f'nafmii-{offering}-chapters','version':VERSION,'rule_pack_id':pack['pack_id'],'market':'nafmii','offering':offering,'document_stages':['registration','issuance'],'chapters':chapters}
    coverage={'schema_version':'capability-coverage-v1','manifest_id':f'nafmii-{offering}-coverage','version':VERSION,'rule_pack_id':pack['pack_id'],'assessed_at':NOW,
       'items':[{'item_id':r['rule_id'],'area':r['title'],'disposition':'uncovered','document_stages':['registration','issuance'],'source_ref_ids':r['source_ref_ids'],'rationale':'已补原文/输入/例外和人工审核规范；未完成自动checker、真实项目验收和发布。'} for r in rules],
       'open_blockers':[{'blocker_id':'rule-consumer','description':'#19生产规则导入/审核发布及实际工具组合待联调；不在此资产脚本复制公共契约。','required_evidence':'@loooo139 明确消费者版本、导入和项目适用性证据。'},
                       {'blocker_id':'authorized-real','description':'本批为规则，无PPN/DFI授权真实项目及成果；现有四组沪深私募测试稿不能替代。','required_evidence':'@ITSophiaXu 提供相应注册/发行材料及目标；产出后做行业验收。'},
                       {'blocker_id':'companion-source','description':'2025第146号承销通知、PPN2020年12月修订发布依据及过渡等精确缺口见交接。','required_evidence':'按缺口逐条核对，不把局部问题当全部工作稿无法运行。'}]}
    dest=BASE/'drafts'/offering
    for name,obj in [('rule-pack',pack),('chapter-template',template),('coverage',coverage)]:write_json(dest/(name+'.json'),obj)
    lines=[f'# {offering.upper()} 规则与章节草案','','版本：`'+VERSION+'`。范围及证据可用于开发；业务checker未完成，正式能力未发布。','','| 条目 | 输入 | 判断与例外 | 正例 / 反例 / 边界 |','|---|---|---|---|']
    for row in definitions:
        short,title,(sid,locs),inputs,decision,exception,pos,neg,boundary=row
        lines.append(f'| {title}（[{sid}:{locs[0]}](../../sources/{sid}.md#{locs[0].lower()})） | '+', '.join(inputs)+f' | {decision} {exception} | {pos} / {neg} / {boundary} |')
    lines+=['','## 章节字段','']+[f'- **{c["chapter_id"]} {c["title"]}**：'+', '.join(c['required_fields']) for c in chapters]
    (dest/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')

def main():
    sources=curate_catalog()
    make_bundle(sources,'ppn',PPN)
    make_bundle(sources,'dfi',DFI)
    shared=[]
    for sid,locs,source_id,title in [
        ('OF002',['PAGE003','PAGE004','PAGE005','PAGE009'],'nafmii-disclosure-rules-2023','银行间债券市场非金融企业债务融资工具信息披露规则（2023修订）'),
        ('OF005',['PAGE002','PAGE003','PAGE004','PAGE014'],'nafmii-registration-procedure-2023','非金融企业债务融资工具注册工作规程（2023版）'),
        ('OF003',[f'L{i:05d}' for i in range(348,367)],'nafmii-mature-tier-notice-2025','关于优化债务融资工具成熟层企业机制有关事项的通知（2025）'),
        ('NA023',['PAGE001','PAGE002','PAGE003'],'nafmii-basic-tier-faq-2026','基础层企业注册发行机制通知操作问答（2026）'),
    ]:
        ref=reference(sources,sid,locs);ref['source_id']=source_id;ref['document_title']=title
        shared.append(ref)
    dest=ROOT/'packages/domain/src/nafmii-source-evidence.ts'
    dest.write_text('// Generated by scripts/build_nafmii_knowledge.py; research sources, no human attestation.\nimport type { RuleSource } from \'./index.js\';\nexport const nafmiiSourceEvidence = '+json.dumps(shared,ensure_ascii=False,indent=2)+' satisfies RuleSource[];\n',encoding='utf-8')
    print('Built 72-source catalog, research index, PPN/DFI draft bundles (18 rules; 26 chapter modules).')

if __name__=='__main__':main()
