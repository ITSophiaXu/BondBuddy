import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewContext, ReviewExecutionRequest, ReviewMessageDraft } from '@bondbuddy/contracts';
import { contextKey, executionIdentity, readDraftCache, saveDraftCache } from './review-state.js';
import { evidenceHtml, rulesHtml } from './review-presentation.js';

const pin={material_id:'material-a',material_version:1,sha256:'a'.repeat(64)};
const context:ReviewContext={project_id:'project-a',report_id:'report-v1',finding_ids:['F2','F1'],material_refs:[pin]};
test('draft identity pins report and material version while ignoring selection order',()=>{
  assert.equal(contextKey(context),contextKey({...context,finding_ids:['F1','F2']}));
  assert.notEqual(contextKey(context),contextKey({...context,report_id:'report-v2'}));
  assert.notEqual(contextKey(context),contextKey({...context,material_refs:[{...pin,material_version:2}]}));
  assert.notEqual(contextKey(context),contextKey({...context,project_id:'project-b'}));
});
test('browser recovery is owner/project scoped and rejects malformed or foreign refs',()=>{
  const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
  const draft:ReviewMessageDraft={context,content:'本条说明',version:1,updated_at:'2026-10-02T10:00:00Z'};
  assert.ok(saveDraftCache(storage,'owner-a','project-a',[draft]));
  assert.deepEqual(readDraftCache(storage,'owner-a','project-a'),[draft]);
  assert.deepEqual(readDraftCache(storage,'owner-b','project-a'),[]);
  assert.deepEqual(readDraftCache(storage,'owner-a','project-b'),[]);
  data.set('bb-review-drafts:owner-a:project-a',JSON.stringify([draft,{...draft,context:{...context,project_id:'other'}},{...draft,context:{...context,material_refs:[{...pin,sha256:'bad'}]}}]));
  assert.deepEqual(readDraftCache(storage,'owner-a','project-a'),[draft]);
});
test('execution identity changes with operation, input, report, plan and selected set',()=>{
  const base:Omit<ReviewExecutionRequest,'execution_request_id'>={operation:'revision',expected_input_version:3,source_report_id:'r1',expected_plan_version:2,finding_ids:['F2','F1']};
  assert.equal(executionIdentity(base),executionIdentity({...base,finding_ids:['F1','F2']}));
  for(const change of [{operation:'differential_review' as const},{expected_input_version:4},{source_report_id:'r2'},{expected_plan_version:3},{finding_ids:['F1']}])assert.notEqual(executionIdentity(base),executionIdentity({...base,...change}));
});
test('model evidence and rule references cannot inject HTML or executable links',()=>{
  const evidence=evidenceHtml([{material_id:'m',material_version:1,material_sha256:'a'.repeat(64),parse_snapshot_id:'s',parse_response_sha256:'b'.repeat(64),record_id:'r',record_sha256:'c'.repeat(64),locator_type:'text_line',locator:{line:1},quote:'<img src=x onerror=alert(1)>',extraction_method:'native_text',uncertainty:[]}],'');
  assert.ok(evidence.includes('&lt;img'));assert.ok(!evidence.includes('<img'));
  const html=rulesHtml({rule_refs:[{rule_id:'r',rule_version:'1',pack_id:'p',pack_version:'1',pack_sha256:'a'.repeat(64),source_id:'s',source_version:'1',source_sha256:'a'.repeat(64),quote:'example',locator:'section',effective_from:null,effective_to:null,applicability:'unknown',authority:'internal_method',url:'javascript:alert(1)'}]} as Parameters<typeof rulesHtml>[0]);
  assert.ok(!html.includes('href='));assert.ok(html.includes('核对方法'));
});
