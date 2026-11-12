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
 entry.quoteCaptures=[{body:quote}];assert.equal(acceptedQuote(entry).runId,'run1');
});
test('quote matching rejects wrong points and conflicting receipts',()=>{
 const entry={id:'qa-dongying',quoteCaptures:[{body:{...quote,points:'8527'}}]};
 retainSubmissionRequest(entry,{url,body:JSON.stringify(request)});retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run1'}});
 assert.throws(()=>acceptedQuote(entry),/No captured/);
 assert.throws(()=>retainSubmissionReceipt(entry,{url,status:202,body:{run_id:'run2'}}),/Conflicting/);
});
