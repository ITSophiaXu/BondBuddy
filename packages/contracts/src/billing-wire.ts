import {parseInt64,serializeInt64,safeBillingNumber,type Int64String} from './billing-integers.js';

/** Explicit transport capability. Price-policy versions remain independent. */
export const BILLING_WIRE_HEADER='x-bb-billing-format';
export const BILLING_WIRE_VERSION='int64-decimal-v1';
export const LEGACY_BILLING_WIRE_VERSION='number-v1';
export type BillingWireVersion=typeof BILLING_WIRE_VERSION|typeof LEGACY_BILLING_WIRE_VERSION;
const under=<P extends string,Q extends readonly string[]>(prefix:P,paths:Q):`${P}.${Q[number]}`[]=>paths.map(path=>`${prefix}.${path}` as `${P}.${Q[number]}`);

// These are semantic DTO paths, not a search/replace over arbitrary business JSON.
// In particular, document fields, page counts, revisions and dates are absent.
const pricing=['base_amount_fen','owned_coverage_fen','due_fen'] as const;
const scopeLine=['quantity','unit_price_fen','amount_fen',...under('pricing',pricing)] as const;
const commerce=['amount_fen','unit_amount_fen','units',...under('scope_lines.*',scopeLine)] as const;
const quote=['points',...commerce] as const;
const balance=['available','frozen'] as const;
const progress=['accrued_points','charged_points','released_points','available_points'] as const;
const charge=[...under('quote',quote),...under('progress',progress)] as const;
const m4Workspace=under('tasks.*.credit_charge',charge);
const period=['amount_fen','points','monthly_points','available_points','held_points','task_held_points','refund_held_points','face_amount_fen','change_held_points'] as const;
const subscription=['next_charge_amount_fen'] as const;
const subscriptionAccount=['available_points','held_points','task_held_points','refund_held_points','change_held_points','subscription_available_points','topup_available_points','other_available_points',...under('periods.*',period),...under('subscription',subscription)] as const;
const refund=['amount_fen','credit_points'] as const;
const qaRun=['reserved_points','charged_points',...commerce,...under('manifest',quote)] as const;
const integrityRun=['charged_points','reserved_points',...under('manifest',quote)] as const;
const fileCheck=['points',...commerce,'files.*.update_points'] as const;
const workpaperBatch=['total_points','charged_points','billing_resume.required_points','billing_resume.available_points','billing_resume.shortage'] as const;
const paidCheckBatch=['points','items.*.points','items.*.charged_points'] as const;
const assistantCard=[...under('quote',quote),...under('balance',balance)] as const;
const tokens=['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens'] as const;
const consumption=['attempts','measured_attempts','unresolved_attempts',...tokens] as const;
const trialUsage=['runs_created','runs_finished','run_duration_ms','attempts','measured_attempts','unresolved_attempts','model_call_duration_ms','conservative_tokens','upload_bytes',...under('measured_tokens',tokens)] as const;

export const BILLING_WIRE_DTOS={
  creditBalance:balance,
  fixedQuote:quote,
  fixedQuoteResponse:[...under('quote',quote),...under('balance',balance),'shortage'],
  creditCharge:charge,
  authoringProgress:progress,
  rechargeOrder:['amount_fen','points'],
  rechargeConfig:['packs.*.amount_fen','packs.*.points'],
  consumptionHistory:[...under('items.*',commerce),'items.*.reserved_points','items.*.charged_points','items.*.released_points','items.*.corrected_points'],
  rechargeHistory:['items.*.amount_fen','items.*.points',...under('items.*',commerce)],
  commerceMetadata:commerce,
  scopeQuotation:['amount_fen',...under('scope_lines.*',scopeLine)],
  scopeQuotationResponse:['quotation.amount_fen',...under('quotation.scope_lines.*',scopeLine)],
  scopeQuotationList:['items.*.amount_fen',...under('items.*.scope_lines.*',scopeLine)],
  commerceCatalog:['items.*.price_fen','items.*.price_points'],
  commerceAccount:['available_fen','held_fen','available_points','held_points'],
  topupRequest:['amount_fen'],
  subscriptionCatalog:['plans.*.amount_fen','plans.*.annual_amount_fen','plans.*.points'],
  subscriptionAccount,
  subscriptionCheckout:['order.amount_fen','order.points',...under('subscription',subscription)],
  subscription,
  subscriptionAutoRenew:under('subscription',subscription),
  refund,
  refundRequest:['amount_fen','points','expected_amount_fen'],
  refundEligibility:['order_amount_fen','original_points','paid_amount_fen','refundable_fen','held_refund_fen','refunded_fen','refundable_points','refunded_points',...under('refunds.*',refund)],
  m4QuoteResponse:[...under('quote',quote),...under('balance',balance),'shortage'],
  m4Workspace,
  qaQuote:quote,
  qaAnswerRequest:['expected_points'],
  qaRun,
  qaRunResponse:[], // The start response contains only run_id; financial fields are in workspace.runs.
  qaWorkspace:[...under('runs.*',qaRun),...under('price',quote)],
  integrityQuote:quote,
  integrityRunRequest:['expected_points'],
  integrityRun,
  integrityRunResponse:[], // The start response contains only run_id.
  integrityWorkspace:[...under('rounds.*',integrityRun),...under('price',quote)],
  projectFileBatchRequest:['expected_points'],
  projectFileBatchQuote:['points',...under('documents.*',quote)],
  projectFileCheckRequest:['expected_points'],
  projectFileCheckQuote:quote,
  projectFileUpdateRequest:['expected_points'],
  projectFileUpdateQuote:['points',...under('items.*',quote)],
  projectFileCheck:fileCheck,
  projectFileCheckResponse:under('check',fileCheck),
  projectFileChecks:under('checks.*',fileCheck),
  projectFileWorkspace:[...under('workspace',m4Workspace),...under('price',quote)],
  workpaperStart:['expected_points'],
  workpaperAction:['expected_points'],
  workpaperBatch,
  workpaperWorkspace:[...under('batches.*',workpaperBatch),'price.points'],
  workpaperPaidCheckRequest:['expected_points'],
  workpaperPaidCheckQuote:['points',...under('items.*',quote)],
  workpaperPaidCheckBatch:paidCheckBatch,
  workpaperPaidCheckBatches:under('batches.*',paidCheckBatch),
  workpaperLibrary:under('paid_checks.*',paidCheckBatch),
  assistantCard,
  assistantCardResponse:under('card',assistantCard),
  assistantCardList:under('cards.*',assistantCard),
  adminJobTimeline:['job.attempts',...under('attempts.*.usage',tokens),...under('consumption.all_attempts',consumption),...under('consumption.completed_attempts',consumption)],
  adminMetrics:['operations.submitted','operations.rejected','jobs.total','jobs.succeeded','jobs.failed','jobs.cancelled','jobs.rejected','jobs.other',
    'attempts.total','attempts.completed','attempts.failed','attempts.pending_reconcile','attempts.confirmed_not_sent','attempts.conflict',
    ...under('consumption.all_attempts',consumption),...under('consumption.completed_attempts',consumption),...under('consumption.retry_attempts',consumption),
    'by_model.*.attempts','by_model.*.completed','by_model.*.failed',...under('by_model.*',tokens),'errors.*.count'],
  adminUsageCorrection:under('usage',tokens),
  adminTrialUsage:[...under('per_user.*',trialUsage),...under('totals.*',trialUsage)],
  adminCostLedger:[...under('items.*',tokens),'items.*.conservative_tokens'],
  adminErrors:['items.*.count'],
} as const satisfies Record<string,readonly string[]>;
export type BillingWireDtoName=keyof typeof BILLING_WIRE_DTOS;
type Descendant<P extends string,K extends string>=P extends `${K}.${infer Rest}`?Rest:never;
export type Int64AtPaths<T,P extends string>=T extends null|undefined?T:
  '' extends P?T extends number|bigint|string?Int64String:T:
  T extends readonly (infer U)[]?Int64AtPaths<U,Descendant<P,'*'>>[]:
  T extends object?{[K in keyof T]:K extends string?Int64AtPaths<T[K],K extends P?'':Descendant<P,K>>:T[K]}:T;
export type BillingWireDto<T,F extends BillingWireDtoName>=Int64AtPaths<T,typeof BILLING_WIRE_DTOS[F][number]>;

function mapPath(value:unknown,parts:readonly string[],map:(value:unknown)=>unknown):unknown{
  if(value===null||value===undefined)return value;
  if(parts.length===0)return map(value);
  const [key,...rest]=parts;
  if(key==='*'){
    if(!Array.isArray(value))throw new TypeError('Billing DTO wildcard requires an array');
    return value.map(item=>mapPath(item,rest,map));
  }
  if(typeof value!=='object'||Array.isArray(value))throw new TypeError('Billing DTO path requires an object');
  if(!Object.hasOwn(value,key))return value;
  return {...value,[key]:mapPath((value as Record<string,unknown>)[key],rest,map)};
}
/** Clones changed branches and never edits an immutable stored manifest/hash input. */
export function transformBillingDto(value:unknown,paths:readonly string[],map:(value:unknown)=>unknown):unknown{
  let result=value;for(const path of new Set(paths))result=mapPath(result,path.split('.'),map);return result;
}
export function encodeBillingDto<T,F extends BillingWireDtoName>(family:F,value:T):BillingWireDto<T,F>{
  return transformBillingDto(value,BILLING_WIRE_DTOS[family],serializeInt64) as BillingWireDto<T,F>;
}
/** Must run on raw parsed JSON before Fastify/AJV can coerce a number into text. */
export function validateBillingDto(family:BillingWireDtoName,value:unknown):void{
  transformBillingDto(value,BILLING_WIRE_DTOS[family],v=>{parseInt64(v);return v;});
}
/** Only for bounded legacy domain request fields; original route schema still applies its business limits. */
export function decodeLegacyBillingRequest<T>(family:BillingWireDtoName,value:unknown):T{
  validateBillingDto(family,value);
  return transformBillingDto(value,BILLING_WIRE_DTOS[family],v=>safeBillingNumber(parseInt64(v))) as T;
}

/** Patch only the declared monetary leaves of a JSON schema, including nullable/union branches. */
export function billingDtoSchema(schema:unknown,family:BillingWireDtoName,integerSchema:Record<string,unknown>):unknown{
 const visit=(node:any,parts:string[]):any=>{
   if(!node||typeof node!=='object')return node;
   if(parts.length===0){
    if(node.type==='null')return node;
    for(const union of ['anyOf','oneOf'])if(Array.isArray(node[union]))return {...node,[union]:node[union].map((branch:any)=>visit(branch,parts))};
    return {...integerSchema,...(node.description?{description:node.description}:{})};
   }
   const next={...node};for(const union of ['anyOf','oneOf','allOf'])if(Array.isArray(node[union]))next[union]=node[union].map((branch:any)=>visit(branch,parts));
   const [key,...rest]=parts;
   if(key==='*'&&node.items)next.items=visit(node.items,rest);
   else if(node.properties?.[key])next.properties={...node.properties,[key]:visit(node.properties[key],rest)};
   return next;
 };
 let result=schema;for(const path of new Set(BILLING_WIRE_DTOS[family]))result=visit(result,path.split('.'));return result;
}
