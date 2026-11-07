import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(root, '.split-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const base = { BB_IMAGE_TAG: 'synthetic', POSTGRES_PASSWORD: 'synthetic', BB_MAIN_DATABASE_URL:'postgresql://bondbuddy:synthetic@postgres:5432/bondbuddy', BB_PUBLIC_ORIGIN: 'https://bondbuddy.test', BB_TERMS_VERSION: 'synthetic',
 BB_TRIAL_SOURCE_SALT: 'synthetic', AZURE_STORAGE_CONNECTION_STRING: 'synthetic', BB_PARSE_CACHE_OCR_VERSION: 'synthetic', BB_PARSE_CACHE_BASIS_VERSION: 'synthetic',
 BB_EXECUTION_DATABASE_URL: 'postgresql://bondbuddy:synthetic@pg-tunnel:5432/bondbuddy', BB_PG_SSH_HOST: 'synthetic.test', BB_PG_SSH_USER: 'tunnel',
 BB_PG_SSH_KEY_FILE: '/dev/null', BB_PG_SSH_KNOWN_HOSTS_FILE: '/dev/null', BB_FILE_TEMPLATE_HOST_DIR: dir, BB_PAYMENT_SECRETS_DIR: dir, BB_INTEGRITY_MODE: 'beijing',BB_INTEGRITY_BEIJING_HOST:'synthetic.test',BB_INTEGRITY_SSH_DIR:dir };
const configProcessEnv = {...process.env};
delete configProcessEnv.BB_WORKER_LEASE_SECONDS; // Exercise the private env file, independent of the test host.
function envFile(role, values = {}) { const path = join(dir, `${role}.env`); writeFileSync(path, Object.entries({...base,BB_DEPLOY_ROLE:role,...values}).map(([k,v])=>`${k}=${v}`).join('\n'), {mode:0o600}); return path; }
function config(role, values = {}, state = join(dir,'state')) {
 return JSON.parse(execFileSync('bash', ['deploy/m1/scripts/role-compose.sh', role, 'config', '--format', 'json'],
 { cwd: root, env: {...configProcessEnv,BB_ENV_FILE:envFile(role,{...values,...(values.BB_ROLE_OVERRIDE_FILE?{BB_ROLE_STATE_DIR:state}:{})}),BB_STATE_DIR:state,BB_IMAGE_TAG:'synthetic'}, stdio:['ignore','pipe','pipe'] }));
}
test('roles have disjoint local services; internal execution containers use only the dual-network SSH bridge', () => {
 const main=config('main'), execution=config('execution');
 assert.deepEqual(Object.keys(main.services).sort(), ['api','egress','migrate','ops','postgres','web']);
 assert.deepEqual(Object.keys(execution.services).sort(), ['egress','integrity-beijing-tunnel','pg-tunnel','worker','worker-parse','worker-review']);
 assert.equal(main.services.postgres.ports[0].host_ip,'127.0.0.1'); assert.equal(execution.services['pg-tunnel'].ports,undefined);
 for(const name of ['worker','worker-review','worker-parse']) {
  const s=execution.services[name]; assert.deepEqual(Object.keys(s.networks),['backend']); assert.ok(s.depends_on['pg-tunnel']);
  assert.equal(s.depends_on.postgres,undefined); assert.equal(s.depends_on.migrate,undefined);
  assert.equal(new URL(s.environment.DATABASE_URL).hostname,'pg-tunnel'); assert.equal(s.environment.BB_WORKER_CONCURRENCY,'1');
 }
 assert.equal(execution.networks.backend.internal,true);
 assert.deepEqual(Object.keys(execution.services['pg-tunnel'].networks).sort(),['backend','edge']);
 assert.equal(execution.services.worker.environment.BB_INTEGRITY_EGRESS_PROXY_URL,'http://integrity-beijing-tunnel:3129');
 assert.ok(execution.services.worker.depends_on['integrity-beijing-tunnel']);
 assert.ok(execution.services.worker.depends_on['pg-tunnel']);
 const integrity=execution.services['integrity-beijing-tunnel'];
 assert.equal(integrity.image,'bondbuddy-integrity-tunnel:synthetic');
 assert.equal(integrity.volumes.find(v=>v.target==='/run/ssh').source,dir);
 assert.equal(integrity.volumes.find(v=>v.target==='/run/ssh').read_only,true);
 assert.equal(execution.services['integrity-egress'],undefined);
 assert.equal(execution.services['worker-parse'].environment.BB_WORKER_JOB_KINDS,'parse');
 assert.equal(execution.services['worker-review'].environment.BB_WORKER_RUN_KINDS,'review');
});
test('execution lease defaults and overrides reach all three groups without local database dependencies', () => {
 for(const lease of [undefined, '', '180']) {
  const {services}=config('execution',lease===undefined?{}:{BB_WORKER_LEASE_SECONDS:lease});
  assert.equal(services.postgres,undefined); assert.equal(services.migrate,undefined);
  for(const name of ['worker','worker-review','worker-parse']) {
   const s=services[name];
   assert.equal(s.environment.BB_WORKER_LEASE_SECONDS,lease || '120',name);
   assert.equal(s.environment.BB_WORKER_CONCURRENCY,'1',name);
   assert.equal(new URL(s.environment.DATABASE_URL).hostname,'pg-tunnel',name);
   assert.ok(s.depends_on['pg-tunnel'],name);
   assert.equal(s.depends_on.postgres,undefined,name); assert.equal(s.depends_on.migrate,undefined,name);
  }
  assert.equal(services.worker.environment.BB_INTEGRITY_EGRESS_PROXY_URL,'http://integrity-beijing-tunnel:3129');
  assert.ok(services.worker.depends_on['integrity-beijing-tunnel']);
 }
});
test('execution lease setting does not change the legacy same-host environment', () => {
 const legacy=JSON.parse(execFileSync('docker',['compose','--project-directory',join(root,'deploy/m1'),'-f',join(root,'deploy/m1/compose.yaml'),
  '--env-file',envFile('legacy',{BB_WORKER_LEASE_SECONDS:'180'}),'config','--format','json'],
  {cwd:root,env:configProcessEnv,stdio:['ignore','pipe','pipe']}));
 for(const name of ['worker','worker-review','worker-parse']) {
  assert.equal(legacy.services[name].environment.BB_WORKER_LEASE_SECONDS,undefined,name);
 }
});
test('integrity modes are explicit, mutually exclusive and keep the PG tunnel',()=>{
 for(const mode of ['direct','disabled']) {
  const c=config('execution',{BB_INTEGRITY_MODE:mode});
  assert.equal(c.services['integrity-beijing-tunnel'],undefined);
  assert.equal(Boolean(c.services['integrity-egress']),mode==='direct');
  assert.ok(c.services.worker.depends_on['pg-tunnel']);assert.equal(c.services.postgres,undefined);
 }
 assert.throws(()=>config('execution',{BB_INTEGRITY_MODE:''}));
});
test('main preserves payment files, complete template bundle, upload spool and remote group readiness', () => {
 const {services}=config('main'); const mounts=services.api.volumes;
 for(const target of ['/run/bondbuddy-payments','/opt/bondbuddy/private-file-templates']) {
  const m=mounts.find(v=>v.target===target); assert.equal(m.read_only,true); assert.equal(m.bind.create_host_path ?? false,false);
 }
 assert.ok(mounts.find(v=>v.target==='/var/lib/bondbuddy/upload-spool' && v.type==='volume'));
 assert.equal(services.api.environment.BB_READY_WORKER_GROUPS,'authoring,review,parse');
 assert.equal(services.api.environment.BB_FILE_TEMPLATE_BUNDLE,'/opt/bondbuddy/private-file-templates');
});
test('execution needs no main-site password; URL-encoded special characters survive Compose', () => {
 const raw='p@ss:#/?%$&=+!'; const value=`postgresql://bondbuddy:${encodeURIComponent(raw)}@pg-tunnel:5432/bondbuddy`;
 const c=config('execution',{POSTGRES_PASSWORD:'',BB_EXECUTION_DATABASE_URL:value});
 assert.equal(decodeURIComponent(new URL(c.services.worker.environment.DATABASE_URL).password),raw);
 assert.equal(c.services.postgres,undefined); assert.equal(c.services.migrate,undefined);
 const mainUrl=value.replace('@pg-tunnel:', '@postgres:');
 const main=config('main',{POSTGRES_PASSWORD:`'${raw}'`,BB_MAIN_DATABASE_URL:mainUrl});
 // Canonical Compose output doubles literal dollars so it can be reloaded safely.
 assert.equal(main.services.postgres.environment.POSTGRES_PASSWORD.replaceAll('$$','$'),raw);
 for(const name of ['api','migrate','ops'])assert.equal(decodeURIComponent(new URL(main.services[name].environment.DATABASE_URL).password),raw);
});
test('legacy deployment, backup, restore and rollback reject a split env before touching Docker', () => {
 for(const script of ['deploy.sh','backup.sh','restore.sh','rollback.sh']) {
  const r=spawnSync('bash',[`deploy/m1/scripts/${script}`,'synthetic'],{cwd:root,env:{...process.env,BB_ENV_FILE:envFile('execution'),BB_STATE_DIR:join(dir,'state')},encoding:'utf8'});
  assert.equal(r.status,2,script); assert.match(r.stderr,/legacy scripts are disabled/);
 }
});
test('business model catalogs retain 1M windows and 900K compression', () => {
 for(const file of ['codex-model-catalog.json','codex-authoring-model-catalog.json','codex-file-authoring-model-catalog.json','codex-image-model-catalog.json','codex-deepseek-model-catalog.json']) {
  const catalog=JSON.parse(readFileSync(join(root,'deploy/m1',file),'utf8'));
  for(const model of catalog.models) {assert.equal(model.context_window,1000000);assert.equal(model.max_context_window,1000000);assert.equal(model.auto_compact_token_limit,900000);}
 }
});
// Exercise actual shell branch ordering; no Docker mutation is performed by these command shims.
for(const role of ['main','execution']) test(`${role} deployment refuses in-flight/unknown calls; only main migrates and recreates web`,()=>{
 const fixture=join(dir,role+'-fixture');mkdirSync(join(fixture,'deploy/m1/scripts'),{recursive:true});mkdirSync(join(fixture,'bin'));
 for(const name of ['lib.sh','role-lib.sh','deploy-role.sh','role-probe.mjs','role-config.mjs','role-source-lib.sh']) cpSync(join(root,'deploy/m1/scripts',name),join(fixture,'deploy/m1/scripts',name));
 for(const name of ['install-codex-file-sandbox.sh','smoke.sh']) writeFileSync(join(fixture,'deploy/m1/scripts',name),'#!/bin/sh\nexit 0\n',{mode:0o755});
 writeFileSync(join(fixture,'bin/git'),`#!/bin/sh\ncase "$*" in *--show-toplevel*) echo "$TEST_FIXTURE";; *HEAD*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; *--verify*) echo "\${TEST_APP_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}";; *'remote get-url origin'*) echo https://github.com/ITSophiaXu/BondBuddy.git;; *for-each-ref*) echo refs/remotes/origin/develop;; *merge-base*) exit "\${TEST_UNTRUSTED:-0}";; *status*) [ "\${TEST_DIRTY:-0}" = 0 ] || echo " M deploy/m1/synthetic";; *diff*) exit "\${TEST_DEPLOY_DIFF:-0}";; *rev-parse*) echo cccccccccccccccccccccccccccccccccccccccc;; esac\n`,{mode:0o755});
 writeFileSync(join(fixture,'bin/docker'),`#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
 *'ps -aq --filter label=com.docker.compose.project='*) case "$*" in *service=postgres*) ;; *) if [ "\${TEST_EXISTING_PROJECT:-0}" = 1 ]; then echo synthetic-existing; fi;; esac;;
 *'ps -q --filter label=com.docker.compose.project='*) [ "\${TEST_CURRENT_RUNTIME:-0}" = 0 ] || echo synthetic-current;;
 *'inspect --format'*com.docker.compose.service*) echo "\${TEST_CURRENT_SERVICE:-api}";;
 *'image inspect --format'*revision*sha256:synthetic*) echo "\${TEST_CURRENT_REVISION-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}";;
 *'config --format json'*) cat "$TEST_CONFIG";;
 *'ps --status running -q worker-parse'*) ;;
 *'image inspect --format'*revision*) if [ "$TEST_BAD_REVISION" = 1 ]; then echo wrong-revision; else echo "\${TEST_APP_SHA:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"; fi;;
 *'image inspect --format'*) echo sha256:synthetic;;
 *'inspect --format'*) if [ "$TEST_BAD_RUNTIME" = 1 ]; then echo sha256:wrong-runtime; else echo sha256:synthetic; fi;;
 *' ps -q '*) echo synthetic-container;;
 *' node --input-type=module - '*' idle') cat >/dev/null; exit "$TEST_GATE";;
 *' node --input-type=module - '*) cat >/dev/null;;
esac
`,{mode:0o755});
 const rendered=join(fixture,'config.json');
 writeFileSync(rendered,execFileSync('docker',['compose','--project-directory',join(root,'deploy/m1'),'-f',join(root,`deploy/m1/compose.${role}.yaml`),...(role==='execution'?['-f',join(root,'deploy/m1/compose.integrity-beijing.yaml')]:[]),'--profile','*','--env-file',envFile(role),'config','--format','json'],{env:{...configProcessEnv,BB_IMAGE_TAG:'synthetic'},stdio:['ignore','pipe','pipe']}));
 const state=join(fixture,'state');mkdirSync(state);const calls=join(fixture,'calls');
 for(const gate of [76,77,0]) {
  writeFileSync(join(state,'current'),'old-release\n');writeFileSync(calls,'');
  const run=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),role,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],{
   env:{...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile(role),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:join(fixture,'config.json'),TEST_CALLS:calls,TEST_GATE:String(gate)},encoding:'utf8'});
  assert.equal(run.status,gate,run.stderr);
  const commands=readFileSync(calls,'utf8');
  if(gate) {assert.doesNotMatch(commands,/up -d|run --rm --no-deps -T migrate/);assert.equal(readFileSync(join(state,'current'),'utf8'),'old-release\n');}
  else if(role==='main') {assert.match(commands,/run --rm --no-deps -T migrate/);assert.match(commands,/up -d --no-deps --force-recreate --wait web/);}
  else {assert.doesNotMatch(commands,/migrate|up -d.*postgres/);assert.match(commands,/bondbuddy-integrity-tunnel:aaaaaaaaaaaa/);assert.match(commands,/up -d --no-deps --wait pg-tunnel egress integrity-beijing-tunnel/);assert.match(commands,/up -d --no-deps --wait worker worker-review worker-parse/);assert.doesNotMatch(commands,/bondbuddy-m1-integrity-egress/);}
 }
 for(const [kind,status] of [['revision',3],['runtime',4]]) {
  writeFileSync(join(state,'current'),'old-release\n');writeFileSync(calls,'');
  const r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),role,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],{
   env:{...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile(role),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:join(fixture,'config.json'),TEST_CALLS:calls,TEST_GATE:'0',TEST_BAD_REVISION:kind==='revision'?'1':'0',TEST_BAD_RUNTIME:kind==='runtime'?'1':'0'},encoding:'utf8'});
  assert.equal(r.status,status,r.stderr);assert.equal(readFileSync(join(state,'current'),'utf8'),'old-release\n');
  if(kind==='revision')assert.doesNotMatch(readFileSync(calls,'utf8'),/up -d|run --rm --no-deps -T migrate/);
 }
});

test('export mode chooses the same domestic tunnel image as role startup',()=>{
 const fixture=join(dir,'execution-fixture');
 cpSync(join(root,'deploy/m1/scripts/export-images-role.sh'),join(fixture,'deploy/m1/scripts/export-images-role.sh'));
 writeFileSync(join(fixture,'bin/tar'),'#!/bin/sh\ncat >/dev/null\n',{mode:0o755});
 for(const [mode,expected,absent] of [['beijing','bondbuddy-integrity-tunnel:aaaaaaaaaaaa','bondbuddy-m1-integrity-egress'],['direct','bondbuddy-m1-integrity-egress:aaaaaaaaaaaa','bondbuddy-integrity-tunnel'],['disabled','bondbuddy-m1-pg-tunnel:aaaaaaaaaaaa','bondbuddy-integrity-tunnel']]){
  const calls=join(fixture,'export-calls');writeFileSync(calls,'');
  const r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/export-images-role.sh'),'execution','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',join(fixture,'images.tar.gz'),mode],{
   env:{...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,TEST_FIXTURE:fixture,TEST_CONFIG:join(fixture,'config.json'),TEST_CALLS:calls},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const commands=readFileSync(calls,'utf8');assert.ok(commands.includes(expected));assert.ok(!commands.includes(absent));
 }
});

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function covered(role, text='services: {}\n', extra={}) {
 const area=mkdtempSync(join(dir,'covered-')), file=join(area,'override.yaml');writeFileSync(file,text,{mode:0o600});
 return {area,file,values:{BB_ROLE_STATE_DIR:join(area,'state'),BB_ROLE_OVERRIDE_FILE:file,BB_ROLE_OVERRIDE_SHA256:digest(file),BB_PARSE_ROLE:'main',...extra}};
}
const bridgeOverlay=`services:
  postgres:
    networks: [backend, pgbridge]
networks:
  pgbridge:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.enable_ip_masquerade: 'false'
`;
test('ordinary role config automatically retains protected PG bridge and pure main parser; execution parser stays inactive',()=>{
 const a=covered('main',bridgeOverlay), b=covered('execution');
 const main=config('main',a.values,join(a.area,'state')), execution=config('execution',b.values,join(b.area,'state'));
 assert.equal(main.networks.backend.internal,true);assert.equal(main.networks.pgbridge.driver_opts['com.docker.network.bridge.enable_ip_masquerade'],'false');
 assert.deepEqual(Object.keys(main.services.postgres.networks).sort(),['backend','pgbridge']);
 assert.equal(main.volumes.pgdata.name,'bb-main_pgdata');assert.equal(main.services.postgres.ports[0].host_ip,'127.0.0.1');
 const parser=main.services['worker-parse'];assert.equal(parser.environment.BB_WORKER_LEASE_SECONDS,'120');assert.equal(parser.environment.BB_WORKER_JOB_KINDS,'parse');
 assert.equal(parser.environment.BB_WORKER_CONCURRENCY,'1');assert.deepEqual(Object.keys(parser.networks),['backend']);
 assert.ok(parser.volumes.every(v=>!v.target.includes('secrets')));assert.ok(Object.keys(parser.environment).every(k=>!/CODEX|COPILOT|DEEPSEEK/.test(k)));
 assert.equal(parser.deploy.resources.limits.cpus,0.5);assert.equal(parser.deploy.resources.limits.memory,'1073741824');
 assert.equal(execution.services['worker-parse'],undefined);assert.equal(execution.services.postgres,undefined);assert.equal(execution.services.migrate,undefined);
 assert.equal(execution.services.worker.environment.BB_INTEGRITY_EGRESS_PROXY_URL,'http://integrity-beijing-tunnel:3129');
});
test('missing file/hash, mismatch and omitted parser placement fail before any Docker call',()=>{
 const fake=join(dir,'reject-bin');mkdirSync(fake);const calls=join(fake,'calls');
 writeFileSync(join(fake,'docker'),'#!/bin/sh\nprintf docker >> "$TEST_CALLS"\nexit 99\n',{mode:0o755});
 const a=covered('main',bridgeOverlay), cases=[{BB_ROLE_OVERRIDE_SHA256:''},{BB_ROLE_OVERRIDE_FILE:join(a.area,'missing')},{BB_ROLE_OVERRIDE_SHA256:'0'.repeat(64)},{BB_PARSE_ROLE:''}];
 for(const invalid of cases){writeFileSync(calls,'');const r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','main','up','-d','postgres'],{
  cwd:root,env:{...process.env,PATH:fake+':'+process.env.PATH,TEST_CALLS:calls,BB_ENV_FILE:envFile('main',{...a.values,...invalid}),BB_STATE_DIR:join(a.area,'state'),BB_IMAGE_TAG:'synthetic'},encoding:'utf8'});
  assert.equal(r.status,2,r.stderr);assert.equal(readFileSync(calls,'utf8'),'');assert.doesNotMatch(r.stderr,/postgresql:\/\//);
 }
});
test('extra flags and Compose environment channels cannot bypass the private role env',()=>{
 const a=covered('main',bridgeOverlay), state=join(a.area,'state');
 for(const args of [['-f',a.file,'up'],['up','--file='+a.file],['--env-file','other','config'],['-pother','up'],['--profile','bb-parse-inactive','up'],['up','--scale','worker-parse=1']]){
  const r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','main',...args],{cwd:root,env:{...process.env,BB_ENV_FILE:envFile('main',a.values),BB_STATE_DIR:state,BB_IMAGE_TAG:'synthetic'},encoding:'utf8'});assert.equal(r.status,2);
 }
 for(const key of ['COMPOSE_FILE','COMPOSE_PROFILES','COMPOSE_ENV_FILES','COMPOSE_PROJECT_NAME']){
  const r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','main','config','--quiet'],{cwd:root,env:{...process.env,[key]:'alternate',BB_ENV_FILE:envFile('main',a.values),BB_STATE_DIR:state,BB_IMAGE_TAG:'synthetic'},encoding:'utf8'});assert.equal(r.status,2);
 }
 const previous=configProcessEnv.BB_MAIN_DATABASE_URL;configProcessEnv.BB_MAIN_DATABASE_URL='postgresql://different@old-database/wrong';
 try{assert.equal(new URL(config('main',a.values,state).services.api.environment.DATABASE_URL).hostname,'postgres');}finally{if(previous===undefined)delete configProcessEnv.BB_MAIN_DATABASE_URL;else configProcessEnv.BB_MAIN_DATABASE_URL=previous;}
});
test('adopted state refuses dropped coverage, alternate env, volume/layout changes and legacy rollback',()=>{
 const a=covered('main',bridgeOverlay), state=join(a.area,'state');config('main',a.values,state);
 assert.throws(()=>config('main',{},state));
 assert.throws(()=>config('main',{...a.values,BB_PARSE_ROLE:'execution'},state));
 const alternate=join(a.area,'alternate.env');writeFileSync(alternate,readFileSync(envFile('main',a.values)));
 let r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','main','config','--quiet'],{cwd:root,env:{...process.env,BB_ENV_FILE:alternate,BB_STATE_DIR:state,BB_IMAGE_TAG:'synthetic'},encoding:'utf8'});assert.equal(r.status,2);
 writeFileSync(a.file,bridgeOverlay+'volumes:\n  pgdata:\n    name: wrong-pgdata\n');assert.throws(()=>config('main',{...a.values,BB_ROLE_OVERRIDE_SHA256:digest(a.file)},state));
 writeFileSync(alternate,'POSTGRES_PASSWORD=synthetic\n');
 r=spawnSync('bash',['deploy/m1/scripts/rollback.sh','synthetic'],{cwd:root,env:{...process.env,BB_ENV_FILE:alternate,BB_STATE_DIR:state},encoding:'utf8'});assert.equal(r.status,2);assert.match(r.stderr,/legacy scripts are disabled/);
});
test('correct hash cannot authorize public PG, masquerade, shared PG bridge or model-capable main parser',()=>{
 for(const text of [
  'services:\n  postgres:\n    ports: !override ["0.0.0.0:15432:5432"]\n',
  bridgeOverlay.replace("'false'","'true'"),
  bridgeOverlay.replace('  postgres:', '  api:\n    networks: [backend, pgbridge]\n  postgres:'),
  'services:\n  worker-parse:\n    environment:\n      DEEPSEEK_API_KEY: synthetic\n',
  'services:\n  worker-parse:\n    deploy:\n      replicas: 0\n'
 ]) {const a=covered('main',text);assert.throws(()=>config('main',a.values,join(a.area,'state')),text);}
 const a=covered('main',bridgeOverlay);const sentinel=join(a.area,'should-not-exist');
 assert.throws(()=>config('main',{...a.values,BB_ROLE_OVERRIDE_FILE:`$(touch ${sentinel})`},join(a.area,'state')));
 assert.throws(()=>readFileSync(sentinel));
});
test('inactive execution parser cannot be explicitly started by ordinary Compose entry',()=>{
 const a=covered('execution');const r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','execution','up','-d','worker-parse'],{cwd:root,env:{...process.env,BB_ENV_FILE:envFile('execution',a.values),BB_STATE_DIR:join(a.area,'state'),BB_IMAGE_TAG:'synthetic'},encoding:'utf8'});
 assert.equal(r.status,2);assert.match(r.stderr,/parser is inactive/);
});
for(const role of ['main','execution'])test(`${role} app rollback uses exact script pin, same coverage, inactive parser and no migration`,()=>{
 const fixture=join(dir,role+'-fixture'), a=covered(role,role==='main'?bridgeOverlay:'services: {}\n',{BB_DEPLOY_SCRIPT_SHA:'a'.repeat(40)}), state=join(a.area,'state'),calls=join(a.area,'calls');mkdirSync(state);
 // Render actual Compose separately; the shim exercises deployment branching and ID verification.
 const c=config(role,a.values,join(a.area,'render-state'));
 // Validation also includes the inactive parser; render all profiles using the same private input.
 const all=execFileSync('docker',['compose','--project-directory',join(root,'deploy/m1'),'-f',join(root,`deploy/m1/compose.${role}.yaml`),...(role==='execution'?['-f',join(root,'deploy/m1/compose.integrity-beijing.yaml')]:[]),'-f',a.file,'--profile','*','--env-file',envFile(role,a.values),'config','--format','json'],{
  env:{...configProcessEnv,BB_IMAGE_TAG:'synthetic',BB_ROLE_PARSE_PROFILE:role==='main'?'bb-parse-active':'bb-parse-inactive',BB_ROLE_PARSE_REPLICAS:role==='main'?'1':'0'},stdio:['ignore','pipe','pipe']});
 const rendered=join(a.area,'config.json');writeFileSync(rendered,all);writeFileSync(join(state,'current'),'old-release\n');writeFileSync(calls,'');
 const r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),role,'a'.repeat(40),'--rollback'],{env:{...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile(role,a.values),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:rendered,TEST_CALLS:calls,TEST_GATE:'0'},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const commands=readFileSync(calls,'utf8');assert.doesNotMatch(commands,/run --rm --no-deps -T migrate|up -d.*postgres/);
 assert.ok(commands.includes('-f '+a.file));
 if(role==='main'){assert.match(commands,/up -d --no-deps --wait api ops egress worker-parse/);assert.match(commands,/--force-recreate --wait web/);assert.ok(c.services['worker-parse']);}
 else {assert.match(commands,/stop worker-parse/);assert.doesNotMatch(commands,/up -d.*worker-review worker-parse/);assert.match(commands,/ps --status running -q worker-parse/);}
 const evidence=readFileSync(join(state,'images-aaaaaaaaaaaa.txt'),'utf8');assert.match(evidence,/script_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);assert.ok(evidence.includes(`override_sha256=${a.values.BB_ROLE_OVERRIDE_SHA256}`));
});
test('independent app/script commits preserve source and clean-checkout protections',()=>{
 const fixture=join(dir,'main-fixture'), a=covered('main',bridgeOverlay,{BB_DEPLOY_SCRIPT_SHA:'a'.repeat(40)}),calls=join(a.area,'calls');
 config('main',a.values,join(a.area,'render-state'));
 const rendered=join(a.area,'config.json');writeFileSync(rendered,execFileSync('docker',['compose','--project-directory',join(root,'deploy/m1'),'-f',join(root,'deploy/m1/compose.main.yaml'),'-f',a.file,'--profile','*','--env-file',envFile('main',a.values),'config','--format','json'],{env:{...configProcessEnv,BB_IMAGE_TAG:'synthetic',BB_ROLE_PARSE_PROFILE:'bb-parse-active',BB_ROLE_PARSE_REPLICAS:'1'},stdio:['ignore','pipe','pipe']}));
 for(const [flags,values,expected] of [
  [{TEST_DEPLOY_DIFF:'1'},a.values,0],
  [{TEST_DEPLOY_DIFF:'1'},{...a.values,BB_DEPLOY_SCRIPT_SHA:''},2],
  [{TEST_UNTRUSTED:'1'},a.values,2],
  [{TEST_DIRTY:'1'},a.values,2],
  [{},{...a.values,BB_DEPLOY_SCRIPT_SHA:'b'.repeat(40)},2],
  [{TEST_BAD_REVISION:'1'},a.values,3]
 ]) {
  const state=mkdtempSync(join(a.area,'state-'));writeFileSync(calls,'');
  const r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),'main','b'.repeat(40)],{env:{...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile('main',{...values,BB_ROLE_STATE_DIR:state}),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:rendered,TEST_CALLS:calls,TEST_GATE:'0',TEST_APP_SHA:'b'.repeat(40),...flags},encoding:'utf8'});
  assert.equal(r.status,expected,r.stderr);
  if(expected)assert.doesNotMatch(readFileSync(calls,'utf8'),/up -d|run --rm --no-deps -T migrate/);
  else {const evidence=readFileSync(join(state,'images-bbbbbbbbbbbb.txt'),'utf8');assert.ok(evidence.includes('commit='+'b'.repeat(40)));assert.ok(evidence.includes('script_commit='+'a'.repeat(40)));assert.ok(evidence.includes('script_tree='+'c'.repeat(40)));}
 }
});
test('private retained state survives default checkout paths and rejects caller state substitution',()=>{
 const a=covered('main',bridgeOverlay),state=a.values.BB_ROLE_STATE_DIR;config('main',a.values,state);
 const shared={...process.env,BB_ENV_FILE:envFile('main',a.values),BB_IMAGE_TAG:'synthetic'};delete shared.BB_STATE_DIR;
 let r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','main','config','--quiet'],{cwd:root,env:shared,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 r=spawnSync('bash',['deploy/m1/scripts/role-compose.sh','main','config','--quiet'],{cwd:root,env:{...shared,BB_STATE_DIR:join(a.area,'empty-replacement')},encoding:'utf8'});assert.equal(r.status,2);assert.match(r.stderr,/must match the retained/);
});
for(const role of ['main','execution'])test(`${role} existing project rejects empty release state; retained state still runs in-flight SQL gate`,()=>{
 const fixture=join(dir,role+'-fixture'),a=covered(role,role==='main'?bridgeOverlay:'services: {}\n',{BB_PARSE_ROLE:'execution',BB_DEPLOY_SCRIPT_SHA:'a'.repeat(40)}),state=a.values.BB_ROLE_STATE_DIR,calls=join(a.area,'calls');
 const rendered=join(fixture,'config.json'); // Existing fixture is the legacy parse-on-execution layout.
 mkdirSync(state);writeFileSync(calls,'');
 const environment={...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile(role,a.values),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:rendered,TEST_CALLS:calls,TEST_GATE:'76',TEST_EXISTING_PROJECT:'1'};
 let r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),role,'a'.repeat(40)],{env:environment,encoding:'utf8'});
 assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/existing role project has no retained release state/);assert.doesNotMatch(readFileSync(calls,'utf8'),/up -d|run --rm/);
 writeFileSync(join(state,'current'),'old-release\n');writeFileSync(calls,'');r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),role,'a'.repeat(40)],{env:environment,encoding:'utf8'});
 assert.equal(r.status,76,r.stderr);assert.match(readFileSync(calls,'utf8'),/ idle/);assert.doesNotMatch(readFileSync(calls,'utf8'),/up -d|run --rm --no-deps -T migrate/);
});
test('configuration-only deployments at one app tag retain separate immutable release evidence',()=>{
 const fixture=join(dir,'main-fixture'),a=covered('main','services: {}\n',{BB_PARSE_ROLE:'execution',BB_DEPLOY_SCRIPT_SHA:'a'.repeat(40)}),state=a.values.BB_ROLE_STATE_DIR,calls=join(a.area,'calls');mkdirSync(state);
 const environment={...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile('main',a.values),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:join(fixture,'config.json'),TEST_CALLS:calls,TEST_GATE:'0'};
 for(let i=0;i<2;i++){writeFileSync(calls,'');const r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),'main','a'.repeat(40)],{env:environment,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 const records=readdirSync(state).filter(n=>/^release-.*\.txt$/.test(n));assert.equal(records.length,2);
 const current=readFileSync(join(state,'current-release'),'utf8').trim(),previous=readFileSync(join(state,'previous-release'),'utf8').trim();assert.notEqual(current,previous);
 for(const id of [current,previous]){const text=readFileSync(join(state,`release-${id}.txt`),'utf8');assert.ok(text.includes(`record=${id}`));assert.ok(text.includes('commit='+'a'.repeat(40)));assert.ok(text.includes(`override_sha256=${a.values.BB_ROLE_OVERRIDE_SHA256}`));}
});
test('current-only retained releases require real source and ID checks before the SQL gate',()=>{
 const fixture=join(dir,'main-fixture'),a=covered('main','services: {}\n',{BB_PARSE_ROLE:'execution',BB_DEPLOY_SCRIPT_SHA:'a'.repeat(40)}),state=a.values.BB_ROLE_STATE_DIR,calls=join(a.area,'calls');mkdirSync(state);
 const environment={...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile('main',a.values),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CONFIG:join(fixture,'config.json'),TEST_CALLS:calls,TEST_CURRENT_RUNTIME:'1',TEST_EXISTING_PROJECT:'1'};
 for(const [revision,gate,status] of [['a'.repeat(40),'76',76],['b'.repeat(40),'0',3],['','0',3],['a'.repeat(40),'0',0]]){
  writeFileSync(join(state,'current'),'aaaaaaaaaaaa\n');writeFileSync(calls,'');const r=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),'main','a'.repeat(40)],{env:{...environment,TEST_CURRENT_REVISION:revision,TEST_GATE:gate},encoding:'utf8'});assert.equal(r.status,status,r.stderr);
  const commands=readFileSync(calls,'utf8');assert.match(commands,/com.docker.compose.service/);
  if(status)assert.doesNotMatch(commands,/up -d|run --rm --no-deps -T migrate/);
  if(status===3)assert.doesNotMatch(commands,/ idle/);
 }
});
