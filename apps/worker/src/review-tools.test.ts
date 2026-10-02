/** Synthetic run-local tools and adapter protocol tests; never calls a provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewFixture,syntheticReviewPack,syntheticRuleContext} from '../../../packages/domain/dist/review-test-fixtures.js';
import {reviewPromptRecordId} from './review-record-context.js';
import {reviewPromptRuleId} from './review-analysis-protocol.js';
import {loadReviewAuditKnowledge} from './review-knowledge.js';
import {callReviewTool,createReviewToolTrace,isReviewModelEnvelope,validateReviewToolTrace,type ReviewToolData} from './review-tools.js';
import {buildCodexArgs,DEFAULT_DISABLED_FEATURES,runContainedModelCall,type CodexAdapterConfig,type ContainedCallInput} from './codex-adapter.js';
import {MemoryCodexJournal} from './codex-memory-journal.js';

async function fixture():Promise<ReviewToolData>{
 const f=reviewFixture();f.addRecord('disclosed','合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入 100.00');
 f.addRecord('audit','合成甲公司 合并 原始报表 2025-01-01至2025-12-31 CNY 万元 营业收入 120.00',false);
 const records=f.records.map(r=>({...r,source_kind:r.material_id===f.ctx.source_material.material_id?'disclosure' as const:'audit' as const}));
 return {input:{input_hash:'f'.repeat(64),evidence:{...f.ctx,records},rule_context:null,rule_packs:[],formatting_requirements:[],requirements:[],
  scope:{mode:'full_review',finding_ids:[]},report_version:1,created_at:'2026-10-02T08:00:00Z',limitations:[]},knowledge:await loadReviewAuditKnowledge(),allowed_target_ids:[reviewPromptRecordId(records[0]!)]};
}
function readAll(data:ReviewToolData,trace:ReturnType<typeof createReviewToolTrace>){
 const listed=callReviewTool(data,'list_materials',{},trace) as {materials:{id:string}[]};
 for(const m of listed.materials)callReviewTool(data,'read_records',{material_id:m.id,offset:0},trace);
}
function observations(data:ReviewToolData){return data.input.evidence.records.map((r,i)=>{const citation={record_id:reviewPromptRecordId(r),quote:r.literal_quote};
 return {observation_id:'o'+i,source_record_id:citation.record_id,entity_id:'合成甲公司',metric:'营业收入',accounting_scope:'合并',basis:'原始报表',
  period:{start:'2025-01-01',end:'2025-12-31',as_of:null},currency:'CNY',unit:'万元',value:i?'120.00':'100.00',value_literal:i?'120.00':'100.00',value_refs:[citation],
  context_refs:{entity:[citation],period:[citation],accounting_scope:[citation],currency:[citation],unit:[citation],basis:[citation]}};});}

test('review reads pin complete Markdown ranges and bounded material pages',async()=>{
 const data=await fixture(),trace=createReviewToolTrace(data);assert.equal(trace.knowledge_read_complete,false);
 const first=callReviewTool(data,'read_knowledge',{offset:0,limit:10},trace) as any;assert.equal(first.markdown,data.knowledge.markdown.slice(0,10));
 assert.equal(trace.knowledge_read_complete,false);let offset=10;
 while(offset<data.knowledge.markdown.length){const page=callReviewTool(data,'read_knowledge',{offset,limit:30000},trace) as any;offset=page.end;}
 assert.equal(trace.knowledge_read_complete,true);readAll(data,trace);assert.equal(trace.read_record_ids.length,2);assert.equal(validateReviewToolTrace(data,trace),true);
 assert.throws(()=>callReviewTool(data,'read_knowledge',{offset:0,limit:30001},trace));
 assert.throws(()=>callReviewTool(data,'read_knowledge',{knowledge_id:'wrong'},trace));
 for(const args of [{material_id:'../../secrets',offset:0},{material_id:'m',offset:0,path:'C:/secrets'},{material_id:'m',offset:0,command:'shell'}])assert.throws(()=>callReviewTool(data,'read_records',args,trace));
 assert.throws(()=>callReviewTool(data,'exec',{command:'whoami'},trace));
});

test('financial tools reject unread evidence, run only selected rules and independently verify stored receipts',async()=>{
 const data=await fixture(),trace=createReviewToolTrace(data),args={observations:observations(data),calculations:[],audit_rule_ids:[]};
 assert.throws(()=>callReviewTool(data,'check_financial',args,trace),/unknown_citation/);readAll(data,trace);
 const result=callReviewTool(data,'check_financial',args,trace) as any;
 assert.ok(result.findings.some((f:any)=>f.conclusion==='error'&&f.suggested_change==='120.00'));
 assert.equal(result.coverage.some((c:any)=>c.check_id.startsWith('audit-reconciliation:')),false);
 assert.equal(validateReviewToolTrace(data,trace),true);assert.equal(trace.receipts[0]!.financial!.observations.length,2);
 const altered=structuredClone(trace);altered.receipts[0]!.evaluation.coverage[0]!.reason='fabricated pass';assert.equal(validateReviewToolTrace(data,altered),false);
 const alteredValue=structuredClone(trace);alteredValue.receipts[0]!.financial!.observations[0]!.value='999';assert.equal(validateReviewToolTrace(data,alteredValue),false);
 const notRead=structuredClone(trace);notRead.read_record_ids=[];assert.equal(validateReviewToolTrace(data,notRead),false);
 assert.throws(()=>callReviewTool(data,'check_financial',{...args,audit_rule_ids:['unknown']},trace),/RULE_UNKNOWN/);
 callReviewTool(data,'check_financial',{observations:[],calculations:[],audit_rule_ids:['audit-reconciliation-01']},trace);
 assert.equal(trace.receipts[1]!.evaluation.coverage.filter(c=>c.check_id.startsWith('audit-reconciliation:')).length,1);
 const other=structuredClone(data);other.input.input_hash='e'.repeat(64);assert.equal(validateReviewToolTrace(other,trace),false);
});

test('compliance and formatting tools check only explicit rules and permitted dimensions',async()=>{
 const data=await fixture(),{pack,ref}=await syntheticReviewPack();data.input.evidence.rules=[...data.input.evidence.rules,ref];data.input.rule_packs=[pack];data.input.rule_context=syntheticRuleContext;
 const trace=createReviewToolTrace(data);readAll(data,trace);
 const none=callReviewTool(data,'check_compliance',{assessments:[],rule_keys:[]},trace) as any;assert.deepEqual(none.coverage,[]);
 const selected=callReviewTool(data,'check_compliance',{assessments:[],rule_keys:[reviewPromptRuleId(ref)]},trace) as any;
 assert.equal(selected.coverage.length,1);assert.equal(selected.coverage[0].outcome,'uncovered');assert.equal(validateReviewToolTrace(data,trace),true);
 const scoped={...data,allowed_target_ids_by_dimension:{compliance:data.allowed_target_ids}};
 const scopedTrace=createReviewToolTrace(scoped);readAll(scoped,scopedTrace);
 assert.throws(()=>callReviewTool(scoped,'check_financial',{observations:observations(scoped),calculations:[]},scopedTrace),/DIMENSION_OUT_OF_SCOPE/);
 assert.throws(()=>callReviewTool(data,'check_compliance',{assessments:[],rule_keys:['L-unknown']},trace),/RULE_UNKNOWN/);
});

const fake=fileURLToPath(new URL('../test-fixtures/codex/fake-review-tools.mjs',import.meta.url));
async function setup(){const root=await mkdtemp(join(tmpdir(),'bb-review-adapter-'));const config:CodexAdapterConfig={command:[process.execPath,fake],model_id:'synthetic',model_provider:'synthetic',base_url:'https://example.invalid',wire_api:'responses',model_config_version:'synthetic-v1',reasoning_effort:null,credential:{kind:'env',name:'BB_SYNTHETIC_KEY'},work_root:join(root,'work'),timeout_ms:10000,kill_grace_ms:200,max_output_bytes:1<<20,max_schema_reasks:0,disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH??'/usr/bin:/bin'};return {root,config};}
function input(data:ReviewToolData,scenario='actual'):ContainedCallInput{return {owner_user_id:'synthetic-user',project_id:'synthetic-project',job_id:'synthetic-job',run_id:'synthetic-run',trace_id:'synthetic-run',logical_call_id:'synthetic-review',prompt_snapshot_ref:'synthetic-prompt',prompt:scenario,result_schema_version:'synthetic-review-v1',reviewTools:data,output:{kind:'json',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},validate:v=>!!v&&typeof v==='object'&&typeof (v as any).answer==='string'}};}

test('adapter trusts actual MCP persisted receipts and reuses their exact envelope without another send',async()=>{
 const data=await fixture(),{root,config}=await setup(),journal=new MemoryCodexJournal();
 try{const result=await runContainedModelCall(input(data),journal,config);assert.equal(result.status,'completed');assert.equal(result.reviewToolTrace!.knowledge_read_complete,true);
  assert.equal(result.reviewToolTrace!.read_record_ids.length,2);assert.equal(result.reviewToolTrace!.receipts.length,1);
  const saved=JSON.parse(journal.results.get(result.attempts[0]!.call_id)!.toString());assert.equal(isReviewModelEnvelope(saved,data),true);
  journal.prior={call_id:result.attempts[0]!.call_id,attempt_no:1,status:'completed',observed:true};journal.readCompleted=async()=>({value:saved,result_sha256:result.attempts[0]!.result_sha256!});
  const replay=await runContainedModelCall(input(data),journal,config);assert.equal(replay.status,'reused');assert.deepEqual(replay.reviewToolTrace,result.reviewToolTrace);assert.equal(replay.attempts.length,0);
  const other=structuredClone(data);other.allowed_target_ids=[];assert.equal((await runContainedModelCall(input(other),journal,config)).status,'needs_reconcile');
  assert.deepEqual(await readdir(config.work_root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('stdout claims cannot create trusted receipts; corrupt trace and unapproved tools fail closed',async()=>{
 const data=await fixture(),{root,config}=await setup();try{
  const claims=await runContainedModelCall(input(data,'stdout-only'),new MemoryCodexJournal(),config);assert.equal(claims.status,'completed');assert.equal(claims.reviewToolTrace!.receipts.length,0);assert.equal(claims.reviewToolTrace!.knowledge_read_complete,false);
  const corrupt=await runContainedModelCall(input(data,'corrupt'),new MemoryCodexJournal(),config);assert.equal(corrupt.error_code,'MODEL_OUTPUT_SCHEMA_INVALID');
  const denied=await runContainedModelCall(input(data,'forbidden'),new MemoryCodexJournal(),config);assert.equal(denied.error_code,'MODEL_TOOL_ATTEMPT_BLOCKED');
  const args=buildCodexArgs(config,{cwd:join(root,'cwd'),schemaFile:null,ephemeral:true,resumeThreadId:null,reviewDataFile:join(root,'cwd','review.json'),reviewTraceFile:join(root,'review-trace.json')});
  assert.ok(args.includes('mcp_servers.bb_review.required=true'));assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.throws(()=>buildCodexArgs(config,{cwd:join(root,'cwd'),schemaFile:null,ephemeral:true,resumeThreadId:null,reviewDataFile:join(root,'cwd','review.json'),reviewTraceFile:join(root,'cwd','trace.json')}));
 }finally{await rm(root,{recursive:true,force:true});}
});
