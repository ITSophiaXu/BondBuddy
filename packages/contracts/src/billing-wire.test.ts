import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeBillingDto,validateBillingDto,decodeLegacyBillingRequest,type BillingWireDto} from './billing-wire.js';

test('quote and scope explanations encode amounts without converting revisions or changing stored snapshots',()=>{
  const input={input_revision:4,quote:{points:123,amount_fen:123,units:1,scope_lines:[{quantity:2,unit_price_fen:100,amount_fen:123,
    pricing:{base_amount_fen:200,owned_coverage_fen:77,due_fen:123}}]},balance:{available:'9007199254740993',frozen:2n},shortage:0};
  const manifest={version:'project-qa-v1',points:123,revision:7},before=JSON.stringify(manifest),hash=createHash('sha256').update(before).digest('hex');
  const wire=encodeBillingDto('fixedQuoteResponse',input);
  assert.equal(wire.quote.points,'123');assert.equal(wire.quote.scope_lines[0].quantity,'2');assert.equal(wire.quote.scope_lines[0].pricing.due_fen,'123');
  assert.deepEqual(wire.balance,{available:'9007199254740993',frozen:'2'});assert.equal(wire.input_revision,4);assert.equal(input.quote.points,123);
  const qa=encodeBillingDto('qaWorkspace',{runs:[{manifest}],price:{points:123}});
  assert.equal(qa.runs[0].manifest.points,'123');assert.equal(qa.runs[0].manifest.revision,7);assert.equal(JSON.stringify(manifest),before);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),hash);
});
test('nested task progress, period hold breakdown and correction history retain full integer range',()=>{
  const max='9223372036854775807';
  const workspace=encodeBillingDto('projectFileWorkspace',{workspace:{tasks:[{credit_charge:{quote:{points:7},progress:{charged_points:max,active_ms:1200}}}]},price:{points:9}});
  assert.equal(workspace.workspace.tasks[0].credit_charge.progress.charged_points,max);assert.equal(workspace.workspace.tasks[0].credit_charge.progress.active_ms,1200);
  const account=encodeBillingDto('subscriptionAccount',{available_points:max,periods:[{points:21000,task_held_points:2,refund_held_points:3,cycle_index:1}]});
  assert.equal(account.periods[0].task_held_points,'2');assert.equal(account.periods[0].refund_held_points,'3');assert.equal(account.periods[0].cycle_index,1);
  const history=encodeBillingDto('consumptionHistory',{items:[{charged_points:max,corrected_points:1,scope_lines:[]}],page:{has_more:false}});
  assert.equal(history.items[0].corrected_points,'1');assert.doesNotThrow(()=>JSON.stringify({workspace,account,history}));
});
test('mixed file generation converts nested money without changing template pins, revisions or immutable input',()=>{
  const original={revision:4,preparation:{target_year:'2026',mappings:{entry:{sha256:'a'.repeat(64)}}},pricing:{workpaper_points:3458,document_points:null},batches:[{points:11423,workpapers:{total_points:3458,charged_points:'9007199254740993',revision:2,billing_resume:{required_points:3458,available_points:100,shortage:3358}},documents:{items:[{draft_version:3}]}}]};
  const before=JSON.stringify(original),wire=encodeBillingDto('fileGenerationWorkspace',original);
  assert.equal(wire.pricing.workpaper_points,'3458');assert.equal(wire.pricing.document_points,null);
  assert.equal(wire.batches[0].points,'11423');assert.equal(wire.batches[0].workpapers.billing_resume.shortage,'3358');assert.equal(wire.batches[0].workpapers.charged_points,'9007199254740993');
  assert.equal(wire.revision,4);assert.equal(wire.batches[0].documents.items[0].draft_version,3);assert.deepEqual(wire.preparation,original.preparation);assert.equal(JSON.stringify(original),before);
  const quotation=encodeBillingDto('fileGenerationQuote',{count:2,points:11423,documents:[{draft_version:3,points:7965,amount_fen:7965,scope_lines:[{quantity:1,unit_price_fen:7965,amount_fen:7965}]}]});
  assert.equal(quotation.documents[0].scope_lines[0].quantity,'1');assert.equal(quotation.documents[0].amount_fen,'7965');assert.equal(quotation.count,2);
});

test('raw requests reject numeric wire values before schema coercion and normalize bounded old hash inputs exactly',()=>{
  for(const bad of [123,'0123','1.5','-1','9223372036854775808'])assert.throws(()=>validateBillingDto('qaAnswerRequest',{expected_points:bad}));
  const raw={request_id:'same-request',expected_revision:4,expected_points:'123',price_version:'same-price'};
  const domain=decodeLegacyBillingRequest<Omit<typeof raw,'expected_points'>&{expected_points:number}>('qaAnswerRequest',raw);
  assert.equal(domain.expected_points,123);assert.equal(domain.expected_revision,4);assert.equal(raw.expected_points,'123');
  const old={...raw,expected_points:123};assert.equal(JSON.stringify(domain),JSON.stringify(old),'unchanged legacy canonical request can keep its existing hash');
  assert.throws(()=>decodeLegacyBillingRequest('qaAnswerRequest',{expected_points:'9007199254740993'}),'bounded old domain cannot be silently rounded');
});
test('refund null evidence and ordinary document quantities are not converted by field-name guessing',()=>{
  const input={original_points:52500,paid_amount_fen:null,refundable_points:100,refunds:[{amount_fen:95,credit_points:100}],
    document:{amount_fen:22,points:[1,2],quantity:3,page_count:10}};
  const result=encodeBillingDto('refundEligibility',input);
  assert.equal(result.paid_amount_fen,null);assert.equal(result.original_points,'52500');assert.equal(result.refunds[0].amount_fen,'95');
  assert.deepEqual(result.document,input.document);
  assert.throws(()=>encodeBillingDto('creditBalance',{available:9007199254740992,frozen:0}),'encoding must not hide an earlier lossy number');
});
test('only cumulative admin usage counts change; rates, durations and revision numbers keep their units',()=>{
  const input={jobs:{total:2,success_rate:0.5,duration_ms_avg:2.25},consumption:{all_attempts:{input_tokens:'9007199254740993',attempts:2}},by_model:[{attempts:2,input_tokens:100}],revision:3};
  const result=encodeBillingDto('adminMetrics',input);assert.equal(result.jobs.total,'2');assert.equal(result.jobs.success_rate,0.5);
  assert.equal(result.jobs.duration_ms_avg,2.25);assert.equal(result.consumption.all_attempts.attempts,'2');assert.equal(result.revision,3);
});

type Example=BillingWireDto<{quote:{points:number;input_revision:number};balance:{available:bigint;frozen:number};shortage:number},'fixedQuoteResponse'>;
const typedExample:Example={quote:{points:'1',input_revision:3},balance:{available:'2',frozen:'0'},shortage:'0'};
void typedExample;
// @ts-expect-error new public wire points cannot remain numeric
const invalidTypedExample:Example={quote:{points:1,input_revision:3},balance:{available:'2',frozen:'0'},shortage:'0'};
void invalidTypedExample;
