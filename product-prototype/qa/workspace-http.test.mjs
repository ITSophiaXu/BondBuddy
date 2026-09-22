import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { ROOT,PYTHON,processRun } from '../lib/platform.mjs';
import { ProspectusLibrary } from '../lib/prospectus-library.mjs';
import { createClient,signIn } from './http-client.mjs';
const runtime=join(ROOT,'qa','artifacts','workspace-'+randomUUID());await mkdir(runtime,{recursive:true});
const script=`from docx import Document\nfrom pathlib import Path\np=Path(r'${runtime.replaceAll('\\','/')}')\nd=Document()\nd.add_paragraph('测试发行人 上海证券交易所 非公开发行公司债券 2024年度历史募集书')\nd.add_paragraph('财务数据123万元，保留原报告期。')\nd.save(p/'history.docx')\nd=Document()\nd.add_paragraph('参考制造企业')\nd.add_paragraph('2025年度合并营业收入按业务（单位：万元）')\nfor row in ['工程施工 | 500','商品销售 | 300','物业服务 | 100','租赁 | 20']: d.add_paragraph(row)\nd.save(p/'peer.docx')\n`;
await processRun(PYTHON,['-c',script]);await writeFile(join(runtime,'settings.json'),JSON.stringify({apiKey:'',tavilyKey:'',registryKey:''}));
const port=6100+Math.floor(Math.random()*400),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,PORT:String(port),BOND_BUDDY_RUNTIME:runtime,DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',d=>stderr+=d);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(stderr||'Server startup timed out')),10000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});test.after(()=>child.kill());
const client=createClient(),other=createClient();await signIn(client,base);await signIn(other,base,'13900139000');
const send=(c,path,data)=>c(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const fields={kind:'update',title:'本期项目',issuer:'测试发行人',scope:'sse-private',periods:'2026-06-30',authoringMode:'historical',projectMessages:JSON.stringify([{text:'截至2026年6月末，银行授信总额50亿元，已使用30亿元，未使用20亿元。'}])};
async function form(values=fields,extraFinancial=''){const form=new FormData();for(const [k,v] of Object.entries(values))form.set(k,v);if(values.authoringMode==='historical')form.append(values.kind==='review'?'updated':'historical',new Blob([await readFile(join(runtime,'history.docx'))]),'history.docx');form.append('audit',new Blob(['测试发行人\n2025年度合并营业收入按业务（单位：万元）\n工程施工 | 500\n商品销售 | 300\n物业服务 | 100\n租赁 | 20']),'审计附注.txt');if(extraFinancial)form.append('financial',new Blob([extraFinancial]),'补充年度财务资料.txt');return form;}
async function assess(id,f=fields,extraFinancial=''){const response=await client(base+`/api/projects/${id}/assessment`,{method:'POST',body:await form(f,extraFinancial)});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.job;}
test('create is free; a single execution request reserves internally with no public quote',async()=>{
  const draft=(await(await send(client,'/api/projects',fields)).json()).job;assert.equal(draft.status,'draft');
  assert.equal((await(await client(base+'/api/billing')).json()).wallet.available,2000);
  assert.equal((await other(base+`/api/projects/${draft.id}/execute`,{method:'POST',body:await form()})).status,403);
  const responses=await Promise.all([client(base+`/api/projects/${draft.id}/execute`,{method:'POST',body:await form()}),client(base+`/api/projects/${draft.id}/execute`,{method:'POST',body:await form()})]);
  for(const r of responses){assert.equal(r.status,202,await r.clone().text());const j=(await r.json()).job;assert.equal(j.id,draft.id);assert(!j.quote);assert(!j.cost);assert(!JSON.stringify(j).includes(runtime));}
  for(let i=0;i<80;i++){const j=(await(await client(base+'/api/tasks/'+draft.id)).json()).job;if(j.billing?.state==='released')break;await new Promise(r=>setTimeout(r,100));}
  const final=(await(await client(base+'/api/tasks/'+draft.id)).json()).job;assert.equal(final.status,'needs_setup');assert.equal(final.billing.state,'released');
  const after=(await(await client(base+'/api/billing')).json()).wallet;assert.equal(after.available,2000);assert.equal(after.spent,0);assert.equal(after.frozen,0);
});

test('automatic matching uses all three audited businesses; customers never see or select library entries',async()=>{
  assert.equal((await client(base+'/api/library')).status,404);
  const library=new ProspectusLibrary(join(runtime,'library'));
  await library.add({title:'测试参考募集书',issuer:'参考制造企业',market:'sse',instrument:'公司债券',offering:'private',projectStatus:'注册生效',sourceUrl:'https://bond.sse.com.cn/test-only',documentUrl:'https://static.sse.com.cn/test-only.pdf',publishedAt:'2026-01-01',version:'测试稿'}, {owner:'primary',visibility:'public',operator:true,confirmed:true,file:{filename:'peer.docx',content:await readFile(join(runtime,'peer.docx'))}});
  const f={...fields,authoringMode:'reference'};const draft=(await(await send(client,'/api/projects',f)).json()).job;
  const job=await assess(draft.id,f);assert.equal(job.status,'awaiting_confirmation');assert(job.files.every(x=>x.role!=='reference'));assert(!job.context.blueprint);assert(!JSON.stringify(job).includes('参考制造企业'));
  const internal=JSON.parse(await readFile(join(runtime,'jobs',job.id,'job.json'),'utf8'));assert.equal(internal.context.blueprint.targetProfile.rows.length,3);assert.equal(internal.context.blueprint.businessProfile.rows.length,3);assert(internal.files.some(x=>x.role==='reference'));
  const bad=await form(f);bad.delete('audit');bad.append('audit',new Blob(['测试发行人 2025年度合并营业收入按业务（单位：万元）\n工程施工 | 500\n商品销售 | 300\n采矿 | 100']),'审计附注.txt');
  const response=await client(base+`/api/projects/${draft.id}/assessment`,{method:'POST',body:bad});assert.equal(response.status,400);
  assert.equal((await send(client,`/api/projects/${draft.id}/start`,{})).status,409);
});
test('internal preparation saves review requirements without exposing pricing',async()=>{
  const f={...fields,kind:'review',scope:'nafmii-mtn',projectMessages:'[{"text":"重点复核关联交易和现金流"}]'};
  const draft=(await(await send(client,'/api/projects',f)).json()).job;const job=await assess(draft.id,f);
  assert.equal(job.context.scope,'nafmii-mtn');assert.equal(job.context.projectMessages[0].text,'重点复核关联交易和现金流');assert.equal(job.status,'awaiting_confirmation');assert.equal(job.cost,undefined);
});

test('grouped uploads save immediately, respect ownership, invalidate quotes and can be removed',async()=>{
  const draft=(await(await send(client,'/api/projects',fields)).json()).job;
  async function upload(role,name,bytes){const body=new FormData();for(const [key,value]of Object.entries(fields))body.set(key,value);body.append(role,new Blob([bytes]),name);return client(base+'/api/projects/'+draft.id+'/materials',{method:'POST',body});}
  const first=await upload('historical','history.docx',await readFile(join(runtime,'history.docx')));assert.equal(first.status,201);const historical=(await first.json()).file;assert(!('path' in historical));
  const second=await upload('audit','审计资料.txt','测试发行人2025年度审计报告及附注，总资产120万元');assert.equal(second.status,201);const audit=(await second.json()).file;
  assert.equal((await other(base+'/api/projects/'+draft.id+'/materials/'+audit.key,{method:'DELETE'})).status,403);
  const body=new FormData();for(const [key,value]of Object.entries(fields))body.set(key,value);body.set('retainedFiles',JSON.stringify([historical.key,audit.key]));
  const response=await client(base+'/api/projects/'+draft.id+'/assessment',{method:'POST',body});assert.equal(response.status,200);const quoted=(await response.json()).job;
  assert.equal((await upload('fundUse','权证.txt','项目建设许可证编号 测试')).status,201);
  assert.equal((await send(client,'/api/projects/'+draft.id+'/start',{})).status,409);
  const currentAudit=quoted.files.find(f=>f.role==='audit');assert.equal((await client(base+'/api/projects/'+draft.id+'/materials/'+audit.key,{method:'DELETE'})).status,404);
  assert.equal((await client(base+'/api/projects/'+draft.id+'/materials/'+currentAudit.key,{method:'DELETE'})).status,200);
  const saved=(await(await client(base+'/api/tasks/'+draft.id)).json()).job;assert.equal(saved.quote,undefined);assert(!saved.files.some(f=>f.role==='audit'));
  const missing=new FormData();for(const [key,value]of Object.entries(fields))missing.set(key,value);missing.set('retainedFiles',JSON.stringify(saved.files.map(f=>f.key)));assert.equal((await client(base+'/api/projects/'+draft.id+'/assessment',{method:'POST',body:missing})).status,400);
});

test('no-history projects accept an optional uploaded peer as structure and keep it separate from issuer evidence',async()=>{
  const values={...fields,authoringMode:'reference'},draft=(await(await send(client,'/api/projects',values)).json()).job;
  const body=await form(values);body.append('userReference',new Blob([await readFile(join(runtime,'peer.docx'))]),'用户参考募集书.docx');
  const response=await client(base+'/api/projects/'+draft.id+'/assessment',{method:'POST',body});assert.equal(response.status,200,await response.clone().text());const job=(await response.json()).job;
  assert(job.files.some(f=>f.role==='userReference'));assert(!job.context.blueprint);
  const internal=JSON.parse(await readFile(join(runtime,'jobs',job.id,'job.json'),'utf8'));assert.equal(internal.context.blueprint.kind,'user-provided');assert(internal.files.some(f=>f.role==='reference'));
});

test('material generation requires a source, reuses broker templates privately and snapshots linked project documents',async()=>{
  const recharge=(await(await send(client,'/api/billing/orders',{type:'recharge',amountCny:50,idempotencyKey:randomUUID()})).json()).order;await send(client,`/api/billing/orders/${recharge.id}/sandbox-pay`,{});
  async function generate(values,files=[] ,account=client){const body=new FormData();for(const [key,value]of Object.entries(values))body.set(key,value);for(const item of files)body.append(item.role,new Blob([item.bytes]),item.name);return account(base+'/api/generation/tasks',{method:'POST',body});}
  const source={role:'prospectus',name:'最新版.docx',bytes:await readFile(join(runtime,'history.docx'))},template={role:'generationTemplate',name:'券商立项模板.txt',bytes:'一、项目概况\n发行人、本期安排\n二、风险审查\n关注偿债风险'};
  assert.equal((await generate({materialType:'underwriter'})).status,400);
  assert.equal((await generate({materialType:'initiation',broker:'测试证券'},[source])).status,400);
  const first=await generate({materialType:'initiation',broker:'测试证券',instructions:'请按模板编写'},[source,template]);assert.equal(first.status,202,await first.clone().text());const job=(await first.json()).job;assert.equal(job.cost,undefined);assert(!job.conversationId);
  const list=(await(await client(base+'/api/generation/templates?broker='+encodeURIComponent('测试证券'))).json()).templates;assert.equal(list.length,1);assert(!JSON.stringify(list).includes(runtime));
  assert.equal((await(await other(base+'/api/generation/templates?broker='+encodeURIComponent('测试证券'))).json()).templates.length,0);
  assert.equal((await generate({materialType:'initiation',broker:'测试证券',templateId:list[0].id},[source],other)).status,404);
  const reused=await generate({materialType:'initiation',broker:'测试证券',templateId:list[0].id},[source]);assert.equal(reused.status,202);assert.equal((await reused.json()).job.cost,undefined);
  const project=(await(await send(client,'/api/projects',fields)).json()).job;await assess(project.id);
  const linked=await generate({materialType:'summary',summaryKind:'private',projectId:project.id});assert.equal(linked.status,202,await linked.clone().text());const output=(await linked.json()).job;assert.equal(output.cost,undefined);assert(output.files.some(f=>f.role==='prospectus'));assert(output.generation.sourceBasis.includes('尚未完成'));
  assert.equal((await generate({materialType:'summary',summaryKind:'public',projectId:project.id},[],other)).status,403);
  assert.equal((await generate({materialType:'summary',summaryKind:'public',projectId:project.id},[source])).status,400);
});
