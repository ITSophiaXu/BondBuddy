import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { emptyUpdateDetails, executableRevisionFinding, isReviewRevisionPin, type ReviewEvidenceRef,
  type ReviewFinding, type ReviewReport, type ReviewRevisionPin } from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { unifiedInputGate, type UnifiedInput } from './unified-input.js';
import { revisionFindingGroups, unifiedModelGenerationStage, type UnifiedPlan } from './unified-model-stage.js';
import { unifiedWordDeliveryStage } from './unified-word-stage.js';
import type { InputRevisionRow, RunRow, StageContext } from './run-pipeline.js';

/** All issuer names, source records and model outputs in this file are synthetic. */
function fixture() {
  const material = (id:string,role:string,texts:string[]) => ({pin:{material_id:id,material_version:1,role,sha256:(id==='source'?'a':'b').repeat(64)},
    filename:`合成${id}`,mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:`private/${id}`,
    records:texts.map((literal_quote,i)=>({record_id:`${id}-${i}`,material_id:id,material_version:1,content_hash:(id==='source'?'a':'b').repeat(64),
      locator_type:'docx_block' as const,locator:{path:[{paragraph:i+1}],stable_ref:`docx:p${i+1}`},literal_quote,context:'synthetic',
      extraction_method:'native_text' as const,extractor_version:'synthetic',confidence:1,uncertainty:[] as string[],formatting:{}}))});
  const source=material('source','historical',['净资产100万元。','摘要：净资产合计100万元。','待明确口径。','排除条款保留。']);
  const audit=material('audit','audit',['本发行人合并口径净资产120万元。']);
  const ref=(m:typeof source,i:number):ReviewEvidenceRef=>({material_id:m.pin.material_id,material_version:1,material_sha256:m.pin.sha256,
    parse_snapshot_id:`parse-${m.pin.material_id}`,parse_response_sha256:'c'.repeat(64),record_id:m.records[i]!.record_id,
    record_sha256:inputManifestHash(m.records[i]),locator_type:'docx_block',locator:m.records[i]!.locator,quote:m.records[i]!.literal_quote,
    extraction_method:'native_text',uncertainty:[]});
  const finding:ReviewFinding={finding_id:'F-1',report_id:'report',dimension:'financial',conclusion:'error',severity:'P1',title:'合成净资产差异',
    description:'正文与摘要均应核对已提供合并报表。',target_refs:[ref(source,0),ref(source,1)],evidence_refs:[ref(audit,0)],
    suggested_change:'依据合成审计材料将净资产100万元更正为120万元。',limitations:[],
    repairability:{can_revise:true,reason:'同主体同期间审计证据与关联位置已齐备。',allowed_record_ids:['source-0','source-1']},
    origin_report_id:'report',check_status:'rechecked'};
  const pending:ReviewFinding={...structuredClone(finding),finding_id:'F-2',conclusion:'conflict',target_refs:[ref(source,2)],
    repairability:{can_revise:false,reason:'口径存在冲突。',allowed_record_ids:[]},limitations:['需先确认合并/母公司口径。']};
  const excluded:ReviewFinding={...structuredClone(pending),finding_id:'F-3',target_refs:[ref(source,3)]};
  const sourcePin={material_id:'source',material_version:1,sha256:source.pin.sha256};
  const report:ReviewReport={report_id:'report',project_id:'project',run_id:'review-run',input_revision:1,version:1,source_material:sourcePin,
    scope:{mode:'full_review',finding_ids:[]},findings:[finding,pending,excluded],coverage:[],limitations:[],created_at:'2026-10-02T00:00:00.000Z'};
  const planBody={plan_id:'accepted-plan',version:1,accepted_at:'2026-10-02T01:00:00.000Z',source_report_id:'report',
    finding_ids:['F-1','F-2'],excluded_findings:[{finding_id:'F-3',reason:'用户明确本轮保留。'}],requirements:['仅修订明确选定的范围。']};
  const plan={...planBody,sha256:inputManifestHash(planBody)};
  const pin:ReviewRevisionPin={version:'review-revision-v1',owner_user_id:'owner',project_id:'project',source_material:sourcePin,
    source_report:{report_id:'report',run_id:'review-run',version:1,input_revision:1,sha256:inputManifestHash(report)},
    accepted_plan:{plan_id:plan.plan_id,version:plan.version,sha256:plan.sha256,accepted_at:plan.accepted_at},
    selected_findings:[finding,pending],excluded_findings:plan.excluded_findings,requirements:plan.requirements,limitations:[]};
  const input:UnifiedInput={manifest:{issuer_name:'合成发行人',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},
    materials:[source.pin,audit.pin],authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[],
      knowledge_status:'authoring_reference_not_compliance_approval',review_revision:pin}},materials:[source,audit],requirements:[]};
  const inputHash=inputManifestHash(input.manifest);
  const run={id:'revision-run',owner_user_id:'owner',project_id:'project',input_revision:2,input_hash:inputHash,task_kind:'update'} as RunRow;
  const revision={manifest:input.manifest,input_hash:inputHash,draft_revision:1,material_versions:input.manifest.materials,
    rule_pack_version:null,template_version:null} as InputRevisionRow;
  const queries:{sql:string;values:unknown[]}[]=[];
  const db={query:async(sql:string,values:unknown[])=>{
    queries.push({sql,values});
    if(sql.includes('FROM bb_review_reports'))return {rows:[{run_id:report.run_id,version:report.version,content_sha256:pin.source_report.sha256,report}]};
    if(sql.includes('FROM bb_review_revision_plans'))return {rows:[{content_sha256:plan.sha256,accepted_at:new Date(plan.accepted_at),plan}]};
    if(sql.includes('FROM bb_material_versions'))return {rows:[input.manifest.materials.find(m=>m.material_id===values[2])]};
    throw new Error(`Unexpected query: ${sql}`);
  }} as unknown as Pool;
  const context={run,pool:db,values:new Map(),checkpoint:{},signal:new AbortController().signal} as StageContext;
  return {input,pin,report,plan,finding,source,audit,run,revision,db,queries,context};
}

test('revision input pins canonical immutable report and explicit accepted plan without M1 period/knowledge requirements',async()=>{
  const f=fixture();
  assert.equal(isReviewRevisionPin(f.pin),true);
  assert.equal(await unifiedInputGate(f.db,f.run,f.revision),null);
  assert.deepEqual(f.queries[0]!.values,['report','owner','project',1]);
  assert.deepEqual(f.queries[1]!.values,['accepted-plan','owner','project',1]);
  assert.equal(f.plan.sha256,inputManifestHash(Object.fromEntries(Object.entries(f.plan).filter(([key])=>key!=='sha256'))));
});

test('revision rejects another owner, stale report content, changed accepted selection and alternate baseline',async()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.pin.owner_user_id='other';},
    (f:ReturnType<typeof fixture>)=>{f.report.findings[0]!.description='tampered';},
    (f:ReturnType<typeof fixture>)=>{f.plan.finding_ids=['F-2'];},
    (f:ReturnType<typeof fixture>)=>{f.pin.source_material.material_id='alternate';},
    (f:ReturnType<typeof fixture>)=>{f.input.manifest.authoring.previous_output={artifact_id:'other',version:1,sha256:'a'.repeat(64),run_id:'old',input_revision:1};},
  ]) {
    const f=fixture();mutate(f);f.revision.input_hash=f.run.input_hash=inputManifestHash(f.input.manifest);
    assert.deepEqual(await unifiedInputGate(f.db,f.run,f.revision),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
  }
});

test('repairability never upgrades conflict, OCR, missing evidence or unknown rule applicability',()=>{
  const f=fixture();assert.equal(executableRevisionFinding(f.finding),true);
  for(const mutate of [
    (v:ReviewFinding)=>{v.conclusion='conflict';},
    (v:ReviewFinding)=>{v.evidence_refs[0]!.extraction_method='ocr';},
    (v:ReviewFinding)=>{v.target_refs[0]!.uncertainty=['OCR_UNCONFIRMED'];},
    (v:ReviewFinding)=>{v.evidence_refs=[];},
    (v:ReviewFinding)=>{v.repairability.allowed_record_ids=['foreign-record'];},
  ]) {const changed=structuredClone(f.finding);mutate(changed);assert.equal(executableRevisionFinding(changed),false);}
});

test('revision changes only exact accepted baseline and preserves original report with independent handling',async()=>{
  const f=fixture(), originalReport=structuredClone(f.report), originalPin=structuredClone(f.pin);
  // The authoring fallback would otherwise prefer a project output. It must not be selected here.
  f.input.materials.unshift({...f.source,pin:{...f.source.pin,material_id:'unrelated-output',role:'project_output'}});
  const prompts:string[]=[];
  const stage=unifiedModelGenerationStage({load:async()=>f.input,model:options=>({name:options.name,run:async context=>{
    prompts.push(await options.buildPrompt(context));
    assert.equal(options.logicalCallId,'review-revision-v1-0');
    const payload=JSON.parse(prompts[0]!.split('输入数据：\n')[1]!);
    assert.equal(payload.source_material.material_id,'source');
    assert.equal(payload.findings.length,1);assert.equal(payload.findings[0].finding_id,'F-1');
    const value={reviewed:['r0','r1'],edits:[
      {record_id:'r0',after:'净资产120万元。',evidence:['e0'],pending:[],finding_ids:['F-1']},
      {record_id:'r1',after:'摘要：净资产合计120万元。',evidence:['e0'],pending:[],finding_ids:['F-1']}],
      additions:[],handling:[{finding_id:'F-1',status:'modified',reason:'已依据同期间审计材料同步修改正文和摘要。',evidence:['e0']}],summary:['同步修订净资产两处引用。']};
    assert.equal(options.validate(value),true);
    assert.equal(options.validate({...value,reviewed:['r0']}),false);
    assert.equal(options.validate({...value,edits:[{...value.edits[0],record_id:'foreign'}]}),false);
    assert.equal(options.validate({...value,edits:[{...value.edits[0],evidence:['requirements']}]}),false);
    assert.equal(options.validate({...value,edits:[{...value.edits[0],finding_ids:['F-2']}]}),false);
    assert.equal(options.validate({...value,handling:[{...value.handling[0],status:'not_modified'}]}),false);
    return {kind:'done',value};
  }})});
  const outcome=await stage.run(f.context);assert.equal(outcome.kind,'done');
  if(outcome.kind!=='done')return;
  const plan=outcome.value as UnifiedPlan;
  assert.equal(plan.source?.pin.material_id,'source');assert.equal(plan.calls,1);
  assert.deepEqual(plan.edits.map(edit=>edit.record_id),['source/source-0','source/source-1']);
  assert.deepEqual(plan.edits[0]!.evidence,['audit/audit-0']);
  assert.equal(plan.revision_handling?.items.find(item=>item.finding_id==='F-1')?.status,'modified');
  assert.equal(plan.revision_handling?.items.find(item=>item.finding_id==='F-2')?.status,'needs_evidence');
  assert.equal(plan.revision_handling?.items.find(item=>item.finding_id==='F-3')?.status,'not_modified');
  assert.ok(plan.revision_handling?.items.every(item=>item.review_passed===false));
  assert.deepEqual(f.report,originalReport);assert.deepEqual(f.pin,originalPin);
});

test('no executable or real changes never deliver an empty revision; unknown provider outcome is not replayed by the stage',async()=>{
  const f=fixture();let calls=0;
  const stage=unifiedModelGenerationStage({load:async()=>f.input,model:options=>({name:options.name,run:async()=>{calls++;
    return {kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'};}})});
  f.pin.selected_findings=[f.pin.selected_findings[1]!];
  assert.deepEqual(await stage.run(f.context),{kind:'pause',stage:'capability_not_ready',reason:'revision_no_executable_changes'});assert.equal(calls,0);
  f.pin.selected_findings=[f.finding];
  assert.deepEqual(await stage.run(f.context),{kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'});assert.equal(calls,1);
  const noChanges=unifiedModelGenerationStage({load:async()=>f.input,model:options=>({name:options.name,run:async()=>({kind:'done',value:{
    reviewed:['r0','r1'],edits:[],additions:[],handling:[{finding_id:'F-1',status:'needs_evidence',reason:'正文存在未说明的口径差异，保留原文。',evidence:['e0']}],summary:[]}})})});
  assert.deepEqual(await noChanges.run(f.context),{kind:'pause',stage:'capability_not_ready',reason:'revision_no_verified_changes'});
});

test('overlapping sources merge transitively into one deterministic revision group',()=>{
  const f=fixture();
  const a={...structuredClone(f.finding),finding_id:'A',evidence_refs:[{...f.finding.evidence_refs[0]!,record_id:'one'}]};
  const b={...structuredClone(f.finding),finding_id:'B',target_refs:[{...f.finding.target_refs[0]!,record_id:'other'}],evidence_refs:[{...f.finding.evidence_refs[0]!,record_id:'two'}]};
  const c={...structuredClone(b),finding_id:'C',evidence_refs:[a.evidence_refs[0]!,b.evidence_refs[0]!]};
  assert.deepEqual(revisionFindingGroups([b,a,c]).map(group=>group.map(item=>item.finding_id)),[['A','B','C']]);
});

test('Word delivery rejects an expanded source scope before blob access or process execution',async()=>{
  const f=fixture();
  const plan:UnifiedPlan={version:'unified-plan-v1',input_hash:f.run.input_hash,source:f.source,edits:[{record_id:'source/source-3',after:'越界修改',evidence:['audit/audit-0'],pending:[]}],
    additions:[],blocks:[],summary:[],reviewed:1,calls:1,input:f.input,
    revision_handling:{version:'review-revision-handling-v1',source_report:f.pin.source_report,source_material:f.pin.source_material,
      accepted_plan:f.pin.accepted_plan,items:[{finding_id:'F-1',report_id:'report',status:'modified',reason:'合成',locations:[],evidence_refs:[],review_passed:false}],limitations:[],review_passed:false}};
  f.context.values.set('model_generation',plan);
  assert.deepEqual(await unifiedWordDeliveryStage().run(f.context),{kind:'fail',code:'INPUT_REVISION_CONFLICT'});
});
