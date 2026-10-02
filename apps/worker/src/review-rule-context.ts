import { isMarketOffering, MARKETS, type Market, type Offering } from '@bondbuddy/contracts';
import { evaluateRulePackCapability, rulePackContentHash, validateRulePack, type RuleContext, type RulePack } from '@bondbuddy/domain';
import { selectProductionRulePack, revalidateProductionRulePackPin, type ProductionRulePackPin, type ProductionRulePackRequest } from '@bondbuddy/rule-pack-registry';
import { loadReviewedRuleApplicabilityContext } from '@bondbuddy/rule-applicability-context';
import { inputManifestHash, loadExactReviewedContext, validContextRef, type RuleApplicabilityContextRef, type LockedRuleSource } from '@bondbuddy/api/production-rule-pin';
import { isVerifiedIssuerIdentityBinding, type VerifiedIssuerIdentityBinding } from '@bondbuddy/api/issuer-identity-binding';
import { checkpointStage } from '@bondbuddy/api/queue';
import type { ReviewRuleRef } from '../../../packages/contracts/dist/review-results.js';
import type { ReviewFormattingRequirement } from '../../../packages/domain/dist/review-compliance-checks.js';
import type { ReviewAnalysisRecord } from './review-model-stage.js';
import type { StageContext } from './run-pipeline.js';

export interface ReviewRuleManifest {
  market:string|null;offering:string|null;issuer_name:string|null;
  draft_revision?:unknown;
  materials:{material_id:string;material_version:number;sha256:string;role:string}[];
  review:{input:{as_of:string|null}};
}
export interface ReviewRuleContextResult {
  rule_context:RuleContext|null;rule_packs:RulePack[];rules:ReviewRuleRef[];
  formatting_requirements:ReviewFormattingRequirement[];limitations:string[];
}
type ReviewedPin={ref:RuleApplicabilityContextRef;identity:VerifiedIssuerIdentityBinding;current:LockedRuleSource};
type CandidatePin={release_id:string;pack_id:string;content_hash:string};
type RuleCheckpoint={version:'review-rules-v1';input_hash:string;mode:'approved'|'reference'|'missing';reviewed?:ReviewedPin;pin?:ProductionRulePackPin;candidates:CandidatePin[];limitations:string[]};
type Options={
  loadExact?:typeof loadExactReviewedContext;select?:typeof selectProductionRulePack;revalidate?:typeof revalidateProductionRulePackPin;
  /** Unit-test persistence seam only; production always writes under the active worker lease. */
  save?:(ctx:StageContext,value:RuleCheckpoint)=>Promise<void>;
};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const day=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const parse=(value:unknown):unknown=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return null;}};
function toContext(request:ProductionRulePackRequest):RuleContext{return {market:request.market,offering:request.offering,document_stage:request.documentStage,
  issuer_scope:request.issuerScope,instrument:request.instrument,investor_scope:request.investorScope,industry:request.industry,
  special_features:request.specialFeatures==null?null:[...request.specialFeatures],as_of:request.asOf};}
function references(pack:RulePack,asOf:string,applicable:Set<string>|null):ReviewRuleRef[]{
  return pack.rules.filter(rule=>!applicable||applicable.has(rule.rule_id)).flatMap(rule=>rule.source_ref_ids.flatMap(id=>{
    const source=pack.sources.find(source=>source.source_id===id);
    if(!source?.document_hash||!source.exact_quote.trim()||!source.clause_locator.trim()
      ||source.effective_from&&source.effective_from>asOf||source.effective_to&&source.effective_to<asOf)return [];
    return [{rule_id:rule.rule_id,rule_version:rule.version,pack_id:pack.pack_id,pack_version:pack.version,pack_sha256:rulePackContentHash(pack),
      source_id:source.source_id,source_version:source.source_version,source_sha256:source.document_hash,quote:source.exact_quote,locator:source.clause_locator,
      effective_from:source.effective_from,effective_to:source.effective_to,applicability:applicable?'applicable' as const:'unknown' as const,
      authority:source.kind==='internal_method'?'internal_method' as const:'regulatory' as const,...(source.official_url?{url:source.official_url}:{})}];
  }));
}
function trustedCandidate(row:Record<string,unknown>,market:string,offering:string,asOf:string):RulePack|null{
  const raw=parse(row.pack_snapshot);if(!validateRulePack(raw).ok)return null;const pack=raw as RulePack;
  if(!['production_release','production_rollback'].includes(String(row.action))||row.has_later_event||row.has_target_withdrawal
    ||pack.status!=='published'||pack.release?.channel!=='production'||row.market!==market||row.offering!==offering
    ||pack.scope.market!==market||pack.scope.offering!==offering||pack.pack_id!==row.pack_id||pack.version!==row.pack_version
    ||rulePackContentHash(pack)!==String(row.content_hash).trim()||pack.release.content_hash!==rulePackContentHash(pack)
    ||pack.validity.effective_from>asOf||pack.validity.effective_to&&pack.validity.effective_to<asOf)return null;
  return pack;
}
async function readCandidates(ctx:StageContext,market:string,offering:string,pins?:CandidatePin[]):Promise<Record<string,unknown>[]>{
  if(pins){if(!pins.length)return [];return (await ctx.pool.query(`SELECT e.*,
    EXISTS(SELECT 1 FROM bb_rule_pack_production_release_events newer WHERE newer.pack_id=e.pack_id AND newer.sequence>e.sequence) AS has_later_event,
    EXISTS(SELECT 1 FROM bb_rule_pack_production_release_events withdrawn WHERE withdrawn.pack_id=e.pack_id AND withdrawn.action='production_withdrawal'
      AND withdrawn.target_event_id=e.id AND withdrawn.sequence>e.sequence) AS has_target_withdrawal
    FROM bb_rule_pack_production_release_events e WHERE e.id=ANY($1::text[]) AND e.market=$2 AND e.offering=$3`,[pins.map(p=>p.release_id),market,offering])).rows;}
  return (await ctx.pool.query(`WITH latest AS (SELECT DISTINCT ON(pack_id) * FROM bb_rule_pack_production_release_events ORDER BY pack_id,sequence DESC)
    SELECT * FROM latest WHERE market=$1 AND offering=$2 ORDER BY pack_id LIMIT 51`,[market,offering])).rows;
}
async function reviewedCandidate(ctx:StageContext,manifest:ReviewRuleManifest,options:Options,asOf:string):Promise<{pin:ReviewedPin;request:ProductionRulePackRequest}|null>{
  if(!Number.isSafeInteger(manifest.draft_revision)||Number(manifest.draft_revision)<1)return null;
  const rows=(await ctx.pool.query(`SELECT d.id,d.version,d.content_hash,d.source_input_revision,d.source_input_hash,i.manifest AS source_manifest
    FROM bb_rule_applicability_context_drafts d JOIN bb_input_revisions i ON i.owner_user_id=d.owner_user_id AND i.project_id=d.project_id AND i.revision=d.source_input_revision
    WHERE d.owner_user_id=$1 AND d.project_id=$2 AND d.source_draft_revision=$3 AND d.as_of=$4::date ORDER BY d.created_at DESC LIMIT 21`,
    [ctx.run.owner_user_id,ctx.run.project_id,manifest.draft_revision,asOf])).rows;
  if(rows.length>20)return null;
  const approved:{pin:ReviewedPin;request:ProductionRulePackRequest}[]=[];
  for(const row of rows){
    const source=parse(row.source_manifest);const identity=record(source)?source.issuer_identity:undefined;
    const ref={context_id:row.id,version:Number(row.version),content_hash:String(row.content_hash).trim(),source_input_revision:Number(row.source_input_revision),source_input_hash:String(row.source_input_hash).trim()};
    if(!validContextRef(ref)||!isVerifiedIssuerIdentityBinding(identity)||identity.issuer_display_name!==manifest.issuer_name)continue;
    const pin:ReviewedPin={ref,identity,current:{draftRevision:Number(manifest.draft_revision),materials:manifest.materials}};
    const result=await (options.loadExact??loadExactReviewedContext)(ctx.pool,ctx.run.owner_user_id,ctx.run.project_id,ref,identity,pin.current,
      ctx.reviewedContextLoader??loadReviewedRuleApplicabilityContext,'selection');
    if(result.status==='approved'&&result.request.market===manifest.market&&result.request.offering===manifest.offering&&result.request.asOf===asOf)
      approved.push({pin,request:result.request});
  }
  // Do not select between conflicting approved applicability contexts by recency alone.
  return approved.length===1?approved[0]!:null;
}

/** Connects review to the same ledger and reviewed-context gate used by production authoring. */
export async function loadReviewRuleContext(ctx:StageContext,manifest:ReviewRuleManifest,records:readonly ReviewAnalysisRecord[],options:Options={}):Promise<ReviewRuleContextResult>{
  if(inputManifestHash(manifest)!==ctx.run.input_hash.trim())throw new Error('REVIEW_RULE_INPUT_HASH_MISMATCH');
  if(records.some(r=>r.owner_user_id!==ctx.run.owner_user_id||r.project_id!==ctx.run.project_id
    ||!manifest.materials.some(m=>m.material_id===r.material_id&&m.material_version===r.material_version&&m.sha256===r.material_sha256)))throw new Error('REVIEW_RULE_RECORD_SCOPE_MISMATCH');
  const result:ReviewRuleContextResult={rule_context:null,rule_packs:[],rules:[],formatting_requirements:[],limitations:[]};
  const stored=ctx.checkpoint.review_rules as unknown as RuleCheckpoint|undefined;
  if(stored&&(stored.version!=='review-rules-v1'||stored.input_hash!==ctx.run.input_hash.trim()))throw new Error('REVIEW_RULE_CHECKPOINT_MISMATCH');
  if(!manifest.market||!manifest.offering||!(MARKETS as readonly string[]).includes(manifest.market)
    ||!isMarketOffering(manifest.market as Market,manifest.offering as Offering)||!day(manifest.review.input.as_of)){
    result.limitations.push('缺少有效市场、品种或法规适用日，不推测规则适用范围；合规检查未覆盖。');return result;
  }
  const asOf=manifest.review.input.as_of;
  let snapshot:RuleCheckpoint=stored??{version:'review-rules-v1',input_hash:ctx.run.input_hash.trim(),mode:'missing',candidates:[],limitations:[]};
  if(!stored){
    const reviewed=await reviewedCandidate(ctx,manifest,options,asOf);
    if(reviewed){
      const selected=await (options.select??selectProductionRulePack)(ctx.pool,reviewed.request);
      if(selected.status==='selected')snapshot={...snapshot,mode:'approved',reviewed:reviewed.pin,pin:selected.pin};
      else snapshot.limitations.push(...selected.reasons.map(reason=>`正式规则选择未通过：${reason}`));
    }else snapshot.limitations.push('尚无与本次材料、主体、日期完全匹配且唯一的已审核适用性上下文；来源仅供人工核对。');
    if(snapshot.mode!=='approved'){
      const candidates=await readCandidates(ctx,manifest.market,manifest.offering);
      if(candidates.length>50)throw new Error('REVIEW_RULE_CANDIDATES_EXCEED_LIMIT');
      snapshot.candidates=candidates.flatMap(row=>{const pack=trustedCandidate(row,manifest.market!,manifest.offering!,asOf);
        return pack?[{release_id:String(row.id),pack_id:pack.pack_id,content_hash:rulePackContentHash(pack)}]:[];});
      snapshot.mode=snapshot.candidates.length?'reference':'missing';
    }
    if(options.save)await options.save(ctx,snapshot);else await checkpointStage(ctx.pool,ctx.lease,'review_rules',snapshot as unknown as Record<string,unknown>);
    ctx.checkpoint.review_rules=snapshot as unknown as Record<string,unknown>;
  }
  result.limitations.push(...snapshot.limitations);
  if(snapshot.mode==='approved'){
    if(!snapshot.reviewed||!snapshot.pin)throw new Error('REVIEW_RULE_CHECKPOINT_INCOMPLETE');
    const reviewed=await (options.loadExact??loadExactReviewedContext)(ctx.pool,ctx.run.owner_user_id,ctx.run.project_id,snapshot.reviewed.ref,
      snapshot.reviewed.identity,snapshot.reviewed.current,ctx.reviewedContextLoader??loadReviewedRuleApplicabilityContext,'replay');
    if(reviewed.status!=='approved'){result.limitations.push(...reviewed.reasons.map(reason=>`已固定适用性不再有效：${reason}`));return result;}
    const context=toContext(reviewed.request),pin=snapshot.pin;
    if(context.market!==manifest.market||context.offering!==manifest.offering||context.as_of!==asOf||pin.market!==context.market||pin.offering!==context.offering
      ||pin.asOf!==asOf||pin.documentStage!==context.document_stage||pin.instrument!==context.instrument
      ||inputManifestHash(pin.applicabilityContext)!==inputManifestHash({issuerScope:reviewed.request.issuerScope,investorScope:reviewed.request.investorScope??null,industry:reviewed.request.industry??null,specialFeatures:reviewed.request.specialFeatures??null}))throw new Error('REVIEW_RULE_CONTEXT_CHANGED');
    const selected=await (options.revalidate??revalidateProductionRulePackPin)(ctx.pool,pin,pin.applicabilityContext);
    if(selected.status!=='selected'){result.limitations.push(...selected.reasons.map(reason=>`已固定正式规则不可用：${reason}`));return result;}
    if(inputManifestHash(selected.pin)!==inputManifestHash(pin)||rulePackContentHash(selected.pack)!==pin.contentHash)throw new Error('REVIEW_RULE_RELEASE_CHANGED');
    const decision=evaluateRulePackCapability(selected.pack,context);
    if(decision.decision!=='eligible_for_evaluation'){result.limitations.push(...decision.reason_codes.map(reason=>`正式规则尚不可评估：${reason}`));return result;}
    result.rule_context=context;result.rule_packs=[selected.pack];result.rules=references(selected.pack,asOf,new Set(decision.applicable_rule_ids));
  }else if(snapshot.mode==='reference'){
    const candidates=await readCandidates(ctx,manifest.market,manifest.offering,snapshot.candidates);
    for(const pin of snapshot.candidates){const row=candidates.find(r=>r.id===pin.release_id);const pack=row?trustedCandidate(row,manifest.market,manifest.offering,asOf):null;
      if(!pack||rulePackContentHash(pack)!==pin.content_hash){result.limitations.push(`固定规则来源 ${pin.pack_id} 已缺失、撤回、替换或失效，本轮不使用。`);continue;}
      result.rule_packs.push(pack);result.rules.push(...references(pack,asOf,null));
    }
    result.limitations.push('所列来源来自固定发布记录，但未完成本项目适用性及当前发布授权/配套验收复核；仅作为引用阅读，不能据此生成合规通过或确定违规。');
  }else result.limitations.push('当前市场、品种和适用日没有可用的已发布规则来源，本轮合规未覆盖；不回退其他品种。');
  if(!result.formatting_requirements.length)result.limitations.push('现有发布模板未提供可执行且已定位的字体、字号或版式要求；不凭模型猜测格式通过。');
  return result;
}
