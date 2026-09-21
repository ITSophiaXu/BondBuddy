import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ROOT, PYTHON, processRun } from '../lib/platform.mjs';
import { createClient, signIn } from './http-client.mjs';

const runtime=join(ROOT,'qa','artifacts','library-http-'+randomUUID());await mkdir(runtime,{recursive:true});
await processRun(PYTHON,[join(ROOT,'qa','make_library_fixtures.py'),runtime]);
await writeFile(join(runtime,'settings.json'),JSON.stringify({apiKey:'',tavilyKey:'',registryKey:''}));
const port=5300+Math.floor(Math.random()*500),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,PORT:String(port),BOND_BUDDY_RUNTIME:runtime,DEEPSEEK_API_KEY:'',TAVILY_API_KEY:'',REGISTRY_API_KEY:''},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});test.after(()=>child.kill());
const client=createClient(),other=createClient();await signIn(client,base);await signIn(other,base,'13700137000');
const pdf=await readFile(join(runtime,'blueprint.pdf'));
let entry;
function importForm(){const f=new FormData();for(const [key,value] of Object.entries({title:'仅测试的官方募集书',issuer:'参考企业（测试）',market:'sse',instrument:'公司债券',offering:'public',projectStatus:'注册生效',sourceUrl:'https://bond.sse.com.cn/fixture/project',documentUrl:'https://static.sse.com.cn/fixture.pdf',version:'注册稿',publishedAt:'2026-06-30',industry:'制造业',confirmed:'on'}))f.set(key,value);f.append('document',new Blob([pdf]),'公开募集书.pdf');return f;}
function taskForm(){const f=new FormData();for(const [key,value] of Object.entries({kind:'update',title:'本企业新项目',issuer:'本次发行人（测试）',scope:'sse-public',periods:'2026-06-30',authoringMode:'reference',blueprintId:entry.id,industry:'制造业'}))f.set(key,value);f.append('financial',new Blob(['本次发行人总资产120万元。']),'财务材料.txt');return f;}

test('authenticated personal imports cannot publish shared entries; official URLs and file types are validated',async()=>{
  assert.equal((await globalThis.fetch(base+'/api/library')).status,401);
  assert.equal((await(await client(base+'/api/health')).json()).libraryVersion,1);
  const bad=importForm();bad.set('documentUrl','https://attacker.test/fixture.pdf');assert.equal((await client(base+'/api/library',{method:'POST',body:bad})).status,400);
  const good=importForm();good.set('visibility','public');good.set('owner','forged');const response=await client(base+'/api/library',{method:'POST',body:good});assert.equal(response.status,201);entry=(await response.json()).item;assert.equal(entry.visibility,'personal');assert.equal(entry.textReady,true);assert(!('owner'in entry));assert(!JSON.stringify(entry).includes(runtime));
  assert.equal((await(await other(base+'/api/library')).json()).total,0);
  for(const path of ['', '/document'])assert.equal((await other(base+'/api/library/'+entry.id+path)).status,404);
  const doc=await client(base+'/api/library/'+entry.id+'/document');assert.equal(doc.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await doc.arrayBuffer()),pdf);
  const fulltext=await(await client(base+'/api/library?q=LIBRARY_BODY_SEARCH_TOKEN')).json();assert.equal(fulltext.total,1);assert.equal(fulltext.items[0].hit.locator,'PDF-P001');
});
test('blueprint checks run before quota reservation and reject missing own evidence, scope conflicts and forged access',async()=>{
  const missing=taskForm();missing.delete('financial');assert.equal((await client(base+'/api/tasks',{method:'POST',body:missing})).status,400);
  const mismatch=taskForm();mismatch.set('scope','szse-public');assert.equal((await client(base+'/api/tasks',{method:'POST',body:mismatch})).status,400);
  const duplicate=taskForm();duplicate.append('reference',new Blob([pdf]),'other.pdf');assert.equal((await client(base+'/api/tasks',{method:'POST',body:duplicate})).status,400);
  const history=taskForm();history.set('authoringMode','historical');assert.equal((await client(base+'/api/tasks',{method:'POST',body:history})).status,400);
  assert.equal((await other(base+'/api/tasks',{method:'POST',body:taskForm()})).status,404);
  assert.equal((await client(base+'/api/tasks',{method:'POST',body:taskForm()})).status,402);
});
test('selecting a PDF blueprint copies immutable bytes and provenance without replacing the target issuer',async()=>{
  const order=(await(await client(base+'/api/billing/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:'personal',idempotencyKey:randomUUID()})})).json()).order;
  await client(base+'/api/billing/orders/'+order.id+'/sandbox-pay',{method:'POST'});
  const response=await client(base+'/api/tasks',{method:'POST',body:taskForm()});assert.equal(response.status,202);const {job}=await response.json();
  assert.equal(job.context.issuer,'本次发行人（测试）');assert.equal(job.context.blueprint.issuer,entry.issuer);assert.equal(job.context.blueprint.sha256,entry.file.sha256);assert.equal(job.files[0].role,'reference');assert.equal(job.context.industry,'制造业');
  let done;for(let i=0;i<80;i++){done=(await(await client(base+'/api/tasks/'+job.id)).json()).job;if(!['queued','extracting'].includes(done.status))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(done.status,'needs_setup',done.progress);assert(done.materials[0].recordCount>0);
  const manifest=JSON.parse(await readFile(join(runtime,'jobs',job.id,'manifest.json'),'utf8'));assert.deepEqual(await readFile(manifest.files[0].path),pdf);assert(manifest.files[0].path.startsWith(join(runtime,'jobs',job.id,'uploads')));
  // The job retains its own copy even when the catalog's underlying file changes later.
  await writeFile(join(runtime,'library','entries',entry.id,'prospectus.pdf'),'changed library copy');assert.deepEqual(await readFile(manifest.files[0].path),pdf);
});
