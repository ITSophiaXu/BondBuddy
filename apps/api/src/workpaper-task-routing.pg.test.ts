import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'workpaper-task-routing');
test('workpaper task projection distinguishes inspections; exact historical reads preserve project and owner isolation',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});let owner='routing-'+randomUUID();const originalOwner=owner;
  const app=createServer({pool,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:'GET'|'POST',url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.json();};
  try{
    const p=await ok('POST','/api/v1/projects',{name:'Synthetic routing project',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),project=p.project_id;
    const foreign=await ok('POST','/api/v1/projects',{name:'Synthetic other project',kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private'});
    const hash='a'.repeat(64),source={project_id:project,version_id:'old-source',selection_revision:1,sequence:1,filename:'合成旧版募集书.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-material',material_version:1,sha256:hash}}};
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
    const addRun=async(state='failed')=>{const id=randomUUID();await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,$5)",[id,owner,project,hash,state]);return id;};
    const request={request_id:'synthetic-assessment',catalogue_id:'catalogue',catalogue_sha256:hash,item_ids:['item'],source_version_id:source.version_id,source_selection_revision:1,requirements:'保留旧检查要求'};
    const addAssessment=async(state='failed')=>{const id=await addRun(state);await pool.query('INSERT INTO bb_workpaper_assessments(run_id,owner_user_id,project_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[id,owner,project,{version:'workpaper-assessment-v1',source,request,entries:[]},hash]);return id;};
    const oldest=await addAssessment('paused');for(let i=0;i<22;i++)await addAssessment();
    const authoring=await addRun();
    const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic files',source_project_id:project})).topic;
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES('catalogue',$1,$2,'catalogue',$3,'{}','synthetic.xlsx','[]','[]',$3)",[owner,project,hash]);
    await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,assessment_id,assessment_hash) VALUES('batch',$1,$2,$3,'catalogue','batch',$4,$5,'complete',0,'synthetic',$6,$4)",[owner,project,topic.topic_id,hash,source,oldest]);
    const check=await addRun();await pool.query('INSERT INTO bb_workpaper_checks(run_id,owner_user_id,project_id,batch_id,manifest,input_hash) VALUES($1,$2,$3,\'batch\',$4,$5)',[check,owner,project,{version:'workpaper-change-v1',batch_id:'batch',source,baseline:source},hash]);
    const tasks=await ok('GET',`/api/v1/projects/${project}/tasks?limit=50`);
    assert.equal(tasks.items.find((t:any)=>t.run_id===oldest).operation,'workpaper_assessment');
    assert.equal(tasks.items.find((t:any)=>t.run_id===check).operation,'workpaper_check');
    assert.equal(tasks.items.find((t:any)=>t.run_id===authoring).operation,null,'legacy generation authoring remains unchanged');
    const summary=(await ok('GET','/api/v1/projects')).items.find((p:any)=>p.project_id===project).task_summary;
    assert.equal(summary.attention,3,'authoring, assessment and change-check lanes each remain visible');
    assert.equal(summary.latest.operation,'workpaper_assessment','the original paused inspection remains the attention task');
    assert.equal(summary.recent_result.operation,'workpaper_check');
    const exact=await ok('GET',`/api/v1/projects/${project}/workpapers/assessments/${oldest}`);
    assert.equal(exact.assessment_id,oldest);assert.equal(exact.request.requirements,request.requirements);
    for(const id of ['absent',check])assert.equal((await send('GET',`/api/v1/projects/${project}/workpapers/assessments/${id}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${foreign.project_id}/workpapers/assessments/${oldest}`)).statusCode,404);
    owner='other-'+randomUUID();assert.equal((await send('GET',`/api/v1/projects/${project}/workpapers/assessments/${oldest}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/tasks`)).statusCode,404);
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[originalOwner,oldest])).rows[0].state,'paused');
  }finally{await app.close();await pool.end();}
});

test('batch tasks project immutable attempt membership to both collection endpoints with owner/source isolation',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});let owner='batch-routing-'+randomUUID();const originalOwner=owner;
  const app=createServer({pool,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:'GET'|'POST',url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.json();};
  const hash='b'.repeat(64);
  try{
    const newProject=async()=>ok('POST','/api/v1/projects',{name:'Synthetic batch project',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'});
    const p=await newProject(),other=await newProject(),project=p.project_id;
    const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic batch files',source_project_id:project})).topic;
    const source={project_id:project,version_id:'synthetic-source',selection_revision:1,sequence:1,filename:'合成募集书.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-material',material_version:1,sha256:hash}}};
    const catalogue=randomUUID(),entry={id:'item',code:'1.1',title:'合成底稿',folder:'1 尽职调查文件',kind:'file',sheet:'目录',row:2,instructions:'',path:'1.1 合成底稿.docx'};
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,'{}','synthetic.xlsx',$5,'[]',$4)",[catalogue,owner,project,hash,JSON.stringify([entry])]);
    const addBatch=async(sourceProject=project)=>{
      const id=randomUUID();
      await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,'running',0,'synthetic','direct')",[id,owner,sourceProject,topic.topic_id,catalogue,hash,source]);
      await pool.query('INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest) VALUES($1,$2,\'item\',1,$3)',[owner,id,{input:{document_type:'workpaper',workpaper:{entry,mode:'direct'}}}]);return id;
    };
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[topic.project_id,owner,hash]);
    const addRun=async(state='failed',documentType='workpaper')=>{
      const id=randomUUID();
      await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,$5)",[id,owner,topic.project_id,hash,state]);
      await pool.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[id,owner,topic.topic_id,{input:{document_type:documentType}},hash]);return id;
    };
    const attempt=async(batch:string,run:string,n=1)=>pool.query('INSERT INTO bb_workpaper_attempts(owner_user_id,batch_id,item_id,attempt,run_id) VALUES($1,$2,\'item\',$3,$4)',[owner,batch,n,run]);
    const batch=await addBatch();
    await pool.query("UPDATE bb_workpaper_batches SET state='queued' WHERE id=$1",[batch]);
    const queued=(await ok('GET',`/api/v1/projects/${project}/tasks`)).items;
    assert.equal(queued.length,1,'a submitted batch is visible before its first child run');
    assert.equal(queued[0].state,'queued');
    assert.deepEqual(queued[0].workpaper_batch,{batch_id:batch,project_id:project,total:1,completed:0});
    await pool.query("UPDATE bb_workpaper_batches SET state='running' WHERE id=$1",[batch]);
    const oldRun=await addRun(),retry=await addRun('running');
    await attempt(batch,oldRun);await attempt(batch,retry,2);
    await pool.query("UPDATE bb_workpaper_items SET run_id=$1,attempt=2,state='running' WHERE batch_id=$2",[retry,batch]);
    const ordinary=await addRun('failed','issuer');
    // Even inconsistent historical associations must not expose another source project.
    const unrelatedBatch=await addBatch(other.project_id),unrelatedRun=await addRun();await attempt(unrelatedBatch,unrelatedRun);
    // Hundreds of delivered files plus historical failed attempts are still one task.
    await pool.query(`INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state)
      SELECT $1,$2,'item-'||n,n,$3,'succeeded' FROM generate_series(2,248)n`,[owner,batch,{input:{document_type:'workpaper',workpaper:{entry,mode:'direct'}}}]);
    const tasks=await ok('GET',`/api/v1/projects/${project}/tasks?limit=50`);
    for(const run of [oldRun,retry])assert.equal(tasks.items.some((t:any)=>t.run_id===run),false);
    const batchTask=tasks.items.find((t:any)=>t.workpaper_batch?.batch_id===batch);
    assert.equal(batchTask.operation,'workpaper_batch');assert.equal(batchTask.state,'running');
    assert.equal(batchTask.project_id,project);assert.equal(batchTask.run_id,batch);
    assert.deepEqual(batchTask.workpaper_batch,{batch_id:batch,project_id:project,total:248,completed:247});
    for(const run of [ordinary,unrelatedRun])assert.equal(tasks.items.find((t:any)=>t.run_id===run).workpaper_batch,undefined);
    assert.equal(tasks.items.length,3,'one batch plus two unrelated ordinary tasks');
    const summary=(await ok('GET','/api/v1/projects')).items.find((item:any)=>item.project_id===project).task_summary;
    assert.equal(summary.latest.run_id,batch);assert.equal(summary.active,1);assert.equal(summary.total,3);
    assert.deepEqual(summary.latest.workpaper_batch,batchTask.workpaper_batch);
    const exact=await ok('GET',`/api/v1/projects/${project}/workpapers/batches/${batch}`);
    assert.equal(exact.items[0].run_id,retry);assert.equal(exact.items[0].attempt,2);
    for(const [batchState,taskState] of [['queued','queued'],['paused','paused'],['partial','failed'],['cancelled','cancelled'],['complete','succeeded']]){
      await pool.query('UPDATE bb_workpaper_batches SET state=$2 WHERE id=$1',[batch,batchState]);
      const page=await ok('GET',`/api/v1/projects/${project}/tasks?limit=1`),all=[...page.items];
      let next=page.page.next_cursor;
      while(next){const part=await ok('GET',`/api/v1/projects/${project}/tasks?limit=1&cursor=${encodeURIComponent(next)}`);all.push(...part.items);next=part.page.next_cursor;}
      assert.equal(all.length,3);assert.equal(all.filter((t:any)=>t.workpaper_batch).length,1);
      assert.equal(all.find((t:any)=>t.workpaper_batch).state,taskState);
      const current=(await ok('GET','/api/v1/projects')).items.find((p:any)=>p.project_id===project).task_summary;
      assert.equal(current.active,batchState==='queued'?1:0,'counts follow batch status, not stale or failed attempts');
    }
    assert.equal((await send('GET',`/api/v1/projects/${other.project_id}/workpapers/batches/${batch}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/workpapers/batches/absent`)).statusCode,404);
    assert.deepEqual((await ok('GET',`/api/v1/projects/${other.project_id}/tasks`)).items,[]);
    owner='foreign-'+randomUUID();
    assert.equal((await send('GET',`/api/v1/projects/${project}/workpapers/batches/${batch}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${project}/tasks`)).statusCode,404);
    assert.deepEqual((await ok('GET','/api/v1/projects')).items,[]);
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[originalOwner,retry])).rows[0].state,'running');
  }finally{await app.close();await pool.end();}
});
