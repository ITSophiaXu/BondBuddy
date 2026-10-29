import {billingRecoverySchemas,type BillingRecoveryDto} from './billing-recovery-wire.js';
import {int64} from '@bondbuddy/contracts';
import {PROJECT_QA_PRICE,OUTCOME_PRICE_VERSION,isOutcomePriceVersion,QaDraftSchema,ProjectFileAssetSchema,qaSchemas,type QaDraft,type ProjectFileAsset} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from './api.js';

export type QaRecoveryCacheStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export type QaRecoveryPending=
  | {kind:'draft';request:Dto<'QaDraftRequest'>}
  | {kind:'prepare';request:Dto<'QaPrepareRequest'>}
  | {kind:'answer';request:BillingRecoveryDto<'QaAnswerRequest'>};
export type QaRecoveryValue={revision:number;draft:QaDraft;needsKnowledgeChoice?:boolean;sourceRun?:string;pending?:QaRecoveryPending};
export type QaRecoveryCacheRead=
  | {status:'empty'|'invalid'|'unavailable';value?:undefined}
  | {status:'valid';value:QaRecoveryValue};
export type QaRecoveryCacheResult=QaRecoveryCacheRead|{status:'conflict';value?:undefined};
const version='qa-recovery-cache-v1';
// A pending draft contains a second copy of up to 200 maximum-length questions.
// Allow JSON's six-character escapes; normal storage quotas fail separately.
const maxRawLength=50000000;
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const nonnegativeInteger=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,required:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>=>record(value)&&
  required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
function validAsset(value:unknown):value is ProjectFileAsset{
  if(!Value.Check(ProjectFileAssetSchema,value)||!validId(value.pin.source_project_id))return false;
  return value.kind==='material'?validId(value.pin.material_id)&&Number.isSafeInteger(value.pin.material_version):
    validId(value.pin.artifact_id)&&Number.isSafeInteger(value.pin.artifact_version);
}
function copyAsset(asset:ProjectFileAsset):ProjectFileAsset{
  return asset.kind==='material'?{kind:'material',pin:{source_project_id:asset.pin.source_project_id,material_id:asset.pin.material_id,material_version:asset.pin.material_version,sha256:asset.pin.sha256}}:
    {kind:'artifact',pin:{source_project_id:asset.pin.source_project_id,artifact_id:asset.pin.artifact_id,artifact_version:asset.pin.artifact_version,sha256:asset.pin.sha256}};
}
function copyDraft(draft:QaDraft):QaDraft{
  return {...(draft.included_followup_of?{included_followup_of:draft.included_followup_of}:{}),preparation_id:draft.preparation_id,questions:draft.questions.map(({id,start,end,question})=>({id,start,end,question})),
    materials:draft.materials.map(copyAsset),requirements:draft.requirements,use_knowledge:draft.use_knowledge};
}
function validDraft(value:unknown):value is QaDraft{
  if(!Value.Check(QaDraftSchema,value)||(value.preparation_id!==null&&!validId(value.preparation_id)))return false;
  let last=-1;const ids=new Set<string>();
  for(const question of value.questions){
    if(!validId(question.id)||!nonnegativeInteger(question.start)||!nonnegativeInteger(question.end)||question.end<question.start||
      question.start<=last||question.id!=='q'+question.start||ids.has(question.id))return false;
    last=question.end;ids.add(question.id);
  }
  if(!value.materials.every(validAsset))return false;
  return new Set(value.materials.map(asset=>JSON.stringify(copyAsset(asset)))).size===value.materials.length;
}
const sameDraft=(a:QaDraft,b:QaDraft)=>JSON.stringify(copyDraft(a))===JSON.stringify(copyDraft(b));
function validValue(value:unknown,project:string,allowUndefinedOptional=false):value is QaRecoveryValue{
  try{return validValueInner(value,project,allowUndefinedOptional);}catch{return false;}
}
function validValueInner(value:unknown,project:string,allowUndefinedOptional=false):value is QaRecoveryValue{
  if(!exact(value,['revision','draft'],['needsKnowledgeChoice','sourceRun','pending'])||!nonnegativeInteger(value.revision)||!validDraft(value.draft))return false;
  if(Object.hasOwn(value,'needsKnowledgeChoice')&&!(allowUndefinedOptional&&value.needsKnowledgeChoice===undefined)&&typeof value.needsKnowledgeChoice!=='boolean')return false;
  if(Object.hasOwn(value,'sourceRun')&&!(allowUndefinedOptional&&value.sourceRun===undefined)&&!validId(value.sourceRun))return false;
  if(!Object.hasOwn(value,'pending')||(allowUndefinedOptional&&value.pending===undefined))return true;
  const pending=value.pending;if(!exact(pending,['kind','request']))return false;
  if(pending.kind==='prepare'){
    return Value.Check(qaSchemas.QaPrepareRequest,pending.request)&&validId(pending.request.request_id)&&validAsset(pending.request.source)&&
      pending.request.source.kind==='material'&&pending.request.source.pin.source_project_id===project;
  }
  if(value.needsKnowledgeChoice===true)return false;
  if(pending.kind==='draft'){
    return Value.Check(qaSchemas.QaDraftRequest,pending.request)&&pending.request.expected_revision===value.revision&&
      validDraft(pending.request.draft)&&sameDraft(value.draft,pending.request.draft);
  }
  if(pending.kind==='answer'){
    return Value.Check(billingRecoverySchemas.QaAnswerRequest,pending.request)&&validId(pending.request.request_id)&&pending.request.expected_revision===value.revision&&
      value.draft.preparation_id!==null&&value.draft.questions.length>0&&
      (isOutcomePriceVersion(pending.request.price_version)?pending.request.included_followup_of===value.draft.included_followup_of&&(int64(pending.request.expected_points)===0n&&!!value.draft.included_followup_of||validId(pending.request.scope_quote_id)):
      int64(pending.request.expected_points)===BigInt(value.draft.questions.length)*BigInt(PROJECT_QA_PRICE.points)&&pending.request.price_version===PROJECT_QA_PRICE.version);
  }
  return false;
}
function clone(value:QaRecoveryValue):QaRecoveryValue{
  let pending:QaRecoveryPending|undefined;
  if(value.pending?.kind==='draft')pending={kind:'draft',request:{expected_revision:value.pending.request.expected_revision,draft:copyDraft(value.pending.request.draft)}};
  if(value.pending?.kind==='prepare')pending={kind:'prepare',request:{request_id:value.pending.request.request_id,source:copyAsset(value.pending.request.source)}};
  if(value.pending?.kind==='answer')pending={kind:'answer',request:{request_id:value.pending.request.request_id,expected_revision:value.pending.request.expected_revision,
    expected_points:value.pending.request.expected_points,price_version:value.pending.request.price_version,...(value.pending.request.scope_quote_id?{scope_quote_id:value.pending.request.scope_quote_id}:{}),...(value.pending.request.included_followup_of?{included_followup_of:value.pending.request.included_followup_of}:{})}};
  return {revision:value.revision,draft:copyDraft(value.draft),...(value.needsKnowledgeChoice!==undefined?{needsKnowledgeChoice:value.needsKnowledgeChoice}:{}),
    ...(value.sourceRun!==undefined?{sourceRun:value.sourceRun}:{}),...(pending?{pending}:{})};
}
function freezeDraft(draft:QaDraft){
  for(const question of draft.questions)Object.freeze(question);Object.freeze(draft.questions);
  for(const asset of draft.materials){Object.freeze(asset.pin);Object.freeze(asset);}Object.freeze(draft.materials);Object.freeze(draft);
}
function frozen(value:QaRecoveryValue):QaRecoveryValue{
  const result=clone(value);freezeDraft(result.draft);
  if(result.pending){
    if(result.pending.kind==='draft')freezeDraft(result.pending.request.draft);
    if(result.pending.kind==='prepare'){Object.freeze(result.pending.request.source.pin);Object.freeze(result.pending.request.source);}
    Object.freeze(result.pending.request);Object.freeze(result.pending);
  }
  return Object.freeze(result);
}
const sameValue=(a:QaRecoveryValue,b:QaRecoveryValue)=>JSON.stringify(clone(a))===JSON.stringify(clone(b));

/** Recovery never sends a request. Only a confirmed valid save can permit POST. */
export class QaRecoveryCache{
  private storage?:QaRecoveryCacheStorage;
  private key?:string;
  constructor(private owner:string,private project:string,storage?:QaRecoveryCacheStorage){
    if(![owner,project].every(validId))return;
    try{this.key=`bb-qa-recovery:${encodeURIComponent(owner)}:${encodeURIComponent(project)}`;}catch{return;}
    try{this.storage=storage??globalThis.localStorage;}catch{/* Report unavailable on access. */}
  }
  read():QaRecoveryCacheRead{
    if(!this.key)return {status:'invalid'};
    if(!this.storage)return {status:'unavailable'};
    let raw:string|null;
    try{raw=this.storage.getItem(this.key);}catch{return {status:'unavailable'};}
    if(raw===null)return {status:'empty'};
    if(raw.length>maxRawLength)return {status:'invalid'};
    try{
      const saved:unknown=JSON.parse(raw);
      if(!exact(saved,['version','owner','project','value'])||saved.version!==version||saved.owner!==this.owner||saved.project!==this.project||
        !validValue(saved.value,this.project))return {status:'invalid'};
      return {status:'valid',value:frozen(saved.value)};
    }catch{return {status:'invalid'};}
  }
  // This is a read/compare/write guard, not an atomic cross-tab CAS. The API's
  // revision and idempotency checks remain authoritative for concurrent writes.
  private compare(expected:QaRecoveryValue|null):'match'|'conflict'|'unavailable'{
    const current=this.read();
    if(current.status==='unavailable')return 'unavailable';
    if(expected===null)return current.status==='empty'?'match':'conflict';
    return current.status==='valid'&&sameValue(current.value,expected)?'match':'conflict';
  }
  save(value:QaRecoveryValue,expected?:QaRecoveryValue|null):QaRecoveryCacheResult{
    if(!this.key)return {status:'invalid'};
    try{
      if(!validValue(value,this.project,true)||(expected!==undefined&&expected!==null&&!validValue(expected,this.project,true)))return {status:'invalid'};
      const snapshot=frozen(value);
      if(!validValue(snapshot,this.project))return {status:'invalid'};
      if(!this.storage)return {status:'unavailable'};
      const body=JSON.stringify({version,owner:this.owner,project:this.project,value:snapshot});
      if(body.length>maxRawLength)return {status:'invalid'};
      if(expected!==undefined){const compared=this.compare(expected);if(compared!=='match')return {status:compared};}
      this.storage.setItem(this.key,body);
      if(this.storage.getItem(this.key)!==body)return {status:'unavailable'};
      return {status:'valid',value:snapshot};
    }catch{return {status:'unavailable'};}
  }
  clear(expected?:QaRecoveryValue):QaRecoveryCacheResult{
    if(!this.key)return {status:'invalid'};
    try{
      if(expected!==undefined&&!validValue(expected,this.project,true))return {status:'invalid'};
      if(!this.storage)return {status:'unavailable'};
      if(expected!==undefined){const compared=this.compare(expected);if(compared!=='match')return {status:compared};}
      this.storage.removeItem(this.key);
      return this.storage.getItem(this.key)===null?{status:'empty'}:{status:'unavailable'};
    }catch{return {status:'unavailable'};}
  }
}
