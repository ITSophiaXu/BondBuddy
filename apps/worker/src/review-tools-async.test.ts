/** Synthetic lease-safe receipt replay; no provider or customer material. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { reviewPromptRecordId } from './review-record-context.js';
import { callReviewTool, createReviewToolTrace, reviewModelEnvelopeAsync, validateReviewToolTrace,
  validateReviewToolTraceAsync, type ReviewToolData } from './review-tools.js';

function fixture(recordCount=2,receiptCount=8){
  const f=reviewFixture();
  for(let i=0;i<recordCount;i++)f.addRecord(`synthetic-${i}`,`Synthetic disclosure paragraph ${i}: 100.00`,true,
    {parse_snapshot_id:'synthetic-parse',parse_response_sha256:'b'.repeat(64)});
  const records=f.records.map(r=>({...r,source_kind:'disclosure' as const}));
  const markdown='Synthetic review method.';
  const data:ReviewToolData={input:{input_hash:'f'.repeat(64),evidence:{...f.ctx,records},rule_context:null,rule_packs:[],
    formatting_requirements:[],requirements:[],scope:{mode:'full_review',finding_ids:[]},report_version:1,
    created_at:'2026-10-04T00:00:00Z',limitations:[]},knowledge:{id:'synthetic',version:'synthetic-v1',sourceSHA:'a'.repeat(64),
    contentSHA:createHash('sha256').update(markdown).digest('hex'),markdown},allowed_target_ids:records.map(reviewPromptRecordId)};
  const trace=createReviewToolTrace(data);
  const materials=callReviewTool(data,'list_materials',{},trace) as {materials:{id:string}[]};
  for(const material of materials.materials){
    let offset:number|null=0;
    while(offset!==null)offset=(callReviewTool(data,'read_records',{material_id:material.id,offset,limit:300},trace) as {next_offset:number|null}).next_offset;
  }
  callReviewTool(data,'check_financial',{observations:[],calculations:[],audit_rule_ids:[]},trace);
  // Identical explicit requests are legitimate separate tool calls. Replay verifies
  // every cloned receipt independently; only the host-generated UUID differs.
  const receipt=trace.receipts[0]!;
  trace.receipts=Array.from({length:receiptCount},()=>({...structuredClone(receipt),receipt_id:`receipt-${randomUUID()}`}));
  return {data,trace};
}

test('async replay verifies every receipt while permitting the lease timer to run',async()=>{
  const {data,trace}=fixture(400,40);
  assert.equal(validateReviewToolTrace(data,trace),true);
  let timerRan=false;
  const timer=setTimeout(()=>{timerRan=true;},0);
  try{
    assert.equal(await validateReviewToolTraceAsync(data,trace),true);
    assert.equal(timerRan,true,'receipt replay must yield to timers, not only microtasks');
    const envelope={version:'review-model-envelope-v1' as const,output:{summary:'synthetic'},tool_trace:trace};
    assert.equal(await reviewModelEnvelopeAsync(envelope,data),envelope);
  }finally{clearTimeout(timer);}
});

test('async replay rejects changed pins and every altered receipt without a cached verdict',async()=>{
  const {data,trace}=fixture();
  assert.equal(await validateReviewToolTraceAsync(data,trace),true);
  for(const index of [0,trace.receipts.length-1]){
    const altered=structuredClone(trace);
    altered.receipts[index]!.arguments_sha256='0'.repeat(64);
    assert.equal(validateReviewToolTrace(data,altered),false);
    assert.equal(await validateReviewToolTraceAsync(data,altered),false);
  }
  data.input.evidence.records[0]!.literal_quote='Changed immutable source.';
  assert.equal(validateReviewToolTrace(data,trace),false);
  assert.equal(await validateReviewToolTraceAsync(data,trace),false);
  assert.equal(await reviewModelEnvelopeAsync('invalid envelope',data),null);
});

test('mutation during a yield cannot turn previously checked metadata into trusted evidence',async()=>{
  const {data,trace}=fixture();
  const mutation=setImmediate(()=>{trace.input_hash='e'.repeat(64);});
  try{assert.equal(await validateReviewToolTraceAsync(data,trace),false);}finally{clearImmediate(mutation);}
  const fresh=fixture();
  const dataMutation=setImmediate(()=>{fresh.data.input.requirements.push('Changed after validation began.');});
  try{assert.equal(await validateReviewToolTraceAsync(fresh.data,fresh.trace),false);}finally{clearImmediate(dataMutation);}
});

test('cancelled receipt replay stops between checks and never returns a trusted envelope',async()=>{
  const {data,trace}=fixture(400,40),abort=new AbortController();
  const timer=setTimeout(()=>abort.abort(),0);
  try{
    assert.equal(await validateReviewToolTraceAsync(data,trace,abort.signal),false);
    assert.equal(await reviewModelEnvelopeAsync({version:'review-model-envelope-v1',output:{},tool_trace:trace},data,abort.signal),null);
  }finally{clearTimeout(timer);}
});
