// Disposable local evidence fixture. Real API/queue/Word/storage, synthetic replies only.
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {environment,databaseURL,blobConnection,instance,runtime,baseURL,terms} from './config.mjs';
if(instance!=='qa-20261021'||new URL(databaseURL).hostname!=='127.0.0.1')throw Error('Isolated QA instance required');
Object.assign(process.env,environment());
process.env.BONDBUDDY_TEST_PYTHON=process.env.BB_PYTHON;
const {createServer}=await import('../../apps/api/dist/server.js');
const {azureBlobs,digest,transaction}=await import('../../apps/api/dist/data.js');
const {grantCredits}=await import('../../apps/api/dist/billing.js');
const {runPipelineOnce,inputLockStage,materialsReadyStage}=await import('../../apps/worker/dist/run-pipeline.js');
const {projectQaModelStage,projectQaDeliveryStage}=await import('../../apps/worker/dist/project-qa-stage.js');
const pool=new Pool({connectionString:databaseURL}),blobs=azureBlobs(blobConnection);let owner;
const app=createServer({pool,blobs,allowedOrigin:baseURL,enableRunRuntime:true,principal:async()=>({userId:owner,csrfVerified:true})});
async function send(method,url,payload){const r=await app.inject({method,url,payload,headers:{origin:baseURL,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});if(r.statusCode>=300)throw Error(r.body);return r.body?r.json():null;}
try{
 if((await pool.query("SELECT 1 FROM bb_runs WHERE state NOT IN('succeeded','failed','cancelled','rejected','test_completed')")).rowCount)throw Error('Preserve active runs; seed only while local worker is stopped and queue idle');
 let account=(await pool.query("SELECT id FROM bb_users WHERE username='integration_user'")).rows[0];
 if(!account){await send('POST','/api/v1/auth/register',{username:'integration_user',password:'Local-Test-2026!',accepted_terms_version:terms});account=(await pool.query("SELECT id FROM bb_users WHERE username='integration_user'")).rows[0];}
 owner=account.id;
 await transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:'local-acceptance-integration_user',points:1000000,expiresAt:null,actor:'local-integration',reason:'Synthetic local test credits; not production'}));
 const project=await send('POST','/api/v1/projects',{kind:'generation',name:'合成项目问答验收 · 模拟回答',issuer_name:'合成发行人',market:'sse',offering:'public'}),path='/api/v1/projects/'+project.project_id,base=path+'/qa';
 async function upload(filename){const bytes=readFileSync(join(runtime,'evidence/synthetic-documents',filename)),decl={sha256:digest(bytes),byte_size:bytes.length},u=await send('POST',path+'/materials/uploads',{...decl,filename,role:'other',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});await send('PUT',u.upload_url,bytes);const m=await send('POST',path+'/materials/uploads/'+u.upload_id+'/complete',decl);return {kind:'material',pin:{source_project_id:project.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256}};}
 const source=await upload('synthetic-questions.docx'),material=await upload('synthetic-materials.docx');
 const execute=()=>runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,projectQaModelStage({model:o=>({name:o.name,run:async ctx=>{
  const {manifest}= (await pool.query('SELECT manifest FROM bb_project_qa_runs WHERE run_id=$1',[ctx.run.id])).rows[0];
  if(!manifest.project_name.startsWith('合成项目问答验收'))throw Error('Only synthetic fixture may use synthetic replies');
  const q=manifest.questions.find(q=>'qa-'+q.id===o.logicalCallId),first=q.id===manifest.questions[0].id;
  return {kind:'done',value:{question_id:q.id,status:first?'draft':'missing',answer:first?'【合成测试回答】本期募集资金 5 亿元全部用于偿还有息债务。':'【合成测试】需要补充材料后形成正式回复。',citations:first?[{asset_index:0,span_id:'p1',quote:'本期发行规模为人民币 5 亿元，募集资金全部用于偿还有息债务。'}]:[],missing_materials:first?[]:['请补充往来占款明细、回款计划及最近一期回款凭证。'],case_ids:[],approach:'合成测试仅验证回填流程，真实模型质量尚未验证。'}};
 }})}),projectQaDeliveryStage()]});
 const prepared=await send('POST',base+'/prepare',{request_id:randomUUID(),source});if(await execute()!=='succeeded')throw Error('Synthetic preparation failed');
 let w=await send('GET',base);w=await send('POST',base+'/draft',{expected_revision:w.revision,draft:{preparation_id:prepared.run_id,questions:w.runs[0].result.questions,materials:[material],requirements:'合成测试，逐题回填并注明待补材料。',use_knowledge:true}});
 const answer=await send('POST',base+'/runs',{request_id:randomUUID(),expected_revision:w.revision,expected_points:w.draft.questions.length*60,price_version:w.price.version});if(await execute()!=='succeeded')throw Error('Synthetic answering failed');
 const receipt={project_id:project.project_id,preparation_id:prepared.run_id,run_id:answer.run_id,url:baseURL+'/#qa?project='+project.project_id+'&run='+answer.run_id,model:'synthetic; no provider call',username:'integration_user',password:'Local-Test-2026!'};
 writeFileSync(join(runtime,'qa-browser-fixture.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{await app.close();await pool.end();}
