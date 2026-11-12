// Synthetic controller seam; browser scenarios independently exercise the actual rendered execution area.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { emptyUpdateDetails, type FirstDraftExclusionsResponse } from '@bondbuddy/contracts';
import { ApiError } from './api.js';
import * as decision from './first-draft-confirmation.js';

function controller() {
  const source=readFileSync(new URL('../src/project-execution.ts',import.meta.url),'utf8'),exports:Record<string,any>={};
  runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,require:(name:string)=>name==='./first-draft-confirmation'?decision:name==='./api'?{ApiError,friendlyError:()=> 'Synthetic error'}:
      {executionTaskKind:()=> 'generation',sourceProspectusInputGaps:()=>[]},AbortController,URLSearchParams,location:{hash:''},setTimeout,clearTimeout});
  const materials=[{material_id:'finance',material_version:1,role:'financial',sha256:'b'.repeat(64)}];
  const fields={market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',target_reporting_periods:[{end:'2025-09-30'}]}};
  const draft={project:{project_id:'project',kind:'generation',draft_revision:1,...fields},fields,dirty:false,state:'saved',valid:true,save:async()=>true};
  const messages={version:1,content_sha256:'c'.repeat(64),message_ids:[]};
  const versions={project_id:'project',selection_revision:0,current_version_id:null,versions:[],inactive_material_ids:[]};
  let preview:FirstDraftExclusionsResponse={project_id:'project',draft_revision:1,project_kind:'generation',scope:'project_undeleted_historical_versions',
    excluded_historical:[{material_id:'history',material_version:1,sha256:'a'.repeat(64),filename:'Synthetic historical.docx'}]};
  const writes:any[]=[],reads:string[]=[];
  const api={prospectusVersions:async()=>{reads.push('versions');return versions;},firstDraftExclusions:async()=>{reads.push('exclusions');return preview;},
    createInputRevision:async(_id:string,input:any)=>{writes.push(input);if(!input.first_draft_confirmation)throw new ApiError(409,'FIRST_DRAFT_CONFIRMATION_REQUIRED');
      return {project_id:'project',input_revision:1,input_hash:'d'.repeat(64)};}};
  const execution=new exports.ProjectExecution(api,draft,{flush:async()=>true,currentRef:async()=>messages,refresh:async()=>{}});
  execution.render=()=>{};execution.materialReady=true;execution.materials=materials;
  execution.start=async()=>execution.save();
  return {execution,draft,api,versions,writes,reads,materials,setPreview:(p:FirstDraftExclusionsResponse)=>{preview=p;},getPreview:()=>preview};
}

test('API requirement offers a review; only a distinct click reads again and submits exact pins without client actor/time',async()=>{
  const f=controller();await f.execution.save();
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].first_draft_confirmation,undefined);
  assert.equal(f.execution.firstDraftReview.exclusions.excluded_historical[0].filename,'Synthetic historical.docx');
  const reads=f.reads.filter(v=>v==='exclusions').length;
  await f.execution.confirmFirstDraft();
  assert.equal(f.reads.filter(v=>v==='exclusions').length,reads+1);
  assert.equal(f.writes.length,2);
  assert.equal(JSON.stringify(f.writes[1].first_draft_confirmation),JSON.stringify({decision:'generate_first_draft',scope:'project_undeleted_historical_versions',
    excluded_historical:[{material_id:'history',material_version:1,sha256:'a'.repeat(64)}]}));
  assert.equal(f.execution.firstDraftConfirmation,undefined);
});

test('changed exclusion set is displayed and requires a second click before any new input is submitted',async()=>{
  const f=controller();await f.execution.save();
  f.setPreview({...f.getPreview(),excluded_historical:[{material_id:'history',material_version:2,sha256:'e'.repeat(64),filename:'New historical.docx'}]});
  await f.execution.confirmFirstDraft();assert.equal(f.writes.length,1);
  assert.equal(f.execution.firstDraftReview.exclusions.excluded_historical[0].material_version,2);
  await f.execution.confirmFirstDraft();assert.equal(f.writes.length,2);
  assert.equal(f.writes[1].first_draft_confirmation.excluded_historical[0].material_version,2);
});

test('target, material hash/role and adopted selection changes invalidate the unsubmitted decision',async()=>{
  for(const change of ['target','hash','role','selection'] as const){
    const f=controller();await f.execution.save();
    if(change==='target')f.draft.fields.update_details.target_reporting_periods[0].end='2025-12-31';
    if(change==='hash')f.materials[0].sha256='e'.repeat(64);
    if(change==='role')f.materials[0].role='historical';
    if(change==='selection')f.execution.readAdoptedVersion=()=>({origin:'generated',artifact_id:'clean'});
    await f.execution.confirmFirstDraft();assert.equal(f.writes.length,1,change);assert.equal(f.execution.firstDraftReview,undefined,change);
  }
});

test('context changed during confirmation lookup cannot confirm or lock input',async()=>{
  const f=controller();await f.execution.save();
  f.api.firstDraftExclusions=async()=>{f.draft.fields.update_details.target_reporting_periods[0].end='2025-12-31';return f.getPreview();};
  await f.execution.confirmFirstDraft();assert.equal(f.writes.length,1);assert.equal(f.execution.firstDraftConfirmation,undefined);
});

test('update and newly adopted baselines never expose a first-draft review',async()=>{
  for(const mode of ['update','adopted'] as const){
    const f=controller();if(mode==='update')f.draft.project.kind='update';else f.versions.current_version_id='adopted' as any;
    await f.execution.save();assert.equal(f.execution.firstDraftReview,undefined);assert.equal(f.writes.length,1);
    await f.execution.confirmFirstDraft();assert.equal(f.writes.length,1);
  }
});

test('preview rejects foreign/stale scope, empty sets, duplicate pins and malformed hashes',()=>{
  const f=controller(),preview=f.getPreview();
  assert.ok(decision.checkedFirstDraftExclusions(preview,'project',1));
  for(const bad of [{...preview,project_id:'foreign'},{...preview,draft_revision:2},{...preview,project_kind:'update'},
    {...preview,scope:'latest_only'},{...preview,excluded_historical:[]},{...preview,excluded_historical:[...preview.excluded_historical,...preview.excluded_historical]},
    {...preview,excluded_historical:[{...preview.excluded_historical[0],sha256:'bad'}]}])assert.equal(decision.checkedFirstDraftExclusions(bad,'project',1),null);
});
