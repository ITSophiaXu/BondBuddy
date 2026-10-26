import {expect,type Page} from '@playwright/test';
import {QaRunSchema} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import type {Dto} from '../src/api';
import {answerId,assertFixture as assertBaseFixture,checked,completed,fixture as baseFixture,install as installBase,otherAnswerId,ownerId,
  projectId,type State as BaseState} from './project-qa-continuation-fixtures';
import {docx,hash} from './word-roundtrip-fixtures';

// Only desktop QA result navigation and exact synthetic Word delivery extend the
// sealed public HTTP fixture. No worker, real content, database or ledger runs.
export const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Word={run_id:string;artifact_id:string;bytes:Buffer;payload:string;metadata:Dto<'ArtifactResponse'>};
type Words={artifacts:Map<string,Word>;fault?:'artifact_id'|'run_id';holdMetadata:boolean;held:{artifact_id:string;release:()=>void}[];metadata:string[];downloads:string[]};
export type State=BaseState&{words:Words};
export const route=(run:string|null=answerId)=>`/#qa?project=${projectId}${run?`&run=${run}`:''}`;
export const historical=(s:State,runId=answerId)=>s.workspace.runs.find(run=>run.run_id===runId)!;
export const word=(s:State,runId=answerId)=>s.words.artifacts.get(historical(s,runId).artifact_id!)!;
const longText=(id:string)=>`合成 ${id} 回答，仅供界面测试。\n`+Array.from({length:18},(_,i)=>`合成说明第 ${i+1} 段：请由项目组对照固定材料核对事实、报告期间与待补依据；这里只验证桌面长结果的定位，不构成业务结论。`).join('\n');

export function registerWord(s:State,runId=answerId){
  const run=historical(s,runId);expect(run.operation).toBe('answer');expect(run.state).toBe('succeeded');expect(run.result).not.toBeNull();expect(run.artifact_id).not.toBeNull();
  const payload=JSON.stringify({synthetic:true,run_id:run.run_id,input_hash:run.result!.input_hash,
    original_question_list:run.result!.snapshot.spans.map(span=>({id:span.id,text:span.text,location:span.location,sha256:span.sha256})),
    source:run.manifest.source,selected_questions:run.manifest.questions,materials:run.manifest.materials,requirements:run.manifest.requirements,
    answers:run.result!.answers});
  const bytes=docx(payload),sha256=hash(bytes),id=run.artifact_id!,filename=`合成项目问答_第${run.sequence}轮_回填.docx`;
  run.result!.document={key:`synthetic/qa/${runId}/${sha256}/document.docx`,sha256,byte_size:bytes.length};
  const metadata:Dto<'ArtifactResponse'>={filename,artifact_id:id,run_id:runId,version:1,media_type:mime,sha256,quality_status:'passed',delivery_status:'available',
    download_url:`/api/v1/artifacts/${id}/download?grant=synthetic-qa-result`,expires_at:'2099-01-01T00:00:00Z'};
  checked('ArtifactResponse',metadata);expect(Value.Check(QaRunSchema,run)).toBe(true);s.words.artifacts.set(id,{run_id:runId,artifact_id:id,bytes,payload,metadata});
  return s.words.artifacts.get(id)!;
}

export function fixture(){
  const s=Object.assign(baseFixture(),{words:{artifacts:new Map(),holdMetadata:false,held:[],metadata:[],downloads:[]} as Words});
  for(const run of s.workspace.runs.filter(r=>r.operation==='answer')){
    for(const answer of run.result!.answers)answer.answer=longText(answer.question_id);
    registerWord(s,run.run_id);
  }
  return s;
}

/** Public-schema-only incomplete history, not a claim of a complete worker delivery. */
export function mixedMissingHistory(s:State,firstUnanswered=false){
  const run=historical(s),result=run.result!;
  result.answers=result.answers.filter(answer=>answer.question_id!==(firstUnanswered?'q2':'q7'));
  const draft=result.answers.find(answer=>answer.question_id==='q4')!;draft.status='draft';draft.missing_materials=['回答草稿仍待补充报告期明细及可定位依据。'];
  result.answers.reverse();registerWord(s);return run;
}

export function progress(s:State,state:'running'|'succeeded'){
  const accepted=[...s.accepted.values()].find(value=>value.run.operation==='answer')!;expect(accepted).toBeDefined();
  if(state==='running'){
    accepted.run.state='running';accepted.run.stage='model_generation';accepted.generic.state='running';accepted.generic.stage='model_generation';
  }else{
    Object.assign(accepted.run,completed(accepted.run.manifest,accepted.run.run_id,accepted.run.sequence));registerWord(s,accepted.run.run_id);
    accepted.generic.state='succeeded';accepted.generic.stage='completed';accepted.generic.artifact_id=accepted.run.artifact_id;
  }
  expect(Value.Check(QaRunSchema,accepted.run)).toBe(true);checked('RunResponse',accepted.generic);return accepted;
}

export async function install(page:Page,s=fixture()){
  await installBase(page,s);checked('QaWorkspaceResponse',s.workspace);
  await page.context().route('**/api/v1/artifacts/**',async intercepted=>{
    const request=intercepted.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length),method=request.method();
    s.calls.push({method,path,search:url.search});
    const match=path.match(/^\/artifacts\/([^/]+)(\/download)?$/),stored=match&&s.words.artifacts.get(match[1]);
    if(method!=='GET'||!stored||s.owner!==ownerId){s.unexpected.push(`${method} ${path}`);return intercepted.fulfill({status:404,json:{code:'NOT_FOUND'}});}
    if(match![2]){
      s.words.downloads.push(stored.artifact_id);return intercepted.fulfill({status:200,contentType:mime,body:stored.bytes});
    }
    s.words.metadata.push(stored.artifact_id);
    if(s.words.holdMetadata){s.words.holdMetadata=false;await new Promise<void>(resolve=>s.words.held.push({artifact_id:stored.artifact_id,release:resolve}));}
    const metadata=structuredClone(stored.metadata),other=word(s,otherAnswerId);
    if(s.words.fault==='artifact_id'){metadata.artifact_id=other.artifact_id;metadata.download_url=other.metadata.download_url;}
    if(s.words.fault==='run_id')metadata.run_id=other.run_id;
    checked('ArtifactResponse',metadata);return intercepted.fulfill({status:200,json:metadata});
  });
  return s;
}

export async function assertFixture(page:Page){await assertBaseFixture(page);}
