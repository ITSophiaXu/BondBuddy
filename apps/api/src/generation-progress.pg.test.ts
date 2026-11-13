import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {readWorkpaperBatch} from './workpapers.js';
import {workpaperFileVersions} from './project-file-storage.js';
import {GenerationProgressSchema,BILLING_WIRE_HEADER,BILLING_WIRE_VERSION} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';

const database=await isolatedTestDatabase(undefined,'egress');
test('248 items / 120 files / 25,997 links: small public responses, retained evidence, progress and ownership',{skip:!database,timeout:120_000},async t=>{
 const pool=new Pool({connectionString:database}),user=randomUUID();let actor=user;
 const app=createServer({pool,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true})});
 const sha='a'.repeat(64),headers={[BILLING_WIRE_HEADER]:BILLING_WIRE_VERSION};
 const post=async(path:string,payload:unknown)=>{const response=await app.inject({method:'POST',url:'/api/v1'+path,headers:{...headers,origin:'http://bondbuddy.test'},payload:payload as any});assert.ok(response.statusCode<300,response.body);return response.json();};
 try{
  const project=(await post('/projects',{name:'Synthetic egress regression',kind:'generation',issuer_name:'Synthetic',market:'sse',offering:'private'})).project_id;
  const topic=(await post('/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic',source_project_id:project})).topic;
  const catalogue=randomUUID(),batch=randomUUID(),generation=randomUUID(),run=randomUUID();
  const source={project_id:project,version_id:'synthetic-source',selection_revision:1,sequence:1,filename:'Synthetic.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-material',material_version:1,sha256:sha}}};
  const entries=Array.from({length:248},(_,i)=>({id:'item-'+i,code:'1-'+i,title:'合成核查记录',folder:'1 尽职调查',kind:'file',sheet:'目录',row:i+2,instructions:'synthetic',path:i+'.docx'}));
  await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,'{}','Synthetic.xlsx',$5,'[]',$4)",[catalogue,user,project,sha,JSON.stringify(entries)]);
  await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,'running',0,'synthetic','direct')",[batch,user,project,topic.topic_id,catalogue,sha,source]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[topic.project_id,user,sha]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'running','writing')",[run,user,topic.project_id,sha]);
  for(let n=0;n<248;n++){
   await pool.query("INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state,run_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[user,batch,entries[n].id,n,{input:{workpaper:{entry:entries[n]}}},n===0?'running':'succeeded',n===0?run:null]);
   if(n>=120)continue;
   const file=randomUUID(),version=randomUUID(),links=Array.from({length:216+(n<77?1:0)},(_,i)=>({source_span_id:'p-'+i,target_span_id:'p-'+i,source_quote:'合成证据'.repeat(12),target_quote:'合成核查'.repeat(12),field:'synthetic',period:'2026',unit:'元',source_location:'paragraph '+i,target_location:'paragraph '+i,source_sha256:sha,target_sha256:sha}));
   await pool.query("INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type,identity_key) VALUES($1,$2,$3,'workpaper',$1)",[file,user,project]);
   await pool.query("INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,links) VALUES($1,$2,$3,1,$4,$5,$6)",[version,user,file,n+'.docx',source.asset,JSON.stringify(links)]);
   await pool.query('UPDATE bb_project_files SET latest_version_id=$2 WHERE id=$1',[file,version]);
   await pool.query('INSERT INTO bb_workpaper_file_bindings(owner_user_id,batch_id,item_id,file_id,original_version_id) VALUES($1,$2,$3,$4,$5)',[user,batch,entries[n].id,file,version]);
  }
  await pool.query("INSERT INTO bb_file_generation_batches(id,owner_user_id,project_id,request_id,request_hash,snapshot,workpaper_batch_id,points) VALUES($1,$2,$3,$1,$4,'{}',$5,1)",[generation,user,project,sha,batch]);
  const base='/api/v1/projects/'+project;
  const get=async(path:string)=>{const response=await app.inject({url:base+path,headers});assert.equal(response.statusCode,200,response.body);return response;};
  const full=await workpaperFileVersions(pool,user,project);
  assert.equal([...full.values()].reduce((sum,f)=>sum+f.original.links.length,0),25997);
  const summary=await readWorkpaperBatch(pool,user,project,batch);
  assert.equal(summary.items.length,248);assert.equal(summary.items.filter(i=>i.file).length,120);
  for(const item of summary.items.filter(i=>i.file)){assert.ok(!('links' in item.file!.original));assert.deepEqual(item.file!.original,item.file!.current);}
  const legacy={...summary,items:summary.items.map(i=>({...i,...(full.has(batch+':'+i.entry.id)?{file:full.get(batch+':'+i.entry.id)}:{})}))};
  const oldBytes=Buffer.byteLength(JSON.stringify(legacy)),newBytes=Buffer.byteLength(JSON.stringify(summary));
  assert.ok(oldBytes>25_000_000);assert.ok(newBytes<500_000);assert.ok(newBytes<oldBytes/50);
  for(const path of ['/workpapers','/file-generation','/workpapers/library?offset=0&limit=50']){
   const response=await get(path);assert.ok(Buffer.byteLength(response.body)<800_000);assert.ok(!response.body.includes('"links":'));
   if(path.includes('/library')){assert.equal(response.json().active,true);assert.equal(response.json().items[0].links_count,217);}
  }
  const first=(await get('/workpapers/progress')).json();assert.ok(Value.Check(GenerationProgressSchema,first));assert.equal(first.active,true);
  assert.deepEqual((await get('/workpapers/progress')).json(),first);
  const fg=(await get('/file-generation/progress')).json();assert.equal(fg.active,true);
  await pool.query("UPDATE bb_runs SET stage='packaging' WHERE id=$1",[run]);
  assert.notEqual((await get('/workpapers/progress')).json().revision,first.revision);
  assert.notEqual((await get('/file-generation/progress')).json().revision,fg.revision);
  await pool.query("UPDATE bb_workpaper_batches SET state='paused' WHERE id=$1",[batch]);
  assert.equal((await get('/workpapers/progress')).json().active,true,'in-flight work must settle before polling stops');
  await pool.query("UPDATE bb_runs SET state='settlement_pending',stage='settlement_pending' WHERE id=$1",[run]);
  for(const path of ['/workpapers/progress','/file-generation/progress'])
    assert.equal((await get(path)).json().active,true,'settlement can finish after the batch is paused');
  await pool.query("UPDATE bb_workpaper_batches SET state='cancelled' WHERE id=$1",[batch]);
  assert.equal((await get('/workpapers/progress')).json().active,true,'stopped batches retain in-flight settlement updates');
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run]);
  assert.equal((await get('/workpapers/progress')).json().active,false);
  const before=(await get('/workpapers/progress')).json().revision;
  await pool.query("UPDATE bb_workpaper_items SET error='synthetic failure' WHERE batch_id=$1 AND item_id='item-0'",[batch]);
  assert.notEqual((await get('/workpapers/progress')).json().revision,before,'errors change without a batch revision');
  const bytes=Buffer.byteLength((await get('/workpapers/progress')).body);assert.ok(bytes<200);
  assert.equal((await app.inject({url:base+'/workpapers/progress?batch_id=missing',headers})).statusCode,404);
  assert.equal((await app.inject({url:base+'/workpapers/progress?batch_id='+batch,headers})).statusCode,200);
  actor=randomUUID();
  for(const path of ['/workpapers','/file-generation','/workpapers/progress','/file-generation/progress','/workpapers/progress?batch_id='+batch])assert.equal((await app.inject({url:base+path,headers})).statusCode,404);
  t.diagnostic(JSON.stringify({synthetic:true,items:248,files:120,links:25997,legacy_bytes:oldBytes,summary_bytes:newBytes,progress_bytes:bytes}));
 }finally{await app.close();await pool.end();}
});
