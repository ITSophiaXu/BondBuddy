import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {cleanupReleaseEnvironment} from './cleanup.mjs';
import {confirmationService,workerParseService} from './upload-confirmation-preflight.mjs';

function fixture(t,services,volumes={}){
 const out=mkdtempSync(join(tmpdir(),'release-cleanup-unit-')),project='bb-release-012345abcd',file=join(out,'compose.json');
 t.after(()=>{assert.ok(resolve(out).startsWith(resolve(tmpdir())+sep));rmSync(out,{recursive:true,force:true});});
 writeFileSync(file,JSON.stringify({services,volumes}));
 const credentials=['copilot-oauth','copilot-auth.json'].map(name=>join(out,name));
 for(const path of credentials)writeFileSync(path,'synthetic-private-copy');
 const compose=args=>['docker',['compose','-p',project,'-f',file,...args]];
 return {out,project,file,credentials,compose,report:{status:'passed'}};
}

test('successful cleanup includes generated parser/confirmation profiles in the exact project before deleting credentials',async t=>{
 const common={DATABASE_URL:'synthetic',AZURE_STORAGE_CONNECTION_STRING:'synthetic',BB_DEPLOYMENT_TIER:'local',BB_RELEASE_TEST_INSTANCE:'synthetic'};
 const services={api:{image:'tested-api'},worker:{image:'tested-worker'},'worker-parse':workerParseService('tested-worker',common,{}),'upload-confirmation':confirmationService('tested-confirmation',common),diagnostic:{image:'synthetic',profiles:['diagnostic']}};
 const f=fixture(t,services,{confirmation:{},'confirmation-small':{}}),calls=[],originalConfig=readFileSync(f.file,'utf8');
 let finishDown;const downComplete=new Promise(resolve=>{finishDown=resolve;});
 const cleanup=cleanupReleaseEnvironment({...f,command:async(...args)=>{calls.push(args);await downComplete;}});
 assert.ok(f.credentials.every(path=>existsSync(path)));assert.equal(f.report.cleanup,undefined,'must wait for down before claiming cleanup');
 finishDown();await cleanup;
 assert.deepEqual(calls,[['docker',['compose','-p',f.project,'-f',f.file,'--profile','diagnostic','--profile','upload-size-split','down','--volumes'],'cleanup.log']]);
 assert.equal(f.report.status,'passed');assert.equal(f.report.cleanup,'completed');assert.ok(f.credentials.every(path=>!existsSync(path)));assert.equal(readFileSync(f.file,'utf8'),originalConfig);
});

test('profileless legacy cleanup keeps its exact project and ordinary down command',async t=>{
 const f=fixture(t,{api:{image:'tested-api'},worker:{image:'tested-worker'}}),calls=[];
 await cleanupReleaseEnvironment({...f,command:async(...args)=>calls.push(args)});
 assert.deepEqual(calls,[['docker',['compose','-p',f.project,'-f',f.file,'down','--volumes'],'cleanup.log']]);assert.equal(f.report.cleanup,'completed');
});

test('failed cleanup keeps credentials and records failure without retrying or claiming completion',async t=>{
 const f=fixture(t,{confirmation:{image:'synthetic',profiles:['upload-size-split']}});let calls=0;
 await cleanupReleaseEnvironment({...f,command:async()=>{calls++;throw Error('synthetic down failed');}});
 assert.equal(calls,1);assert.equal(f.report.status,'blocked');assert.equal(f.report.cleanup,'failed');assert.match(f.report.error,/synthetic down failed/);assert.ok(f.credentials.every(path=>existsSync(path)));
});

test('blocked or explicitly retained runs issue no cleanup command and keep their original credentials',async t=>{
 for(const [status,keep] of [['blocked',false],['passed',true]]){
  const f=fixture(t,{api:{image:'synthetic'}});f.report.status=status;
  await cleanupReleaseEnvironment({...f,keep,compose(){throw Error('Must not construct a cleanup command');},command(){throw Error('Must not run cleanup');}});
  assert.equal(f.report.status,status);assert.equal(f.report.cleanup,'retained');assert.ok(f.credentials.every(path=>existsSync(path)));
 }
});
