import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fiveFlowFixture} from './evidence-fixtures.mjs';
import {verifyReport} from './verify.mjs';
const now=Date.now(),expected={commit:'a'.repeat(40),tree:'b'.repeat(40),inspectorSha256:'c'.repeat(64)};
const fixture=()=>fiveFlowFixture(expected,new Date(now-1000).toISOString(),Object.fromEntries(['api','worker','web'].map(target=>[target,{id:'sha256:'+'d'.repeat(64),platform:'linux/amd64'}])));
test('five flows require their own quote, billing, artifact and repeat-download proof',()=>{
 assert.doesNotThrow(()=>verifyReport(fixture(),expected,now));
 for(let i=0;i<5;i++)for(const mutate of [
  entry=>delete entry.artifactEvidence,entry=>delete entry.billingEvidence,entry=>delete entry.refreshEvidence,
  entry=>delete entry.accepted,entry=>delete entry.quoteResponse,entry=>entry.billingEvidence.held='1',
  entry=>entry.billingEvidence.walletDeltaVerified=false,entry=>entry.billingEvidence.charged='1',
  entry=>entry.billingEvidence.reservations[0].net='0',entry=>entry.refreshEvidence.sameTask=false,
  entry=>entry.billingEvidence.reservations[0].priceVersion='wrong-version',
  entry=>delete entry.billingPageEvidence,entry=>entry.billingPageEvidence.records=[],
  entry=>entry.billingPageEvidence.frozen='1',entry=>entry.billingPageEvidence.records[0].runId='another-run',
  entry=>delete entry.refreshEvidence.billingPage,entry=>entry.refreshEvidence.billingPage.available='999',
  entry=>delete entry.modelEvidence,entry=>entry.modelEvidence.summary.attempts++,
  entry=>entry.modelEvidence.raw.owner_id='another-owner',
  entry=>entry.refreshEvidence.billing.unchanged=false,entry=>entry.refreshEvidence.downloads[0].sha256='f'.repeat(64),
  entry=>entry.artifactEvidence.downloads[0].inspection.status='failed',
  entry=>{entry.downloads[1].path=entry.downloads[0].path;entry.artifactEvidence.downloads[1].path=entry.downloads[0].path;},
  entry=>{entry.downloads.splice(1,1);entry.artifactEvidence.downloads.splice(1,1);},
 ]){const report=fixture();mutate(report.cases[i]);assert.throws(()=>verifyReport(report,expected,now));}
 for(let i=0;i<4;i++)for(const mutate of [
  e=>e.billingEvidence.reservations[0].quoteId='other-quote',
  e=>{e.accepted.points='999';const q=i<2?e.quoteResponse.quote:e.quoteResponse;q.points='999';e.billingEvidence.acceptedPoints='999';},
 ]){const report=fixture();mutate(report.cases[i]);assert.throws(()=>verifyReport(report,expected,now));}
});
test('model evidence preserves unknown usage and zero-call official integrity observations',()=>{
 const report=fixture(),entry=report.cases[0],attempt=entry.modelEvidence.raw.attempts[0];
 attempt.usage_present=false;attempt.usage_status=null;
 for(const field of ['input_tokens','output_tokens','cached_input_tokens','reasoning_tokens'])attempt[field]=null;
 // Rebuild only the synthetic snapshot's normalized projection, as the real
 // collector does; the gate must reject any independently rewritten totals.
 return import('./model-quality-evidence.mjs').then(({validateModelEvidence})=>{
  entry.modelEvidence=validateModelEvidence(entry.modelEvidence.raw,{ownerId:report.ownerId,runIds:[entry.runId]});
  assert.equal(entry.modelEvidence.summary.inputTokens.total,null);
  assert.equal(report.cases[3].modelEvidence.summary.attempts,0);
  assert.doesNotThrow(()=>verifyReport(report,expected,now));
  entry.modelEvidence.summary.inputTokens.total='0';
  assert.throws(()=>verifyReport(report,expected,now));
 });
});
test('legacy schema, unpinned inspector, mixed platform and missing immutable completion reject',()=>{
 for(const mutate of [r=>delete r.schema,r=>r.schema='release-three-flow-v1',r=>delete r.completedAt,r=>r.modelMode='mock',
  r=>r.artifactInspector.sha256='f'.repeat(64),r=>r.artifactInspector.imageId='sha256:'+'f'.repeat(64),
  r=>r.artifactInspector.sha='f'.repeat(40),r=>r.images.worker.platform='linux/arm64']){
  const report=fixture();mutate(report);assert.throws(()=>verifyReport(report,expected,now));
 }
});
test('all five workpaper mappings and nested DOCX checks are mandatory',()=>{
 for(const mutate of [
  e=>e.expectedWorkpapers.pop(),e=>e.expectedWorkpapers[0].archivePath='可生成文件/../outside.docx',
  e=>e.expectedWorkpapers[0].sha256='f'.repeat(64),e=>e.expectedWorkpapers[1].entryId=e.expectedWorkpapers[0].entryId,
  e=>e.artifactEvidence.downloads[0].inspection.members.pop(),
  e=>e.artifactEvidence.downloads[0].inspection.members[4].inspection.bodyCharacters=0,
  e=>e.artifactEvidence.downloads[0].inspection.members[4].inspection.checks.ooxml_relationships='not_run',
  e=>e.artifactEvidence.downloads[0].inspection.regularFiles=6,
 ]){const report=fixture();mutate(report.cases[4]);assert.throws(()=>verifyReport(report,expected,now));}
});
test('completion timestamps cannot be renewed by replaying a passed suite',()=>{
 const report=fixture(),old=now-25*60*60*1000;
 report.startedAt=new Date(old-1000).toISOString();for(const entry of report.cases)entry.finishedAt=new Date(old).toISOString();
 report.completedAt=report.finishedAt=report.lastAttemptFinishedAt=new Date(now).toISOString();
 assert.throws(()=>verifyReport(report,expected,now),/expired/);
});
test('update needs original mechanical quality and rendered pages without inventing human acceptance',()=>{
 for(const mutate of [e=>delete e.qualityEvidence,e=>e.qualityEvidence.humanAcceptance='passed',e=>e.qualityEvidence.reportSha256='f'.repeat(64),
  e=>e.qualityEvidence.runId='another-run',e=>e.qualityEvidence.artifacts.clean.sha256='f'.repeat(64),
  e=>e.qualityEvidence.report.document_size_check.page_check.status='not_run',e=>e.qualityEvidence.pageCount.clean=1,
  e=>e.qualityEvidence.report.factual_accuracy='verified',
 ]){const report=fixture();mutate(report.cases[0]);assert.throws(()=>verifyReport(report,expected,now));}
});
test('zero model calls cannot hide missing or duplicated official integrity observations',()=>{
 for(const mutate of [e=>delete e.integrityVerifiedPairs,e=>e.integrityVerifiedPairs=[],e=>e.integrityVerifiedPairs.push(e.integrityVerifiedPairs[0])]){
  const report=fixture();mutate(report.cases[3]);assert.throws(()=>verifyReport(report,expected,now));
 }
});
