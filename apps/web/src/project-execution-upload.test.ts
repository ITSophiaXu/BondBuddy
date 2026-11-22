import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Exercise the real submission controller with an intentionally stale render.
// The upload queue can change while an asynchronous save or request hash runs.
function controller(readBlock:()=>string, request:()=>Promise<unknown>=async()=>({})) {
  const source=readFileSync(new URL('../src/project-execution.ts',import.meta.url),'utf8');
  const exports:Record<string,any>={};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:()=>({executionRequest:request,executionTaskKind:()=> 'update',sourceProspectusInputGaps:()=>[]}),AbortController,URLSearchParams,location:{hash:''},setTimeout,clearTimeout});
  const messages={version:1,content_sha256:'messages',message_ids:[]};
  const draft={project:{project_id:'synthetic',kind:'update',market:'sse',offering:'private'},state:'saved',valid:true,dirty:false,
    fields:{market:'sse',offering:'private',update_details:{authoring_mode:'unified_v1',target_reporting_periods:[{}]}},save:async()=>true};
  const execution=new exports.ProjectExecution({},draft,{flush:async()=>true,currentRef:async()=>messages},undefined,undefined,'',undefined,undefined,readBlock);
  execution.render=()=>{};execution.action=async(work:()=>Promise<void>)=>work();
  execution.materialReady=true;execution.materials=[{material_id:'saved',material_version:1}];
  execution.selected=true;execution.selectedMessages=messages;execution.input={};execution.preflight={status:'ready'};
  return {execution,draft};
}

test('a stale enabled snapshot cannot start while the live upload queue is incomplete',async()=>{
  let pending='新报表.pdf：正在传输 50%';
  const {execution}=controller(()=>pending);
  let checks=0;execution.execute=async()=>{checks++;};
  assert.equal(execution.startBlock().reason,pending);
  await execution.start();assert.equal(checks,0);
  pending='新报表.pdf：已发送 100%，正在保存…';
  await execution.start();assert.equal(checks,0);
  pending='';await execution.start();assert.equal(checks,1);
});

test('an upload beginning during draft save prevents locking a partial input',async()=>{
  let pending='';const {execution,draft}=controller(()=>pending);
  draft.save=async()=>{pending='等待新材料保存';return true;};
  let inputs=0;execution.api={createInputRevision:async()=>{inputs++;throw new Error('partial input');}};
  await execution.save();assert.equal(inputs,0);
});

test('an upload beginning during version lookup prevents locking a partial input',async()=>{
  let pending='';const {execution}=controller(()=>pending);
  let inputs=0;
  execution.api={prospectusVersions:async()=>{pending='等待新材料保存';return {selection_revision:1};},
    createInputRevision:async()=>{inputs++;throw new Error('partial input');}};
  await execution.save();assert.equal(inputs,0);
});

test('an upload beginning during execution request preparation prevents submission',async()=>{
  let pending='';
  const {execution}=controller(()=>pending,async()=>{pending='等待新材料保存';return {execution_request_id:'synthetic'};});
  let submissions=0;execution.submitExecution=async()=>{submissions++;};
  await execution.execute();assert.equal(submissions,0);assert.equal(execution.pendingExecution,undefined);
  pending='';execution.readMaterialBlock=()=>'';
  await execution.execute();assert.equal(submissions,1);
});
