// End-to-end acceptance through HTTP, real Codex CLI, local fake DeepSeek and Word.
// Never uses live credentials or business files.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, signIn } from './http-client.mjs';
const fetch=createClient();
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, PYTHON, processRun } from '../lib/platform.mjs';
const runtime=join(ROOT,'qa','artifacts','e2e-'+randomUUID());await mkdir(runtime,{recursive:true});
await processRun(PYTHON,[join(ROOT,'qa','make_fixtures.py'),runtime]);
let calls=0;
const upstream=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  assert.equal(req.headers.authorization,'Bearer LOCAL_TEST_ONLY');
  const request=JSON.parse(raw);assert(!request.tools);calls++;
  const prompt=request.messages.map(m=>m.content).join('\n');
  let value;
  if(prompt.includes('"edits"'))value={summary:'测试模拟',edits:[{locator:'P0002',quote:'100',replacement:'120',reason:'测试同口径更新',evidence:[{documentId:'D02',locator:'L00001',quote:'发行人总资产120万元'}]}],gaps:['端到端测试数据']};
  else if(prompt.includes('"findings"'))value={summary:'测试模拟',findings:[],checks:[],limitations:['端到端测试数据，并未验证业务准确率']};
  else value={title:'测试项目说明书',answer:'这是本地端到端测试回复。',document:'## 项目背景\n本地端到端测试材料。',sources:[],limitations:['测试响应']};
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:100,completion_tokens:20}}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const port=5500+Math.floor(Math.random()*500),base=`http://127.0.0.1:${port}`;
const app=spawn(process.execPath,[join(ROOT,'server.mjs')],{cwd:ROOT,windowsHide:true,env:{...process.env,PORT:String(port),BOND_BUDDY_RUNTIME:runtime,DEEPSEEK_API_KEY:'LOCAL_TEST_ONLY',DEEPSEEK_BASE_URL:`http://127.0.0.1:${upstream.address().port}`},stdio:['ignore','pipe','pipe']});
await new Promise((r,j)=>{app.stdout.once('data',r);app.once('error',j);});
const reports=[];
try{
  await signIn(fetch,base);
  const checkout=await fetch(base+'/api/billing/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan:'professional',idempotencyKey:randomUUID()})});assert.equal(checkout.status,201);
  const {order}=await checkout.json();assert.equal((await fetch(base+'/api/billing/orders/'+order.id+'/sandbox-pay',{method:'POST'})).status,200);
  for(const kind of ['generate','update','review']){
    const form=new FormData();form.set('kind',kind);form.set('title','E2E '+kind);form.set('issuer','测试发行人');form.set('scope','sse-private');form.set('periods','2026-06-30');form.set('prompt','生成测试说明书');
    if(kind!=='generate'){
      form.append(kind==='review'?'updated':'historical',new Blob([await readFile(join(runtime,'source.docx'))]),'source.docx');
      if(kind==='update')form.append('financial',new Blob([await readFile(join(runtime,'财务材料.txt'))]),'财务材料.txt');
    }
    const response=await fetch(base+'/api/tasks',{method:'POST',body:form});assert.equal(response.status,202);
    const created=(await response.json()).job;let job;
    for(let i=0;i<150;i++){
      job=(await(await fetch(base+'/api/tasks/'+created.id)).json()).job;
      if(['complete','failed','needs_setup'].includes(job.status))break;
      await new Promise(r=>setTimeout(r,500));
    }
    assert.equal(job.status,'complete',job.progress);
    const docx=job.downloads.find(n=>n.endsWith('.docx'));assert(docx);
    const download=await fetch(base+`/api/tasks/${job.id}/download/${encodeURIComponent(docx)}`);
    assert.equal(download.status,200);const bytes=Buffer.from(await download.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');
    reports.push({kind,status:job.status,download:docx,bytes:bytes.length});
  }
  await writeFile(join(runtime,'acceptance.json'),JSON.stringify({calls,codex:'real',deepseek:'local mocked response',reports},null,2));
  const balance=await(await fetch(base+'/api/billing')).json();assert.equal(balance.seat.quota.used.points,5);assert.equal(balance.seat.quota.used.qa,1);
  console.log(JSON.stringify({calls,reports,upstream:'local-only',runtime},null,2));
}finally{app.kill();upstream.closeAllConnections();upstream.close();}
