import {billingDtoSchema,BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION,type BillingWireDtoName} from './billing-wire.js';
import {Int64Schema} from './billing-integers.js';

export type BillingReplayKind='run'|'qa'|'integrity'|'fileCheck'|'fileBatch'|'fileUpdate'|'workpaper'|'workpaperResume'|'workpaperCheck'|'m4Run'|'m4Message'|'topup'|'refund'|'subscription';
export type BillingWireRoute={request?:BillingWireDtoName;response?:BillingWireDtoName;replay?:BillingReplayKind};
/** Explicit URL families shared by HTTP hooks and typed clients. No document JSON heuristics. */
export function billingWireRoute(method:string,url:string):BillingWireRoute|undefined{
 const p=url.replace(/^\/api\/v1/,'').split('?')[0],post=method.toUpperCase()==='POST';
 if(p==='/credits/balance')return{response:'creditBalance'};
 if(p==='/credits/consumption-history')return{response:'consumptionHistory'};
 if(p==='/credits/recharge-history')return{response:'rechargeHistory'};
 if(p==='/credits/recharge-config')return{response:'rechargeConfig'};
 if(/^\/credits\/recharge-orders(?:\/[^/]+(?:\/(?:refresh|close))?)?$/.test(p))return{response:'rechargeOrder',...(post&&p==='/credits/recharge-orders'?{replay:'topup' as const}:{})};
 if(/^\/runs\/[^/]+\/credit-charge$/.test(p))return{response:'creditCharge'};
 if(p==='/runs/execute'&&post)return{replay:'run'};
 if(/^\/projects\/[^/]+\/(?:credit-quote|review-(?:executions|updates)\/quote)$/.test(p))return{response:'fixedQuoteResponse'};
 if(/^\/projects\/[^/]+\/review-(?:executions|updates)$/.test(p)&&post)return{replay:'run'};
 if(p==='/commerce/catalog')return{response:'commerceCatalog'};
 if(p==='/commerce/account')return{response:'commerceAccount'};
 if(p==='/commerce/quotations')return{response:'scopeQuotationList'};
 if(/^\/commerce\/quotations\/[^/]+(?:\/(?:decline|requote))?$/.test(p))return{response:'scopeQuotationResponse'};
 if(p==='/commerce/topups'&&post)return{request:'topupRequest',response:'rechargeOrder',replay:'topup'};
 if(/^\/commerce\/topups\/[^/]+(?:\/refresh)?$/.test(p))return{response:'rechargeOrder'};
 if(/^\/commerce\/topups\/[^/]+\/refund-eligibility$/.test(p))return{response:'refundEligibility'};
 if(/^\/commerce\/topups\/[^/]+\/refunds$/.test(p)&&post)return{request:'refundRequest',response:'refund',replay:'refund'};
 if(/^\/commerce\/refunds\/[^/]+(?:\/refresh)?$/.test(p))return{response:'refund'};
 if(p==='/subscriptions/catalog')return{response:'subscriptionCatalog'};
 if(p==='/subscriptions/account')return{response:'subscriptionAccount'};
 if((p==='/subscriptions'||/^\/subscriptions\/[^/]+\/renew$/.test(p))&&post)return{response:'subscriptionCheckout',replay:'subscription'};
 if(/^\/subscriptions\/[^/]+\/cancel$/.test(p)&&post)return{response:'subscription'};
 if(/^\/subscriptions\/[^/]+\/auto-renew(?:\/refresh)?$/.test(p)&&post)return{response:'subscriptionAutoRenew'};
 if(/^\/m4\/topics\/[^/]+\/workspace$/.test(p))return{response:'m4Workspace'};
 if(/^\/m4\/topics\/[^/]+\/quote$/.test(p))return{response:'m4QuoteResponse'};
 if(/^\/m4\/topics\/[^/]+\/execute$/.test(p)&&post)return{replay:'m4Run'};
 if(/^\/m4\/topics\/[^/]+\/messages$/.test(p)&&post)return{replay:'m4Message'};
 if(/^\/assistant\/topics\/[^/]+\/cards$/.test(p))return{response:post?'assistantCardResponse':'assistantCardList'};
 if(/^\/projects\/[^/]+\/qa(?:\/draft)?$/.test(p))return{response:'qaWorkspace'};
 if(/^\/projects\/[^/]+\/qa\/quote$/.test(p))return{response:'qaQuote'};
 if(/^\/projects\/[^/]+\/qa\/prepare$/.test(p))return{response:'qaRunResponse'};
 if(/^\/projects\/[^/]+\/qa\/runs$/.test(p)&&post)return{request:'qaAnswerRequest',response:'qaRunResponse',replay:'qa'};
 if(/^\/projects\/[^/]+\/integrity(?:\/draft|\/runs\/[^/]+\/evidence)?$/.test(p))return{response:'integrityWorkspace'};
 if(/^\/projects\/[^/]+\/integrity\/quote$/.test(p))return{response:'integrityQuote'};
 if(/^\/projects\/[^/]+\/integrity\/runs$/.test(p)&&post)return{request:'integrityRunRequest',response:'integrityRunResponse',replay:'integrity'};
 if(/^\/projects\/[^/]+\/integrity\/runs\/[^/]+\/exports$/.test(p))return{response:'integrityRunResponse'};
 if(/^\/projects\/[^/]+\/project-files\/workspace$/.test(p))return{response:'projectFileWorkspace'};
 if(/^\/projects\/[^/]+\/project-files\/batches\/quote$/.test(p))return{request:'projectFileBatchRequest',response:'projectFileBatchQuote'};
 if(/^\/projects\/[^/]+\/project-files\/batches$/.test(p)&&post)return{request:'projectFileBatchRequest',replay:'fileBatch'};
 if(/^\/projects\/[^/]+\/project-files\/checks\/quote$/.test(p))return{request:'projectFileCheckRequest',response:'projectFileCheckQuote'};
 if(/^\/projects\/[^/]+\/project-files\/checks$/.test(p))return post?{request:'projectFileCheckRequest',replay:'fileCheck'}:{response:'projectFileChecks'};
 if(/^\/projects\/[^/]+\/project-files\/(?:checks\/[^/]+|updates\/[^/]+\/check)$/.test(p))return{response:'projectFileCheckResponse'};
 if(/^\/projects\/[^/]+\/project-files\/checks\/[^/]+\/updates\/quote$/.test(p))return{response:'projectFileUpdateQuote'};
 if(/^\/projects\/[^/]+\/project-files\/checks\/[^/]+\/updates$/.test(p)&&post)return{request:'projectFileUpdateRequest',replay:'fileUpdate'};
 if(/^\/projects\/[^/]+\/workpapers$/.test(p))return{response:'workpaperWorkspace'};
 if(/^\/projects\/[^/]+\/workpapers\/library$/.test(p))return{response:'workpaperLibrary'};
 if(/^\/projects\/[^/]+\/workpapers\/batches$/.test(p)&&post)return{request:'workpaperStart',response:'workpaperBatch',replay:'workpaper'};
 if(/^\/projects\/[^/]+\/workpapers\/batches\/[^/]+$/.test(p))return{response:'workpaperBatch'};
 if(/^\/projects\/[^/]+\/workpapers\/batches\/[^/]+\/actions$/.test(p)&&post)return{request:'workpaperAction',response:'workpaperBatch',replay:'workpaperResume'};
 if(/^\/projects\/[^/]+\/workpapers\/check-batches\/quote$/.test(p))return{request:'workpaperPaidCheckRequest',response:'workpaperPaidCheckQuote'};
 if(/^\/projects\/[^/]+\/workpapers\/check-batches$/.test(p))return post?{request:'workpaperPaidCheckRequest',response:'workpaperPaidCheckBatch',replay:'workpaperCheck'}:{response:'workpaperPaidCheckBatches'};
 if(/^\/projects\/[^/]+\/workpapers\/check-batches\/[^/]+$/.test(p))return{response:'workpaperPaidCheckBatch'};
 if(p==='/admin/metrics')return{response:'adminMetrics'};
 if(p==='/admin/trial/usage')return{response:'adminTrialUsage'};
 if(p==='/admin/trial/cost-ledger')return{response:'adminCostLedger'};
 if(p==='/admin/errors')return{response:'adminErrors'};
 if(/^\/admin\/jobs\/[^/]+\/timeline$/.test(p))return{response:'adminJobTimeline'};
 if(/^\/admin\/attempts\/[^/]+\/usage-corrections$/.test(p))return{response:'adminUsageCorrection'};
 return undefined;
}

/** Independent wire components preserve original domain/persisted-manifest schemas. */
export function transformBillingOpenApi<T extends {paths:Record<string,Record<string,unknown>>;components:{schemas:Record<string,unknown>}}>(original:T):T{
 const document=structuredClone(original),schemas=document.components.schemas;
 const expand=(value:any,stack:string[]=[]):any=>{
  if(Array.isArray(value))return value.map(v=>expand(v,stack));
  if(!value||typeof value!=='object')return value;
  if(typeof value.$ref==='string'&&value.$ref.startsWith('#/components/schemas/')){
   const name=value.$ref.slice('#/components/schemas/'.length);if(stack.includes(name))return value;
   if(schemas[name])return expand(schemas[name],[...stack,name]);
  }
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,expand(v,stack)]));
 };
 const wire=(schema:any,family:BillingWireDtoName)=>{
  const source=typeof schema?.$ref==='string'?schema.$ref.split('/').at(-1):undefined;
  const transformed=billingDtoSchema(expand(schema),family,Int64Schema);
  if(!source)return transformed;
  const name='BillingInt64_'+source+'_'+family;schemas[name]=transformed;return {$ref:'#/components/schemas/'+name};
 };
 for(const [url,methods] of Object.entries(document.paths))for(const [method,raw] of Object.entries(methods)){
  const family=billingWireRoute(method,url);if(!family||!raw||typeof raw!=='object')continue;
  const operation=raw as any;
  operation.parameters=[...(operation.parameters??[]).filter((p:any)=>!(p.in==='header'&&p.name===BILLING_WIRE_HEADER)),{in:'header',name:BILLING_WIRE_HEADER,required:false,
   schema:{type:'string',enum:[BILLING_WIRE_VERSION,LEGACY_BILLING_WIRE_VERSION],default:BILLING_WIRE_VERSION},
   description:'Defaults to exact int64 decimal strings. number-v1 is for checked legacy reads and persisted identical-request replay only; it cannot create a new financial write.'}];
  const body=operation.requestBody?.content?.['application/json'];if(family.request&&body?.schema)body.schema=wire(body.schema,family.request);
  for(const [status,response] of Object.entries(operation.responses??{})){
   const content=(response as any)?.content?.['application/json'];if(/^2/.test(status)&&family.response&&content?.schema)content.schema=wire(content.schema,family.response);
  }
 }
 return document;
}
