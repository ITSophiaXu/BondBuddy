import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePublicReview, publicReviewCategories, publicComparisonMaterials, reviewPublicStage, verifiedSearchSources, type PublicAnalysis } from './review-public-stage.js';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { isReviewReport, type ReviewReport } from '@bondbuddy/contracts';
import { reviewPromptRecordId, type ReviewAnalysisInput } from './review-model-stage.js';
import type { StageContext } from './run-pipeline.js';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { CodexAdapterConfig } from './codex-adapter.js';
import { callMaterialTool, createMaterialToolTrace, type MaterialToolData, type MaterialModelEnvelope } from './authoring-material-tools.js';
import { recordMaterialToolRead } from './material-tool-trace.js';

test('actual query or opened URL alone never proves returned source content', () => {
  const time = '2026-10-02T00:00:00Z';
  assert.equal(verifiedSearchSources([{ observed_at: time, item: { id: 'query', type: 'web_search', query: 'source', action: { type: 'open_page', url: 'https://example.invalid', text: 'This is a request, not evidence' } } }]).size, 0);
  assert.equal(verifiedSearchSources([{ observed_at: time, item: { id: 'fake', type: 'agent_message', result: { url: 'https://example.invalid', text: 'Model claims a source' } } }]).size, 0);
  const sources = verifiedSearchSources([{ observed_at: time, item: { id: 'tool', type: 'web_search', results: [{ url: 'https://example.invalid', title: 'Actual tool response (synthetic)', snippet: 'Returned evidence' }] } }]);
  assert.deepEqual(sources.get('https://example.invalid'), { id: 'tool', time, text: 'Returned evidence', title: 'Actual tool response (synthetic)', published_at: null });
});

const publicContext = { issuer: '合成甲公司', as_of: '2026-10-02' };
function fixture(recordCount = 1) {
  const f = reviewFixture(); f.observation('disclosure','100.00');
  for (let i=1;i<recordCount;i++) f.addRecord(`other-${i}`,`Synthetic source paragraph ${i}.`);
  const input: ReviewAnalysisInput = { input_hash:'a'.repeat(64), evidence:{ ...f.ctx, records:f.records.map(r=>({...r,source_kind:'disclosure' as const})) },
    rule_context:null,rule_packs:[],formatting_requirements:[],requirements:[],scope:{mode:'full_review',finding_ids:[]},report_version:1,created_at:'2026-10-02T00:00:00Z',limitations:[] };
  const report: ReviewReport = { report_id:f.ctx.report_id, project_id:f.ctx.project_id,run_id:'synthetic',input_revision:1,version:1,
    source_material:f.ctx.source_material,scope:input.scope,findings:[],coverage:[],limitations:[],created_at:input.created_at };
  const quote = '合成甲公司于2026年9月1日公告发生一项诉讼。';
  const events = [{ observed_at:'2026-10-02T00:00:00Z', item:{ type:'web_search',id:'real-tool-event-synthetic',results:[{url:'https://example.invalid/source',title:'Synthetic official notice',text:quote,published_at:'2026-09-01'}] } }];
  const check: PublicAnalysis['checks'][number] = {category:'litigation_penalties',conclusion:'conflict',description:'Synthetic conflict for regression',urls:['https://example.invalid/source'],source_record_ids:[reviewPromptRecordId(input.evidence.records[0]!)],
    sources:[{url:'https://example.invalid/source',title:'Model title ignored',quote,entity:publicContext.issuer,entity_match:'confirmed',published_at:'2026-09-01'}]};
  return {input,report,events,check};
}

test('public comparison requires returned text, exact current source pins, entity and applicable publication date',()=>{
  const {input,report,events,check}=fixture();
  const merged=mergePublicReview(report,{checks:[check]},events,input,undefined,publicContext);
  assert(isReviewReport(merged));assert.equal(merged.findings[0]?.conclusion,'conflict');assert.equal(merged.findings[0]?.public_sources?.[0]?.title,'Synthetic official notice');
  assert.equal(merged.coverage.find(c=>c.check_id==='public:litigation_penalties')?.outcome,'issue');
  assert(merged.coverage.filter(c=>c.check_id!=='public:litigation_penalties').every(c=>c.outcome==='uncovered'));
  for(const changed of [
    {...check,source_record_ids:[input.evidence.records[0]!.record_id]},
    {...check,sources:[{...check.sources[0]!,entity:'同名另一公司'}]},
    {...check,sources:[{...check.sources[0]!,published_at:'2026-10-03'}]},
    {...check,sources:[{...check.sources[0]!,published_at:null}]},
  ]) assert.equal(mergePublicReview(report,{checks:[changed]},events,input,undefined,publicContext).findings[0]?.conclusion,'needs_evidence');
  const fabricated={...check,sources:[{...check.sources[0]!,quote:'Model fabricated a quote'}]};
  assert.equal(mergePublicReview(report,{checks:[fabricated]},events,input,undefined,publicContext).findings.length,0);
});

test('consistent or no-results cannot become a public risk-free pass; repeated findings are deduplicated',()=>{
  const {input,report,events,check}=fixture();
  const repeated=mergePublicReview(report,{checks:[check,check]},events,input,undefined,publicContext);assert.equal(repeated.findings.length,1);assert(isReviewReport(repeated));
  const consistent=mergePublicReview(report,{checks:[{...check,conclusion:'consistent'}]},events,input,undefined,publicContext);
  assert(!consistent.coverage.some(c=>c.outcome==='pass'));assert.equal(consistent.findings.length,0);
  const absent=mergePublicReview(report,{checks:[{...check,conclusion:'no_results',sources:[]}]},events,input,undefined,publicContext);
  assert(absent.coverage.every(c=>c.outcome==='uncovered'));
});

test('differential public scope preserves the old concern when search is unavailable',()=>{
  const {input,report,events,check}=fixture();const old=mergePublicReview(report,{checks:[check]},events,input,undefined,publicContext);
  const nextInput={...input,evidence:{...input.evidence,report_id:'next'},scope:{mode:'differential_review' as const,finding_ids:[old.findings[0]!.finding_id]},previous_report:old,report_version:2};
  const next={...report,report_id:'next',version:2,scope:nextInput.scope};
  assert.deepEqual(publicReviewCategories(nextInput),['litigation_penalties']);
  const merged=mergePublicReview(next,null,[],nextInput,'Tool unavailable',publicContext);
  assert(isReviewReport(merged));assert.equal(merged.findings[0]?.origin_report_id,old.report_id);assert.equal(merged.findings[0]?.check_status,'carried_forward');
  assert.deepEqual(merged.coverage.map(c=>c.check_id),['public:litigation_penalties',`scope:${old.findings[0]!.finding_id}`]);
  assert(merged.coverage.every(c=>c.outcome==='uncovered'));
});

function stageContext(input: ReviewAnalysisInput, report: ReviewReport, events: ReturnType<typeof fixture>['events'], attempts: Record<string,unknown>[] = []): StageContext {
  return {run:{id:'synthetic',owner_user_id:input.evidence.owner_user_id,project_id:report.project_id,input_revision:1,input_hash:input.input_hash},
    checkpoint:{},values:new Map([['model_generation',{report,input}]]),signal:new AbortController().signal,
    pool:{query:async(sql:string)=>({rows:sql.includes('bb_input_revisions')?[{manifest:{issuer_name:publicContext.issuer,review:{input:{as_of:publicContext.as_of}}}}]
      :sql.includes('bb_model_call_attempts')?attempts:[{events,content_sha256:inputManifestHash(events)}]})}} as unknown as StageContext;
}
function comparisonEnvelope(data: MaterialToolData, output: PublicAnalysis, readCount = 1): MaterialModelEnvelope {
  const trace=createMaterialToolTrace(data);
  if(readCount)recordMaterialToolRead(trace,'read_records',callMaterialTool(data,'read_records',{material_id:data.materials[0]!.id,offset:0,limit:readCount}));
  return {version:'material-tool-result-v1',model_output:output,tool_trace:trace};
}
async function enabled<T>(work:()=>Promise<T>):Promise<T>{
  const original=process.env.BB_REVIEW_WEB_SEARCH_ENABLED;process.env.BB_REVIEW_WEB_SEARCH_ENABLED='1';
  try{return await work();}finally{if(original===undefined)delete process.env.BB_REVIEW_WEB_SEARCH_ENABLED;else process.env.BB_REVIEW_WEB_SEARCH_ENABLED=original;}
}

test('search receives only public issuer context; offline comparison exposes read tools and failures preserve other dimensions',async()=>enabled(async()=>{
  const {input,report,events,check}=fixture();input.requirements=['PRIVATE-REQUIREMENT'];input.evidence.records[0]!.literal_quote+=' PRIVATE-SOURCE';
  const ctx=stageContext(input,report,events);
    let calls=0;const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async context=>{
      calls++;const prompt=await options.buildPrompt(context);const configuration=typeof options.config==='function'?options.config():options.config;
      if(calls===1){assert.equal(configuration.web_search,'live');assert(!prompt.includes('PRIVATE-'));assert.equal(options.materialTools,undefined);return {kind:'done',value:{checks:[{...check,source_record_ids:[]}]}};}
      assert.equal(configuration.web_search,'disabled');assert(!prompt.includes('PRIVATE-SOURCE'));
      assert(!prompt.includes('You have no shell, file, network or tool access'),'material tools must be permitted by the outer prompt');
      assert(options.materialTools?.materials[0]?.records[0]?.text.includes('PRIVATE-SOURCE'));assert.equal(options.materialToolsTrace,true);
      return {kind:'fail',code:'VALIDATION_FAILED'};
    }})});
    const outcome=await stage.run(ctx);assert.equal(outcome.kind,'done');assert.equal(calls,2);
    if(outcome.kind==='done'){assert(isReviewReport(outcome.value));assert((outcome.value as ReviewReport).coverage.every(c=>c.outcome==='uncovered'));}
    const failed=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>({kind:'pause',stage:'provider_reconcile',reason:'unknown'})})});
    assert.deepEqual(await failed.run(ctx),{kind:'pause',stage:'provider_reconcile',reason:'unknown'});
}));

test('large source uses one durable comparison call; CLI reads are bounded and unread coverage stays explicit',async()=>enabled(async()=>{
  const {input,report,events,check}=fixture(260),ctx=stageContext(input,report,events),calls:string[]=[];
  const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>{
    calls.push(options.logicalCallId);
    if(options.logicalCallId==='m3-public-search-v2')return {kind:'done',value:{checks:[{...check,source_record_ids:[]}]}};
    assert.equal(options.materialTools?.materials[0]?.records.length,260);
    assert(options.validate({checks:[check]}));
    return {kind:'done',value:comparisonEnvelope(options.materialTools!,{checks:[check]})};
  }})});
  const result=await stage.run(ctx);assert.equal(result.kind,'done');assert.deepEqual(calls,['m3-public-search-v2','m3-public-compare-v2']);
  if(result.kind==='done'){
    const report=result.value as ReviewReport;assert(isReviewReport(report));assert.equal(report.findings[0]?.conclusion,'conflict');
    const reading=report.coverage.find(c=>c.check_id==='public:reading-coverage');assert.equal(reading?.outcome,'uncovered');assert(reading?.reason.includes('实际读取 1 条，未读 259 条'));
  }
}));

test('comparison rejects forged public quotes, invented source records and citations never read by the CLI',async()=>enabled(async()=>{
  for(const kind of ['forged_quote','invented_record','unread','changed_tool_data'] as const){
    const {input,report,events,check}=fixture(),ctx=stageContext(input,report,events);
    const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>{
      if(options.logicalCallId==='m3-public-search-v2')return {kind:'done',value:{checks:[{...check,source_record_ids:[]}]}};
      const output={checks:[structuredClone(check)]};
      if(kind==='forged_quote')output.checks[0]!.sources[0]!.quote='Fabricated tool quotation';
      if(kind==='invented_record')output.checks[0]!.source_record_ids=['forged'];
      if(kind==='forged_quote'||kind==='invented_record')assert.equal(options.validate(output),false);
      const envelope=comparisonEnvelope(options.materialTools!,output,kind==='unread'?0:1);
      if(kind==='changed_tool_data')envelope.tool_trace.data_sha256='b'.repeat(64);
      return {kind:'done',value:envelope};
    }})});
    assert.deepEqual(await stage.run(ctx),{kind:'fail',code:'VALIDATION_FAILED'},kind);
  }
}));

test('differential comparison tools expose only selected current targets and reject unrelated categories or records',async()=>enabled(async()=>{
  const {input,report,events,check}=fixture(2),old=mergePublicReview(report,{checks:[check]},events,input,undefined,publicContext);
  const nextInput={...input,evidence:{...input.evidence,report_id:'next'},scope:{mode:'differential_review' as const,finding_ids:[old.findings[0]!.finding_id]},previous_report:old,report_version:2};
  const next={...report,report_id:'next',version:2,scope:nextInput.scope},ctx=stageContext(nextInput,next,events);
  const data=publicComparisonMaterials(nextInput,next);assert.equal(data.materials[0]?.records.length,1);assert.equal(data.materials[0]?.records[0]?.id,check.source_record_ids[0]);
  const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>{
    if(options.logicalCallId==='m3-public-search-v2')return {kind:'done',value:{checks:[{...check,source_record_ids:[]}]}};
    assert.equal(options.validate({checks:[{...check,category:'entity_control'}]}),false);
    assert.equal(options.validate({checks:[{...check,source_record_ids:[reviewPromptRecordId(input.evidence.records[1]!)]}]}),false);
    assert.throws(()=>callMaterialTool(options.materialTools!,'read_records',{material_id:'outside-scope',offset:0}));
    return {kind:'done',value:comparisonEnvelope(options.materialTools!,{checks:[check]})};
  }})});
  const result=await stage.run(ctx);assert.equal(result.kind,'done');if(result.kind==='done'){
    const current=result.value as ReviewReport;
    assert(current.findings.some(f=>f.finding_id===old.findings[0]!.finding_id&&f.conclusion==='conflict'));
    assert(!current.coverage.some(c=>c.outcome==='pass'),'a new comparison never automatically clears the original public concern');
  }
}));

test('legacy calls replay original identities; mixed protocols and unknown attempts never start a new call',async()=>enabled(async()=>{
  const {input,report,events,check}=fixture();
  for(const state of ['legacy','mixed','unknown'] as const){
    const ctx=stageContext(input,report,events,state==='legacy'?[]:[{logical_call_id:state==='mixed'?'m3-public-compare-v2':'m3-public-search',status:state==='unknown'?'pending_reconcile':'completed'}]);
    ctx.checkpoint.public_review_prompt={snapshot_id:'legacy-prompt'};
    const calls:string[]=[];
    const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>{
      calls.push(options.logicalCallId);return {kind:'done',value:{checks:[{...check,source_record_ids:options.logicalCallId==='m3-public-search'?[]:check.source_record_ids}]}};
    }})});
    const result=await stage.run(ctx);
    if(state==='legacy'){assert.equal(result.kind,'done');assert.deepEqual(calls,['m3-public-search','m3-public-compare-0']);}
    else{assert.equal(result.kind,'pause');assert.deepEqual(calls,[]);}
  }
}));

test('changed v2 prompt snapshots pause without issuing fresh provider work',async()=>enabled(async()=>{
  const {input,report,events}=fixture(),ctx=stageContext(input,report,events);
  ctx.checkpoint.public_search_v2_previous_prompt={snapshot_id:'previous'};let calls=0;
  const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>{calls++;return {kind:'fail',code:'UNEXPECTED_CALL'};}})});
  assert.deepEqual(await stage.run(ctx),{kind:'pause',stage:'capability_not_ready',reason:'public_review_snapshot_changed'});assert.equal(calls,0);
}));

test('unchanged v2 stage replay consumes the same completed search and traced comparison results',async()=>enabled(async()=>{
  const {input,report,events,check}=fixture(),ctx=stageContext(input,report,events),saved=new Map<string,unknown>();
  let providerCalls=0;
  // A completed-model seam stands in for the durable adapter, which independently tests its stored-envelope reuse.
  const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async context=>{
    if(!saved.has(options.logicalCallId)){
      providerCalls++;
      saved.set(options.logicalCallId,options.logicalCallId==='m3-public-search-v2'?{checks:[{...check,source_record_ids:[]}]}
        :comparisonEnvelope(options.materialTools!,{checks:[check]}));
      context.checkpoint[`${options.name}_prompt`]={snapshot_id:`snapshot-${options.logicalCallId}`};
    }
    return {kind:'done',value:saved.get(options.logicalCallId)};
  }})});
  const first=await stage.run(ctx);assert.equal(first.kind,'done');assert.equal(providerCalls,2);
  if(first.kind==='done')ctx.checkpoint.model_generation={public_review:first.checkpoint};
  const replay=await stage.run(ctx);assert.deepEqual(replay,first);assert.equal(providerCalls,2);
  input.evidence.records[0]!.literal_quote+=' Changed after checkpoint';
  assert.deepEqual(await stage.run(ctx),{kind:'pause',stage:'capability_not_ready',reason:'public_review_snapshot_changed'});
  assert.equal(providerCalls,2);
}));

test('completed unavailable search remains unavailable when environment later enables search',async()=>{
  const {input,report,events}=fixture(),ctx=stageContext(input,report,events),original=process.env.BB_REVIEW_WEB_SEARCH_ENABLED;let calls=0;
  const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>{calls++;return {kind:'fail',code:'UNEXPECTED_CALL'};}})});
  try{
    delete process.env.BB_REVIEW_WEB_SEARCH_ENABLED;
    const first=await stage.run(ctx);assert.equal(first.kind,'done');if(first.kind!=='done')return;
    ctx.checkpoint.model_generation={public_review:first.checkpoint};process.env.BB_REVIEW_WEB_SEARCH_ENABLED='1';
    assert.deepEqual(await stage.run(ctx),first);assert.equal(calls,0);
  }finally{if(original===undefined)delete process.env.BB_REVIEW_WEB_SEARCH_ENABLED;else process.env.BB_REVIEW_WEB_SEARCH_ENABLED=original;}
});
