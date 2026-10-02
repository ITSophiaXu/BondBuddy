import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePublicReview, publicReviewCategories, reviewPublicStage, verifiedSearchSources, type PublicAnalysis } from './review-public-stage.js';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { isReviewReport, type ReviewReport } from '@bondbuddy/contracts';
import { reviewPromptRecordId, type ReviewAnalysisInput } from './review-model-stage.js';
import type { StageContext } from './run-pipeline.js';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { CodexAdapterConfig } from './codex-adapter.js';

test('actual query or opened URL alone never proves returned source content', () => {
  const time = '2026-10-02T00:00:00Z';
  assert.equal(verifiedSearchSources([{ observed_at: time, item: { id: 'query', type: 'web_search', query: 'source', action: { type: 'open_page', url: 'https://example.invalid', text: 'This is a request, not evidence' } } }]).size, 0);
  assert.equal(verifiedSearchSources([{ observed_at: time, item: { id: 'fake', type: 'agent_message', result: { url: 'https://example.invalid', text: 'Model claims a source' } } }]).size, 0);
  const sources = verifiedSearchSources([{ observed_at: time, item: { id: 'tool', type: 'web_search', results: [{ url: 'https://example.invalid', title: 'Actual tool response (synthetic)', snippet: 'Returned evidence' }] } }]);
  assert.deepEqual(sources.get('https://example.invalid'), { id: 'tool', time, text: 'Returned evidence', title: 'Actual tool response (synthetic)', published_at: null });
});

const publicContext = { issuer: '合成甲公司', as_of: '2026-10-02' };
function fixture() {
  const f = reviewFixture(); f.observation('disclosure','100.00');
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

test('search receives only public issuer context; private comparison disables tools and failures preserve other dimensions',async()=>{
  const {input,report,events,check}=fixture();input.requirements=['PRIVATE-REQUIREMENT'];input.evidence.records[0]!.literal_quote+=' PRIVATE-SOURCE';
  const ctx={run:{id:'synthetic',owner_user_id:input.evidence.owner_user_id,project_id:report.project_id,input_revision:1},values:new Map([['model_generation',{report,input}]]),signal:new AbortController().signal,
    pool:{query:async(sql:string)=>({rows:sql.includes('bb_input_revisions')?[{manifest:{issuer_name:publicContext.issuer,review:{input:{as_of:publicContext.as_of}}}}]:[{events,content_sha256:inputManifestHash(events)}]})}} as unknown as StageContext;
  const original=process.env.BB_REVIEW_WEB_SEARCH_ENABLED;process.env.BB_REVIEW_WEB_SEARCH_ENABLED='1';
  try {
    let calls=0;const stage=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async context=>{
      calls++;const prompt=await options.buildPrompt(context);const configuration=typeof options.config==='function'?options.config():options.config;
      if(calls===1){assert.equal(configuration.web_search,'live');assert(!prompt.includes('PRIVATE-'));return {kind:'done',value:{checks:[{...check,source_record_ids:[]}]}};}
      assert.equal(configuration.web_search,'disabled');assert(prompt.includes('PRIVATE-SOURCE'));
      return {kind:'fail',code:'VALIDATION_FAILED'};
    }})});
    const outcome=await stage.run(ctx);assert.equal(outcome.kind,'done');assert.equal(calls,2);
    if(outcome.kind==='done'){assert(isReviewReport(outcome.value));assert(!(outcome.value as ReviewReport).coverage.some(c=>c.outcome==='pass'));}
    const failed=reviewPublicStage({config:()=>({} as CodexAdapterConfig),model:options=>({name:options.name,run:async()=>({kind:'pause',stage:'provider_reconcile',reason:'unknown'})})});
    const failedOutcome=await failed.run(ctx);assert.equal(failedOutcome.kind,'done');if(failedOutcome.kind==='done')assert((failedOutcome.value as ReviewReport).coverage.every(c=>c.outcome==='uncovered'));
  } finally { if(original===undefined)delete process.env.BB_REVIEW_WEB_SEARCH_ENABLED;else process.env.BB_REVIEW_WEB_SEARCH_ENABLED=original; }
});
