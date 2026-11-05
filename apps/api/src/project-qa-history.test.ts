// Real PostgreSQL/API, synthetic task history only; no worker, model or billing calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {Type} from '@sinclair/typebox';
import {QA_HISTORY_CAPABILITY,PROJECT_QA_PRICE,QaRunSchema,QaWorkspaceSchema,billingDtoSchema,Int64Schema,type QaInput,type QaWorkspace} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {digest,uid} from './data.js';

const connection=await isolatedTestDatabase(undefined,'qa-answer-history');
const wireWorkspaceSchema=billingDtoSchema(QaWorkspaceSchema,'qaWorkspace',Int64Schema) as typeof QaWorkspaceSchema;
test('answer history counts the whole project, keeps recent answers through preparations, and preserves direct task links', {skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection}),origin='http://bondbuddy.test';
 let owner='synthetic-qa-history-owner';
 const app=createServer({pool,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
 const create=async()=>{
  const response=await app.inject({method:'POST',url:'/api/v1/projects',headers:{origin},payload:{name:'Synthetic QA history',kind:'generation',issuer_name:null,market:null,offering:null}});
  assert.equal(response.statusCode,201,response.body);return response.json().project_id as string;
 };
 const seed=async(project:string,operations:('prepare'|'answer')[])=>{
  const records=operations.map((operation,index)=>{
   const sequence=index+1,id=uid();
   const manifest:QaInput={version:'project-qa-v1',operation,project_name:'Synthetic QA history',source:{filename:'synthetic-questions.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-question-material',material_version:1,sha256:digest('synthetic')}}},preparation_id:null,questions:[],materials:[],requirements:'',cases:[],price_version:PROJECT_QA_PRICE.version,points:0};
   return {id,owner,project,sequence,operation,manifest,hash:digest(JSON.stringify(manifest)),state:operation==='prepare'?'cancelled':['failed','cancelled','queued'][index%3]};
  });
  const json=JSON.stringify(records),fields='id text,owner text,project text,sequence integer,operation text,manifest jsonb,hash text,state text';
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
   SELECT project,sequence,owner,1,hash,manifest,'[]','[]' FROM jsonb_to_recordset($1::jsonb) AS x(${fields})`,[json]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
   SELECT id,owner,project,sequence,hash,id,'generation',hash,state FROM jsonb_to_recordset($1::jsonb) AS x(${fields})`,[json]);
  await pool.query(`INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash)
   SELECT id,owner,project,sequence,operation,manifest,hash FROM jsonb_to_recordset($1::jsonb) AS x(${fields})`,[json]);
  return records;
 };
 const read=async(project:string,run?:string)=>{
  const response=await app.inject({method:'GET',headers:{[QA_HISTORY_CAPABILITY.header]:QA_HISTORY_CAPABILITY.value},url:`/api/v1/projects/${project}/qa${run?'?run_id='+run:''}`});
  assert.equal(response.statusCode,200,response.body);const value=response.json();
  assert.ok(Value.Check(wireWorkspaceSchema,value),JSON.stringify([...Value.Errors(wireWorkspaceSchema,value)]));return value as QaWorkspace;
 };
 try{
  const project=await create(),records=await seed(project,['prepare','answer','prepare','answer']);
  const second=await create();await seed(second,['answer','answer','answer']);
  const legacySchema=Type.Composite([Type.Omit(QaWorkspaceSchema,['runs']),Type.Object({runs:Type.Array(Type.Omit(QaRunSchema,['answer_sequence']))})]);
  for(const headers of [{},{[QA_HISTORY_CAPABILITY.header]:'unknown'}]){
   const legacy=await app.inject({method:'GET',url:`/api/v1/projects/${project}/qa`,headers});
   assert.equal(legacy.statusCode,200);assert.ok(legacy.json().runs.every((r:any)=>!('answer_sequence' in r)));
   assert.ok(Value.Check(billingDtoSchema(legacySchema,'qaWorkspace',Int64Schema) as typeof legacySchema,legacy.json()),'old strict workspace DTO remains readable with the current int64 money wire format');
  }
  const recent=await read(project);
  assert.deepEqual(recent.runs.filter(r=>r.operation==='answer').map(r=>[r.sequence,r.answer_sequence]),[[4,2],[2,1]]);
  assert.ok(recent.runs.filter(r=>r.operation==='prepare').every(r=>r.answer_sequence===undefined));
  const direct=await read(project,records[0].id);
  assert.equal(direct.runs[0].run_id,records[0].id,'prepare task remains directly readable');
  assert.deepEqual(direct.runs.filter(r=>r.operation==='answer').map(r=>r.answer_sequence),[2,1]);

  const large=await create(),operations:('prepare'|'answer')[]=Array.from({length:212},(_,i)=>i%2?'answer':'prepare');
  operations.push(...Array<'prepare'>(105).fill('prepare'));
  const longRecords=await seed(large,operations),firstAnswer=longRecords[1],firstPreparation=longRecords[0];
  await pool.query('INSERT INTO bb_project_qa_drafts(owner_user_id,project_id,revision,draft) VALUES($1,$2,1,$3)',[owner,large,{preparation_id:firstPreparation.id,questions:[],materials:[],requirements:'',use_knowledge:false}]);
  const page=await read(large),answers=page.runs.filter(r=>r.operation==='answer');
  assert.equal(answers.length,100,'preparation tasks do not consume the answer history window');
  assert.deepEqual(answers.map(r=>r.answer_sequence),Array.from({length:100},(_,i)=>106-i));
  assert.ok(page.runs.some(r=>r.run_id===firstPreparation.id),'current preparation still available');
  const older=await read(large,firstAnswer.id);
  assert.equal(older.runs[0].run_id,firstAnswer.id);assert.equal(older.runs[0].answer_sequence,1);
  assert.equal(older.runs.filter(r=>r.operation==='answer').length,101);
  assert.deepEqual((await pool.query('SELECT sequence,operation,manifest FROM bb_project_qa_runs WHERE project_id=$1 ORDER BY sequence',[large])).rows,longRecords.map(r=>({sequence:r.sequence,operation:r.operation,manifest:r.manifest})),'reading history does not rewrite task snapshots');

  owner='synthetic-other-owner';const privateProject=await create();await seed(privateProject,['prepare','answer']);
  assert.deepEqual((await read(privateProject,firstAnswer.id)).runs.filter(r=>r.operation==='answer').map(r=>r.answer_sequence),[1]);
  const denied=await app.inject({method:'GET',url:`/api/v1/projects/${large}/qa?run_id=${firstAnswer.id}`});
  assert.equal(denied.statusCode,404,'history remains isolated by owner');
 }finally{await app.close();await pool.end();}
});
