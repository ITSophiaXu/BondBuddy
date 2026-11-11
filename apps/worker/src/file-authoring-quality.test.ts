import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWordQuality, parseWordQualityReport } from './file-authoring-quality.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';

const python=!!(process.env.BONDBUDDY_TEST_PYTHON||process.env.BONDBUDDY_WORD_PYTHON);
test('quality process status and report findings must agree before a pass can be accepted',()=>{
  const valid={version:'word-quality-v1',status:'passed',issues:[],metrics:{},limitations:[]};
  assert.equal(parseWordQualityReport(JSON.stringify(valid),false).status,'passed');
  for(const [report,rejected] of [[{...valid,issues:['WORD_SOURCE_CONTENT_LOST']},false],
    [{...valid,status:'failed'},false],[valid,true],[{...valid,issues:null},false]] as const)
    assert.throws(()=>parseWordQualityReport(JSON.stringify(report),rejected),/WORD_QUALITY_REPORT_INVALID/);
  for(const invalid of ['null','{malformed'])assert.throws(()=>parseWordQualityReport(invalid,false),/WORD_QUALITY_REPORT_INVALID/);
});
test('host quality accepts a valid identical first-draft pair without claiming factual or visual review',{skip:!python},async()=>{
  const bytes=makeWorkerDocxFixture({externalLink:false,text:'合成首次编制全文。'});
  const report=await verifyWordQuality({data:{input_hash:'a'.repeat(64),baseline_kind:'none'},tracked:bytes,clean:bytes});
  assert.equal(report.status,'passed',JSON.stringify(report));
  assert.ok(report.limitations.length);
});
test('host quality rejects unequal clean text even when the provider completed and both ZIPs exist',{skip:!python},async()=>{
  const tracked=makeWorkerDocxFixture({externalLink:false,text:'合成新版净资产120万元。'});
  const clean=makeWorkerDocxFixture({externalLink:false,text:'合成旧版净资产100万元。'});
  const report=await verifyWordQuality({data:{baseline_kind:'none'},tracked,clean});
  assert.equal(report.status,'failed');assert.match(JSON.stringify(report.issues),/WORD_ACCEPT_MISMATCH/);
});
test('host quality rejects the 104-to-39 content-collapse regression against the locked source',{skip:!python},async()=>{
  const parts=Array.from({length:104},(_,i)=>`第${i+1}项合成发行人的原有业务风险、法定条款和财务信息均应按本轮范围逐项保留。`);
  // Real OOXML paragraphs: newlines inside one w:t are only prose shortening.
  const baseline=makeWorkerDocxFixture({externalLink:false,paragraphs:parts});
  const truncated=makeWorkerDocxFixture({externalLink:false,paragraphs:parts.slice(0,39)});
  const report=await verifyWordQuality({data:{baseline_kind:'uploaded_source',revision_author:'BondBuddy-synthetic'},
    baseline,tracked:truncated,clean:truncated});
  assert.equal(report.status,'failed');assert.match(JSON.stringify(report.issues),/WORD_SOURCE_CONTENT_REDUCED/);
  assert.equal((report.metrics.baseline as {nonempty_paragraphs:number}).nonempty_paragraphs,104);
  assert.equal((report.metrics.output as {nonempty_paragraphs:number}).nonempty_paragraphs,39);
});
test('host quality reports corrupt packages as a failed check instead of accepting their magic bytes',{skip:!python},async()=>{
  const broken=Buffer.from('PK synthetic corrupt package');
  const report=await verifyWordQuality({data:{baseline_kind:'none'},tracked:broken,clean:broken});
  assert.equal(report.status,'failed');assert.ok(report.issues.length);
});
