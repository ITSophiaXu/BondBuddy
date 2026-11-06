import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(root, '.split-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const base = { BB_IMAGE_TAG: 'synthetic', POSTGRES_PASSWORD: 'synthetic', BB_MAIN_DATABASE_URL:'postgresql://bondbuddy:synthetic@postgres:5432/bondbuddy', BB_PUBLIC_ORIGIN: 'https://bondbuddy.test', BB_TERMS_VERSION: 'synthetic',
 BB_TRIAL_SOURCE_SALT: 'synthetic', AZURE_STORAGE_CONNECTION_STRING: 'synthetic', BB_PARSE_CACHE_OCR_VERSION: 'synthetic', BB_PARSE_CACHE_BASIS_VERSION: 'synthetic',
 BB_EXECUTION_DATABASE_URL: 'postgresql://bondbuddy:synthetic@pg-tunnel:5432/bondbuddy', BB_PG_SSH_HOST: 'synthetic.test', BB_PG_SSH_USER: 'tunnel',
 BB_PG_SSH_KEY_FILE: '/dev/null', BB_PG_SSH_KNOWN_HOSTS_FILE: '/dev/null', BB_FILE_TEMPLATE_HOST_DIR: dir, BB_PAYMENT_SECRETS_DIR: dir, BB_INTEGRITY_BROWSER: '1' };
function envFile(role, values = {}) { const path = join(dir, `${role}.env`); writeFileSync(path, Object.entries({...base,BB_DEPLOY_ROLE:role,...values}).map(([k,v])=>`${k}=${v}`).join('\n'), {mode:0o600}); return path; }
function config(role, values = {}) {
 return JSON.parse(execFileSync('bash', ['deploy/m1/scripts/role-compose.sh', role, 'config', '--format', 'json'],
 { cwd: root, env: {...process.env,BB_ENV_FILE:envFile(role,values),BB_STATE_DIR:join(dir,'state'),BB_IMAGE_TAG:'synthetic'}, stdio:['ignore','pipe','pipe'] }));
}
test('roles have disjoint local services; internal execution containers use only the dual-network SSH bridge', () => {
 const main=config('main'), execution=config('execution');
 assert.deepEqual(Object.keys(main.services).sort(), ['api','egress','migrate','ops','postgres','web']);
 assert.deepEqual(Object.keys(execution.services).sort(), ['egress','integrity-egress','pg-tunnel','worker','worker-parse','worker-review']);
 assert.equal(main.services.postgres.ports[0].host_ip,'127.0.0.1'); assert.equal(execution.services['pg-tunnel'].ports,undefined);
 for(const name of ['worker','worker-review','worker-parse']) {
  const s=execution.services[name]; assert.deepEqual(Object.keys(s.networks),['backend']); assert.ok(s.depends_on['pg-tunnel']);
  assert.equal(s.depends_on.postgres,undefined); assert.equal(s.depends_on.migrate,undefined);
  assert.equal(new URL(s.environment.DATABASE_URL).hostname,'pg-tunnel'); assert.equal(s.environment.BB_WORKER_CONCURRENCY,'1');
 }
 assert.equal(execution.networks.backend.internal,true);
 assert.deepEqual(Object.keys(execution.services['pg-tunnel'].networks).sort(),['backend','edge']);
 assert.equal(execution.services.worker.environment.BB_INTEGRITY_EGRESS_PROXY_URL,'http://integrity-egress:3129');
 assert.equal(execution.services['worker-parse'].environment.BB_WORKER_JOB_KINDS,'parse');
 assert.equal(execution.services['worker-review'].environment.BB_WORKER_RUN_KINDS,'review');
});
test('main preserves payment files, complete template bundle, upload spool and remote group readiness', () => {
 const {services}=config('main'); const mounts=services.api.volumes;
 for(const target of ['/run/bondbuddy-payments','/opt/bondbuddy/private-file-templates']) {
  const m=mounts.find(v=>v.target===target); assert.equal(m.read_only,true); assert.equal(m.bind.create_host_path,false);
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
 const main=config('main',{POSTGRES_PASSWORD:raw.replace('$',''),BB_MAIN_DATABASE_URL:mainUrl});
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
 for(const name of ['lib.sh','role-lib.sh','deploy-role.sh','role-probe.mjs']) cpSync(join(root,'deploy/m1/scripts',name),join(fixture,'deploy/m1/scripts',name));
 for(const name of ['install-codex-file-sandbox.sh','smoke.sh']) writeFileSync(join(fixture,'deploy/m1/scripts',name),'#!/bin/sh\nexit 0\n',{mode:0o755});
 writeFileSync(join(fixture,'bin/git'),'#!/bin/sh\ncase "$*" in *--show-toplevel*) echo "$TEST_FIXTURE";; *--verify*) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; esac\n',{mode:0o755});
 writeFileSync(join(fixture,'bin/docker'),`#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
 *' node --input-type=module - '*' idle') cat >/dev/null; exit "$TEST_GATE";;
 *' node --input-type=module - '*) cat >/dev/null;;
esac
`,{mode:0o755});
 const state=join(fixture,'state');mkdirSync(state);const calls=join(fixture,'calls');
 for(const gate of [76,77,0]) {
  writeFileSync(join(state,'current'),'old-release\n');writeFileSync(calls,'');
  const run=spawnSync('bash',[join(fixture,'deploy/m1/scripts/deploy-role.sh'),role,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],{
   env:{...process.env,PATH:join(fixture,'bin')+':'+process.env.PATH,BB_ENV_FILE:envFile(role),BB_STATE_DIR:state,TEST_FIXTURE:fixture,TEST_CALLS:calls,TEST_GATE:String(gate)},encoding:'utf8'});
  assert.equal(run.status,gate,run.stderr);
  const commands=readFileSync(calls,'utf8');
  if(gate) {assert.doesNotMatch(commands,/up -d|run --rm --no-deps -T migrate/);assert.equal(readFileSync(join(state,'current'),'utf8'),'old-release\n');}
  else if(role==='main') {assert.match(commands,/run --rm --no-deps -T migrate/);assert.match(commands,/up -d --no-deps --force-recreate --wait web/);}
  else assert.doesNotMatch(commands,/migrate|up -d.*postgres/);
 }
});
