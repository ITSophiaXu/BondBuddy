import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {AUTOMATIC_PRICE_VERSION,PREVIOUS_AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,MANAGED_AUTOMATIC_PRICE_PATTERN,isAutomaticPriceVersion,type AutomaticPriceVersion} from './automatic-pricing.js';
import type {ScopeLine} from './commerce.js';

export const LEGACY_OUTCOME_PRICE_VERSION='outcome-cny-20261028-v1' as const;
export const OUTCOME_PRICE_VERSION='outcome-cny-20261028-v2' as const;
export const OutcomePriceVersionSchema=Type.Union([Type.Literal(LEGACY_OUTCOME_PRICE_VERSION),Type.Literal(OUTCOME_PRICE_VERSION),Type.Literal(LEGACY_AUTOMATIC_PRICE_VERSION),Type.Literal(PREVIOUS_AUTOMATIC_PRICE_VERSION),Type.Literal(AUTOMATIC_PRICE_VERSION),Type.Unsafe<AutomaticPriceVersion>(Type.String({pattern:MANAGED_AUTOMATIC_PRICE_PATTERN}))]);
export type OutcomePriceVersion=Static<typeof OutcomePriceVersionSchema>;
export const isOutcomePriceVersion=(value:unknown):value is OutcomePriceVersion=>value===OUTCOME_PRICE_VERSION||value===LEGACY_OUTCOME_PRICE_VERSION||isAutomaticPriceVersion(value);

/** Trial-03 business units, in integer CNY fen. This is not a semantic scope recognizer. */
export const OUTCOME_RATE_CARD={fact_reply:980,fact_revision:3900,calculation_reply:3900,argument_revision:9900,argument_reply:9900,new_disclosure:9900,period:24900,financial_restatement:24900,financial_group:49900,template:1990,check:990,sync:1990,review:14900} as const;
export type OutcomePriceKey=keyof typeof OUTCOME_RATE_CARD;
export const OUTCOME_PRICE_LABELS:Record<OutcomePriceKey,string>={fact_reply:'直接事实回复',fact_revision:'事实或业务事项修订',calculation_reply:'核对或计算回复',argument_revision:'同事项实质论证',argument_reply:'独立论证回复',new_disclosure:'独立新披露',period:'报告期更新',financial_restatement:'包外独立重构成果',financial_group:'完整财务披露组',template:'标准模板应用',check:'基础一致性检查',sync:'检查并修订',review:'独立财务组复核'};

export type GoalOutcomePriceKey='fact_reply'|'fact_revision'|'calculation_reply'|'argument_revision'|'argument_reply'|'new_disclosure'|'check'|'sync';
export type IndependentOutcomePriceKey=Exclude<OutcomePriceKey,'period'|'financial_group'>;
/** Resolved by the trusted service: owned, valid contract coverage, not arbitrary money credit. */
export type OutcomeOwnedCoverage={id:string;coverage_key:string;price_key:OutcomePriceKey;period_keys?:string[];complete_group?:boolean};
type ItemBase={key:string;coverage_key:string;label?:string;evidence:string[]};
export type OutcomePricingItem=ItemBase&(
  |{family:'goal_upgrade';price_key:GoalOutcomePriceKey}
  |{family:'financial_group';main_period_keys:string[];annual_main_periods:number;interim_main_periods:number;requires_complete_group_build?:boolean;necessary_restatement?:boolean}
  |{family:'independent_output';price_key:IndependentOutcomePriceKey}
  |{family:'included';owned_coverage_id:string;reason:string}
);
/** coverage_key is a trusted business identity, never an input hash or a client authorization. */
export type OutcomeWorkPlan={scope_status:'confirmed'|'unknown'|'unsupported';items:OutcomePricingItem[]};
export type OutcomePricingInput=OutcomeWorkPlan&{owned_coverage?:OutcomeOwnedCoverage[]};
export type OutcomePricingExplanation={base_amount_fen:number;owned_coverage_fen:number;due_fen:number;reason:string};
export type OutcomePricingItemResult=OutcomePricingExplanation&{key:string;coverage_key:string;family:OutcomePricingItem['family'];price_key?:OutcomePriceKey;period_keys?:string[];complete_group?:boolean;owned_coverage_ids:string[]};
export type OutcomePricingResult={status:'ready'|'pending_scope'|'unavailable';price_version:typeof OUTCOME_PRICE_VERSION;amount_fen:number|null;scope_lines:ScopeLine[];pricing_items:OutcomePricingItemResult[];reason:string};

const schemaText=(maxLength:number)=>Type.String({minLength:1,maxLength});
const schemaId=schemaText(128),schemaCoverageKey=schemaText(500);
const schemaPeriods=Type.Array(schemaText(200),{maxItems:30,uniqueItems:true});
const schemaPriceKey=Type.Union(Object.keys(OUTCOME_RATE_CARD).map(key=>Type.Literal(key)));
const schemaBase={key:schemaId,coverage_key:schemaCoverageKey,label:Type.Optional(schemaText(200)),evidence:Type.Array(schemaText(1000),{minItems:1,maxItems:50})};
const schemaObject=<T extends Record<string,import('@sinclair/typebox').TSchema>>(properties:T)=>Type.Object(properties,{additionalProperties:false});
export const OutcomePricingItemSchema=Type.Union([
  schemaObject({...schemaBase,family:Type.Literal('goal_upgrade'),price_key:Type.Union(['fact_reply','fact_revision','calculation_reply','argument_revision','argument_reply','new_disclosure','check','sync'].map(key=>Type.Literal(key)))}),
  schemaObject({...schemaBase,family:Type.Literal('financial_group'),main_period_keys:schemaPeriods,annual_main_periods:Type.Integer({minimum:0,maximum:30}),interim_main_periods:Type.Integer({minimum:0,maximum:30}),requires_complete_group_build:Type.Optional(Type.Boolean()),necessary_restatement:Type.Optional(Type.Boolean())}),
  schemaObject({...schemaBase,family:Type.Literal('independent_output'),price_key:Type.Union(Object.keys(OUTCOME_RATE_CARD).filter(key=>key!=='period'&&key!=='financial_group').map(key=>Type.Literal(key)))}),
  schemaObject({...schemaBase,family:Type.Literal('included'),owned_coverage_id:schemaId,reason:schemaText(1000)}),
]);
export const OutcomeOwnedCoverageSchema=schemaObject({id:schemaId,coverage_key:schemaCoverageKey,price_key:schemaPriceKey,period_keys:Type.Optional(schemaPeriods),complete_group:Type.Optional(Type.Boolean())});
const schemaPlan={scope_status:Type.Union([Type.Literal('confirmed'),Type.Literal('unknown'),Type.Literal('unsupported')]),items:Type.Array(OutcomePricingItemSchema,{maxItems:200})};
/** Public work plans cannot supply ownership. The trusted service injects that separately. */
export const OutcomeWorkPlanSchema=schemaObject(schemaPlan);
export const OutcomePricingInputSchema=schemaObject({...schemaPlan,owned_coverage:Type.Optional(Type.Array(OutcomeOwnedCoverageSchema,{maxItems:10000}))});
const schemaAmount=Type.Integer({minimum:0,maximum:100000000});
export const OutcomePricingExplanationSchema=schemaObject({base_amount_fen:schemaAmount,owned_coverage_fen:schemaAmount,due_fen:schemaAmount,reason:schemaText(1000)});

export class OutcomePricingInputError extends Error{readonly code='INVALID_OUTCOME_PRICING_INPUT';constructor(message:string){super(message);}}
function fail(message:string):never{throw new OutcomePricingInputError(message);}
const text=(value:unknown,max=500):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const priceKey=(value:unknown):value is OutcomePriceKey=>typeof value==='string'&&Object.hasOwn(OUTCOME_RATE_CARD,value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
const goalFamily=(key:OutcomePriceKey)=>key==='check'||key==='sync'?'check':(['fact_reply','fact_revision','calculation_reply','argument_revision','argument_reply','new_disclosure'].includes(key)?'goal':null);
const periodKeys=(keys:unknown):keys is string[]=>Array.isArray(keys)&&keys.every(key=>text(key,200))&&new Set(keys).size===keys.length;
const pending=(status:'pending_scope'|'unavailable',reason:string):OutcomePricingResult=>({status,price_version:OUTCOME_PRICE_VERSION,amount_fen:null,scope_lines:[],pricing_items:[],reason});

/** Pure arithmetic only. The caller must establish scope, ownership and coverage validity. */
export function calculateOutcomePrice(input:OutcomePricingInput):OutcomePricingResult{
  if(!Value.Check(OutcomePricingInputSchema,input))fail('Invalid pricing input contract');
  if(input.scope_status==='unknown')return pending('pending_scope','业务范围尚未确认，不能按低档收费执行。');
  if(input.scope_status==='unsupported')return pending('unavailable','范围超出当前标准目录，须先明确可交付范围与总价。');
  if(input.scope_status!=='confirmed'||!Array.isArray(input.items)||input.items.length>200)fail('Invalid confirmed pricing scope');
  const owned=input.owned_coverage??[];
  if(!Array.isArray(owned))fail('Invalid owned coverage');
  const receiptIds=new Set<string>();
  for(const coverage of owned){
    if(!text(coverage.id,128)||receiptIds.has(coverage.id)||!text(coverage.coverage_key)||!priceKey(coverage.price_key)||coverage.period_keys!==undefined&&!periodKeys(coverage.period_keys)||coverage.complete_group!==undefined&&typeof coverage.complete_group!=='boolean')fail('Invalid or duplicate owned coverage');
    receiptIds.add(coverage.id);
  }
  const groups=new Map<string,OutcomePricingItem[]>(),keys=new Set<string>();
  for(const item of input.items){
    if(!text(item.key,128)||keys.has(item.key)||!text(item.coverage_key)||item.label!==undefined&&!text(item.label,200)||!Array.isArray(item.evidence)||item.evidence.length<1||item.evidence.length>50||item.evidence.some(e=>!text(e,1000)))fail('Invalid pricing work item');
    keys.add(item.key);
    if(!['goal_upgrade','financial_group','independent_output','included'].includes(item.family))fail('Unknown pricing family');
    if(item.family==='goal_upgrade'&&(!priceKey(item.price_key)||goalFamily(item.price_key)===null))fail('Invalid goal upgrade SKU');
    if(item.family==='independent_output'&&!priceKey(item.price_key))fail('Invalid independent output SKU');
    if(item.family==='financial_group'&&(!periodKeys(item.main_period_keys)||!integer(item.annual_main_periods)||!integer(item.interim_main_periods)||item.requires_complete_group_build!==undefined&&typeof item.requires_complete_group_build!=='boolean'||item.necessary_restatement!==undefined&&typeof item.necessary_restatement!=='boolean'))fail('Invalid financial scope');
    if(item.family==='included'&&(!text(item.owned_coverage_id,128)||!text(item.reason,1000)))fail('Included work requires owned coverage and reason');
    const siblings=groups.get(item.coverage_key)??[];
    if(siblings.some(other=>other.family!==item.family))fail('One coverage key cannot identify different pricing families');
    siblings.push(item);groups.set(item.coverage_key,siblings);
  }
  const scope_lines:ScopeLine[]=[],pricing_items:OutcomePricingItemResult[]=[];
  for(const [coverage_key,items] of groups){
    const first=items[0],matches=owned.filter(coverage=>coverage.coverage_key===coverage_key);
    let base=0,credit=0,due=0,reason='',sku:OutcomePriceKey|undefined,mainKeys:string[]|undefined,completeGroup:boolean|undefined;
    let used:OutcomeOwnedCoverage[]=[];
    if(first.family==='included'){
      for(const item of items){
        const included=item as Extract<OutcomePricingItem,{family:'included'}>;
        const receipt=matches.find(coverage=>coverage.id===included.owned_coverage_id);
        if(!receipt)fail('Included work has no matching owned contract coverage');
        if(!used.includes(receipt))used.push(receipt);
      }
      credit=Math.max(...used.map(coverage=>OUTCOME_RATE_CARD[coverage.price_key]));reason=first.reason;
    }else if(first.family==='goal_upgrade'){
      const goals=items as Extract<OutcomePricingItem,{family:'goal_upgrade'}>[];
      const family=goalFamily(first.price_key);
      if(goals.some(item=>goalFamily(item.price_key)!==family)||matches.some(coverage=>goalFamily(coverage.price_key)!==family))fail('Incompatible goal/check coverage cannot be transferred');
      sku=goals.reduce((best,item)=>OUTCOME_RATE_CARD[item.price_key]>OUTCOME_RATE_CARD[best]?item.price_key:best,first.price_key);
      base=OUTCOME_RATE_CARD[sku];used=matches;
      credit=matches.length?Math.max(...matches.map(coverage=>OUTCOME_RATE_CARD[coverage.price_key])):0;
      due=Math.max(0,base-credit);reason=due===0?'有效合同覆盖已包含同一目标，原范围履约不再收费。':credit?'同一目标按最终覆盖补差，已购有效等级只抵扣一次。':'按已确认业务目标报价，必要回复及主稿落地按包内范围交付。';
    }else if(first.family==='independent_output'){
      const outputs=items as Extract<OutcomePricingItem,{family:'independent_output'}>[];
      if(outputs.some(item=>item.price_key!==first.price_key)||matches.some(coverage=>coverage.price_key!==first.price_key))fail('Independent output identity has inconsistent contract coverage');
      sku=first.price_key;base=OUTCOME_RATE_CARD[sku];used=matches;credit=matches.length?base:0;due=matches.length?0:base;
      reason=due===0?'该独立成果已有有效合同覆盖，不重复购买。':'仅购买归类后的新增独立成果，共享分析不重复收费。';
    }else{
      const financial=items as Extract<OutcomePricingItem,{family:'financial_group'}>[];
      if(financial.some(item=>item.annual_main_periods!==first.annual_main_periods||item.interim_main_periods!==first.interim_main_periods))fail('Financial group counts must identify one stable target');
      const count=first.annual_main_periods+first.interim_main_periods;
      if(first.annual_main_periods>3||first.interim_main_periods>1||count<1)return pending('unavailable','超出最多三个年度及一个最新中期的标准财务组，须另行明确范围。');
      const requested=[...new Set(financial.flatMap(item=>item.main_period_keys))];
      const fullBuild=financial.some(item=>item.requires_complete_group_build===true);
      if(requested.length>count||!requested.length&&!fullBuild)fail('Financial main periods do not match target counts');
      if(matches.some(coverage=>coverage.price_key!=='period'&&coverage.price_key!=='financial_group'||coverage.price_key==='period'&&!coverage.complete_group&&(!coverage.period_keys||!coverage.period_keys.length)))fail('Financial ownership requires period or complete-group coverage');
      const covered=new Set(matches.flatMap(coverage=>coverage.period_keys??[]));
      if(new Set([...requested,...covered]).size>count)fail('Owned and requested periods exceed this standard target group');
      const complete=matches.some(coverage=>coverage.complete_group===true||coverage.price_key==='financial_group');
      completeGroup=complete||fullBuild;
      mainKeys=complete?[]:requested.filter(key=>!covered.has(key));used=matches;
      credit=complete?OUTCOME_RATE_CARD.financial_group:Math.min(OUTCOME_RATE_CARD.financial_group,covered.size*OUTCOME_RATE_CARD.period);
      sku=fullBuild?'financial_group':'period';
      base=complete?0:fullBuild?OUTCOME_RATE_CARD.financial_group:mainKeys.length*OUTCOME_RATE_CARD.period;
      due=Math.min(base,Math.max(0,OUTCOME_RATE_CARD.financial_group-credit));
      reason=due===0?'同一财务事实快照及目标组的有效覆盖已包含本次工作。':'先扣除已购主期，再按同组剩余499元封顶额度合价；必要比较、补建、对齐与重述包含，不加价。';
    }
    const evidence=[...new Set(items.flatMap(item=>item.evidence))];
    if(evidence.length>50)fail('Consolidated scope evidence exceeds supported range');
    const pricing={base_amount_fen:base,owned_coverage_fen:credit,due_fen:due,reason};
    // A full-price new period earns independent coverage. Only a discount or zero-price
    // continuation depends on prior receipts, so reversing an unrelated earlier period
    // cannot revoke another period purchased for its full 249-yuan price.
    const parents=first.family==='included'||due<base||due===0?used:[];
    scope_lines.push({key:first.key,label:first.label??(sku?OUTCOME_PRICE_LABELS[sku]:'原范围包含工作'),quantity:1,unit:'项',unit_price_fen:due,amount_fen:due,evidence,pricing});
    pricing_items.push({key:first.key,coverage_key,family:first.family,...(sku?{price_key:sku}:{}),...(mainKeys?{period_keys:mainKeys}:{}),...(completeGroup!==undefined?{complete_group:completeGroup}:{}),owned_coverage_ids:parents.map(coverage=>coverage.id),...pricing});
  }
  const amount=scope_lines.reduce((total,line)=>total+line.amount_fen,0);
  if(!integer(amount)||amount>100000000)fail('Calculated amount exceeds supported range');
  return{status:'ready',price_version:OUTCOME_PRICE_VERSION,amount_fen:amount,scope_lines,pricing_items,reason:'仅对受信服务确认的业务范围和有效已购合同覆盖计算价格；未执行自动语义识别。'};
}
