import {test} from 'node:test';
import assert from 'node:assert/strict';
import {posix} from 'node:path';
import {CASES,SAMPLE_REF,verdict,caseCompletionTime,contained,assertLocalContext,assertTestReport} from './support.mjs';

test('suite completion is the latest actual journey completion, independent of later resume attempts',()=>{
 const first='2026-11-09T10:00:00.000Z',last='2026-11-09T11:00:00.000Z';
 const cases=CASES.map((id,i)=>({id,status:'passed',finishedAt:i===0?last:first}));
 assert.equal(caseCompletionTime(cases),Date.parse(last));
 assert.equal(caseCompletionTime([...cases].reverse()),Date.parse(last));
 for(const value of [undefined,null,0,'','invalid'])assert.throws(()=>caseCompletionTime([{...cases[0],finishedAt:value},...cases.slice(1)]),/timestamps/);
 assert.throws(()=>caseCompletionTime([]),/timestamps/);
});
test('a missing, failed, skipped or blocked journey never grants release readiness',()=>{
 const good=CASES.map(id=>({id,status:'passed'}));assert.equal(verdict(good),'passed');
 for(const state of ['failed','skipped','blocked','not_run'])assert.equal(verdict([...good.slice(0,2),{id:CASES[2],status:state}]),'blocked');
 assert.equal(verdict(good.slice(1)),'blocked');assert.equal(verdict([]),'blocked');
});
test('resume cannot redirect business tests to a remote site or an incomplete candidate',()=>{
 const report={baseURL:'http://localhost:5288',project:'bb-release-012345abcd',sha:'a'.repeat(40),sampleRef:SAMPLE_REF,modelProbe:'passed',cases:CASES.map(id=>({id})),images:Object.fromEntries(['api','worker','web'].map(k=>[k,{id:'sha256:'+'b'.repeat(64)}]))};
 assertTestReport(report);
 for(const bad of [{baseURL:'https://production.example'},{sampleRef:'other'},{modelProbe:'not_run'},{cases:[...report.cases,report.cases[0]]},{images:{}}])assert.throws(()=>assertTestReport({...report,...bad}));
});
test('local test harness refuses remote Docker and fixture traversal',()=>{
 assertLocalContext({Endpoints:{docker:{Host:'unix:///tmp/docker.sock'}}});
 for(const Host of ['tcp://production:2375','ssh://server',''])assert.throws(()=>assertLocalContext({Endpoints:{docker:{Host}}}));
 assert.throws(()=>contained('/tmp/samples','../secrets',posix));
 assert.equal(contained('/tmp/samples','case/source.docx',posix),'/tmp/samples/case/source.docx');
});
