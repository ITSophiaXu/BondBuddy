import type { ChapterTemplate, CoverageManifest, RuleDefinition, RulePack } from './index.js';
import { nafmiiMtnChapterTemplate, nafmiiMtnDraftRulePack } from './nafmii-mtn.js';

const CHECKED_AT='2026-09-24T09:00:00Z';
const commonSources=nafmiiMtnDraftRulePack.sources.filter(source=>source.source_id!=='nafmii-mtn-guide-2021');
const unreviewedSources=new Set(commonSources.filter(source=>source.kind==='unverified_lead').map(source=>source.source_id));
const applicability:RuleDefinition['applicability']={document_stages:['registration','issuance'],issuer_scopes:['domestic-nonfinancial-enterprise-public'],investor_scopes:['interbank-institutional'],industries:[],special_features:[]};

const rule=(input:Omit<RuleDefinition,'version'|'enabled'|'enforcement'|'checker'|'owner_role'> & {checker_id:string}):RuleDefinition=>{
  const {checker_id,...definition}=input;
  const requiresReview=definition.source_ref_ids.some(id=>unreviewedSources.has(id));
  return {version:requiresReview?'2':'1',enabled:!requiresReview,enforcement:requiresReview?'research_only':'soft_check',owner_role:'industry_reviewer',checker:{checker_id,checker_version:'1',parameter_version:requiresReview?'2026-09-27':'2026-03-23'},...definition};
};

export const nafmiiCpDraftRulePack={
  schema_version:'rule-pack-v1',pack_id:'nafmii-cp',version:'2026.09.27-draft.2',supersedes_version:'2026.09-draft.1',status:'draft',
  scope:{market:'nafmii',offering:'cp',instruments:['standard-cp'],document_stages:['registration','issuance'],issuer_scopes:['domestic-nonfinancial-enterprise-public']},
  validity:{published_on:null,effective_from:'2026-03-23',effective_to:null,transition_terms:['The 2026-03-23 notice changes basic-tier classification and registration mechanics; an industry reviewer must confirm its interaction with the 2023 procedure before release.']},
  sources:[{
    source_id:'nafmii-cp-guide-2021',kind:'formal_rule',authority:'中国银行间市场交易商协会',document_title:'非金融企业短期融资券业务指引（2021版）',source_version:'2021',
    official_url:'https://www.nafmii.org.cn/ggtz/gg/202103/P020220117435171924460.docx',document_hash:'20995cb88877bd53e81bfc9190898fa21433c544ad2fb35fcd75737ac84ad5b1',
    clause_locator:'第二条至第五条',
    exact_quote:'第二条 本指引所称短期融资券，是指具有法人资格的非金融企业（以下简称企业）在银行间债券市场发行的，约定在1年内还本付息的债务融资工具。第三条 企业发行短期融资券应依据《非金融企业债务融资工具注册发行规则》在交易商协会注册。第四条 企业发行短期融资券所募集的资金应用于符合国家相关法律法规及政策要求的企业生产经营活动，并在发行文件中明确披露具体资金用途。企业在短期融资券存续期内变更募集资金用途应提前披露。第五条 企业发行短期融资券应按交易商协会《银行间债券市场非金融企业债务融资工具信息披露规则》在银行间债券市场披露信息。',
    published_on:'2021-03-26',effective_from:'2021-03-26',effective_to:null,verified_by:'official-source-integrity',verified_at:CHECKED_AT,
  },{
    source_id:'nafmii-funds-use-procedure-2022',kind:'formal_rule',authority:'中国银行间市场交易商协会',document_title:'银行间债券市场非金融企业债务融资工具募集资金用途管理规程',source_version:'2022',
    official_url:null,document_hash:'c456615379afad6ccce41b5b5e1c338185e74572023d245da332c2e788dbfa0f',
    clause_locator:'第六条',
    exact_quote:'第六条 募集资金应当按照发行文件的约定使用。企业变更募集资金用途的，应当及时披露拟变更后的募集资金用途。发行文件中约定了募集资金用途备案、持有人会议等特别变更程序的，应按约定履行。',
    published_on:'2022-11-22',effective_from:'2022-12-01',effective_to:null,verified_by:'official-source-integrity',verified_at:CHECKED_AT,
  },...commonSources],
  rules:[
    rule({rule_id:'cp-instrument-identity',title:'CP产品身份与一年内期限边界',checker_id:'cp-scope-and-tenor-check',source_ref_ids:['nafmii-cp-guide-2021'],applicability:{...applicability},
      required_inputs:['issuer_legal_form','issuer_financial_status','market','offering','investor_scope','interest_start_date','maturity_date','stated_tenor'],exceptions:['境外、定向、资产支持、专项或主题产品须选择对应独立规则包。'],evidence_requirements:['发行人主体材料','发行对象依据','期限起止日及原始期限表达'],outputs:{when_met:'pass',when_not_met:'issue',severity:'warning'},boundaries:['CP须约定在1年内还本付息；不能套用SCP的270天边界，不能用固定365天替代所有日历年判断，也不能把恰好一年误判为超期。'],
      positive_examples:[{example_id:'cp-identity-positive',summary:'合成工程示例：境内非金融企业公开发行标准CP，原始期限条款约定11个月，起息日为2025-01-01、到期日为2025-12-01，符合来源所载“1年内”表述。',expected_outcome:'pass',evidence_ref:'synthetic:cp-eleven-month-tenor'}],negative_examples:[{example_id:'cp-identity-negative',summary:'期限超过一年的工具被标成CP。',expected_outcome:'issue',evidence_ref:'synthetic:cp-over-one-year'}],boundary_examples:[{example_id:'cp-identity-boundary',summary:'只有到期日但缺起息日，无法计算是否在一年内。',expected_outcome:'needs_evidence',evidence_ref:'synthetic:cp-tenor-anchor-missing'}]}),
    rule({rule_id:'cp-registration-files',title:'CP注册文件、方式与有效期证据',checker_id:'cp-registration-evidence-check',source_ref_ids:['nafmii-registration-rules-2023','nafmii-registration-procedure-2023','nafmii-mature-tier-notice-2025','nafmii-basic-tier-notice-2026','nafmii-basic-tier-faq-2026'],applicability:{...applicability},
      required_inputs:['registration_mode','registration_notice','registration_expiry','document_stage','issuer_tier'],exceptions:['历史过渡项目及专项或主题产品按其适用规定处理。'],evidence_requirements:['注册文件','接受注册通知书（发行阶段）','发行人层级与注册方式依据'],outputs:{when_met:'pass',when_not_met:'needs_evidence',severity:'warning'},boundaries:['不得沿用2023规程中原第四类企业的旧备案逻辑作为2026年3月23日后的确定结论。'],
      positive_examples:[{example_id:'cp-registration-positive',summary:'发行阶段提供在有效期内且覆盖CP的注册通知。',expected_outcome:'pass',evidence_ref:'synthetic:cp-registration-valid'}],negative_examples:[{example_id:'cp-registration-negative',summary:'以不覆盖CP的注册文件支持本期发行。',expected_outcome:'issue',evidence_ref:'synthetic:cp-registration-mismatch'}],boundary_examples:[{example_id:'cp-registration-boundary',summary:'基础层统一注册项目的过渡适用依据不完整。',expected_outcome:'needs_evidence',evidence_ref:'synthetic:cp-registration-transition'}]}),
    rule({rule_id:'cp-chapter-and-financial-disclosure',title:'CP的M表章节与财务披露',checker_id:'cp-m-form-coverage-check',source_ref_ids:['nafmii-public-forms-2020','nafmii-disclosure-rules-2023'],applicability:{...applicability},
      required_inputs:['document_stage','m_form_coverage','financial_periods','financial_scope','conditional_features'],exceptions:['符合条件的后续发行可使用BM表；补充表、产品表和行业表按事实触发。'],evidence_requirements:['M-0至M-17章节映射','最近三年审计报告和最近一期报表证据','合并及母公司口径'],outputs:{when_met:'pass',when_not_met:'needs_evidence',severity:'warning'},boundaries:['SCP的MC.4省略披露机制不适用于CP；评级报告为如有，不得因缺少评级而虚构。'],
      positive_examples:[{example_id:'cp-chapters-positive',summary:'标准首期CP映射M表并保留完整财务章节。',expected_outcome:'pass',evidence_ref:'synthetic:cp-full-m-form'}],negative_examples:[{example_id:'cp-chapters-negative',summary:'复制SCP省略披露方式删除CP财务章节。',expected_outcome:'issue',evidence_ref:'synthetic:cp-scp-omission'}],boundary_examples:[{example_id:'cp-chapters-boundary',summary:'季度报表已披露但发行人层级和更新要求尚不明确。',expected_outcome:'needs_evidence',evidence_ref:'synthetic:cp-quarter-update'}]}),
    rule({rule_id:'cp-funds-use-and-ongoing-disclosure',title:'CP募集资金用途与存续披露',checker_id:'cp-funds-and-disclosure-check',source_ref_ids:['nafmii-cp-guide-2021','nafmii-funds-use-procedure-2022','nafmii-public-forms-2020','nafmii-disclosure-rules-2023','nafmii-basic-tier-notice-2026'],applicability:{...applicability},
      required_inputs:['funds_use_stage','funds_use_items','issue_amount','change_procedure','disclosure_arrangements','payment_schedule'],exceptions:['仅在确有用途变更时核验该次实际披露和新用途生效时间；无变更的项目不要求伪造事件日期。','基础层有额度统一注册的注册阶段原则上可按大类匡算；政策敏感用途仍按现行要求披露明细。'],evidence_requirements:['用途逐项金额与材料锚点','注册/发行阶段','如已发生用途变更，提供该次实际披露日期及变更后用途生效日期','披露与用途变更条款须分别归于CP指引第四条、NA004第六条和2023披露规则第二十七条','重大事项、定期报告和兑付披露安排'],outputs:{when_met:'pass',when_not_met:'needs_evidence',severity:'warning'},boundaries:['用途未知保持待补，不得造值；注册阶段大类匡算不等于发行阶段无需具体披露。','已发生用途变更时，按CP指引第四条→NA004第六条→2023披露规则第二十七条核对实际披露日期先于新用途生效日期；第二十七条规定至少于资金使用前5个工作日披露，工作日日历和顺延无统一口径，不换算、不并列第二十六条（增进机构变更）；只有日期且同日、来源冲突、跨条款误引或证据不足时保持待审核，不推断盘中先后。'],
      positive_examples:[{example_id:'cp-funds-positive',summary:'发行阶段用途、金额和披露安排完整且相互一致；如存续期发生变更，证据显示在新用途生效前披露。',expected_outcome:'pass',evidence_ref:'synthetic:cp-funds-complete'}],negative_examples:[{example_id:'cp-funds-negative',summary:'分项用途金额超过发行规模，或新用途生效后才披露变更，且未提示冲突。',expected_outcome:'issue',evidence_ref:'synthetic:cp-funds-overflow'},{example_id:'cp-funds-clause-negative',summary:'把2023披露规则第二十六条（增进机构变更）当作募集资金用途变更依据，或引用未在CP指引第四条、NA004第六条、披露规则第二十七条确认链内的条款。',expected_outcome:'issue',evidence_ref:'synthetic:cp-funds-clause-misattribution'}],boundary_examples:[{example_id:'cp-funds-boundary',summary:'统一注册阶段只有用途大类且具体一期尚未形成；用途变更披露日与新用途生效日相同，日期证据无法证明提前披露。',expected_outcome:'needs_evidence',evidence_ref:'synthetic:cp-funds-registration-stage'}]}),
  ],
  sample_suite:{suite_id:'nafmii-cp-synthetic-engineering',version:'1',data_classification:'synthetic',cases:[
    {case_id:'cp-synthetic-basic',polarity:'positive',evidence_ref:'synthetic:cp-eleven-month-tenor',result:'passed',reviewed_by:'engineering-fixture-author',reviewed_at:CHECKED_AT},
    {case_id:'cp-synthetic-over-tenor',polarity:'negative',evidence_ref:'synthetic:cp-over-one-year',result:'passed',reviewed_by:'engineering-fixture-author',reviewed_at:CHECKED_AT},
    {case_id:'cp-synthetic-transition',polarity:'boundary',evidence_ref:'synthetic:cp-registration-transition',result:'passed',reviewed_by:'engineering-fixture-author',reviewed_at:CHECKED_AT},
  ]},reviews:[],release:null,withdrawal:null,
} satisfies RulePack;

export const nafmiiCpChapterTemplate={...nafmiiMtnChapterTemplate,template_id:'nafmii-cp-m-form',version:'2026.09.27-draft.2',rule_pack_id:'nafmii-cp',offering:'cp'} satisfies ChapterTemplate;

export const nafmiiCpCoverageManifest={schema_version:'capability-coverage-v1',manifest_id:'nafmii-cp-coverage',version:'2026.09.27-draft.2',rule_pack_id:'nafmii-cp',assessed_at:CHECKED_AT,items:[
  {item_id:'standard-cp-m-form',area:'标准公开发行CP的M表章节骨架',disposition:'covered',document_stages:['registration','issuance'],source_ref_ids:['nafmii-public-forms-2020'],rationale:'复用协会通用M-0至M-17章节结构，不复用MTN产品规则。'},
  {item_id:'cp-core-product',area:'标准CP产品身份、一年内期限、注册、用途和披露',disposition:'covered',document_stages:['registration','issuance'],source_ref_ids:['nafmii-cp-guide-2021','nafmii-funds-use-procedure-2022','nafmii-registration-rules-2023','nafmii-disclosure-rules-2023'],rationale:'用途变更条款链固定为CP指引第四条→NA004第六条→2023披露规则第二十七条；新来源仍待效力与业务审核，不因字段非空认为完整。'},
  {item_id:'basic-tier-2026',area:'2026基础层分类和有额度统一注册',disposition:'uncovered',document_stages:['registration','issuance'],source_ref_ids:['nafmii-basic-tier-notice-2026','nafmii-registration-rules-2023'],rationale:'已补2023母规程、2025成熟层及2026基础层操作问答；具体项目资格、存量过渡和生产接入仍待审核。'},
  {item_id:'mtn-ppn-scp-dfi',area:'MTN、PPN、SCP、DFI产品规则',disposition:'not_applicable',document_stages:['registration','issuance'],source_ref_ids:['nafmii-cp-guide-2021'],rationale:'本包仅适用于offering=cp；尤其不得把SCP的270天及省略披露机制用于CP。'},
  {item_id:'special-products',area:'绿色、科创、乡村振兴等专项或主题CP',disposition:'uncovered',document_stages:['registration','issuance'],source_ref_ids:[],rationale:'需要专项规则、补充表、适用矩阵和独立样本。'},
  {item_id:'industry-overlays',area:'房地产、城市基础设施等行业补充表',disposition:'uncovered',document_stages:['registration','issuance'],source_ref_ids:[],rationale:'尚未录入现行行业补充表及政策证据。'},
  {item_id:'authorized-real-samples',area:'基础、复杂、边界真实样本',disposition:'uncovered',document_stages:['registration','issuance'],source_ref_ids:[],rationale:'只有合成工程样本，不能替代授权真实任务和行业审核。'},
],open_blockers:[
  {blocker_id:'industry-source-review',description:'现行效力、过渡、范围和例外尚未由行业审核人签署。',required_evidence:'行业审核attestation及逐项意见。'},
  {blocker_id:'real-sample-suite',description:'缺少授权真实CP基础、复杂和边界样本。',required_evidence:'样本哈希、期望结果、规则锚点及行业复核记录。'},
  {blocker_id:'special-overlay-gaps',description:'专项产品和行业补充表尚未覆盖。',required_evidence:'补齐独立规则和样本，或批准受限上线范围。'},
]} satisfies CoverageManifest;
