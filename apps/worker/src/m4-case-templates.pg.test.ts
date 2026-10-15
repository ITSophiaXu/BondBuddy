// Real isolated PostgreSQL/API/worker/Word delivery; synthetic facts/model and in-memory private Blob adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { M4_CASE_TEMPLATES } from '@bondbuddy/contracts';
import { createServer } from '@bondbuddy/api';
import { digest,uid,transaction,type PrivateBlobs } from '@bondbuddy/api/data';
import { emptyM4Draft } from '@bondbuddy/api/m4-workspace';
import { grantCredits,creditBalance } from '../../api/dist/billing.js';
import { isolatedTestDatabase } from './test-database.js';
import { defaultRunStages,runPipelineOnce,type codexModelStage } from './run-pipeline.js';
import { modelGenerationRouter } from './model-generation-router.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { m4DocumentStage } from './m4-document-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';

const connection=await isolatedTestDatabase(undefined,'m4-cases');
const root=resolve(fileURLToPath(import.meta.url),'../../../..'),runFile=promisify(execFile);
test('case templates: real API -> exact worker input -> native Word pair -> one settlement for each supported scope',
  {skip:!connection,timeout:240000},async()=>{
  const pool=new Pool({connectionString:connection}),owner=uid(),files=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>files.get(k)!,getIfExists:async k=>files.get(k)??null,
    getIfExistsBounded:async k=>files.get(k)??null,exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
  let actor:string=owner,calls=0;
  const app=createServer({pool,blobs,enableSyntheticQueue:true,principal:async()=>({userId:actor,csrfVerified:true}),allowedOrigin:'http://bondbuddy.test'});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as never,url,payload:payload as never,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
  const base=resolve(tmpdir()),directory=await mkdtemp(join(base,'bb-case-pipeline-'));
  const model:typeof codexModelStage=options=>({name:options.name,run:async ctx=>{
    const cwd=join(directory,ctx.run.id);await mkdir(cwd);await options.fileWorkspace!.prepare(cwd);calls++;
    const data=JSON.parse(await readFile(join(cwd,'input.json'),'utf8'));
    assert.equal(digest(await readFile(join(cwd,data.knowledge.template_path))),data.task.knowledge.template.sha256);
    assert.match(await options.buildPrompt(ctx),/固定 Word 模板/);
    await runFile(process.env.BONDBUDDY_TEST_PYTHON??'python3',['-B','-c',
      "import json,re,sys; from pathlib import Path; from zipfile import ZipFile; from docx import Document; from lxml import etree as E; from bondbuddy_m4_render_template import fill; p=Path(sys.argv[1]); d=json.loads((p/'input.json').read_text(encoding='utf-8')); t=p/d['knowledge']['template_path']; z=ZipFile(t); x=E.fromstring(z.read('word/document.xml')); v={k:'合成测试内容' for k in re.findall(r'\\{\\{([^{}]+)\\}\\}', ''.join(x.itertext()))}; fill(t,v,p/'output/document.docx'); n=Document(); n.add_paragraph('SYNTHETIC 编制说明：未调用真实模型'); n.save(p/'output/preparation-note.docx')",cwd],
      {cwd:root,env:{...process.env,PYTHONPATH:join(root,'python'),PYTHONIOENCODING:'utf-8'},timeout:30000});
    return {kind:'done',value:await options.fileWorkspace!.collect(cwd,{call_id:uid()} as never,{text:''})};
  }});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'case_'+owner.slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:uid(),points:30000,expiresAt:null,actor:'synthetic',reason:'isolated case template regression'}));
    for(const entry of M4_CASE_TEMPLATES.filter(t=>t.default)){
      const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:uid(),name:'Synthetic '+entry.id})).topic;
      const url=`/api/v1/m4/topics/${topic.topic_id}`,project=topic.project_id,material=uid(),upload=uid(),key='test/'+material,bytes=Buffer.from('Synthetic issuer evidence; no original client facts.');
      files.set(key,bytes);
      await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.txt','text/plain',$4,$5,'other',$6,now()+interval '1 hour','completed')",[upload,owner,project,bytes.length,digest(bytes),key]);
      await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'other','synthetic.txt','text/plain',$5,$6,$7,'persisted')",[material,owner,project,upload,bytes.length,digest(bytes),key]);
      const pin={source_project_id:project,material_id:material,material_version:1,sha256:digest(bytes)};
      const input={...emptyM4Draft(entry.document_type),source_material:pin,fields:{market:entry.market,offering:entry.offering,case_template_id:entry.id}};
      await ok('PUT',`${url}/drafts/${entry.document_type}`,{expected_version:0,input});
      const quote=(await ok('POST',`${url}/quote`,{kind:'document',document_type:entry.document_type,expected_draft_version:1})).quote;
      assert.equal(quote.points,4500);assert.equal(quote.billing_policy,'authoring_balance_v2');
      const request={execution_request_id:uid(),document_type:entry.document_type,expected_draft_version:1,quote_id:quote.quote_id,entrypoint:'workspace'};
      const run=(await ok('POST',`${url}/execute`,request)).run;
      assert.equal((await ok('POST',`${url}/execute`,request)).run.run_id,run.run_id);
      const before=(await ok('GET',`${url}/workspace`)).tasks[0].manifest;
      // Changing the live draft after submission cannot replace the pinned bytes.
      await ok('PUT',`${url}/drafts/${entry.document_type}`,{expected_version:1,input:{...input,supplemental_requirements:'next run only'}});
      const result=await runPipelineOnce({pool,blobs,leaseSeconds:60,runKinds:['generation'],stages:defaultRunStages({
        model_generation:modelGenerationRouter({m4Document:m4DocumentStage({config:loadCodexAdapterConfig({}),model})}),word_delivery:historicalWordDeliveryStage()}),onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
      assert.equal(result,'succeeded',JSON.stringify((await ok('GET',`${url}/workspace`)).tasks[0].events));
      const task=(await ok('GET',`${url}/workspace`)).tasks[0];assert.equal(task.artifacts.length,2);assert.deepEqual(task.manifest,before);
      assert.equal(task.credit_charge.progress.charged_points,4500);
      actor='foreign-owner';assert.equal((await send('GET',`${url}/workspace`)).statusCode,404);actor=owner;
    }
    assert.equal(calls,6);assert.equal((await creditBalance(pool,owner)).available,3000);
  }finally{await app.close();await pool.end();assert.ok(directory.startsWith(base));await rm(directory,{recursive:true,force:true});}
});
