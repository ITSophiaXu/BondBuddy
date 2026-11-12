import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {advanceWorkpaperBatch} from './workpapers.js';

const connection=await isolatedTestDatabase(undefined,'workpaper-stop-retry');
test('ending a queue retains the current run; retry waits for terminal state and distinguishes owner-safe blockers',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});let owner='stop-retry-'+randomUUID();const originalOwner=owner;
  const app=createServer({pool,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:'GET'|'POST',url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.json();};
  try{
    const p=await ok('POST','/api/v1/projects',{name:'Synthetic stop/retry',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),project=p.project_id;
    const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic files',source_project_id:project})).topic;
    const hash='a'.repeat(64),source={project_id:project,version_id:'synthetic-source',selection_revision:1,sequence:1,filename:'合成募集书.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-material',material_version:1,sha256:hash}}};
    const catalogue=randomUUID(),batch=randomUUID(),entries=['complete','current','pending'].map((id,i)=>({id,code:`1.${i+1}`,title:'合成底稿 '+id,folder:'1 尽职调查',kind:'file',sheet:'目录',row:i+2,instructions:'',path:id+'.docx'}));
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,'{}','synthetic.xlsx',$5,'[]',$4)",[catalogue,owner,project,hash,JSON.stringify(entries)]);
    const addBatch=async(id:string,state:string)=>pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,$8,0,'synthetic','direct')",[id,owner,project,topic.topic_id,catalogue,hash,source,state]);
    await addBatch(batch,'running');
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[topic.project_id,owner,hash]);
    const addRun=async(state:string)=>{const id=randomUUID();await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,$5)",[id,owner,topic.project_id,hash,state==='succeeded'?'failed':state]);
      if(state==='succeeded'){
        const artifact=randomUUID(),evidence=randomUUID();
        await pool.query("INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence) VALUES($1,$2,$3,$4,1,$5,64,'synthetic-validator','passed','available','readback_verified',$5,64,$6)",[evidence,owner,id,artifact,hash,{sha256:hash,byte_size:64,validator_version:'synthetic-validator',quality_status:'passed'}]);
        await pool.query("INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id) VALUES($1,1,$2,$3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$1,'passed','available',$5)",[artifact,owner,id,hash,evidence]);
        await pool.query("UPDATE bb_runs SET state='succeeded',artifact_id=$2,artifact_version=1 WHERE id=$1",[id,artifact]);
      }
      return id;};
    const completed=await addRun('succeeded'),current=await addRun('running');
    for(let i=0;i<entries.length;i++){
      const run=[completed,current,null][i];
      await pool.query('INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state,run_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[owner,batch,entries[i].id,i+1,{input:{document_type:'workpaper',workpaper:{entry:entries[i],mode:'direct'}}},i===0?'succeeded':i===1?'running':'queued',run]);
      if(run)await pool.query('INSERT INTO bb_workpaper_attempts(owner_user_id,batch_id,item_id,attempt,run_id) VALUES($1,$2,$3,1,$4)',[owner,batch,entries[i].id,run]);
    }
    const base=`/api/v1/projects/${project}/workpapers`,url=`${base}/batches/${batch}/actions`;
    const cancelled=await ok('POST',url,{action:'cancel',expected_revision:1});
    assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.items[1].state,'running');assert.equal(cancelled.items[2].state,'cancelled');
    assert.equal(await advanceWorkpaperBatch(pool),false,'cancelled queue never starts another file');
    const revision=cancelled.revision,retry={action:'retry_failed',expected_revision:revision};
    const blocked=async(reason:string)=>{const r=await send('POST',url,retry);assert.equal(r.statusCode,409,r.body);assert.equal(r.json().code,'PROJECT_RUN_ACTIVE');assert.deepEqual(r.json().field_errors,[{field:'workpaper_batch',code:reason,message:'Workpaper queue is occupied'}]);};
    for(const state of ['running','paused','awaiting_input','settlement_pending']){
      await pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[current,state]);
      await blocked('current_item_active');
      const fresh=await ok('GET',`${base}/batches/${batch}`);
      assert.equal(fresh.items[1].state,state);assert.equal(fresh.items[1].run_id,current);assert.equal(fresh.revision,revision);
      assert.equal((await ok('GET',`${base}/progress?batch_id=${batch}`)).active,!['paused','awaiting_input'].includes(state));
    }
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[current]);
    const otherBatch=randomUUID();await addBatch(otherBatch,'paused');await blocked('other_batch_active');
    await pool.query("UPDATE bb_workpaper_batches SET state='cancelled' WHERE id=$1",[otherBatch]);
    const otherTask=await addRun('running');await blocked('source_task_active');
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[otherTask]);
    owner='foreign-'+randomUUID();assert.equal((await send('POST',url,retry)).statusCode,404);owner=originalOwner;
    const before=(await pool.query('SELECT count(*) n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n;
    const credits=(await pool.query('SELECT count(*) n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n;
    const simultaneous=await Promise.all([send('POST',url,retry),send('POST',url,retry)]);
    assert.deepEqual(simultaneous.map(r=>r.statusCode).sort(),[200,409]);
    assert.equal(simultaneous.find(r=>r.statusCode===409)!.json().code,'INPUT_REVISION_CONFLICT');
    const fresh=await ok('GET',`${base}/batches/${batch}`);
    assert.equal(fresh.state,'queued');assert.equal(fresh.revision,revision+1);
    assert.equal(fresh.items[0].run_id,completed);assert.equal(fresh.items[0].attempt,1);assert.equal(fresh.items[0].state,'succeeded');
    assert.equal(fresh.items[1].run_id,null);assert.equal(fresh.items[1].attempt,2);assert.equal(fresh.items[1].state,'queued');
    assert.equal(fresh.items[2].attempt,1);assert.equal(fresh.items[2].state,'queued');
    assert.equal((await pool.query('SELECT count(*) n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,before,'retry only queues, it does not duplicate runs');
    assert.equal((await pool.query('SELECT count(*) n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,credits,'rejected/duplicate retry never charges');
    assert.equal((await pool.query('SELECT count(*) n FROM bb_workpaper_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,'2','immutable old attempts remain');
  }finally{await app.close();await pool.end();}
});
