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
const adminToken=randomUUID();
const port=5300+Math.floor(Math.random()*500),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,PORT:String(port),BOND_BUDDY_RUNTIME:runtime,BOND_BUDDY_ADMIN_TOKEN:adminToken,DEEPSEEK_API_KEY:'',TAVILY_API_KEY:'',REGISTRY_API_KEY:''},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});test.after(()=>child.kill());
const client=createClient(),other=createClient();await signIn(client,base);await signIn(other,base,'13700137000');
const pdf=await readFile(join(runtime,'blueprint.pdf'));
let entry;
function importForm(){const f=new FormData();for(const [key,value] of Object.entries({title:'仅测试的官方募集书',issuer:'参考企业（测试）',market:'sse',instrument:'公司债券',offering:'public',projectStatus:'注册生效',sourceUrl:'https://bond.sse.com.cn/fixture/project',documentUrl:'https://static.sse.com.cn/fixture.pdf',version:'注册稿',publishedAt:'2026-06-30',industry:'制造业',confirmed:'on'}))f.set(key,value);f.append('document',new Blob([pdf]),'公开募集书.pdf');return f;}
function taskForm(){const f=new FormData();for(const [key,value] of Object.entries({kind:'update',title:'本企业新项目',issuer:'本次发行人（测试）',scope:'sse-public',periods:'2026-06-30',authoringMode:'reference',blueprintId:entry.id,industry:'制造业'}))f.set(key,value);f.append('financial',new Blob(['本次发行人总资产120万元。']),'财务材料.txt');return f;}

test('library is unavailable to customers; operator ingestion still validates official sources and serves documents',async()=>{
  assert.equal((await globalThis.fetch(base+'/api/library')).status,401);
  assert.equal((await client(base+'/api/library')).status,404);
  assert.equal((await client(base+'/api/library',{method:'POST',body:importForm()})).status,404);
  const bad=importForm();bad.set('documentUrl','https://attacker.test/fixture.pdf');assert.equal((await client(base+'/api/library',{method:'POST',headers:{'X-BondBuddy-Admin':adminToken},body:bad})).status,400);
  const response=await client(base+'/api/library',{method:'POST',headers:{'X-BondBuddy-Admin':adminToken},body:importForm()});assert.equal(response.status,201);entry=(await response.json()).item;assert.equal(entry.textReady,true);assert(!('owner'in entry));assert(!JSON.stringify(entry).includes(runtime));
  for(const path of ['', '/document'])assert.equal((await other(base+'/api/library/'+entry.id+path)).status,404);
  const doc=await client(base+'/api/library/'+entry.id+'/document',{headers:{'X-BondBuddy-Admin':adminToken}});assert.equal(doc.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await doc.arrayBuffer()),pdf);
  const fulltext=await(await client(base+'/api/library?q=LIBRARY_BODY_SEARCH_TOKEN',{headers:{'X-BondBuddy-Admin':adminToken}})).json();assert.equal(fulltext.total,1);
});

test('customers cannot select internal entries or upload another issuer as the project basis',async()=>{
  for(const body of [taskForm(),taskForm()]){
    body.append('audit',new Blob(['本次发行人审计资料']),'审计.txt');
    assert.equal((await client(base+'/api/tasks',{method:'POST',body})).status,400);
  }
  const manual=taskForm();manual.delete('blueprintId');manual.append('reference',new Blob([pdf]),'peer.pdf');assert.equal((await client(base+'/api/tasks',{method:'POST',body:manual})).status,400);
  const quota=(await(await client(base+'/api/billing')).json()).seat.quota;assert.equal(quota.used.credits,0);assert.equal(quota.reserved.credits,0);
});
