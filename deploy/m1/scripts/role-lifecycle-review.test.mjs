// Stateful synthetic Docker failures exercise the actual ordinary deploy/rollback scripts.
// Real Compose renders configs/hashes; the unchanged isolated PG/SSH SQL evidence is separate.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'../../..'),area=mkdtempSync(join(root,'.role-review-'));
process.on('exit',()=>rmSync(area,{recursive:true,force:true}));
const realDocker=execFileSync('which',['docker'],{encoding:'utf8'}).trim();
const hash=s=>createHash('sha256').update(s).digest('hex');
// Diagnostic-only phase names and numeric IDs: never emit commands, paths or environment values.
let caseId=0,fixtureId=0,caseStarted,renderFiles=[];
const elapsed=started=>Number(process.hrtime.bigint()-started)/1e6;
function timing(phase,event,duration=0,fixture=0,count) {
 writeSync(2,'ROLE_LIFECYCLE_TIMING '+JSON.stringify({case:caseId,fixture,phase,event,duration_ms:Number(duration.toFixed(3)),...(count===undefined?{}:{count})})+'\n');
}
function timed(phase,fixture,action) {
 const started=process.hrtime.bigint();timing(phase,'start',0,fixture);
 try{return action();}finally{timing(phase,'end',elapsed(started),fixture);}
}
function composeRender(args,action,file) {
 const started=process.hrtime.bigint();
 try{return action();}finally{appendFileSync(file,JSON.stringify({phase:args.includes('--hash')?'compose.hash':args.includes('--format')?'compose.json':'compose.other',duration_ms:elapsed(started)})+'\n');}
}
beforeEach(()=>{caseId++;renderFiles=[];caseStarted=process.hrtime.bigint();timing('case','start');});
afterEach(()=>{
 const duration=elapsed(caseStarted);
 for(const {file,fixture}of renderFiles){
  const totals=new Map();
  if(existsSync(file))for(const line of readFileSync(file,'utf8').trim().split('\n').filter(Boolean)){
   const row=JSON.parse(line),total=totals.get(row.phase)||{count:0,duration:0};total.count++;total.duration+=row.duration_ms;totals.set(row.phase,total);
  }
  for(const [phase,total]of totals)timing(phase,'summary',total.duration,fixture,total.count);
 }
 timing('case','end',duration);
});
const base={POSTGRES_PASSWORD:'synthetic',BB_MAIN_DATABASE_URL:'postgresql://bondbuddy:synthetic@postgres:5432/bondbuddy',BB_EXECUTION_DATABASE_URL:'postgresql://bondbuddy:synthetic@pg-tunnel:5432/bondbuddy',BB_PUBLIC_ORIGIN:'https://bondbuddy.test',BB_TERMS_VERSION:'synthetic',BB_TRIAL_SOURCE_SALT:'synthetic',AZURE_STORAGE_CONNECTION_STRING:'synthetic',BB_PARSE_CACHE_OCR_VERSION:'synthetic',BB_PARSE_CACHE_BASIS_VERSION:'synthetic',BB_PG_SSH_HOST:'synthetic.test',BB_PG_SSH_USER:'tunnel',BB_PG_SSH_KEY_FILE:'/dev/null',BB_PG_SSH_KNOWN_HOSTS_FILE:'/dev/null',BB_INTEGRITY_MODE:'disabled'};
function fixture(role,{covered=true,current=true}={}) {
 const id=++fixtureId;
 return timed('fixture.initialize',id,()=>{
 const dir=mkdtempSync(join(area,role+'-'));mkdirSync(join(dir,'deploy'),{recursive:true});cpSync(join(root,'deploy/m1'),join(dir,'deploy/m1'),{recursive:true});mkdirSync(join(dir,'bin'));
 const timings=join(dir,'render-timings.jsonl');renderFiles.push({file:timings,fixture:id});
 for(const name of ['smoke.sh','install-codex-file-sandbox.sh'])writeFileSync(join(dir,'deploy/m1/scripts',name),'#!/bin/sh\nexit 0\n');
 const git=(...a)=>execFileSync('git',['-C',dir,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const {A,B}=timed('fixture.source_seal',id,()=>{
 git('init','-q');git('config','user.name','muhualing');git('config','user.email','12086605+muhualing@users.noreply.github.com');git('remote','add','origin','https://github.com/ITSophiaXu/BondBuddy.git');
 writeFileSync(join(dir,'package.json'),JSON.stringify({type:'commonjs'}));writeFileSync(join(dir,'synthetic-app.txt'),'A');git('add','.');git('commit','-qm','synthetic A');const A=git('rev-parse','HEAD');
 writeFileSync(join(dir,'synthetic-app.txt'),'B');git('add','synthetic-app.txt');git('commit','-qm','synthetic B');const B=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/test',B);
 return {A,B};
 });
 const state=covered?join(dir,'retained-state'):join(dir,`deploy/m1/state-${role}`);mkdirSync(state,{recursive:true});
 const file=join(dir,'private.env'),overlay=join(dir,'private.yaml'),runtime=join(dir,'runtime.json'),calls=join(dir,'calls');
 writeFileSync(overlay,'services: {}\n');
 const values={...base,BB_DEPLOY_ROLE:role,COMPOSE_PROJECT_NAME:`bb-${role}`,BB_FILE_TEMPLATE_HOST_DIR:dir,BB_PAYMENT_SECRETS_DIR:dir,BB_DEPLOY_SCRIPT_SHA:B,...(covered?{BB_ROLE_STATE_DIR:state,BB_ROLE_OVERRIDE_FILE:overlay,BB_ROLE_OVERRIDE_SHA256:hash(readFileSync(overlay)),BB_PARSE_ROLE:'main'}:{})};
 const envWrite=()=>writeFileSync(file,Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});envWrite();
 if(current)writeFileSync(join(state,'current'),A.slice(0,12)+'\n');writeFileSync(calls,'');
 const environment={...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,BB_ENV_FILE:file,TEST_REAL_DOCKER:realDocker,TEST_CALLS:calls,TEST_RUNTIME:runtime,TEST_A:A,TEST_B:B,TEST_STATE:state,TEST_TIMINGS:timings};delete environment.BB_STATE_DIR;
 // The model is deliberately stateful: up really changes its service ID/hash before failure.
 writeFileSync(join(dir,'bin/docker'),`#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const {appendFileSync}=fs,elapsed=${elapsed.toString()};
${composeRender.toString()}
const a=process.argv.slice(2),e=process.env,db=JSON.parse(fs.readFileSync(e.TEST_RUNTIME)),out=x=>process.stdout.write(String(x)+'\\n');
const digest=x=>'sha256:'+crypto.createHash('sha256').update(x).digest('hex');
fs.appendFileSync(e.TEST_CALLS,JSON.stringify(a)+'\\n');
function render(args){return composeRender(args,()=>cp.execFileSync(e.TEST_REAL_DOCKER,args,{env:e,encoding:'utf8',stdio:['ignore','pipe','pipe']}),e.TEST_TIMINGS);}
function img(ref){if(ref==='postgres:16')return {id:db.pgId,source:null};const tag=ref.split(':').at(-1),commit=tag===e.TEST_A.slice(0,12)?e.TEST_A:tag===e.TEST_B.slice(0,12)?e.TEST_B:'c'.repeat(40);const target=ref.includes('sha256:')?null:ref.slice(0,ref.lastIndexOf(':'));if(!target){for(const x of Object.values(db.containers))if(x.image===ref)return{id:ref,source:x.source};return{id:ref,source:'c'.repeat(40)};}return{id:db.drift && tag===e.TEST_A.slice(0,12)?digest('drift'):digest(target+commit),source:commit};}
if(a[0]==='compose'){
 const ci=a.indexOf('config');
 if(ci>=0){process.stdout.write(render(a));process.exit(0);}
 const pi=a.indexOf('ps');if(pi>=0){const s=a.at(-1);if(s==='worker-parse'&&db.role==='execution'&&db.parseRole==='main')process.exit(0);if(db.containers[s])out(s);process.exit(0);}
 const up=a.indexOf('up'),stop=a.indexOf('stop');
 if(a.includes('logs')&&(a.includes('--follow')||a.includes('-f'))||up>=0&&e.TEST_SLOW_UP){fs.writeFileSync(e.TEST_READY,'ready');setInterval(()=>{},1000);return;}
 if(a.includes('run')){if(e.TEST_DEPLOY_ENTRY==='1'&&!fs.existsSync(e.TEST_STATE+'/pending-release.json'))process.exit(99);process.stdin.resume();process.stdin.on('end',()=>process.exit(a.at(-1)==='idle'?Number(e.TEST_GATE||0):a.at(-1)==='connect'?Number(e.TEST_CONNECT_FAIL||0):0));return;}
 if(stop>=0){delete db.containers[a.at(-1)];fs.writeFileSync(e.TEST_RUNTIME,JSON.stringify(db));process.exit(0);}
 if(up>=0){
  if(e.TEST_DEPLOY_ENTRY==='1'&&!fs.existsSync(e.TEST_STATE+'/pending-release.json'))process.exit(99);
  if(e.TEST_FAIL_INFRA && e.BB_IMAGE_TAG===e.TEST_B.slice(0,12))process.exit(1);
  const c=JSON.parse(render([...a.slice(0,up),'--profile','*','config','--format','json']));
  const hashes=Object.fromEntries(render([...a.slice(0,up),'--profile','*','config','--hash','*']).trim().split('\\n').map(x=>x.split(/\\s+/)));
  for(const service of a.slice(up+1).filter(x=>c.services[x])){
   const v=img(c.services[service].image);db.containers[service]={image:v.id,source:v.source,configHash:hashes[service]};fs.writeFileSync(e.TEST_RUNTIME,JSON.stringify(db));
   if(e.TEST_FAIL_SWITCH && e.BB_IMAGE_TAG===e.TEST_B.slice(0,12)&&service===(db.role==='main'?'api':'worker'))process.exit(1);
  }
  process.exit(0);
 }
 process.exit(0);
}
if(a[0]==='ps'){for(const service of Object.keys(db.containers)){if(a.some(x=>x==='label=com.docker.compose.service=postgres')&&service!=='postgres')continue;out(service);}process.exit(0);}
if(a[0]==='image'&&a[1]==='inspect'){const v=img(a.at(-1));if(a.includes('--format'))out(a[a.indexOf('--format')+1].includes('revision')?v.source:v.id);process.exit(0);}
if(a[0]==='inspect'){const service=a.at(-1),v=db.containers[service];if(!v)process.exit(1);const fmt=a[a.indexOf('--format')+1];if(fmt.includes('com.docker.compose.service'))out(service);else if(fmt.includes('com.docker.compose.project'))out(db.project);else if(fmt.includes('com.docker.compose.config-hash'))out(v.configHash);else if(fmt.includes('Mounts'))out(JSON.stringify([{Type:'volume',Name:db.pgName,Destination:'/var/lib/postgresql/data'}]));else out(v.image);process.exit(0);}
process.exit(0);
`,{mode:0o755});
 const composeArgs=sha=>['compose','--project-directory',join(dir,'deploy/m1'),'--project-name',values.COMPOSE_PROJECT_NAME,'-f',join(dir,`deploy/m1/compose.${role}.yaml`),...(covered?['-f',overlay]:[]),'--profile','*','--env-file',file];
 const render=(sha,args)=>composeRender(args,()=>execFileSync(realDocker,[...composeArgs(sha),'config',...args],{env:{...process.env,BB_IMAGE_TAG:sha.slice(0,12),POSTGRES_PASSWORD:role==='execution'?'unused-no-local-database':'synthetic',...(covered?{BB_ROLE_PARSE_PROFILE:role==='main'?'bb-parse-active':'bb-parse-inactive',BB_ROLE_PARSE_REPLICAS:role==='main'?'1':'0'}:{})},encoding:'utf8',stdio:['ignore','pipe','pipe']}),timings);
 const c=JSON.parse(render(A,['--format','json'])),hashes=Object.fromEntries(render(A,['--hash','*']).trim().split('\n').map(x=>x.split(/\s+/)));
 const containers={};for(const [service,s]of Object.entries(c.services)){if(service==='migrate'||service==='upload-confirmation'&&Number(s.deploy?.replicas)===0||service==='worker-parse'&&role==='execution'&&covered||service==='worker-parse'&&role==='main'&&!covered)continue;const target=s.image.slice(0,s.image.lastIndexOf(':'));containers[service]={image:service==='postgres'?'sha256:'+hash('PG'): 'sha256:'+hash(target+A),source:service==='postgres'?null:A,configHash:hashes[service]};}
 const initial={role,parseRole:covered?'main':'execution',project:values.COMPOSE_PROJECT_NAME,pgName:'bb-main_pgdata',pgId:'sha256:'+hash('PG'),containers};writeFileSync(runtime,JSON.stringify(initial));
 const cmd=(script,args,extra={})=>timed(script==='deploy-role.sh'?'command.deploy':'command.compose',id,()=>spawnSync('bash',[join(dir,'deploy/m1/scripts',script),...args],{cwd:dir,env:{...environment,TEST_DEPLOY_ENTRY:script==='deploy-role.sh'?'1':'0',...extra},encoding:'utf8'}));
 return {dir,state,file,overlay,values,envWrite,environment,runtime,calls,A,B,initial,git,cmd,read:()=>JSON.parse(readFileSync(runtime)),save:x=>writeFileSync(runtime,JSON.stringify(x))};
 });
}
for(const role of ['main','execution'])test(`${role}: partial B failure leaves A current; ordinary rollback accepts only sealed A/B and restores missing services`,()=>{
 const f=fixture(role),primary=role==='main'?'api':'worker';
 let r=f.cmd('deploy-role.sh',[role,f.B],{TEST_FAIL_SWITCH:'1'});assert.equal(r.status,1,r.stderr);
 assert.equal(readFileSync(join(f.state,'current'),'utf8').trim(),f.A.slice(0,12));const pendingBytes=readFileSync(join(f.state,'pending-release.json'));
 const p=JSON.parse(pendingBytes);assert.equal(p.status,'pending');assert.equal(p.from,f.A.slice(0,12));assert.equal(p.to,f.B.slice(0,12));
 assert.equal(f.read().containers[primary].source,f.B);assert.ok(Object.values(f.read().containers).some(x=>x.source===f.A));
 assert.equal(f.read().pgName,'bb-main_pgdata');assert.ok(p.releases.every(x=>x.snapshot.binding_sha256&&x.snapshot.config_sha256));
 const mixed=f.read(),bad=structuredClone(mixed);bad.containers[primary]={image:'sha256:'+hash('unknown C'),source:'c'.repeat(40),configHash:'c'.repeat(64)};f.save(bad);writeFileSync(f.calls,'');
 r=f.cmd('deploy-role.sh',[role,f.A,'--rollback']);assert.equal(r.status,3,r.stderr);assert.deepEqual(readFileSync(join(f.state,'pending-release.json')),pendingBytes);assert.doesNotMatch(readFileSync(f.calls,'utf8'),/"up"|"run"/);
 f.save({...mixed,drift:true});r=f.cmd('deploy-role.sh',[role,f.A,'--rollback']);assert.equal(r.status,3,r.stderr);assert.deepEqual(readFileSync(join(f.state,'pending-release.json')),pendingBytes);
 const wrongConfig=structuredClone(mixed);wrongConfig.containers[primary].configHash='c'.repeat(64);f.save(wrongConfig);writeFileSync(f.calls,'');
 r=f.cmd('deploy-role.sh',[role,f.A,'--rollback']);assert.equal(r.status,3,r.stderr);assert.deepEqual(readFileSync(join(f.state,'pending-release.json')),pendingBytes);assert.doesNotMatch(readFileSync(f.calls,'utf8'),/"up"|"run"/);
 delete mixed.containers[role==='main'?'web':'worker-review'];f.save(mixed);writeFileSync(f.calls,'');
 r=f.cmd('deploy-role.sh',[role,f.A,'--rollback']);assert.equal(r.status,0,r.stderr);
 assert.equal(readFileSync(join(f.state,'current'),'utf8').trim(),f.A.slice(0,12));assert.equal(existsSync(join(f.state,'pending-release.json')),false);
 for(const [service,x]of Object.entries(f.read().containers))if(service!=='postgres')assert.equal(x.source,f.A,service);
 assert.equal(f.read().pgName,'bb-main_pgdata');assert.equal(f.read().pgId,f.initial.pgId);
 const rollback=readFileSync(f.calls,'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.ok(!rollback.some(a=>a.includes('migrate')));assert.ok(!rollback.some(a=>a.includes('up')&&a.includes('postgres')));
 assert.equal(role==='execution'?f.read().containers['worker-parse']:undefined,undefined);
});
test('wrong first PG binding leaves no receipt; corrected overlay succeeds without deleting/resetting binding',()=>{
 const f=fixture('main');writeFileSync(f.overlay,'services: {}\nvolumes:\n  pgdata:\n    name: wrong-pgdata\n');f.values.BB_ROLE_OVERRIDE_SHA256=hash(readFileSync(f.overlay));f.envWrite();
 let r=f.cmd('role-compose.sh',['main','config','--quiet']);assert.equal(r.status,2,r.stderr);assert.equal(existsSync(join(f.state,'environment-binding.json')),false);assert.equal(existsSync(join(f.state,'pg-volume.json')),false);
 writeFileSync(f.overlay,'services: {}\n');f.values.BB_ROLE_OVERRIDE_SHA256=hash(readFileSync(f.overlay));f.envWrite();r=f.cmd('role-compose.sh',['main','config','--quiet']);assert.equal(r.status,0,r.stderr);
 assert.equal(JSON.parse(readFileSync(join(f.state,'environment-binding.json'))).pg_volume.name,'bb-main_pgdata');assert.equal(f.read().pgName,'bb-main_pgdata');
});
test('PG forwarding env and published port reject mismatches, dynamic/range/invalid declarations',()=>{
 for(const [declared,published] of [['15432','15433'],['0','15432'],['65536','15432'],['15432','0'],['15432','15432-15433'],['15432',''],['abc','15432'],['15432-15433','15432']]){
  const f=fixture('main');f.values.BB_PG_FORWARD_PORT=declared;writeFileSync(f.overlay,`services:\n  postgres:\n    ports: !override ['127.0.0.1:${published}:5432']\n`);f.values.BB_ROLE_OVERRIDE_SHA256=hash(readFileSync(f.overlay));f.envWrite();
  const r=f.cmd('role-compose.sh',['main','config','--quiet']);assert.equal(r.status,2,`${declared}/${published}: ${r.stderr}`);assert.equal(existsSync(join(f.state,'environment-binding.json')),false);
 }
 const f=fixture('main');f.values.BB_PG_FORWARD_PORT='65535';f.envWrite();assert.equal(f.cmd('role-compose.sh',['main','config','--quiet']).status,0);
});
for(const role of ['main','execution'])test(`${role}: actual default state stays ignored while dirty/untracked deployment sources still refuse`,()=>{
 const f=fixture(role,{covered:false});
 for(const args of [['config','--quiet'],['probe','idle'],['up','-d',role==='main'?'postgres':'worker']]){const r=f.cmd('role-compose.sh',[role,...args]);assert.equal(r.status,0,r.stderr);}
 let deployed=f.cmd('deploy-role.sh',[role,f.A]);assert.equal(deployed.status,0,deployed.stderr);
 assert.equal(existsSync(join(f.state,'config.lock')),true);assert.equal(f.git('status','--porcelain','--untracked-files=all','--','deploy/m1'),'');
 const nested=join(f.dir,'deploy/m1/scripts',`state-${role}`);mkdirSync(nested);writeFileSync(join(nested,'new-source.sh'),'# synthetic\n');let nestedResult=f.cmd('role-compose.sh',[role,'probe','idle']);assert.equal(nestedResult.status,2);assert.match(nestedResult.stderr,/deployment directory must be clean/);rmSync(nested,{recursive:true});
 writeFileSync(join(f.dir,'deploy/m1/scripts/untracked-review.sh'),'# synthetic\n');let r=f.cmd('role-compose.sh',[role,'up','-d',role==='main'?'postgres':'worker']);assert.equal(r.status,2);assert.match(r.stderr,/deployment directory must be clean/);rmSync(join(f.dir,'deploy/m1/scripts/untracked-review.sh'));
 writeFileSync(join(f.dir,'deploy/m1/scripts/role-source-lib.sh'),readFileSync(join(f.dir,'deploy/m1/scripts/role-source-lib.sh'),'utf8')+'\n# dirty\n');r=f.cmd('role-compose.sh',[role,'probe','idle']);assert.equal(r.status,2);assert.match(r.stderr,/deployment directory must be clean/);
});
test('legitimate first deployments atomically create current only after success on both roles',()=>{
 for(const role of ['main','execution']){
  const f=fixture(role,{current:false});f.save({...f.initial,containers:{}});
  const r=f.cmd('deploy-role.sh',[role,f.A]);assert.equal(r.status,0,r.stderr);
  assert.equal(readFileSync(join(f.state,'current'),'utf8').trim(),f.A.slice(0,12));assert.equal(existsSync(join(f.state,'pending-release.json')),false);
 }
});
for(const role of ['main','execution'])for(const stage of ['early','partial'])test(`${role}: first-release ${stage} failure resumes only the sealed target and gates consumers`,()=>{
 const f=fixture(role,{current:false}),primary=role==='main'?'api':'worker';f.save({...f.initial,containers:{}});
 let r=f.cmd('deploy-role.sh',[role,f.B],stage==='early'?{TEST_FAIL_INFRA:'1'}:{TEST_FAIL_SWITCH:'1'});assert.equal(r.status,1,r.stderr);
 assert.equal(existsSync(join(f.state,'current')),false);const pendingBytes=readFileSync(join(f.state,'pending-release.json')),p=JSON.parse(pendingBytes);
 assert.equal(p.from,'');assert.equal(p.releases.length,1);assert.equal(p.releases[0].snapshot.commit,f.B);
 const failed=f.read();assert.equal(stage==='partial'?failed.containers[primary].source:Object.keys(failed.containers).length,stage==='partial'?f.B:0);
 writeFileSync(f.calls,'');r=f.cmd('deploy-role.sh',[role,f.B]);assert.equal(r.status,3,r.stderr);assert.doesNotMatch(readFileSync(f.calls,'utf8'),/"up"|"run"|"stop"/);
 r=f.cmd('role-compose.sh',[role,'up','-d',primary],{BB_PENDING_COMMAND:'1',BB_ROLE_READONLY:'1',BB_IMAGE_TAG:f.B.slice(0,12)});assert.equal(r.status,3,r.stderr);assert.match(r.stderr,/pending role release/);assert.doesNotMatch(readFileSync(f.calls,'utf8'),/"up"|"run"|"stop"/);
 r=f.cmd('deploy-role.sh',[role,f.A,'--rollback']);assert.equal(r.status,3,r.stderr);assert.deepEqual(readFileSync(join(f.state,'pending-release.json')),pendingBytes);
 if(stage==='early'&&role==='main'){
  writeFileSync(f.calls,'');r=f.cmd('deploy-role.sh',[role,f.B,'--rollback'],{TEST_CONNECT_FAIL:'77'});assert.equal(r.status,77,r.stderr);
  assert.deepEqual(readFileSync(join(f.state,'pending-release.json')),pendingBytes);assert.equal(f.read().containers[primary],undefined);assert.doesNotMatch(readFileSync(f.calls,'utf8'),/"migrate"|"stop"/);
 }
 if(stage==='partial'){
  const bad=structuredClone(failed);bad.containers[primary].image='sha256:'+hash('unknown first-release C');bad.containers[primary].source='c'.repeat(40);f.save(bad);writeFileSync(f.calls,'');
  r=f.cmd('deploy-role.sh',[role,f.B,'--rollback']);assert.equal(r.status,3,r.stderr);assert.doesNotMatch(readFileSync(f.calls,'utf8'),/"up"|"run"|"stop"/);f.save(failed);
 }
 writeFileSync(f.calls,'');r=f.cmd('deploy-role.sh',[role,f.B,'--rollback'],{TEST_GATE:'76'});assert.equal(r.status,76,r.stderr);
 assert.equal(existsSync(join(f.state,'current')),false);assert.deepEqual(readFileSync(join(f.state,'pending-release.json')),pendingBytes);
 const blocked=readFileSync(f.calls,'utf8').split('\n').filter(Boolean).map(JSON.parse),idle=blocked.findIndex(a=>a.at(-1)==='idle');assert.ok(idle>=0);
 if(stage==='partial'){assert.ok(!blocked.some(a=>a.includes('up')||a.includes('stop')||a.includes('migrate')));assert.deepEqual(f.read(),failed);}
 else {assert.ok(blocked.slice(0,idle).some(a=>a.includes('up')&&a.includes(role==='main'?'postgres':'pg-tunnel')));assert.ok(!blocked.some(a=>a.includes('stop')));assert.equal(f.read().containers[primary],undefined);}
 writeFileSync(f.calls,'');r=f.cmd('deploy-role.sh',[role,f.B,'--rollback']);assert.equal(r.status,0,r.stderr);
 const calls=readFileSync(f.calls,'utf8').split('\n').filter(Boolean).map(JSON.parse),gate=calls.findIndex(a=>a.at(-1)==='idle'),consumer=calls.findIndex(a=>a.includes('stop')||a.includes('up')&&a.includes(primary));
 assert.ok(gate>=0&&consumer>gate);if(stage==='partial')assert.ok(gate<calls.findIndex(a=>a.includes('up')));
 if(role==='main')assert.ok(calls.some(a=>a.includes('up')&&a.includes('postgres'))&&calls.some(a=>a.includes('migrate')));else assert.ok(!calls.some(a=>a.includes('postgres')||a.includes('migrate')));
 assert.equal(readFileSync(join(f.state,'current'),'utf8').trim(),f.B.slice(0,12));assert.equal(existsSync(join(f.state,'pending-release.json')),false);
 assert.match(readFileSync(join(f.state,`images-${f.B.slice(0,12)}.txt`),'utf8'),/resume_first=1/);
 assert.equal(f.read().containers[primary].source,f.B);assert.equal(f.read().pgName,'bb-main_pgdata');assert.equal(f.read().pgId,f.initial.pgId);
});
async function ready(file,child){const started=process.hrtime.bigint();timing('lock.ready','start',0,fixtureId);try{for(let i=0;i<750;i++){if(existsSync(file))return;if(child.exitCode!==null)throw new Error(`long command exited: code=${child.exitCode}, signal=${child.signalCode}`);await new Promise(r=>setTimeout(r,20));}throw new Error('long command not ready');}finally{timing('lock.ready','end',elapsed(started),fixtureId);}}
async function stop(child){const started=process.hrtime.bigint();timing('lock.stop','start',0,fixtureId);try{if(child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));process.kill(-child.pid,'SIGTERM');await exited;}finally{timing('lock.stop','end',elapsed(started),fixtureId);}}
test('logs --follow and local logs -f release the read lock; global flags reject and real write lock remains exclusive',async()=>{
 const f=fixture('main');
 for(const flag of ['--follow','-f']){
  const marker=join(f.dir,'ready-'+flag),child=spawn('bash',[join(f.dir,'deploy/m1/scripts/role-compose.sh'),'main','logs',flag],{cwd:f.dir,env:{...f.environment,TEST_READY:marker},detached:true,stdio:'ignore'});
  try{await ready(marker,child);assert.equal(spawnSync('flock',['-n',join(f.state,'config.lock'),'true']).status,0);const r=f.cmd('deploy-role.sh',['main',f.A]);assert.equal(r.status,0,r.stderr);}finally{await stop(child);}
 }
 for(const args of [['-f','extra.yaml','logs'],['logs','--file=extra.yaml'],['logs','--env-file=extra.env']])assert.equal(f.cmd('role-compose.sh',['main',...args]).status,2);
 const marker=join(f.dir,'write-ready'),child=spawn('bash',[join(f.dir,'deploy/m1/scripts/role-compose.sh'),'main','up','-d','postgres'],{cwd:f.dir,env:{...f.environment,TEST_READY:marker,TEST_SLOW_UP:'1'},detached:true,stdio:'ignore'});
 try{await ready(marker,child);const r=f.cmd('deploy-role.sh',['main',f.A]);assert.equal(r.status,75,r.stderr);}finally{await stop(child);}
});
test('external internal markers cannot unlock either write entry on either role',async()=>{
 for(const role of ['main','execution'])for(const script of ['role-compose.sh','deploy-role.sh']){
  const f=fixture(role),marker=join(f.dir,'external-write-ready'),args=script==='deploy-role.sh'?[role,f.A]:[role,'up','-d',role==='main'?'postgres':'worker'];
  const child=spawn('bash',[join(f.dir,'deploy/m1/scripts',script),...args],{cwd:f.dir,env:{...f.environment,BB_ROLE_READONLY:'1',BB_PENDING_COMMAND:'1',TEST_READY:marker,TEST_SLOW_UP:'1',TEST_DEPLOY_ENTRY:script==='deploy-role.sh'?'1':'0'},detached:true,stdio:'ignore'});
  try{await ready(marker,child);assert.notEqual(spawnSync('flock',['-n',join(f.state,'config.lock'),'true']).status,0);const r=f.cmd('deploy-role.sh',[role,f.A],{BB_ROLE_READONLY:'1',BB_PENDING_COMMAND:'1'});assert.equal(r.status,75,r.stderr);}finally{await stop(child);}
 }
});
