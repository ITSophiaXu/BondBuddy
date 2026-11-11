import {test} from 'node:test';
import assert from 'node:assert/strict';
import {posix} from 'node:path';
import {CASES,SAMPLE_REF,verdict,contained,assertLocalContext,assertTestReport} from './support.mjs';
import {hostEnvironment} from './platform.mjs';
test('Windows Docker plugin discovery keeps ProgramFiles regardless of environment key casing',()=>{
 for(const key of ['ProgramFiles','PROGRAMFILES','programfiles']){
  const source={[key]:'C:\\Program Files',Path:'C:\\tools',SYSTEMROOT:'C:\\Windows'};
  const before={...source};
  assert.deepEqual(hostEnvironment(source,'C:\\Users\\tester'),{
   HOME:'C:\\Users\\tester',DOCKER_BUILDKIT:'1',PATH:'C:\\tools',SystemRoot:'C:\\Windows',ProgramFiles:'C:\\Program Files',
  });
  assert.deepEqual(source,before);
 }
});
test('Windows plugin support cannot forward application credentials or remote Docker settings',()=>{
 const source={ProgramFiles:'C:\\Program Files',HOME:'C:\\untrusted-home',DOCKER_BUILDKIT:'0',
  DATABASE_URL:'synthetic-db',AZURE_STORAGE_CONNECTION_STRING:'synthetic-storage',
  ALIPAY_PRIVATE_KEY:'synthetic-payment',BB_CODEX_API_KEY:'synthetic-model',OPENAI_API_KEY:'synthetic-openai',
  BB_RELEASE_COPILOT_OAUTH_FILE:'C:\\synthetic-oauth',GH_TOKEN:'synthetic-gh',
  DOCKER_HOST:'tcp://remote:2375',DOCKER_CONTEXT:'production',DOCKER_CONFIG:'C:\\remote-docker',
  DOCKER_TLS_VERIFY:'1',DOCKER_CERT_PATH:'C:\\remote-certs',HTTP_PROXY:'http://remote:8080',
  PROGRAMFILES_SECRET:'synthetic-secret'};
 assert.deepEqual(hostEnvironment(source,'C:\\Users\\tester'),{
  HOME:'C:\\Users\\tester',DOCKER_BUILDKIT:'1',ProgramFiles:'C:\\Program Files',
 });
 assert.deepEqual(hostEnvironment({ProgramFiles:''},'/test-home'),{HOME:'/test-home',DOCKER_BUILDKIT:'1'});
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
