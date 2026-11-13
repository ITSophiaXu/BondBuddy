// Synthetic inputs and provider. Real PostgreSQL, contained adapter, durable
// journal, shared stage, scheduler and authenticated batch actions; no paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import {inputManifestHash as hash} from '@bondbuddy/api/production-rule-pin';
import {advanceWorkpaperBatch,pauseSharedWorkpaperBatch,pauseFailedSharedWorkpaperBatch} from '@bondbuddy/api/workpapers';
import type {M4DocumentManifest} from '@bondbuddy/contracts';
import {codexModelStage,type StageContext} from './run-pipeline.js';
import {sharedWorkpaperDocument,sharedPlanIdentity} from './workpaper-shared-stage.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {isolatedTestDatabase} from './test-database.js';

const database=await isolatedTestDatabase(undefined,'workpaper-shared-failure');
async function setup(){
  const pool=new Pool({connectionString:database}),owner=randomUUID(),objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>Buffer.from(objects.get(k)!),
    getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,max)=>{const b=objects.get(k);assert.ok(!b||b.length<=max);return b??null;},
    exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const origin='http://bondbuddy.test',app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const ok=async(method:'GET'|'POST',url:string,payload?:any)=>{const r=await app.inject({method,url,payload,headers:{origin}});assert.ok(r.statusCode<300,r.body);return r.json();};
  async function fixture(options:{execution?:string;template?:boolean;state?:string;siblings?:boolean}={}){
    const project=(await ok('POST','/api/v1/projects',{name:'Synthetic shared failure',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'})).project_id;
    const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic shared files',source_project_id:project})).topic;
    const batch=randomUUID(),catalogue=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID(),sha='a'.repeat(64);
    const entries=['current',...(options.siblings?['next']:[])].map((id,i)=>({id,code:String(i+1),title:'Synthetic '+id,folder:'',kind:'file' as const,sheet:'Synthetic',row:i+2,instructions:'',path:id+'.docx'}));
    const manifests=entries.map(entry=>({kind:'document',input:{fields:{issuer_name:'Synthetic issuer'},template:options.template?{id:'synthetic-template'}:null,
      workpaper:{batch_id:batch,entry,mode:'direct',execution:options.execution??'shared_batch_v1'}}} as unknown as M4DocumentManifest));
    const source={project_id:project,version_id:'synthetic-source',selection_revision:1,sequence:1,filename:'synthetic.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-material',material_version:1,sha256:sha}}};
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,'{}','synthetic.xlsx',$5,'[]',$4)",[catalogue,owner,project,sha,JSON.stringify(entries)]);
    await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,'running',0,'synthetic','direct')",[batch,owner,project,topic.topic_id,catalogue,sha,source]);
    const inputHash=hash(manifests[0]),state=options.state??'running';
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[topic.project_id,owner,inputHash,manifests[0]]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,$5)",[runId,owner,topic.project_id,inputHash,state]);
    await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,lease_token,lease_until,attempts) VALUES($1,$2,$3,'generation','m4_document_v1',$4,$5,CASE WHEN $5::text IS NULL THEN NULL ELSE now()+interval '60 seconds' END,1)",[jobId,owner,runId,state,state==='running'?token:null]);
    for(let i=0;i<entries.length;i++)await pool.query('INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state,run_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[owner,batch,entries[i].id,i,manifests[i],i===0?'running':'queued',i===0?runId:null]);
    await pool.query('INSERT INTO bb_workpaper_attempts(owner_user_id,batch_id,item_id,attempt,run_id) VALUES($1,$2,$3,1,$4)',[owner,batch,entries[0].id,runId]);
    const snapshot={version:'workpaper-source-v1',source:{sha256:sha,spans:[]},tables:[],images:[]};
    await pool.query('INSERT INTO bb_workpaper_shared_sources(owner_user_id,batch_id,input_hash,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5)',[owner,batch,sharedPlanIdentity(manifests),snapshot,hash(snapshot)]);
    const ctx:StageContext={pool,blobs,lease:{jobId,runId,owner,token,checkpoint:{},attempts:1},run:{id:runId,owner_user_id:owner,project_id:topic.project_id,input_revision:1,input_hash:inputHash,task_kind:'generation'},signal:new AbortController().signal,checkpoint:{},values:new Map()};
    const base=`/api/v1/projects/${project}/workpapers/batches/${batch}`;
    const read=()=>ok('GET',base),action=async(action:string)=>ok('POST',base+'/actions',{action,expected_revision:(await read()).revision});
    return {batch,ctx,manifests,read,action,async durableState(next:string){await pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[runId,next]);await pool.query('UPDATE bb_jobs SET state=$2,lease_token=NULL,lease_until=NULL WHERE id=$1',[jobId,next]);}};
  }
  return {pool,fixture,close:async()=>{await app.close();await pool.end();}};
}

test('journal-settled invalid shared output pauses once, including scheduler before worker return',{skip:!database||process.platform!=='linux',timeout:60000},async t=>{
  const s=await setup(),root=await mkdtemp(join(tmpdir(),'bb-shared-failure-'));
  try{
    for(const schedulerFirst of [false,true])await t.test(schedulerFirst?'scheduler wins after journal commit':'worker observes journal-cleared lease',async()=>{
      const f=await s.fixture({siblings:true});let observed=0,stopped=0;
      const config={...loadCodexAdapterConfig({BB_CODEX_PATH:process.env.BB_CODEX_PATH}),
        command:[process.execPath,fileURLToPath(new URL('../test-fixtures/codex/fake-file-authoring.mjs',import.meta.url))],
        work_root:join(root,randomUUID()),authoring_timeout_ms:5000};
      const model:typeof codexModelStage=options=>{
        const stage=codexModelStage({...options,buildPrompt:async()=> 'SCENARIO:workpaper_invalid',wrapJournal:journal=>new Proxy(journal,{get(target,key){
          if(key==='recordObservation')return async(...args:Parameters<typeof journal.recordObservation>)=>{
            await target.recordObservation(...args);observed++;
            const job=(await s.pool.query('SELECT state,lease_token FROM bb_jobs WHERE id=$1',[f.ctx.lease.jobId])).rows[0];
            assert.deepEqual(job,{state:'failed',lease_token:null},'real journal commits failure before model stage returns');
            if(schedulerFirst)assert.equal(await advanceWorkpaperBatch(s.pool),true);
          };
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }})});
        return {...stage,run:async ctx=>{const outcome=await stage.run(ctx);assert.equal(outcome.kind,'stopped');stopped++;return outcome;}};
      };
      assert.deepEqual(await sharedWorkpaperDocument(f.ctx,{manifest:f.manifests[0],materials:[],artifacts:[]},model,config),{kind:'stopped'});
      assert.equal(observed,1);assert.equal(stopped,1);
      const b=await f.read();assert.equal(b.state,'paused');assert.match(b.error,/共享材料或编制计划尚未完成/);assert.equal(b.revision,2);
      assert.deepEqual(b.items.map((i:any)=>[i.state,i.run_id]),[['failed',f.ctx.run.id],['queued',null]]);
      assert.equal((await s.pool.query('SELECT count(*)::int n FROM bb_workpaper_attempts WHERE batch_id=$1',[f.batch])).rows[0].n,1);
      const attempt=(await s.pool.query('SELECT status,usage_status FROM bb_model_call_attempts WHERE job_id=$1',[f.ctx.lease.jobId])).rows;
      assert.deepEqual(attempt,[{status:'failed',usage_status:'measured'}]);
      assert.equal(await advanceWorkpaperBatch(s.pool),false);
      assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false);
      await f.action('resume');assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false,'late worker cannot pause acknowledged failure');
      assert.equal((await s.pool.query('SELECT state FROM bb_workpaper_items WHERE batch_id=$1 AND item_id=$2',[f.batch,'current'])).rows[0].state,'failed');
      await f.action('cancel');
    });
  }finally{await s.close();await rm(root,{recursive:true,force:true});}
});

test('shared pause guards retain cancellation, lease identity, cache and explicit-resume behavior',{skip:!database},async t=>{
  const s=await setup();
  try{
    await t.test('stopped reconciliation error cannot fall through to an unscoped pause',async()=>{
      const f=await s.fixture();let injected=0;
      const pool=new Proxy(s.pool,{get(target,key){
        if(key==='connect')return async()=>{
          const client=await target.connect();return new Proxy(client,{get(c,k){
            if(k==='query')return async(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM bb_workpaper_batches WHERE owner_user_id=')){injected++;throw Error('SYNTHETIC_RECONCILIATION_UNAVAILABLE');}return (c.query as any)(...args);};
            const value=Reflect.get(c,k);return typeof value==='function'?value.bind(c):value;
          }});
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      }});
      const stopped:typeof codexModelStage=options=>({name:options.name,run:async()=>({kind:'stopped'})});
      assert.deepEqual(await sharedWorkpaperDocument({...f.ctx,pool},{manifest:f.manifests[0],materials:[],artifacts:[]},stopped,loadCodexAdapterConfig({})),{kind:'stopped'});
      assert.equal(injected,1);assert.equal((await f.read()).state,'running');await f.action('cancel');
    });
    await t.test('stopped does not imply failure; no cross-owner, job or claim effects',async()=>{
      const f=await s.fixture();
      assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false,'running replacement lease is not failure');
      await f.durableState('paused');assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false,'reconciliation pause is not failure');
      await f.durableState('cancelled');assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false,'cancel is not failure');
      await f.durableState('failed');
      for(const lease of [{...f.ctx.lease,owner:'foreign'},{...f.ctx.lease,runId:randomUUID()},{...f.ctx.lease,jobId:randomUUID()},{...f.ctx.lease,attempts:0}])assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,lease,f.batch),false);
      await f.action('cancel');assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false,'cancelled batch remains cancelled');
    });
    for(const option of [{execution:'legacy'},{template:true},{cached:true},{cancelled:true}])await t.test('independent file continues '+JSON.stringify(option),async()=>{
      const f=await s.fixture({...option,state:'cancelled' in option?'cancelled':'failed'});
      if('cached' in option)await s.pool.query("INSERT INTO bb_workpaper_shared_plans(owner_user_id,batch_id,input_hash,method_hash,source_hash,plan,plan_hash,author_run_id) VALUES($1,$2,$3,$3,$3,'{}',$3,$4)",[f.ctx.lease.owner,f.batch,'a'.repeat(64),f.ctx.run.id]);
      assert.equal(await pauseFailedSharedWorkpaperBatch(s.pool,f.ctx.lease,f.batch),false);
      assert.equal(await advanceWorkpaperBatch(s.pool),true);assert.equal((await f.read()).state,'partial');
    });
    await t.test('fail/throw pause followed by durable failure is acknowledged on resume',async()=>{
      const f=await s.fixture();await pauseSharedWorkpaperBatch(s.pool,f.ctx.lease.owner,f.batch);await f.durableState('failed');
      await f.action('resume');assert.equal(await advanceWorkpaperBatch(s.pool),true);assert.equal((await f.read()).state,'partial','does not pause again for the same failure');
    });
    await t.test('resuming a still-active item does not acknowledge a future failure',async()=>{
      const f=await s.fixture();await f.action('pause');await f.action('resume');
      assert.equal(await advanceWorkpaperBatch(s.pool),false);await f.durableState('failed');
      assert.equal(await advanceWorkpaperBatch(s.pool),true);assert.equal((await f.read()).state,'paused');
      await f.action('resume');assert.equal(await advanceWorkpaperBatch(s.pool),true);assert.equal((await f.read()).state,'partial');
    });
  }finally{await s.close();}
});
