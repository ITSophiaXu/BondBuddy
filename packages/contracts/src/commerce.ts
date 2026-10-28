import {Type,type Static,type TSchema} from '@sinclair/typebox';

/** Reference design prices are CNY minor units; executable amounts come from reviewed scope quotations. */
export const OUTCOME_PRICE_VERSION='outcome-cny-20261028-v1' as const;
export const OUTCOME_PRICING_MODE='outcome_cny_v1' as const;
export const OUTCOME_PRICES={
  prospectus_first_draft:59900,
  prospectus_period_update:24900,
  prospectus_local_revision:3900,
  linked_document_generation:9900,
  linked_consistency_check:990,
  linked_document_sync:1990,
  substantive_review:14900,
  question_answer:980,
  integrity_check:5000,
} as const;
export type OutcomeProduct=keyof typeof OUTCOME_PRICES;
const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const amount=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
const text=Type.String({maxLength:2000});
const provider=Type.Union([Type.Literal('wechat'),Type.Literal('alipay')]);
export const ScopeLineSchema=obj({key:id,label:Type.String({minLength:1,maxLength:200}),quantity:Type.Integer({minimum:1,maximum:100000}),unit:Type.String({minLength:1,maxLength:40}),unit_price_fen:Type.Integer({minimum:0,maximum:100000000}),amount_fen:amount,evidence:Type.Array(Type.String({minLength:1,maxLength:1000}),{minItems:1,maxItems:50})});
export type ScopeLine=Static<typeof ScopeLineSchema>;
export const CommerceMetadataFields={
  pricing_mode:Type.Optional(Type.Literal(OUTCOME_PRICING_MODE)),
  currency:Type.Optional(Type.Literal('CNY')),
  amount_fen:Type.Optional(amount),
  unit_amount_fen:Type.Optional(amount),
  units:Type.Optional(Type.Integer({minimum:0,maximum:100000})),
  scope_quote_id:Type.Optional(id),
  quote_status:Type.Optional(Type.Union([Type.Literal('pending_scope'),Type.Literal('ready')])),
  scope_lines:Type.Optional(Type.Array(ScopeLineSchema,{maxItems:200})),
};
export const CommercePriceMetadataSchema=obj(CommerceMetadataFields);
export type CommercePriceMetadata=Static<typeof CommercePriceMetadataSchema>;
export const OUTCOME_CATALOG=[
  {code:'prospectus_first_draft',label:'募集书首稿',unit:'份',price_fen:59900,capability:'limited',scope:['已开放市场及品种，一主体、一份募集书工作稿','按锁定材料和目标版本编制；缺少依据的内容明确列待确认'],included:['原范围内部核对、清洁版与修订版、平台纠错']},
  {code:'prospectus_period_update',label:'新报告期更新',unit:'次',price_fen:24900,capability:'limited',scope:['同主体、同市场品种的一个新报告期','跨市场、跨品种或多期补更先确定单独范围，不按本标准价自动启动'],included:['本期受影响正文与表格、内部核对、双Word及原范围修正']},
  {code:'prospectus_local_revision',label:'新事实局部修订',unit:'组',price_fen:3900,capability:'limited',scope:['同期间一个明确业务变化及直接受影响范围','不按一句对话收费；新增独立业务范围另行确认'],included:['原范围澄清、修正、修订版与清洁版']},
  {code:'linked_document_generation',label:'标准关联文件编制',unit:'份',price_fen:9900,capability:'limited',scope:['仅所选已开放标准模板及锁定材料','输出辅助工作稿；未核实事实和独立专业意见须人工确认'],included:['模板与材料复用、正文Word、编制说明及平台纠错']},
  {code:'linked_consistency_check',label:'关联文件一致性检查',unit:'份',price_fen:990,capability:'limited',scope:['选定文件与当前募集书的固定版本','交付实际检查范围、差异位置与依据；不等于全面合规复核'],included:['报告、依据定位、相同有效范围结果复用']},
  {code:'linked_document_sync',label:'检查并修订已定位差异',unit:'份',price_fen:1990,capability:'limited',scope:['落地有准确依据且可定位的差异；存疑内容保留并说明','按实际所选差异范围报价；同版本已付检查作为复用依据，不再次收费'],included:['一致性检查、所选差异修订、清洁版与修订版']},
  {code:'substantive_review',label:'独立实质复核',unit:'份',price_fen:14900,capability:'limited',scope:['用户另行选定材料、版本与复核范围','交付有定位和覆盖说明的问题报告，需人工审阅，不出售人工签审'],included:['约定范围的问题报告、依据与平台纠错']},
  {code:'question_answer',label:'内审问题回复',unit:'题',price_fen:980,capability:'limited',scope:['用户确认的标准问题及原要求','明显复合范围在执行前确定；缺资料如实标注，原承诺补证不重复收费'],included:['问题整理、资料引用、回复Word、待补清单及原范围修正']},
  {code:'integrity_check',label:'诚信核查',unit:'轮',price_fen:5000,capability:'limited',scope:['所选主体及本轮可访问官网','逐站披露已查、受限与未完成范围，不把查询受限视为无记录'],included:['本轮可用证据、来源与核查工作稿']},
] as const;
export const COMMERCE_RULES=[
  '按明确成果付费，无强制订阅、月最低消费或大额充值要求。',
  '同类任务依实际处理范围逐单报价，目录金额仅作参考，不是所有任务统一价。',
  '开始前核对本单处理范围、工作项明细和人民币总价；范围报价待确认时不能收费执行。预留全价，交付结算，未交付部分释放。',
  '主动检查与独立复核收费；生成内部核对、原范围澄清、平台纠错和重试包含在原价。',
  '同版本已付检查后修订只补差额；新事实、新期间或独立新增范围另行确认。',
  '充值形成可用服务余额，未消费金额不是任务收入；旧任务保留提交时规则。',
  '生成内容为工作稿，显示实际覆盖与待确认项，由用户审阅后采用。',
] as const;
export const commerceSchemas={
  CommerceScopeQuotationsResponse:obj({items:Type.Array(obj({id,project_id:id,action:id,input_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),quote_status:Type.Union([Type.Literal('pending_scope'),Type.Literal('ready')]),amount_fen:amount,scope_lines:Type.Array(ScopeLineSchema),reason:text,created_at:Type.String(),published_at:Type.Union([Type.String(),Type.Null()])}))}),
  CommerceCatalogResponse:obj({enabled:Type.Boolean(),currency:Type.Literal('CNY'),version:id,model:Type.Literal('pay_as_you_go'),
    items:Type.Array(obj({code:id,label:text,unit:text,price_fen:amount,capability:Type.Union([Type.Literal('standard'),Type.Literal('limited'),Type.Literal('unavailable')]),scope:Type.Array(text),included:Type.Array(text)})),rules:Type.Array(text)}),
  CommerceAccountResponse:obj({available_fen:amount,held_fen:amount,payment_enabled:Type.Boolean(),providers:Type.Array(provider),legacy_balance_notice:text}),
  CommerceTopupRequest:obj({request_id:id,provider,amount_fen:Type.Integer({minimum:1,maximum:1000000}),project_id:Type.Optional(id)}),
  CommerceFeedbackRequest:obj({request_id:id,run_id:id,outcome:Type.Union([Type.Literal('adopted'),Type.Literal('needs_changes'),Type.Literal('not_used')]),reason:Type.Optional(Type.String({maxLength:1000}))}),
  CommerceFeedbackResponse:obj({ok:Type.Boolean()}),
};
export type CommerceCatalog=Static<typeof commerceSchemas.CommerceCatalogResponse>;
export type CommerceAccount=Static<typeof commerceSchemas.CommerceAccountResponse>;
export type CommerceTopup=Static<typeof commerceSchemas.CommerceTopupRequest>;
export function commerceMetadata(amountFen:number,unitAmountFen=amountFen,units=1):CommercePriceMetadata{
  if(![amountFen,unitAmountFen,units].every(Number.isSafeInteger)||amountFen<0||unitAmountFen<0||units<0)throw Error('Invalid CNY minor units');
  return{pricing_mode:OUTCOME_PRICING_MODE,currency:'CNY',amount_fen:amountFen,unit_amount_fen:unitAmountFen,units};
}
