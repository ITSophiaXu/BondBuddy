import {expect,type Page,type Route} from '@playwright/test';
import {PROJECT_QA_PRICE,type ProjectFileAsset,type QaDraft,type QaInput,type QaRun} from '@bondbuddy/contracts';
import {isDeepStrictEqual} from 'node:util';
import type {Dto} from '../src/api';
import {QaRecoveryCache,type QaRecoveryValue} from '../src/qa-recovery-cache';
import {fixture as baseFixture,install as installBase,assertFixture as assertBase,checked,sha,now,
  oldMaterial,newMaterial,oldArtifact,source,questions,projectId,ownerId,prepareId,answerId,writes,workspaceReads,historicalRecords} from './project-qa-continuation-fixtures';

export {checked,sha,now,source,questions,projectId,ownerId,prepareId,answerId,writes,workspaceReads,historicalRecords};
export const sameName='合成同名参考文件.docx';
export const materialV2=structuredClone(oldMaterial),materialV3=structuredClone(newMaterial),artifactV4=structuredClone(oldArtifact);
if(oldMaterial.kind!=='material')throw Error('R38 requires the original synthetic business report to be a material asset.');
const originalMaterialPin=oldMaterial.pin;
// This source ID is a synthetic member of the displayed project collection, not an arbitrary third-party project.
export const linkedMaterial:ProjectFileAsset={kind:'material',pin:{...originalMaterialPin,source_project_id:'synthetic-qa-related-member'}};
export const extraMaterial:ProjectFileAsset={kind:'material',pin:{source_project_id:projectId,material_id:'synthetic-qa-extra-reference',material_version:7,sha256:sha('r38-extra-reference-v7')}};
export const hashReplacement:ProjectFileAsset={kind:'material',pin:{...originalMaterialPin,sha256:sha('r38-same-short-pin-different-bytes')}};
export const route=(run?:string)=>`/#qa?project=${projectId}${run?'&run='+encodeURIComponent(run):''}`;
export function assetKey(a:ProjectFileAsset){return a.kind==='material'?JSON.stringify({kind:a.kind,pin:{source_project_id:a.pin.source_project_id,material_id:a.pin.material_id,material_version:a.pin.material_version,sha256:a.pin.sha256}}):JSON.stringify({kind:a.kind,pin:{source_project_id:a.pin.source_project_id,artifact_id:a.pin.artifact_id,artifact_version:a.pin.artifact_version,sha256:a.pin.sha256}});}
export const version=(a:ProjectFileAsset)=>a.kind==='material'?a.pin.material_version:a.pin.artifact_version;
export const identity=(a:ProjectFileAsset)=>a.kind==='material'?a.pin.material_id:a.pin.artifact_id;
export const selectedDraft=(materials:ProjectFileAsset[]=[artifactV4,materialV2]):QaDraft=>({preparation_id:prepareId,questions:structuredClone([questions[0],questions[2]]),materials:structuredClone(materials),requirements:'合成 R38：保留问题原文、材料顺序与所有版本引用。',use_knowledge:false});

export function fixture(){
  const s=Object.assign(baseFixture(),{expectedDraft:undefined as QaDraft|undefined,serviceChecks:[] as {kind:string;materials:string[];revision:number}[],
    rejected:[] as string[],reservations:[] as {run_id:string;points:number}[],draftGate:undefined as (()=>Promise<void>)|undefined,heldDrafts:0});
  s.workspace.draft=selectedDraft();
  s.workspace.materials=[materialV2,artifactV4,materialV3,linkedMaterial].map(asset=>({filename:sameName,asset:structuredClone(asset)}));
  s.workspace.materials.push({filename:'合成独立补充说明.xlsx',asset:structuredClone(extraMaterial)});
  for(const run of s.workspace.runs)for(const item of run.manifest.materials){const names=s.workspace.materials.filter(m=>assetKey(m.asset)===assetKey(item.asset));if(names.length===1)item.filename=names[0].filename;}
  return s;
}
export type State=ReturnType<typeof fixture>;
export function manyFixture(count=62){
  const s=fixture();s.workspace.materials=Array.from({length:count},(_,i)=>({filename:`合成长列表材料_${String(i+1).padStart(3,'0')}_报告期间、资金来源及经营情况详细说明.docx`,
    asset:{kind:'material' as const,pin:{source_project_id:projectId,material_id:`synthetic-r38-list-${i+1}`,material_version:i%4+1,sha256:sha(`r38-list-${i+1}`)}}}));
  s.workspace.draft=selectedDraft([s.workspace.materials[8].asset,s.workspace.materials[1].asset]);return s;
}
export function addActiveRun(s:State){const active=structuredClone(s.workspace.runs.find(run=>run.run_id===answerId)!);active.run_id='synthetic-r38-background-active';active.sequence=20;active.state='running';active.stage='model_generation';active.result=null;active.artifact_id=null;active.reserved_points=active.manifest.points;active.charged_points=0;s.workspace.runs.unshift(active);return active;}
export function filenameFor(s:State,a:ProjectFileAsset){const names=[...new Set(s.workspace.materials.filter(m=>assetKey(m.asset)===assetKey(a)).map(m=>m.filename))];expect(names,'The synthetic service must not guess conflicting full-pin names.').toHaveLength(1);expect(names[0].trim()).not.toBe('');return names[0];}
function validateDraft(s:State,d:QaDraft){
  const prepared=s.workspace.runs.filter(r=>r.run_id===d.preparation_id&&r.operation==='prepare'&&r.state==='succeeded');expect(prepared).toHaveLength(1);
  const p=prepared[0];expect(p.result).not.toBeNull();expect(d.materials.length).toBeLessThanOrEqual(50);expect(new Set(d.materials.map(assetKey)).size).toBe(d.materials.length);
  for(const a of d.materials){expect(assetKey(a)).not.toBe(assetKey(p.manifest.source.asset));expect(s.workspace.materials.some(m=>assetKey(m.asset)===assetKey(a)),'Exact complete material pin is currently available.').toBe(true);filenameFor(s,a);}
  let end=-1;for(const q of d.questions){expect(q.start).toBeGreaterThan(end);expect(q.end).toBeGreaterThanOrEqual(q.start);expect(q.id).toBe('q'+q.start);expect(q.question).toBe(p.result!.snapshot.spans.slice(q.start,q.end+1).map(span=>span.text).join('\n').trim());end=q.end;}
  return p;
}
const problem=(r:Route,status:number,code:string)=>r.fulfill({status,json:{code}});
function record(s:State,r:Route){const req=r.request(),url=new URL(req.url()),body=req.postDataJSON();s.calls.push({method:req.method(),path:url.pathname.slice('/api/v1'.length),search:url.search,body:structuredClone(body)});return body;}

/** Real main.ts route and original HTTP fixture, with stricter independent service assertions.
 * This is synthetic HTTP; it does not run PostgreSQL, a worker, a model, Word or real billing. */
export async function install(page:Page,s=fixture()){
  await installBase(page,s);
  await page.route(`**/api/v1/projects/${projectId}/qa/draft`,async intercepted=>{
    if(intercepted.request().method()!=='POST')return intercepted.fallback();const body:unknown=record(s,intercepted);checked('QaDraftRequest',body);
    s.drafts.push(structuredClone(body));s.heldDrafts++;try{await s.draftGate?.();}finally{s.heldDrafts--;}
    if(body.expected_revision!==s.workspace.revision){s.rejected.push('INPUT_REVISION_CONFLICT');return problem(intercepted,409,'INPUT_REVISION_CONFLICT');}
    validateDraft(s,body.draft);if(s.expectedDraft)expect(body.draft).toEqual(s.expectedDraft);
    s.serviceChecks.push({kind:'draft',materials:body.draft.materials.map(assetKey),revision:body.expected_revision});
    s.workspace.draft=structuredClone(body.draft);s.workspace.revision++;
    if(s.dropDraft){s.dropDraft=false;return intercepted.abort('connectionreset');}
    checked('QaWorkspaceResponse',s.workspace);return intercepted.fulfill({json:s.workspace});
  });
  await page.route(`**/api/v1/projects/${projectId}/qa/runs`,async intercepted=>{
    if(intercepted.request().method()!=='POST')return intercepted.fallback();const body:unknown=record(s,intercepted);checked('QaAnswerRequest',body);s.answers.push(structuredClone(body));
    const token='answer:'+body.request_id,old=s.accepted.get(token);if(old){expect(isDeepStrictEqual(old.body,body)).toBe(true);return intercepted.fulfill({json:{run_id:old.run.run_id}});}
    const drop=s.dropAnswer;s.dropAnswer=undefined;if(drop==='before')return intercepted.abort('connectionreset');
    if(s.rejectAnswer){const code=s.rejectAnswer;s.rejectAnswer=undefined;s.rejected.push(code);return problem(intercepted,code==='CREDITS_INSUFFICIENT'?402:409,code);}
    expect(body.expected_revision).toBe(s.workspace.revision);expect(body.expected_points).toBe(s.workspace.draft.questions.length*60);expect(body.price_version).toBe(PROJECT_QA_PRICE.version);expect(s.available).toBeGreaterThanOrEqual(body.expected_points);
    const d=s.workspace.draft,p=validateDraft(s,d);expect(d.questions.length).toBeGreaterThan(0);
    const manifest:QaInput={...structuredClone(p.manifest),operation:'answer',preparation_id:d.preparation_id,questions:structuredClone(d.questions),materials:d.materials.map(asset=>({filename:filenameFor(s,asset),asset:structuredClone(asset)})),requirements:d.requirements,cases:[],points:body.expected_points};
    const sequence=Math.max(...s.workspace.runs.map(r=>r.sequence))+1,run_id=`synthetic-r38-answer-${sequence}`;
    const run:QaRun={run_id,sequence,operation:'answer',state:'queued',stage:'queued',created_at:now,manifest,result:null,artifact_id:null,reserved_points:body.expected_points,charged_points:0};
    const generic:Dto<'RunResponse'>={run_id,execution_request_id:'qa-answer:'+body.request_id,project_id:projectId,input_revision:100+sequence,input_hash:sha(JSON.stringify(manifest)),channel:'production',test_grant_id:null,uncovered_items:[],state:'queued',stage:'queued',event_cursor:0,billing_mode:'fixed_credits',reservation_id:'synthetic-r38-reservation-'+sequence,artifact_id:null,prompt_snapshot_ref:null,updated_at:now};
    checked('RunResponse',generic);s.workspace.runs.unshift(run);s.accepted.set(token,{body:structuredClone(body),run,generic});s.reservations.push({run_id,points:body.expected_points});s.serviceChecks.push({kind:'answer',materials:d.materials.map(assetKey),revision:body.expected_revision});
    if(drop==='after')return intercepted.abort('connectionreset');return intercepted.fulfill({json:{run_id}});
  });return s;
}
export async function assertFixture(page:Page){await assertBase(page);}
export async function recovery(page:Page):Promise<QaRecoveryValue>{const entries=await page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)!])));const value=new QaRecoveryCache(ownerId,projectId,{getItem:key=>entries[key]??null,setItem:()=>{throw Error('Read-only snapshot');},removeItem:()=>{throw Error('Read-only snapshot');}}).read();expect(value.status).toBe('valid');if(value.status!=='valid')throw Error('Expected valid QA recovery snapshot');return structuredClone(value.value);}
export async function storageSnapshot(page:Page){return page.evaluate(()=>Object.fromEntries(Object.keys(localStorage).sort().map(key=>[key,localStorage.getItem(key)!])));}
