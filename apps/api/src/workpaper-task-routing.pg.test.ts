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
