import {INTEGRITY_PRICE,INTEGRITY_SITES,IntegrityDraftSchema,IntegrityEvidenceSchema,IntegrityManualSchema,IntegrityRoundSchema,
  type IntegrityDraft,type IntegrityEvidence,type IntegrityManual,type IntegrityRecord,type IntegrityRound,type IntegritySubject} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';

export type IntegrityRoundChoice={roundId?:string;original?:IntegrityRound;originalMissing?:boolean;error?:string};
export type IntegrityWorkItem={key:string;subject:IntegritySubject;siteId:string;record?:IntegrityRecord;evidence:IntegrityEvidence[];
  pending:boolean;includedEvidenceCount:number;newEvidenceCount:number};
export type IntegrityWorkChoice={items:IntegrityWorkItem[];error?:string};
export type IntegrityManualReadback={evidence?:IntegrityEvidence;error?:string};
const terminal=new Set(['succeeded','failed','cancelled','rejected','test_completed']);
const sites=new Map(INTEGRITY_SITES.map(site=>[site.id,site]));
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const safeInteger=(value:number)=>Number.isSafeInteger(value)&&value>=0;
const pairKey=(subjectId:string,siteId:string)=>JSON.stringify([subjectId,siteId]);
const subjectValue=(subject:IntegritySubject)=>({id:subject.id,kind:subject.kind,name:subject.name,identifier:subject.identifier,
  role:subject.role,province:subject.province,city:subject.city});
const draftKey=(draft:IntegrityDraft)=>JSON.stringify({subjects:draft.subjects.map(subjectValue),site_ids:draft.site_ids,notes:draft.notes});
function validDraft(value:unknown):value is IntegrityDraft{
  return Value.Check(IntegrityDraftSchema,value)&&value.subjects.every(subject=>validId(subject.id))&&
    new Set(value.subjects.map(subject=>subject.id)).size===value.subjects.length&&value.site_ids.every(id=>validId(id)&&sites.has(id));
}
function canonical(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value)??'null';
}

/** Compare all saved fields exactly; object insertion order is irrelevant and array order is retained. */
export function integritySameDraft(a:IntegrityDraft,b:IntegrityDraft):boolean{
  try{return validDraft(a)&&validDraft(b)&&draftKey(a)===draftKey(b);}catch{return false;}
}
function validManual(value:unknown):value is IntegrityManual{
  return Value.Check(IntegrityManualSchema,value)&&[value.request_id,value.subject_id,value.site_id,value.material.source_project_id,value.material.material_id].every(validId)&&
    safeInteger(value.material.material_version)&&Number.isFinite(Date.parse(value.queried_at));
}
function validEvidence(value:unknown):value is IntegrityEvidence{
  if(!Value.Check(IntegrityEvidenceSchema,value)||!validId(value.id)||!Number.isFinite(Date.parse(value.created_at)))return false;
  const {id:_,created_at:__,...manual}=value;
  return validManual(manual);
}
const manualKey=(manual:IntegrityManual)=>JSON.stringify({request_id:manual.request_id,subject_id:manual.subject_id,site_id:manual.site_id,
  queried_at:manual.queried_at,url:manual.url,note:manual.note,conclusion:manual.conclusion,material:{source_project_id:manual.material.source_project_id,
    material_id:manual.material.material_id,material_version:manual.material.material_version,sha256:manual.material.sha256},
  ...(manual.registration?{registration:{province:manual.registration.province,city:manual.registration.city}}:{})});
function evidenceError(evidence:readonly IntegrityEvidence[]):string|undefined{
  const ids=new Set<string>(),requests=new Set<string>();
  for(const item of evidence){
    if(!validEvidence(item))return '人工证据记录不完整，请重新读取后再继续。';
    if(ids.has(item.id)||requests.has(item.request_id))return '人工证据身份不唯一，请重新读取后再继续。';
    ids.add(item.id);requests.add(item.request_id);
  }
}
function roundError(value:unknown):string|undefined{
  if(!Value.Check(IntegrityRoundSchema,value)||![value.run_id,value.round_id,value.manifest.round_id].every(validId)||!validDraft(value.manifest.draft)||
    !value.manifest.draft.subjects.length||!value.manifest.draft.site_ids.length||!safeInteger(value.sequence)||
    !safeInteger(value.charged_points)||!safeInteger(value.reserved_points)||!Number.isFinite(Date.parse(value.created_at))||
    value.artifacts.some(artifact=>!validId(artifact.artifact_id)||!safeInteger(artifact.artifact_version))||
    value.artifact_id!==null&&!validId(value.artifact_id))return '本轮核查记录不完整，请重新读取后再继续。';
  if(value.operation!==value.manifest.operation||value.round_id!==value.manifest.round_id)return '本轮核查身份与执行快照不一致，请重新读取后再继续。';
  if(value.operation==='check'){
    if(value.run_id!==value.round_id||value.manifest.points!==INTEGRITY_PRICE.points||value.manifest.records.length||value.manifest.evidence_ids.length)
      return '原核查轮次与收费快照不一致，请重新读取后再继续。';
  }else if(value.run_id===value.round_id||value.manifest.points!==0||value.charged_points!==0||value.reserved_points!==0)
    return '免费导出与原核查轮次不一致，请重新读取后再继续。';
}

/** Exact manifest subject × site work; attachments never rewrite the automatic observation status. */
export function integrityWorkItems(round:IntegrityRound):IntegrityWorkChoice{
  const failure=(error:string):IntegrityWorkChoice=>({items:[],error});
  try{
    const error=roundError(round);if(error)return failure(error);
    const draft=round.manifest.draft,subjects=new Map(draft.subjects.map(subject=>[subject.id,subject])),siteIds=new Set(draft.site_ids),records=new Map<string,IntegrityRecord>();
    // Export has no new website observations: even a queued export uses its immutable original-record snapshot.
    const observations=round.operation==='export'?round.manifest.records:round.records;
    if(round.operation==='export'&&round.records.length&&canonical(round.records)!==canonical(observations))return failure('导出结果与原查询快照不一致，请重新读取后再继续。');
    for(const record of observations){
      const key=pairKey(record.subject_id,record.site_id);
      if(!subjects.has(record.subject_id)||!siteIds.has(record.site_id)||records.has(key))return failure('查询记录与主体、网站的对应关系不唯一，请重新读取后再继续。');
      records.set(key,record);
    }
    const invalidEvidence=evidenceError(round.evidence);if(invalidEvidence)return failure(invalidEvidence);
    const evidenceByPair=new Map<string,IntegrityEvidence[]>(),evidenceIds=new Set(round.evidence.map(item=>item.id)),included=new Set(round.manifest.evidence_ids);
    if(included.size!==round.manifest.evidence_ids.length||round.manifest.evidence_ids.some(id=>!validId(id)||!evidenceIds.has(id)))
      return failure('此版底稿的证据清单不完整或不唯一，请重新读取后再继续。');
    for(const item of round.evidence){
      const subject=subjects.get(item.subject_id),site=sites.get(item.site_id);
      if(!subject||!siteIds.has(item.site_id)||!site||subject.kind==='person'&&site.companyOnly)return failure('人工证据与本轮主体、网站不一致，请重新读取后再继续。');
      const key=pairKey(item.subject_id,item.site_id),attached=evidenceByPair.get(key)??[];attached.push(item);evidenceByPair.set(key,attached);
    }
    return {items:draft.subjects.flatMap(subject=>draft.site_ids.map(siteId=>{
      const key=pairKey(subject.id,siteId),record=records.get(key),evidence=evidenceByPair.get(key)??[],includedEvidenceCount=evidence.filter(item=>included.has(item.id)).length,
        applicable=!(subject.kind==='person'&&sites.get(siteId)?.companyOnly);
      return {key,subject,siteId,...(record?{record}:{}),evidence,pending:applicable&&(record?record.status==='needs_manual'||record.status==='query_failed':terminal.has(round.state)),
        includedEvidenceCount,newEvidenceCount:evidence.length-includedEvidenceCount};
    }))};
  }catch{return failure('本轮核查记录不完整，请重新读取后再继续。');}
}

/**
 * Resolve only the bound check ID. originalMissing means a valid export whose original check is outside
 * the history window: its own frozen records/evidence remain readable, but it must not authorize writes.
 * Never substitute another check or infer the latest round; roundId is never an export run_id.
 */
export function integrityRoundFor(round:IntegrityRound,allRounds:readonly IntegrityRound[]):IntegrityRoundChoice{
  try{
    if(!Array.isArray(allRounds))return {error:'核查历史记录不完整，请重新读取后再继续。'};
    const work=integrityWorkItems(round);if(work.error)return {error:work.error};
    const matches=allRounds.filter(item=>item&&typeof item==='object'&&item.run_id===round.round_id);
    if(matches.length>1)return {error:'原核查记录不唯一，请重新读取后再继续。'};
    const original=round.operation==='check'?round:matches[0];
    if(!original)return {roundId:round.round_id,originalMissing:true};
    const originalWork=integrityWorkItems(original);
    if(originalWork.error||original.operation!=='check'||original.run_id!==round.round_id||original.round_id!==round.round_id)
      return {error:'未找到身份一致的原核查记录，请重新读取后再继续。'};
    if(matches.length&&round.operation==='check'&&(integrityWorkItems(matches[0]).error||matches[0].operation!=='check'||canonical(matches[0].manifest)!==canonical(round.manifest)))
      return {error:'原核查执行快照不一致，请重新读取后再继续。'};
    if(round.operation==='export'&&(!terminal.has(original.state)||!integritySameDraft(round.manifest.draft,original.manifest.draft)||round.manifest.project_name!==original.manifest.project_name||
      round.manifest.collector!==original.manifest.collector||canonical(round.manifest.records)!==canonical(original.records)))
      return {error:'导出与原核查的名单、范围或查询记录不一致，请重新读取后再继续。'};
    return {roundId:round.round_id,original};
  }catch{return {error:'本轮核查身份不完整，请重新读取后再继续。'};}
}

/** GET-only acknowledgement of the complete original manual request; response ID/time are the only ignored fields. */
export function integrityManualReadback(request:IntegrityManual,evidence:readonly IntegrityEvidence[]):IntegrityManualReadback{
  try{
    if(!validManual(request)||!Array.isArray(evidence))return {error:'待确认的补证请求不完整，请保留原记录并重新读取。'};
    const error=evidenceError(evidence);if(error)return {error};
    const matches=evidence.filter(item=>item.request_id===request.request_id);
    if(!matches.length)return {};
    if(matches.length!==1||manualKey(matches[0])!==manualKey(request))return {error:'同一补证请求的内容不一致，请保留原记录并核对。'};
    return {evidence:matches[0]};
  }catch{return {error:'补证回执不完整，请保留原记录并重新读取。'};}
}
