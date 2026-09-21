import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ROOT, PYTHON, processRun } from '../lib/platform.mjs';
import { createClient, signIn } from './http-client.mjs';
const fetch=createClient();
const runtime=join(ROOT,'qa','artifacts','http-'+randomUUID());await mkdir(runtime,{recursive:true});
await processRun(PYTHON,[join(ROOT,'qa','make_fixtures.py'),runtime]);
// Test process is isolated from production settings, real credentials and jobs.
await writeFile(join(runtime,'settings.json'),JSON.stringify({apiKey:'',tavilyKey:'',registryKey:''}));
const port=4400+Math.floor(Math.random()*700),base=`http://127.0.0.1:${port}`,adminToken=randomUUID();
const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,PORT:String(port),BOND_BUDDY_RUNTIME:runtime,BOND_BUDDY_ADMIN_TOKEN:adminToken,DEEPSEEK_API_KEY:'',TAVILY_API_KEY:'',REGISTRY_API_KEY:''},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
test.after(()=>child.kill());
const file=await readFile(join(runtime,'source.docx'));
const signed=await signIn(fetch,base);
function form(kind='review'){const f=new FormData();f.set('kind',kind);f.set('title','HTTP lifecycle test');f.set('issuer','测试发行人');f.set('scope','szse-public');f.set('periods','2026-06-30');f.append(kind==='update'?'historical':'updated',new Blob([file]),'募集说明书.docx');return f;}
async function complete(id,client=fetch){for(let i=0;i<40;i++){const j=(await(await client(base+'/api/tasks/'+id)).json()).job;if(!['queued','extracting'].includes(j.status))return j;await new Promise(r=>setTimeout(r,100));}throw new Error('Job did not finish');}
test('subscription gate and sandbox checkout grant only server-calculated entitlements',async()=>{
  assert.equal(signed.created,true);assert.equal(signed.user.phoneMasked,'138****8000');
  assert.equal((await globalThis.fetch(base+'/api/tasks',{headers:{'X-BondBuddy-Seat':'primary'}})).status,401);
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:form()})).status,402);
  const r=await fetch(base+'/api/billing/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:'professional',idempotencyKey:randomUUID(),amount:1,ownerId:'other'})});assert.equal(r.status,201);const {order}=await r.json();assert.equal(order.amount,99900);assert.equal(order.ownerId,signed.user.id);
  assert.equal((await(await fetch(base+'/api/billing')).json()).seat.quota.active,false);
  assert.equal((await fetch(base+'/api/billing/orders/'+order.id+'/sandbox-pay',{method:'POST'})).status,200);
  assert.equal((await(await fetch(base+'/api/billing')).json()).seat.quota.available.points,12);
});
test('home and all eight knowledge documents are served',async()=>{let r=await fetch(base);assert.equal(r.status,200);assert((await r.text()).includes('BondBuddy'));const k=await(await fetch(base+'/api/knowledge')).json();assert.equal(k.packs.length,8);for(const p of k.packs){r=await fetch(base+'/api/knowledge/'+p.id+'/download');assert.equal(r.status,200);assert(r.headers.get('content-disposition').includes('attachment'));}});
test('review accepts only the required draft; optional financial/history materials do not block it',async()=>{const input=form();input.set('reportingWindow','forged client periods');input.set('investor','ordinary');input.set('queryMode','auto');const r=await fetch(base+'/api/tasks',{method:'POST',body:input});assert.equal(r.status,202);const {job}=await r.json();assert.equal(job.files.length,1);assert(!('investor'in job.context));assert(job.context.investorBasis.includes('以募集书原文'));assert.equal(job.queryMode,'auto');assert(job.queryLimitations.some(t=>t.includes('外部核验')));assert(!('path'in job.files[0]));assert.deepEqual(job.context.reportingWindow.periods.map(p=>p.label),['2023年度','2024年度','2025年度','2026年1—6月']);const done=await complete(job.id);assert.equal(done.status,'needs_setup');assert(done.materials[0].recordCount>0);const download=await fetch(base+`/api/tasks/${job.id}/download/anything.docx`);assert.equal(download.status,404);});
test('update accepts historical Word and preserves a resumable task',async()=>{const r=await fetch(base+'/api/tasks',{method:'POST',body:form('update')});assert.equal(r.status,202);const {job}=await r.json();assert.equal((await complete(job.id)).status,'needs_setup');const retry=await fetch(base+`/api/tasks/${job.id}/retry`,{method:'POST'});assert.equal(retry.status,202);assert.equal((await complete(job.id)).status,'needs_setup');});
test('unsupported dates, missing review target and unsupported market fail before queuing',async()=>{const badDate=form();badDate.set('periods','2026-07-01');const missing=form();missing.delete('updated');const scope=form();scope.set('scope','interbank');for(const body of [badDate,missing,scope])assert.equal((await fetch(base+'/api/tasks',{method:'POST',body})).status,400);});

test('reference mode persists optional information and material roles; invalid modes and missing own evidence do not queue',async()=>{
  const input=form('update');input.delete('historical');input.set('authoringMode','reference');input.append('reference',new Blob([file]),'同业参考.docx');
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:input})).status,400);
  input.append('issuancePlan',new Blob(['本企业本期发行方案']),'发行方案.txt');input.append('bankFacilities',new Blob(['本企业银行授信明细']),'银行授信.txt');
  input.set('registrationAmount','30亿元');input.set('size','10亿元');input.set('hasRating','否');input.set('issuerRating','AAA');input.set('bookrunner','示例簿记管理人');
  const response=await fetch(base+'/api/tasks',{method:'POST',body:input});assert.equal(response.status,202);const {job}=await response.json();
  assert.equal(job.context.authoringMode,'reference');assert.equal(job.context.registrationAmount,'30亿元');assert.equal(job.context.size,'10亿元');assert.equal(job.context.bookrunner,'示例簿记管理人');assert.equal(job.context.issuerRating,'');assert.equal(job.context.hasEnhancement,'');assert.deepEqual(job.files.map(f=>f.role),['reference','issuancePlan','bankFacilities']);assert.equal((await complete(job.id)).status,'needs_setup');
  input.set('authoringMode','wrong');assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:input})).status,400);
  input.set('authoringMode','historical');assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:input})).status,400);
});
test('customers cannot configure platform services; operator access never returns secrets',async()=>{const r=await fetch(base+'/api/settings',{method:'POST',headers:{Origin:'https://external.example','Content-Type':'application/json'},body:'{"apiKey":"not-saved"}'});assert.equal(r.status,403);for(const [path,method] of [['/api/settings','GET'],['/api/settings','POST'],['/api/settings/test','POST'],['/api/connectors','POST'],['/api/connectors/discover','POST'],['/api/connectors/example','DELETE']])assert.equal((await fetch(base+path,{method})).status,403);const cfg=await(await fetch(base+'/api/settings',{headers:{'X-BondBuddy-Admin':adminToken}})).json();assert(!('apiKey'in cfg));assert(!('registryUrl'in cfg));assert.equal(cfg.configured,false);const traversal=await fetch(base+'/..%2F.env');assert.equal(traversal.status,404);});
test('chat accepts text-only tasks and enforces project context',async()=>{const f=new FormData();f.set('kind','generate');f.set('prompt','帮我起草项目说明书');const r=await fetch(base+'/api/tasks',{method:'POST',body:f});assert.equal(r.status,202);const {job}=await r.json();assert(job.conversationId);assert.equal((await complete(job.id)).status,'needs_setup');const wrong=new FormData();wrong.set('kind','generate');wrong.set('prompt','继续');wrong.set('projectId',job.id);assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:wrong})).status,400);});
test('connector configuration preserves private credentials without exposing them',async()=>{
  const r=await fetch(base+'/api/connectors',{method:'POST',headers:{'Content-Type':'application/json','X-BondBuddy-Admin':adminToken},body:JSON.stringify({name:'Wind 测试',vendor:'wind',purpose:'bonds',url:'https://adapter.example/mcp',tool:'query',args:{issuer:'{{issuer}}'},token:'test-private-token',readOnlyConfirmed:true})});assert.equal(r.status,200);const {id}=await r.json();
  const list=await(await fetch(base+'/api/connectors')).json();assert.equal(list.connectors[0].name,'Wind 测试');for(const field of ['token','url','args','tool','hasToken'])assert(!(field in list.connectors[0]));assert(!JSON.stringify(list).includes('test-private-token'));
  const linked=(await(await fetch(base+'/api/tasks')).json()).jobs.find(j=>j.kind==='review');const body=new FormData();body.set('kind','generate');body.set('prompt','查询全部公司债兑付情况');body.set('queryMode','auto');body.set('projectId',linked.id);
  const response=await fetch(base+'/api/tasks',{method:'POST',body});assert.equal(response.status,202);const {job}=await response.json();assert.deepEqual(job.connectorIds,[id]);assert.equal(job.queryIssuer,'测试发行人');assert.equal(job.queryMode,'auto');await complete(job.id);
  const personal=createClient();await signIn(personal,base,'13700137000');
  const personalOrder=(await(await personal(base+'/api/billing/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:'personal',idempotencyKey:randomUUID()})})).json()).order;
  await personal(base+'/api/billing/orders/'+personalOrder.id+'/sandbox-pay',{method:'POST'});
  assert.deepEqual((await(await personal(base+'/api/connectors')).json()).connectors,[]);
  const before=(await(await personal(base+'/api/billing')).json()).seat.quota;
  for(const fields of [{prompt:'查询全部公司债兑付情况',queryMode:'auto'},{prompt:'查询工商信息'},{prompt:'起草说明',connectorIds:JSON.stringify([id]),plan:'professional'},{prompt:'起草说明',registry:'true'},{prompt:'起草说明',web:'true'}]){
    const input=new FormData();input.set('kind','generate');for(const [key,value] of Object.entries(fields))input.set(key,value);
    const denied=await personal(base+'/api/tasks',{method:'POST',body:input});assert.equal(denied.status,402);assert.equal((await denied.json()).code,'PROFESSIONAL_REQUIRED');
  }
  assert.deepEqual((await(await personal(base+'/api/billing')).json()).seat.quota.available,before.available);
  assert.equal((await(await personal(base+'/api/tasks')).json()).jobs.length,0);
  const material=await personal(base+'/api/tasks',{method:'POST',body:form()});assert.equal(material.status,202);const localJob=(await material.json()).job;assert.deepEqual(localJob.connectorIds,[]);assert.equal(localJob.registry,false);assert.equal(localJob.web,false);await complete(localJob.id,personal);
  const upgraded=(await(await personal(base+'/api/billing/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'upgrade',idempotencyKey:randomUUID()})})).json()).order;
  await personal(base+'/api/billing/orders/'+upgraded.id+'/sandbox-pay',{method:'POST'});
  assert.equal((await(await personal(base+'/api/billing')).json()).seat.quota.externalData,true);
  assert.equal((await(await personal(base+'/api/connectors')).json()).connectors[0].id,id);
  const retry=await personal(base+`/api/tasks/${localJob.id}/retry`,{method:'POST'});assert.equal(retry.status,202);assert.deepEqual((await retry.json()).job.connectorIds,[id]);
  assert.equal((await fetch(base+'/api/connectors/'+id,{method:'DELETE',headers:{'X-BondBuddy-Admin':adminToken}})).status,200);
});
test('cookie identity isolates projects, downloads, orders and balances; logout revokes it',async()=>{
  const other=createClient();await signIn(other,base,'13900139000');const existing=(await(await fetch(base+'/api/tasks')).json()).jobs[0];assert(existing);
  assert.equal((await(await other(base+'/api/tasks',{headers:{'X-BondBuddy-Seat':'primary'}})).json()).jobs.length,0);
  assert.equal((await other(base+'/api/tasks/'+existing.id)).status,403);
  assert.equal((await other(base+'/api/tasks/'+existing.id+'/download/anything.docx?seat=primary')).status,403);
  const primaryOrder=(await(await fetch(base+'/api/billing')).json()).orders[0];assert.equal((await other(base+'/api/billing/orders/'+primaryOrder.id)).status,404);
  assert.equal((await(await other(base+'/api/billing',{headers:{'X-BondBuddy-Seat':'primary'}})).json()).seat.quota.active,false);
  const logout=await other(base+'/api/auth/logout',{method:'POST'});assert.equal(logout.status,200);assert.equal((await other(base+'/api/tasks')).status,401);
  const returning=await signIn(fetch,base);assert.equal(returning.created,false);assert.equal((await(await fetch(base+'/api/billing')).json()).seat.quota.active,true);
});
