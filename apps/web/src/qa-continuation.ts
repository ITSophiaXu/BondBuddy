import {int64,parseInt64} from '@bondbuddy/contracts';
import {OUTCOME_PRICE_VERSION,isOutcomePriceVersion,PROJECT_QA_PRICE,ProjectFileAssetSchema,QaDraftSchema,QaRunSchema,type ProjectFileAsset,type QaDraft,type QaQuestion,type QaResult,type QaRun} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';

export type QaPreparationChoice={preparation?:QaRun;error?:string};
export type QaFollowupChoice={preparation?:QaRun;questions:QaQuestion[];missingIds:string[];error?:string};
const terminal=new Set(['succeeded','failed','cancelled','rejected','test_completed']);
const validId=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
const nonnegativeInteger=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Every pin field matters; object insertion order does not. */
export function qaAssetKey(asset:ProjectFileAsset):string{
  return asset.kind==='material'?JSON.stringify({kind:'material',pin:{source_project_id:asset.pin.source_project_id,material_id:asset.pin.material_id,
    material_version:asset.pin.material_version,sha256:asset.pin.sha256}}):JSON.stringify({kind:'artifact',pin:{source_project_id:asset.pin.source_project_id,
    artifact_id:asset.pin.artifact_id,artifact_version:asset.pin.artifact_version,sha256:asset.pin.sha256}});
}
function validAsset(value:unknown):value is ProjectFileAsset{
  if(!Value.Check(ProjectFileAssetSchema,value)||!validId(value.pin.source_project_id))return false;
  return value.kind==='material'?validId(value.pin.material_id)&&Number.isSafeInteger(value.pin.material_version):
    validId(value.pin.artifact_id)&&Number.isSafeInteger(value.pin.artifact_version);
}
function validDraft(value:unknown):value is QaDraft{
  return Value.Check(QaDraftSchema,value)&&(value.preparation_id===null||validId(value.preparation_id))&&value.materials.every(validAsset)&&
    new Set(value.materials.map(qaAssetKey)).size===value.materials.length&&value.questions.every(q=>validId(q.id)&&nonnegativeInteger(q.start)&&nonnegativeInteger(q.end));
}
const questionValue=(q:QaQuestion)=>({id:q.id,start:q.start,end:q.end,question:q.question});
const questionKey=(questions:readonly QaQuestion[])=>JSON.stringify(questions.map(questionValue));
const draftKey=(draft:QaDraft)=>JSON.stringify({included_followup_of:draft.included_followup_of,preparation_id:draft.preparation_id,questions:draft.questions.map(questionValue),
  materials:draft.materials.map(qaAssetKey),requirements:draft.requirements,use_knowledge:draft.use_knowledge});

/** Compare the complete request meaning, retaining question and material order. */
export function qaSameDraft(a:QaDraft,b:QaDraft):boolean{
  try{return validDraft(a)&&validDraft(b)&&draftKey(a)===draftKey(b);}catch{return false;}
}
function validPoints(value:unknown){try{parseInt64(value);return true;}catch{return false;}}
function validRun(value:unknown):value is QaRun{
  return Value.Check(QaRunSchema,value)&&validId(value.run_id)&&Number.isSafeInteger(value.sequence)&&validPoints(value.reserved_points)&&
    validPoints(value.charged_points)&&validAsset(value.manifest.source.asset)&&value.manifest.materials.every(m=>validAsset(m.asset))&&
    (value.manifest.preparation_id===null||validId(value.manifest.preparation_id))&&(value.artifact_id===null||validId(value.artifact_id));
}
function questionsMatch(questions:readonly QaQuestion[],snapshot:QaResult['snapshot']):boolean{
  let last=-1;const ids=new Set<string>();
  for(const q of questions){
    if(!validId(q.id)||!nonnegativeInteger(q.start)||!nonnegativeInteger(q.end)||q.start<=last||q.end<q.start||q.end>=snapshot.spans.length||
      q.id!=='q'+q.start||ids.has(q.id))return false;
    const text=snapshot.spans.slice(q.start,q.end+1).map(span=>span.text).join('\n').trim();
    if(!text||q.question!==text)return false;
    ids.add(q.id);last=q.end;
  }
  return true;
}
const snapshotKey=(snapshot:QaResult['snapshot'])=>JSON.stringify({version:snapshot.version,sha256:snapshot.sha256,format:snapshot.format,
  spans:snapshot.spans.map(({id,text,location,sha256})=>({id,text,location,sha256})),warnings:snapshot.warnings,coverage:snapshot.coverage});

/** Resolve only the explicit successful preparation; no newest-run fallback. */
export function qaPreparationFor(draft:QaDraft,runs:readonly QaRun[],projectId:string):QaPreparationChoice{
  try{
    if(!validId(projectId)||!validDraft(draft)||!Array.isArray(runs))return {error:'问题清单记录不完整，请重新读取后再继续。'};
    if(draft.preparation_id===null)return {error:'请先完成 Word 问题清单解析。'};
    const matches=runs.filter(run=>record(run)&&run.run_id===draft.preparation_id);
    if(!matches.length)return {error:'未找到当前问题清单的原解析结果，请重新读取后再继续。'};
    if(matches.length!==1)return {error:'原问题清单的解析记录不唯一，请重新读取后再继续。'};
    const preparation=matches[0];
    if(!validRun(preparation))return {error:'原问题清单的解析记录不完整，请重新读取后再继续。'};
    if(preparation.operation!=='prepare'||preparation.manifest.operation!=='prepare'||preparation.state!=='succeeded'||preparation.result===null)
      return {error:'原问题清单尚未成功解析，请稍后重试。'};
    if(preparation.manifest.preparation_id!==null||int64(preparation.manifest.points)!==0n||preparation.manifest.questions.length||
      preparation.manifest.materials.length||preparation.manifest.cases.length)return {error:'原问题清单的解析来源不一致，请重新读取后再继续。'};
    const source=preparation.manifest.source.asset;
    if(source.kind!=='material'||source.pin.source_project_id!==projectId)return {error:'原问题清单与当前项目不一致，请选择本项目的 Word 清单。'};
    if(!questionsMatch(draft.questions,preparation.result.snapshot))return {error:'问题与原文定位不一致，请重新上传问题清单。'};
    if(draft.materials.some(asset=>qaAssetKey(asset)===qaAssetKey(source)))return {error:'问题清单不能同时作为回答的事实依据，请重新选择材料。'};
    return {preparation};
  }catch{return {error:'问题清单记录不完整，请重新读取后再继续。'};}
}

/** Select safe follow-up work, not proof of a delivered or fully grounded result. */
export function qaFollowupFor(run:QaRun,runs:readonly QaRun[],projectId:string):QaFollowupChoice{
  const failure=(error:string):QaFollowupChoice=>({questions:[],missingIds:[],error});
  try{
    if(!validRun(run)||run.operation!=='answer'||run.manifest.operation!=='answer')return failure('本轮回答记录不完整，请重新读取后再继续。');
    if(!terminal.has(run.state))return failure('本轮仍在处理中，请结束后再准备下一轮。');
    const input=run.manifest;
    if(!input.questions.length||int64(input.points)!==(isOutcomePriceVersion(input.price_version)?int64(input.amount_fen):BigInt(input.questions.length)*BigInt(PROJECT_QA_PRICE.points)))return failure('本轮问题数量与记录不一致，请重新读取后再继续。');
    const resolved=qaPreparationFor({preparation_id:input.preparation_id,questions:input.questions,materials:input.materials.map(m=>m.asset),
      requirements:input.requirements,use_knowledge:false},runs,projectId);
    if(!resolved.preparation)return failure(resolved.error??'未找到原问题清单，请重新读取后再继续。');
    const preparation=resolved.preparation;
    if(qaAssetKey(input.source.asset)!==qaAssetKey(preparation.manifest.source.asset)||input.source.filename!==preparation.manifest.source.filename)
      return failure('本轮问题清单与原解析文件版本不一致，请重新读取后再继续。');
    if(run.result&&(snapshotKey(run.result.snapshot)!==snapshotKey(preparation.result!.snapshot)||questionKey(run.result.questions)!==questionKey(input.questions)))
      return failure('本轮结果与原问题清单不一致，请重新读取后再继续。');
    const ids=new Set(input.questions.map(q=>q.id)),answers=new Map<string,NonNullable<QaRun['result']>['answers'][number]>();
    for(const answer of run.result?.answers??[]){
      if(!ids.has(answer.question_id)||answers.has(answer.question_id))return failure('本轮回答与问题的对应关系不一致，请重新读取后再继续。');
      answers.set(answer.question_id,answer);
    }
    const missingIds=input.questions.filter(q=>!answers.has(q.id)||answers.get(q.id)!.status==='missing'||answers.get(q.id)!.missing_materials.length>0).map(q=>q.id);
    const missing=new Set(missingIds),selected=missingIds.length?input.questions.filter(q=>missing.has(q.id)):input.questions;
    return {preparation,questions:selected.map(questionValue),missingIds};
  }catch{return failure('本轮回答记录不完整，请重新读取后再继续。');}
}
