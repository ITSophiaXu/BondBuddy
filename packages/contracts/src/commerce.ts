import {Type,type Static,type TSchema} from '@sinclair/typebox';
import {OUTCOME_PRICE_VERSION,OUTCOME_RATE_CARD,OUTCOME_PRICE_LABELS,OutcomePriceVersionSchema,OutcomePricingExplanationSchema,type OutcomePriceVersion} from './outcome-pricing.js';
export {OUTCOME_PRICE_VERSION,LEGACY_OUTCOME_PRICE_VERSION,OutcomePriceVersionSchema,isOutcomePriceVersion} from './outcome-pricing.js';

/** Compatibility wallet mode; price_version separately pins the original v1 or current v2 rules. */
export const OUTCOME_PRICING_MODE='outcome_cny_v1' as const;
export const OUTCOME_PRICES=OUTCOME_RATE_CARD;
export type OutcomeProduct=keyof typeof OUTCOME_PRICES;
const obj=<T extends Record<string,TSchema>>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const amount=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
const text=Type.String({maxLength:2000});
const provider=Type.Union([Type.Literal('wechat'),Type.Literal('alipay')]);
export const ScopeLineSchema=obj({key:id,label:Type.String({minLength:1,maxLength:200}),quantity:Type.Integer({minimum:1,maximum:100000}),unit:Type.String({minLength:1,maxLength:40}),unit_price_fen:Type.Integer({minimum:0,maximum:100000000}),amount_fen:amount,evidence:Type.Array(Type.String({minLength:1,maxLength:1000}),{minItems:1,maxItems:50}),pricing:Type.Optional(OutcomePricingExplanationSchema)});
export type ScopeLine=Static<typeof ScopeLineSchema>;
export const ScopeQuoteStatusSchema=Type.Union([Type.Literal('pending_scope'),Type.Literal('ready'),Type.Literal('unavailable'),Type.Literal('declined'),Type.Literal('expired')]);
export type ScopeQuoteStatus=Static<typeof ScopeQuoteStatusSchema>;
export const ScopeQuotationSchema=obj({id,project_id:id,action:id,input_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),price_version:Type.Optional(OutcomePriceVersionSchema),quote_status:ScopeQuoteStatusSchema,amount_fen:amount,scope_lines:Type.Array(ScopeLineSchema),reason:text,created_at:Type.String(),published_at:Type.Union([Type.String(),Type.Null()]),expires_at:Type.Union([Type.String(),Type.Null()]),closed_at:Type.Union([Type.String(),Type.Null()]),decline_reason:Type.String({maxLength:1000}),closure_reason:text,revision:Type.Integer({minimum:1}),previous_quote_id:Type.Union([id,Type.Null()])});
export const CommerceMetadataFields={
  pricing_mode:Type.Optional(Type.Literal(OUTCOME_PRICING_MODE)),
  price_version:Type.Optional(id),
  currency:Type.Optional(Type.Literal('CNY')),
  amount_fen:Type.Optional(amount),
  unit_amount_fen:Type.Optional(amount),
  units:Type.Optional(Type.Integer({minimum:0,maximum:100000})),
  scope_quote_id:Type.Optional(id),
  quote_status:Type.Optional(ScopeQuoteStatusSchema),
  scope_expires_at:Type.Optional(Type.Union([Type.String(),Type.Null()])),
  scope_lines:Type.Optional(Type.Array(ScopeLineSchema,{maxItems:200})),
};
export const CommercePriceMetadataSchema=obj(CommerceMetadataFields);
export type CommercePriceMetadata=Static<typeof CommercePriceMetadataSchema>;
export const OUTCOME_CATALOG=[
  {code:'fact_reply',label:OUTCOME_PRICE_LABELS.fact_reply,unit:'事项',price_fen:OUTCOME_PRICES.fact_reply,capability:'limited',scope:['一个去重后的回应目标，复用已确认事实组织回复'],included:['基本来源核对、引用、回复稿及原范围补证纠错']},
  {code:'fact_revision',label:OUTCOME_PRICE_LABELS.fact_revision,unit:'事项',price_fen:OUTCOME_PRICES.fact_revision,capability:'limited',scope:['一个事实或业务变化在一份锁定募集书内完整落地'],included:['同目标对应回复、所有必要传播、双Word与原范围修正']},
  {code:'calculation_reply',label:OUTCOME_PRICE_LABELS.calculation_reply,unit:'事项',price_fen:OUTCOME_PRICES.calculation_reply,capability:'limited',scope:['一个需新增调查性核对或关联计算的回应目标'],included:['同目标回复及一份锁定募集书的必要落地，不叠低档费']},
  {code:'argument_revision',label:OUTCOME_PRICE_LABELS.argument_revision,unit:'目标',price_fen:OUTCOME_PRICES.argument_revision,capability:'limited',scope:['一个事先列明的实质论证目标'],included:['必要核对计算、对应回复及一份锁定募集书的必要落地']},
  {code:'argument_reply',label:OUTCOME_PRICE_LABELS.argument_reply,unit:'事项',price_fen:OUTCOME_PRICES.argument_reply,capability:'limited',scope:['一个需新增实质解释或规范论证的回应目标'],included:['必要核对计算、对应回复及一份锁定募集书的必要落地']},
  {code:'new_disclosure',label:OUTCOME_PRICE_LABELS.new_disclosure,unit:'目标',price_fen:OUTCOME_PRICES.new_disclosure,capability:'limited',scope:['公开目录中一个独立新增披露目标，按实际剩余工作归类'],included:['必要引用计算、约定成果及必要主稿同步，同成果不叠模板费']},
  {code:'period',label:OUTCOME_PRICE_LABELS.period,unit:'新增主要期',price_fen:OUTCOME_PRICES.period,capability:'limited',scope:['一个新增主要年度或中期；必要比较列不算新主期'],included:['合并及母公司披露、比较信息、缺口补建、历史对齐、必要重述及全文传播']},
  {code:'financial_group',label:OUTCOME_PRICE_LABELS.financial_group,unit:'发行人—目标期间组',price_fen:OUTCOME_PRICES.financial_group,capability:'limited',scope:['同一财务事实快照、目标会计基础，最多三个年度及一个最新中期','作为同组完整交付价格与增量累计上限'],included:['有效已购主期持续复用；必要比较、补建、对齐及重述，不叠同组期间价']},
  {code:'financial_restatement',label:OUTCOME_PRICE_LABELS.financial_restatement,unit:'独立委托目标',price_fen:OUTCOME_PRICES.financial_restatement,capability:'limited',scope:['本次期间更新及完整财务组之外，另行委托且可独立验收的重构成果'],included:['该目标必要的来源、受影响比较期与解释；本组必要重述不属此收费项']},
  {code:'template',label:OUTCOME_PRICE_LABELS.template,unit:'独立成果',price_fen:OUTCOME_PRICES.template,capability:'limited',scope:['仅将已有确认事实应用到一个已开放标准模板'],included:['约定成果与原范围修正；共享分析不重新销售']},
  {code:'check',label:OUTCOME_PRICE_LABELS.check,unit:'固定版本及覆盖',price_fen:OUTCOME_PRICES.check,capability:'limited',scope:['一份关联文件对照锁定募集书的明确基础字段范围'],included:['定位报告及相同有效范围结果复用；不等于财务或法律实质复核']},
  {code:'sync',label:OUTCOME_PRICE_LABELS.sync,unit:'固定版本及覆盖',price_fen:OUTCOME_PRICES.sync,capability:'limited',scope:['基础一致性检查并按准确依据修订约定差异'],included:['同范围已买9.9元检查只补10元，累计19.9元；双Word不另计']},
  {code:'review',label:OUTCOME_PRICE_LABELS.review,unit:'标准财务组',price_fen:OUTCOME_PRICES.review,capability:'limited',scope:['所选标准财务组版本的来源对应、勾稽、期间单位及约定财务叙述'],included:['定位问题与实际覆盖清单；不含任意全文法律合规结论或人工签审']},
  {code:'integrity_check',label:'诚信核查：待明确范围及价格',unit:'待报价',price_fen:null,capability:'unavailable',scope:['当前未标定标准价，不能按免费或旧50元标签执行'],included:[]},
] as const;
export const COMMERCE_RULES=[
  '按明确成果付费，无强制订阅、月最低消费或大额充值要求。',
  '由受信服务确认业务目标、期间及成果覆盖，再按公开工作包合价；尚未实现自动语义范围识别。',
  '开始前核对本单处理范围、工作项明细和人民币总价；范围报价待确认时不能收费执行。预留全价，交付结算，未交付部分释放。',
  '主动检查与独立复核收费；生成内部核对、原范围澄清、平台纠错和重试包含在原价。',
  '同版本已付检查后修订只补差额；新事实、新期间或独立新增范围另行确认。',
  '同目标9.8、39、99元按有效合同覆盖补差；原范围漏估、补证与纠错为0元。',
  '249元更新包含必要比较、补建、对齐及重述；同一财务事实快照及标准目标组累计不超过499元。',
  '地址、项目名、文件hash或另购回复不重置财务封顶；真正新增财务目标只计算真实增量。',
  '共享分析先复用，新增独立成果按剩余工作归类；未知范围和未标定项目不能按0元或低档执行。',
  '充值形成可用服务余额，未消费金额不是任务收入；旧任务保留提交时规则。',
  '生成内容为工作稿，显示实际覆盖与待确认项，由用户审阅后采用。',
] as const;
export const commerceSchemas={
  CommerceScopeQuotationsResponse:obj({items:Type.Array(ScopeQuotationSchema)}),
  CommerceScopeQuotationResponse:obj({quotation:ScopeQuotationSchema}),
  CommerceScopeDeclineRequest:obj({request_id:id,reason:Type.String({minLength:1,maxLength:1000})}),
  CommerceScopeRequoteRequest:obj({request_id:id}),
  CommerceCatalogResponse:obj({enabled:Type.Boolean(),currency:Type.Literal('CNY'),version:id,model:Type.Literal('pay_as_you_go'),
    items:Type.Array(obj({code:id,label:text,unit:text,price_fen:Type.Union([amount,Type.Null()]),capability:Type.Union([Type.Literal('standard'),Type.Literal('limited'),Type.Literal('unavailable')]),scope:Type.Array(text),included:Type.Array(text)})),rules:Type.Array(text)}),
  CommerceAccountResponse:obj({available_fen:amount,held_fen:amount,payment_enabled:Type.Boolean(),providers:Type.Array(provider),legacy_balance_notice:text}),
  CommerceTopupRequest:obj({request_id:id,provider,amount_fen:Type.Integer({minimum:1,maximum:1000000}),project_id:Type.Optional(id)}),
  CommerceFeedbackRequest:obj({request_id:id,run_id:id,outcome:Type.Union([Type.Literal('adopted'),Type.Literal('needs_changes'),Type.Literal('not_used')]),reason:Type.Optional(Type.String({maxLength:1000}))}),
  CommerceFeedbackResponse:obj({ok:Type.Boolean()}),
};
export type CommerceCatalog=Static<typeof commerceSchemas.CommerceCatalogResponse>;
export type CommerceAccount=Static<typeof commerceSchemas.CommerceAccountResponse>;
export type CommerceTopup=Static<typeof commerceSchemas.CommerceTopupRequest>;
export function commerceMetadata(amountFen:number,unitAmountFen=amountFen,units=1,priceVersion:OutcomePriceVersion=OUTCOME_PRICE_VERSION):CommercePriceMetadata{
  if(![amountFen,unitAmountFen,units].every(Number.isSafeInteger)||amountFen<0||unitAmountFen<0||units<0)throw Error('Invalid CNY minor units');
  return{pricing_mode:OUTCOME_PRICING_MODE,price_version:priceVersion,currency:'CNY',amount_fen:amountFen,unit_amount_fen:unitAmountFen,units};
}
