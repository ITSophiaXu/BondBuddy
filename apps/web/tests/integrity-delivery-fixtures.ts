import {fixtureBody} from './billing-fixture-wire';
import {expect,type Page} from '@playwright/test';
import {type IntegrityDraft,type IntegrityEvidence,type IntegrityRecord,type IntegrityRound} from '@bondbuddy/contracts';
import type {Dto} from './billing-fixture-wire';
import {assertFixture as assertBaseFixture,checkId,checked,exportId,fixture as baseFixture,install as installBase,ownerId,projectId,type State as BaseState} from './integrity-continuation-fixtures';
import {docx,hash,mime} from './word-roundtrip-fixtures';

// Desktop public HTTP projection and real synthetic OOXML bytes only. This does
// not execute official queries, a worker/Python process, storage or credit fees.
export {mime};
export type Kind='company'|'person';
export type Fault='artifact_id'|'version'|'run_id'|'comparison_cross_run';
export type Payload={synthetic:true;kind:Kind;run_id:string;round_id:string;operation:'check'|'export';input_hash:string;draft:IntegrityDraft;records:IntegrityRecord[];evidence_ids:string[];evidence:IntegrityEvidence[]};
export type Word={kind:Kind;run_id:string;artifact_id:string;version:number;bytes:Buffer;payload:Payload;metadata:Dto<'ArtifactResponse'>};
type Words={artifacts:Map<string,Word>;metadata:string[];responses:Dto<'ArtifactResponse'>[];downloads:string[];diagnostics:unknown[];fault?:Fault};
export type State=BaseState&{words:Words};
export const route=(run:string|null=exportId)=>`/#integrity?project=${projectId}${run?`&run=${run}`:''}`;
export const historical=(s:State,runId=exportId)=>s.workspace.rounds.find(round=>round.run_id===runId)!;
const key=(run:string,id:string,version:number)=>JSON.stringify([run,id,version]);
export function word(s:State,runId=exportId,kind:Kind='company'){
  const pin=historical(s,runId).artifacts.find(item=>item.kind===kind)!;
  return s.words.artifacts.get(key(runId,pin.artifact_id,pin.artifact_version))!;
}

function payload(s:State,round:IntegrityRound,kind:Kind):Payload{
  const subjects=round.manifest.draft.subjects.filter(subject=>subject.kind===kind).map(subject=>({...structuredClone(subject),identifier:subject.kind==='person'&&subject.identifier?'****'+subject.identifier.slice(-4):subject.identifier}));
  const subjectIds=new Set(subjects.map(subject=>subject.id)),ids=[...round.manifest.evidence_ids];
  const accepted=[...s.accepted.values()].find(value=>value.round.run_id===round.run_id);
  return {synthetic:true,kind,run_id:round.run_id,round_id:round.round_id,operation:round.operation,input_hash:accepted?.generic.input_hash??hash(JSON.stringify(round.manifest)),
    draft:{...structuredClone(round.manifest.draft),subjects},records:structuredClone((round.operation==='export'?round.manifest.records:round.records).filter(record=>subjectIds.has(record.subject_id))),
    evidence_ids:ids,evidence:structuredClone(round.evidence.filter(item=>ids.includes(item.id)&&subjectIds.has(item.subject_id)))};
}

/** Register once: a live shared evidence list must never rewrite old Word bytes. */
export function registerWords(s:State,runId=exportId){
  const round=historical(s,runId);expect(round.state).toBe('succeeded');
  for(const pin of round.artifacts){
    const wordKey=key(runId,pin.artifact_id,pin.artifact_version);expect(s.words.artifacts.has(wordKey),'Each artifact/version/run is immutable.').toBe(false);
    const content=payload(s,round,pin.kind),bytes=docx(JSON.stringify(content));
    const metadata:Dto<'ArtifactResponse'>={artifact_id:pin.artifact_id,run_id:runId,version:pin.artifact_version,filename:`合成诚信核查_第${round.sequence}次_${pin.kind==='company'?'企业':'人员'}底稿.docx`,media_type:mime,sha256:hash(bytes),quality_status:'passed',delivery_status:'available',
      download_url:`/api/v1/artifacts/${pin.artifact_id}/download?grant=synthetic-integrity-delivery`,expires_at:'2099-01-01T00:00:00Z'};
    checked('ArtifactResponse',metadata);s.words.artifacts.set(wordKey,{kind:pin.kind,run_id:runId,artifact_id:pin.artifact_id,version:pin.artifact_version,bytes,payload:content,metadata});
  }
  checked('IntegrityWorkspaceResponse',s.workspace);
}

export function fixture(){
  const s=Object.assign(baseFixture(),{words:{artifacts:new Map(),metadata:[],responses:[],downloads:[],diagnostics:[]} as Words});
  // Current worker uses a distinct artifact ID per run and version 1. Normalize
  // this extension's copied DTOs without changing the sealed continuation fixture.
  for(const round of s.workspace.rounds){
    for(const pin of round.artifacts)pin.artifact_version=1;
    for(const record of round.records)record.reason+=' '+Array.from({length:4},(_,i)=>`合成取证说明第${i+1}段：请对照原主体、原查询条件、原查询时间与公开来源核对；人工补证保留独立结论，不能把原待核实状态当作已经解决。`).join(' ');
  }
  const check=historical(s,checkId);for(const round of s.workspace.rounds.filter(value=>value.operation==='export'))round.manifest.records=structuredClone(check.records);
  for(const round of s.workspace.rounds)registerWords(s,round.run_id);
  return s;
}

/** Mutate the accepted run itself; route selection remains its export run_id. */
export function progress(s:State,state:'running'|'succeeded'){
  const accepted=[...s.accepted.values()].find(value=>value.round.operation==='export')!;expect(accepted).toBeDefined();
  accepted.round.state=state;accepted.round.stage=state==='running'?'model_generation':null;
  accepted.generic.state=state;accepted.generic.stage=state==='running'?'model_generation':'completed';
  if(state==='succeeded'){
    accepted.round.records=structuredClone(accepted.round.manifest.records);accepted.round.reserved_points=0;accepted.round.charged_points=0;
    accepted.round.artifacts=(['company','person'] as const).filter(kind=>accepted.round.manifest.draft.subjects.some(subject=>subject.kind===kind)).map(kind=>({kind,artifact_id:`${accepted.round.run_id}-${kind}-word`,artifact_version:1}));
    accepted.round.artifact_id=accepted.round.artifacts[0]?.artifact_id??null;accepted.generic.artifact_id=accepted.round.artifact_id;
    registerWords(s,accepted.round.run_id);
  }
  checked('RunResponse',accepted.generic);checked('IntegrityWorkspaceResponse',s.workspace);return accepted;
}

/** Decode only our known stored OOXML fixture, not arbitrary production Word. */
export function readPayload(bytes:Buffer):Payload{
  const text=bytes.toString('utf8').match(/<w:t>(.*?)<\/w:t>/s)?.[1];expect(text).toBeDefined();
  return JSON.parse(text!.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')) as Payload;
}

export {assertDownloadProgress,checkedDownloadProgress,type DownloadProgressDiagnostic} from './artifact-download-diagnostic-fixture';

export async function install(page:Page,s=fixture()){
  await installBase(page,s);checked('IntegrityWorkspaceResponse',s.workspace);
  await page.context().route('**/api/v1/browser-errors',async intercepted=>{
    const body=intercepted.request().postDataJSON();checked('BrowserErrorReportRequest',body);s.words.diagnostics.push(body);
    return intercepted.fulfill({status:201,json:{report_id:'synthetic-download-report',deduplicated:false,received_at:'2026-11-20T00:00:00Z'}});
  });
  // Last context route runs first. Preserve the old fixture's allow-list and
  // error checks for every request this narrow artifact extension does not own.
  await page.context().route('**/api/v1/artifacts/**',async intercepted=>{
    const request=intercepted.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),method=request.method();
    const match=path.match(/^\/artifacts\/([^/]+)(\/download)?$/);if(!match)return intercepted.fallback();
    const stored=[...s.words.artifacts.values()].find(item=>item.artifact_id===match[1]);if(!stored)return intercepted.fallback();
    s.calls.push({method,path,search:url.search});
    if(method!=='GET'||s.owner!==ownerId){s.unexpected.push(`${method} ${path}`);return intercepted.fulfill({status:404,json:fixtureBody(intercepted,{code:'NOT_FOUND'})});}
    if(match[2]){s.words.downloads.push(stored.artifact_id);return intercepted.fulfill({status:200,contentType:mime,body:stored.bytes});}
    s.words.metadata.push(stored.artifact_id);let metadata=structuredClone(stored.metadata);
    // The functional ID fault changes only artifact identity: another kind in
    // this same run has matching run/version and genuine hash-consistent bytes.
    if(s.words.fault==='artifact_id')metadata=structuredClone(word(s,stored.run_id,stored.kind==='company'?'person':'company').metadata);
    // Keep the previous-component comparison's cross-run download separate.
    if(s.words.fault==='comparison_cross_run')metadata=structuredClone(word(s,checkId,stored.kind).metadata);
    if(s.words.fault==='version')metadata.version=stored.version+1;
    if(s.words.fault==='run_id')metadata.run_id=checkId;
    checked('ArtifactResponse',metadata);s.words.responses.push(structuredClone(metadata));return intercepted.fulfill({status:200,json:fixtureBody(intercepted,metadata)});
  });return s;
}
export async function assertFixture(page:Page){await assertBaseFixture(page);}
