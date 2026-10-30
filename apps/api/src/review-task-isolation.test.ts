// Synthetic data with real PostgreSQL/API; no worker, model, or customer account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, uid } from './data.js';

const connection=await isolatedTestDatabase(undefined,'review-task-isolation');
test('opening review never projects update work as a review task and preserves the execution mutex',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),owner='synthetic-review-route-owner',origin='http://bondbuddy.test';
  const app=createServer({pool,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  const ok=(r:{statusCode:number;body:string})=>assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);
  try{
    const created=await send('POST','/api/v1/projects',{name:'Synthetic update project',kind:'update',issuer_name:null,market:null,offering:null});ok(created);
    const id=created.json().project_id,base=`/api/v1/projects/${id}`,runId=uid(),hash=digest('synthetic update');
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[id,owner,hash]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'update',$4,'queued')`,[runId,owner,id,hash,uid()]);
    const execution={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    for(const state of ['queued','running','paused','awaiting_input']){
      await pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[runId,state]);
      const entry=await send('POST',`${base}/review-entry`,{});ok(entry);assert.equal(entry.json().project_id,id);
      const response=await send('GET',`${base}/review-workspace`);ok(response);
      assert.equal(response.json().active_run,null,`update ${state} must not appear as active review`);
      assert.deepEqual(response.json().timeline,[]);
      assert.deepEqual((await send('GET',`${base}/review-history`)).json().items,[]);
      const blocked=await send('POST',`${base}/review-executions`,execution);assert.equal(blocked.statusCode,409,blocked.body);
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_review_executions WHERE project_id=$1',[id])).rows[0].n,0);
    // The run's own kind, not the project's original kind, controls the progress display.
    await pool.query("UPDATE bb_runs SET task_kind='review',state='running' WHERE id=$1",[runId]);
    assert.equal((await send('GET',`${base}/review-workspace`)).json().active_run.run_id,runId);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[runId]);
    assert.equal((await send('GET',`${base}/review-workspace`)).json().active_run,null);
  }finally{await app.close();await pool.end();}
});
