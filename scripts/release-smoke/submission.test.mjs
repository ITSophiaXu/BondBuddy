import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainSubmissionRequest,retainSubmissionReceipt,acceptedQuote} from './submission.mjs';
import {assertSubmissionCanStart} from './journey-state.mjs';
const url='http://localhost:5288/api/v1/projects/p/qa/runs';
const request={request_id:'req1',expected_points:'8526',price_version:'v4',scope_quote_id:'scope1'};
const quote={points:'8526',price_version:'v4',scope_quote_id:'scope1'};
test('lost receipt preserves actual bytes and blocks automatic resubmission',()=>{
 const entry={id:'qa-dongying'};let saves=0;
 retainSubmissionRequest(entry,{url,body:JSON.stringify(request)},()=>saves++);
 assert.equal(saves,1);assert.throws(()=>assertSubmissionCanStart(entry),/no resolved receipt/);
 assert.throws(()=>retainSubmissionRequest(entry,{url,body:JSON.stringify({...request,request_id:'req2'})}),/changed/);
 assert.equal(entry.submissionRequest.identity,'req1');assert.ok(entry.submissionConflict);
});
test('accepted run survives missing quote and later evidence failure',()=>{
 const entry={id:'qa-dongying'};retainSubmissionRequest(entry,{url,body:JSON.stringify(request)});
 retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run1'}});
 assert.equal(entry.runId,'run1');assert.throws(()=>acceptedQuote(entry),/No captured/);
 entry.quoteCaptures=[{status:200,body:quote}];assert.equal(acceptedQuote(entry).runId,'run1');
});
test('quote matching rejects wrong points and conflicting receipts',()=>{
 const entry={id:'qa-dongying',quoteCaptures:[{status:200,body:{...quote,points:'8527'}}]};
 retainSubmissionRequest(entry,{url,body:JSON.stringify(request)});retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run1'}});
 assert.throws(()=>acceptedQuote(entry),/No captured/);
 assert.throws(()=>retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run2'}}),/Conflicting/);
});

test('failed preview cannot supply acceptance evidence',()=>{
 const entry={id:'qa-dongying',quoteCaptures:[{status:500,body:quote}]};retainSubmissionRequest(entry,{url,body:JSON.stringify(request)});retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run1'}});assert.throws(()=>acceptedQuote(entry),/No captured/);
});

test('the persisted quote for the release gate is the accepted capture, never the latest unrelated preview',()=>{
 const entry={id:'qa-dongying',quoteCaptures:[{status:200,body:quote},{status:200,body:{...quote,points:'9999',scope_quote_id:'other'}}]};
 retainSubmissionRequest(entry,{url,body:JSON.stringify(request)});retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run1'}});
 const accepted=acceptedQuote(entry);assert.deepEqual(entry.quoteResponse,quote);assert.equal(entry.quoteResponse.points,accepted.points);assert.notEqual(entry.quoteResponse,quote);
 entry.quoteCaptures[0].body={...quote,points:'8527'};assert.throws(()=>acceptedQuote(entry),/No captured/);assert.deepEqual(entry.quoteResponse,quote);
});
