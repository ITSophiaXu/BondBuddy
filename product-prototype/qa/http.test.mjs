import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ROOT, PYTHON, processRun } from '../lib/platform.mjs';
import { createClient, signIn, withQuoteConfirmation } from './http-client.mjs';
const fetch=withQuoteConfirmation(createClient());
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
function form(kind='review'){const f=new FormData();f.set('kind',kind);f.set('title','HTTP lifecycle test');f.set('issuer','测试发行人');f.set('scope','szse-public');f.set('periods','2026-06-30');f.append(kind==='update'?'historical':'updated',new Blob([file]),'募集说明书.docx');f.append('audit',new Blob(['测试发行人2025年度审计报告及财务报表附注，总资产120万元']),'审计报告.txt');return f;}
async function complete(id,client=fetch){for(let i=0;i<40;i++){const j=(await(await client(base+'/api/tasks/'+id)).json()).job;if(!['queued','extracting'].includes(j.status))return j;await new Promise(r=>setTimeout(r,100));}throw new Error('Job did not finish');}
test('registration credits and recharge use only server-calculated amounts',async()=>{
  assert.equal(signed.created,true);assert.equal(signed.user.phoneMasked,'138****8000');
  assert.equal((await globalThis.fetch(base+'/api/tasks',{headers:{'X-BondBuddy-Seat':'primary'}})).status,401);
  assert.equal((await(await fetch(base+'/api/billing')).json()).wallet.available,2000);
  const r=await fetch(base+'/api/billing/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'recharge',amountCny:50,idempotencyKey:randomUUID(),amount:1,credits:999999,ownerId:'other'})});assert.equal(r.status,201);const {order}=await r.json();assert.equal(order.amount,5000);assert.equal(order.credits,5000);assert.equal(order.ownerId,signed.user.id);
  assert.equal((await(await fetch(base+'/api/billing')).json()).seat.quota.active,true);
  assert.equal((await fetch(base+'/api/billing/orders/'+order.id+'/sandbox-pay',{method:'POST'})).status,200);
  assert.equal((await(await fetch(base+'/api/billing')).json()).wallet.available,7000);
});
test('home and all eight knowledge documents are served',async()=>{let r=await fetch(base);assert.equal(r.status,200);assert((await r.text()).includes('BondBuddy'));const k=await(await fetch(base+'/api/knowledge')).json();assert.equal(k.packs.length,8);for(const p of k.packs){r=await fetch(base+'/api/knowledge/'+p.id+'/download');assert.equal(r.status,200);assert(r.headers.get('content-disposition').includes('attachment'));}});
test('review requires the prospectus and financial evidence and preserves the reporting window',async()=>{const input=form();input.set('reportingWindow','forged client periods');input.set('investor','ordinary');input.set('queryMode','auto');const r=await fetch(base+'/api/tasks',{method:'POST',body:input});assert.equal(r.status,202);const {job}=await r.json();assert.equal(job.files.length,2);assert(!('investor'in job.context));assert(job.context.investorBasis.includes('所选发行方式'));assert.equal(job.queryMode,'auto');assert(job.queryLimitations.some(t=>t.includes('外部核验')));assert(!('path'in job.files[0]));assert.deepEqual(job.context.reportingWindow.periods.map(p=>p.label),['2023年度','2024年度','2025年度','2026年1—6月']);const done=await complete(job.id);assert.equal(done.status,'needs_setup');assert(done.materials[0].recordCount>0);const download=await fetch(base+`/api/tasks/${job.id}/download/anything.docx`);assert.equal(download.status,404);});
test('update accepts historical Word and preserves a resumable task',async()=>{const r=await fetch(base+'/api/tasks',{method:'POST',body:form('update')});assert.equal(r.status,202);const {job}=await r.json();assert.equal((await complete(job.id)).status,'needs_setup');const retry=await fetch(base+`/api/tasks/${job.id}/retry`,{method:'POST'});assert.equal(retry.status,202);assert.equal((await complete(job.id)).status,'needs_setup');});
test('unsupported dates, missing review target and unsupported market fail before queuing',async()=>{const badDate=form();badDate.set('periods','2026-07-01');const missing=form();missing.delete('updated');const scope=form();scope.set('scope','interbank');const noFinancial=form();noFinancial.delete('audit');for(const body of [badDate,missing,scope,noFinancial])assert.equal((await fetch(base+'/api/tasks',{method:'POST',body})).status,400);});

test('project notes and flexible institution arrangements persist; user-selected reference documents are rejected',async()=>{
  const input=form('update');input.append('issuancePlan',new Blob(['本企业本期发行方案']),'发行方案.txt');input.append('bankFacilities',new Blob(['本企业银行授信明细']),'银行授信.txt');
  input.set('registrationAmount','30亿元');input.set('size','10亿元');input.set('hasRating','否');input.set('issuerRating','AAA');input.set('underwritingArrangements','示例证券独家承销并担任簿记管理人');
  const response=await fetch(base+'/api/tasks',{method:'POST',body:input});assert.equal(response.status,202);const {job}=await response.json();
  assert.equal(job.context.registrationAmount,'30亿元');assert.equal(job.context.size,'10亿元');assert.equal(job.context.underwritingArrangements,'示例证券独家承销并担任簿记管理人');assert.equal(job.context.issuerRating,'');assert.equal(job.context.hasEnhancement,'');assert.deepEqual(job.files.map(f=>f.role),['historical','audit','issuancePlan','bankFacilities']);assert.equal((await complete(job.id)).status,'needs_setup');
  input.set('authoringMode','wrong');assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:input})).status,400);
  input.set('authoringMode','reference');input.append('reference',new Blob([file]),'同业.docx');assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:input})).status,400);
});
test('customers cannot configure platform services; operator access never returns secrets',async()=>{const r=await fetch(base+'/api/settings',{method:'POST',headers:{Origin:'https://external.example','Content-Type':'application/json'},body:'{"apiKey":"not-saved"}'});assert.equal(r.status,403);for(const [path,method] of [['/api/settings','GET'],['/api/settings','POST'],['/api/settings/test','POST'],['/api/connectors','POST'],['/api/connectors/discover','POST'],['/api/connectors/example','DELETE']])assert.equal((await fetch(base+path,{method})).status,403);const cfg=await(await fetch(base+'/api/settings',{headers:{'X-BondBuddy-Admin':adminToken}})).json();assert(!('apiKey'in cfg));assert(!('registryUrl'in cfg));assert.equal(cfg.configured,false);const traversal=await fetch(base+'/..%2F.env');assert.equal(traversal.status,404);});
test('chat accepts text-only tasks and enforces project context',async()=>{const f=new FormData();f.set('kind','generate');f.set('prompt','帮我起草项目说明书');const r=await fetch(base+'/api/tasks',{method:'POST',body:f});assert.equal(r.status,202);const {job}=await r.json();assert(job.conversationId);assert.equal((await complete(job.id)).status,'needs_setup');const wrong=new FormData();wrong.set('kind','generate');wrong.set('prompt','继续');wrong.set('projectId',job.id);assert.equal((await fetch(base+'/api/tasks',{method:'POST',body:wrong})).status,400);});
test('connector configuration preserves private credentials without exposing them',async()=>{
  const r=await fetch(base+'/api/connectors',{method:'POST',headers:{'Content-Type':'application/json','X-BondBuddy-Admin':adminToken},body:JSON.stringify({name:'Wind 测试',vendor:'wind',purpose:'bonds',url:'https://adapter.example/mcp',tool:'query',args:{issuer:'{{issuer}}'},token:'test-private-token',readOnlyConfirmed:true})});assert.equal(r.status,200);const {id}=await r.json();
  const list=await(await fetch(base+'/api/connectors')).json();assert.equal(list.connectors[0].name,'Wind 测试');for(const field of ['token','url','args','tool','hasToken'])assert(!(field in list.connectors[0]));assert(!JSON.stringify(list).includes('test-private-token'));
  const linked=(await(await fetch(base+'/api/tasks')).json()).jobs.find(j=>j.kind==='review');const body=new FormData();body.set('kind','generate');body.set('prompt','查询全部公司债兑付情况');body.set('queryMode','auto');body.set('projectId',linked.id);
  const response=await fetch(base+'/api/tasks',{method:'POST',body});assert.equal(response.status,202);const {job}=await response.json();assert.deepEqual(job.connectorIds,[id]);assert.equal(job.queryIssuer,'测试发行人');assert.equal(job.queryMode,'auto');await complete(job.id);
  const personal=withQuoteConfirmation(createClient());await signIn(personal,base,'13700137000');
  assert.equal((await(await personal(base+'/api/connectors')).json()).connectors[0].id,id);
  const input=new FormData();input.set('kind','generate');input.set('prompt','查询全部公司债兑付情况');input.set('queryIssuer','测试发行人');
  const allowed=await personal(base+'/api/tasks',{method:'POST',body:input});assert.equal(allowed.status,202);await complete((await allowed.json()).job.id,personal);
  const material=form();material.set('reviewNotes','仅依据上传材料');const responseLocal=await personal(base+'/api/tasks',{method:'POST',body:material});assert.equal(responseLocal.status,202);const localJob=(await responseLocal.json()).job;assert.deepEqual(localJob.connectorIds,[]);await complete(localJob.id,personal);
  assert.equal((await(await personal(base+'/api/billing')).json()).wallet.available,2000);
  assert.equal((await fetch(base+'/api/connectors/'+id,{method:'DELETE',headers:{'X-BondBuddy-Admin':adminToken}})).status,200);
});
test('cookie identity isolates projects, downloads, orders and balances; logout revokes it',async()=>{
  const other=createClient();await signIn(other,base,'13900139000');const existing=(await(await fetch(base+'/api/tasks')).json()).jobs[0];assert(existing);
  assert.equal((await(await other(base+'/api/tasks',{headers:{'X-BondBuddy-Seat':'primary'}})).json()).jobs.length,0);
  assert.equal((await other(base+'/api/tasks/'+existing.id)).status,403);
  assert.equal((await other(base+'/api/tasks/'+existing.id+'/download/anything.docx?seat=primary')).status,403);
  const primaryOrder=(await(await fetch(base+'/api/billing')).json()).orders[0];assert.equal((await other(base+'/api/billing/orders/'+primaryOrder.id)).status,404);
  assert.equal((await(await other(base+'/api/billing',{headers:{'X-BondBuddy-Seat':'primary'}})).json()).seat.quota.active,true);
  const logout=await other(base+'/api/auth/logout',{method:'POST'});assert.equal(logout.status,200);assert.equal((await other(base+'/api/tasks')).status,401);
  const returning=await signIn(fetch,base);assert.equal(returning.created,false);assert.equal((await(await fetch(base+'/api/billing')).json()).seat.quota.active,true);
});

test('free wallet QA is one click, replay-safe, and does not call the model',async()=>{
  const requestId=randomUUID(),body=()=>{const f=new FormData();f.set('kind','generate');f.set('prompt','积分余额');f.set('requestId',requestId);f.set('credits','0');return f;};
  const before=(await(await fetch(base+'/api/billing')).json()).wallet;
  const responses=await Promise.all([fetch(base+'/api/tasks',{method:'POST',body:body()}),fetch(base+'/api/tasks',{method:'POST',body:body()})]);
  const jobs=await Promise.all(responses.map(async r=>{assert.equal(r.status,202,await r.clone().text());return (await r.json()).job;}));
  assert.equal(jobs[0].id,jobs[1].id);assert.equal(jobs[0].status,'complete');assert.equal(jobs[0].billing.charged,0);assert(jobs[0].result.answer.includes('可用积分'));assert(!jobs[0].cost);assert(!jobs[0].quote);
  const again=(await(await fetch(base+'/api/tasks',{method:'POST',body:body()})).json()).job;assert.equal(again.id,jobs[0].id);
  assert.equal((await(await fetch(base+'/api/billing')).json()).wallet.available,before.available);
});

test('insufficient credit never queues work and forged price fields cannot bypass the wallet',async()=>{
  const person=createClient();await signIn(person,base,'13600136000');
  const form=new FormData();form.set('kind','generate');form.set('prompt','进行多步骤深度研究');form.set('credits','0');form.set('coefficient','0');form.set('cost','0');form.append('other',new Blob(['材料'.repeat(600000)]),'大量材料.txt');
  const result=await person(base+'/api/tasks',{method:'POST',body:form});assert.equal(result.status,402,await result.clone().text());assert.equal((await result.json()).code,'CREDITS_INSUFFICIENT');
  const wallet=(await(await person(base+'/api/billing')).json()).wallet;assert.equal(wallet.available,2000);assert.equal(wallet.frozen,0);assert.equal(wallet.spent,0);assert.equal((await(await person(base+'/api/tasks')).json()).jobs.length,0);
});
