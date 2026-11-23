import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID as uid} from 'node:crypto';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {PROJECT_QA_PRICE,PROJECT_QA_LIST_PRICE,type QaDraft,type QaInput,type QaResult} from '@bondbuddy/contracts';
import {Problem,publicProblem,transaction,digest,type PrivateBlobs} from '@bondbuddy/api/data';
import {registerProjectQa} from '@bondbuddy/api/project-qa';
import {collectionTasksSql,collectionFilesSql} from '../../api/dist/project-collection.js';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {configureAutomaticBilling} from '../../api/dist/automatic-billing-context.js';
import {publishScopeQuote,publishStandardScopeQuote} from '../../api/dist/scope-quotations.js';
import {claim,finish,promoteWordArtifact,action} from '@bondbuddy/api/queue';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';
import {projectQaInputGate,projectQaPriceValid,loadProjectQaInput} from './project-qa-input.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type RunStage} from './run-pipeline.js';
import {projectQaDeliveryStage} from './project-qa-stage.js';

// Real HTTP, isolated PostgreSQL, immutable quotes, worker gates, private Word readback and wallet.
// Question extraction and answer content are synthetic; no provider/model is called.
const database=process.env.BB_TEST_DATABASE_URL;
const media='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function memoryBlobs():PrivateBlobs{
 const values=new Map<string,Buffer>();return {put:async(k,b)=>{values.set(k,Buffer.from(b));},get:async k=>{const b=values.get(k);assert.ok(b);return b;},getIfExists:async k=>values.get(k)??null,
  getIfExistsBounded:async(k,n)=>{const b=values.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>values.has(k),delete:async k=>{values.delete(k);}};
}
type Mode='legacy'|'reviewed'|'automatic'|'coverage';
async function setup(mode:Mode){
 const pool=new Pool({connectionString:await isolatedTestDatabase(undefined,'qa-pricing-'+uid())}),owner=uid(),project=uid(),blobs=memoryBlobs();
 configureAutomaticBilling(pool,mode==='automatic');
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_qa_'+owner.slice(0,8)]);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic QA pricing','generation')",[project,owner]);
 await transaction(pool,c=>grantCredits(c,{owner,points:100000,key:uid(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'Isolated regression credits'}));
 const app=Fastify();app.setErrorHandler((e,r,reply)=>e instanceof Problem?reply.code(e.status).send(publicProblem(e,r.id)):reply.code(500).send({message:e instanceof Error?e.message:String(e)}));
 registerProjectQa(app,()=>pool,async()=>owner,mode!=='legacy');
 const base=`/api/v1/projects/${project}/qa`;
 const post=async(path:string,payload:unknown)=>{const r=await app.inject({method:'POST',url:base+path,payload:payload as any});assert.equal(r.statusCode,200,r.body);return r.json();};
 async function material(filename:string,role='other'){
  const id=uid(),upload=uid(),bytes=makeSyntheticDocxFixture({text:filename}),sha=digest(bytes);await blobs.put(id,bytes,media);
  await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1,now()+interval '1 day','completed')",[upload,owner,project,filename,media,bytes.length,sha,role]);
  await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$1,'persisted')",[id,owner,project,upload,role,filename,media,bytes.length,sha]);
  return {kind:'material' as const,pin:{source_project_id:project,material_id:id,material_version:1,sha256:sha}};
 }
 const source=await material('Synthetic questions.docx'),prospectus=await material('Synthetic prospectus.docx','historical'),version=uid();
 await pool.query("INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version) VALUES($1,$2,$3,1,'upload','Synthetic prospectus.docx',$4,$5,1)",[version,owner,project,prospectus.pin.sha256,prospectus.pin.material_id]);
 await pool.query('INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)',[owner,project,version]);
 const prep=await post('/prepare',{request_id:uid(),source}),lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,prep.run_id);
 const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[prep.run_id])).rows[0];
 const input=(await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[project,run.input_revision])).rows[0];
 assert.equal(await projectQaInputGate(pool,run,input),null,'free preparation remains valid');
 const bytes=makeSyntheticDocxFixture({text:'Synthetic prepared questions'}),doc=await promoteWordArtifact(pool,lease,bytes,blobs,'generated_pair_v1');
 const artifact=(await pool.query('SELECT * FROM bb_artifact_versions WHERE id=$1',[doc.artifactId])).rows[0];
 const questions=Array.from({length:7},(_,i)=>({id:'q'+i,start:i,end:i,question:`Synthetic independent question ${i+1}`}));
 const result:QaResult={version:'project-qa-result-v1',input_hash:run.input_hash.trim(),document:{key:artifact.object_key,sha256:digest(bytes),byte_size:bytes.length},
  snapshot:{version:'project-file-text-v1',sha256:source.pin.sha256,format:'docx',spans:questions.map(q=>({id:q.id,text:q.question,location:'Synthetic source',sha256:digest(q.question)})),warnings:[],coverage:'complete'},questions,answers:[],warnings:[],evidence:[]};
 await pool.query('UPDATE bb_project_qa_runs SET result=$2,result_hash=$3 WHERE run_id=$1',[prep.run_id,result,inputManifestHash(result)]);
 await finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
 let revision=0;
 const draft:QaDraft={preparation_id:prep.run_id,questions,materials:[prospectus],requirements:'Synthetic evidenced response',use_knowledge:false};
 const save=async()=>{const w=await post('/draft',{expected_revision:revision,draft});revision=w.revision;};await save();
 async function quote(){
  let q=await post('/quote',{expected_revision:revision});
  if(q.quote_status==='pending_scope'){
   const s=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[q.scope_quote_id])).rows[0];
   if(mode==='coverage')await publishStandardScopeQuote(pool,{id:s.id,expected_input_hash:s.input_hash.trim(),actor:'synthetic-reviewer',reason:'Synthetic same contractual target',work_plan:{scope_status:'confirmed',items:[{key:'target',coverage_key:'synthetic-target-'+project,family:'goal_upgrade',price_key:'fact_revision',evidence:['synthetic:approved scope']}]}});
   else await publishScopeQuote(pool,{id:s.id,expected_input_hash:s.input_hash.trim(),actor:'synthetic-reviewer',reason:'Synthetic reviewed seven-question package',lines:[{key:'reply',label:'Synthetic reply package',unit:'package',quantity:1,unit_price_fen:3817,amount_fen:3817,evidence:['synthetic:approved scope']}]});
   q=await post('/quote',{expected_revision:revision});
  }
  return q;
 }
 async function start(followup?:string){
  const q=followup?await post('/quote',{expected_revision:revision,included_followup_of:followup}):await quote();
  const body={request_id:uid(),expected_revision:revision,expected_points:q.points,price_version:q.price_version,...(followup?{included_followup_of:followup}:{scope_quote_id:q.scope_quote_id})};
  const started=await post('/runs',body);assert.equal((await post('/runs',body)).run_id,started.run_id,'same request is idempotent');return {...started,points:Number(q.points)};
 }
 let modelEntries=0,fail=false,pauseNext=false;
 const synthetic:RunStage={name:'model_generation',replay:true,run:async ctx=>{
  assert.equal(await ctx.validateBeforeModelCall!(),null);assert.equal(await ctx.validateBeforeModelCall!(),null,'provider replay keeps the accepted price');
  const m=await loadProjectQaInput(ctx);if(pauseNext){pauseNext=false;return {kind:'pause',stage:'capability_not_ready',reason:'synthetic_checkpoint_pause'};}modelEntries++;if(fail)return {kind:'fail',code:'SYNTHETIC_PROVIDER_FAILED'};
  const bytes=makeSyntheticDocxFixture({text:'Synthetic answers '+ctx.run.id}),sha256=digest(bytes),key=`owners/${owner}/projects/${project}/runs/${ctx.run.id}/qa/${sha256}/document.docx`;await blobs.put(key,bytes,media);
  const taskQuestions=m.price_version===PROJECT_QA_LIST_PRICE.version?questions:m.questions;
  const value:QaResult={...result,input_hash:ctx.run.input_hash.trim(),document:{key,sha256,byte_size:bytes.length},questions:taskQuestions,answers:taskQuestions.map(q=>({question_id:q.id,answer:'Synthetic answer',status:'missing',missing_materials:['Synthetic evidence gap'],citations:[],case_ids:[],approach:'Synthetic regression'}))};
  await pool.query('UPDATE bb_project_qa_runs SET result=$2,result_hash=$3 WHERE run_id=$1',[ctx.run.id,value,inputManifestHash(value)]);return {kind:'done',value};
 }};
 return {pool,app,blobs,owner,project,source,draft,save,start,quote,post,get revision(){return revision;},get modelEntries(){return modelEntries;},set fail(v:boolean){fail=v;},set pauseNext(v:boolean){pauseNext=v;},
  execute:()=>runPipelineOnce({pool,blobs,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,synthetic,projectQaDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))}),
  read:async(id:string)=>{const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[id])).rows[0];const input=(await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[project,run.input_revision])).rows[0];return {run,input};},
  close:async()=>{await app.close();await pool.end();}};
}

for(const mode of ['legacy','reviewed','automatic','coverage'] as const)test(`QA ${mode}: accepted price passes worker, delivers Word and settles once`,{skip:!database,timeout:120000},async()=>{
 const h=await setup(mode);
 try{
  const started=await h.start(),expected={legacy:420,reviewed:3817,automatic:8526,coverage:3900}[mode];assert.equal(started.points,expected);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100000-expected,frozen:expected});
  const {run,input}=await h.read(started.run_id);assert.equal(await projectQaInputGate(h.pool,run,input),null);
  assert.deepEqual(await projectQaInputGate(h.pool,{...run,owner_user_id:uid()},input),{kind:'fail',code:'INPUT_REVISION_CONFLICT'},'foreign quote cannot execute');
  assert.deepEqual(await projectQaInputGate(h.pool,run,{...input,manifest:{...input.manifest,points:1}}),{kind:'fail',code:'INPUT_REVISION_CONFLICT'},'changed price cannot execute');
  const manifest=input.manifest as QaInput;
  for(const changed of [{...manifest,points:expected+1},{...manifest,price_version:mode==='legacy'?'outcome-cny-20261028-v1':PROJECT_QA_PRICE.version},{...manifest,scope_quote_id:uid()}] as QaInput[])
   assert.equal(await projectQaPriceValid(h.pool,run,changed),false,'quote must match amount, version and scope identity');
  if(mode==='automatic'){
   assert.equal(await projectQaPriceValid(h.pool,run,{...manifest,requirements:manifest.requirements+' changed'}),false,'same amount does not authorize a different scope');
   h.pauseNext=true;assert.equal(await h.execute(),'paused');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:91474,frozen:8526});
  }
  // Only the quotation lifecycle status changes: the already accepted task retains its locked price.
  if(mode!=='legacy')await h.pool.query("UPDATE bb_scope_quotations SET status='expired',closed_at=clock_timestamp(),closure_reason='Synthetic expiry after acceptance' WHERE id=$1",[input.manifest.scope_quote_id]);
  if(mode==='automatic')await action(h.pool,h.owner,started.run_id,'resume',uid());
  assert.equal(await h.execute(),'succeeded');assert.equal(h.modelEntries,1);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100000-expected,frozen:0});
  const delivered=(await h.pool.query('SELECT * FROM bb_runs WHERE id=$1',[started.run_id])).rows[0];assert.ok(delivered.artifact_id);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[started.run_id])).rows[0].n,1);
  assert.equal(await h.execute(),'idle');assert.equal(h.modelEntries,1);
  if(mode!=='legacy'){
   const followup=await h.start(started.run_id);assert.equal(followup.points,0);
   assert.equal(await h.execute(),'succeeded');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100000-expected,frozen:0});
   assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[followup.run_id])).rows[0].n,0,'included original questions need no new hold');
   assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1',[followup.run_id])).rows[0].n,0,'included continuation has no wallet events');
   if(mode==='coverage'){
    h.draft.requirements+='; necessary same-target clarification';await h.save();const covered=await h.start();assert.equal(covered.points,0);
    assert.equal(await h.execute(),'succeeded');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100000-expected,frozen:0});
   }
  }else assert.equal(input.manifest.price_version,PROJECT_QA_PRICE.version);
 }finally{await h.close();}
});

test('whole-list fixed price starts without a preparation link and settles exactly 12000 points after Word delivery',{skip:!database,timeout:120000},async()=>{
 const h=await setup('legacy');
 try{
  h.draft.source=h.source;h.draft.preparation_id=null;h.draft.questions=[];await h.save();
  const q=await h.post('/quote',{expected_revision:h.revision});
  assert.deepEqual(q,{points:PROJECT_QA_LIST_PRICE.points,price_version:PROJECT_QA_LIST_PRICE.version});
  const started=await h.post('/runs',{request_id:uid(),expected_revision:h.revision,expected_points:q.points,price_version:q.price_version});
  const {run,input}=await h.read(started.run_id),manifest=input.manifest as QaInput;
  assert.equal(manifest.preparation_id,null);assert.deepEqual(manifest.questions,[]);
  assert.equal(await projectQaInputGate(h.pool,run,input),null);
  assert.equal(await projectQaPriceValid(h.pool,run,{...manifest,price_version:PROJECT_QA_PRICE.version}),false);
  assert.equal(await projectQaPriceValid(h.pool,run,{...manifest,points:PROJECT_QA_PRICE.points}),false);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:88000,frozen:12000});
  assert.equal(await h.execute(),'succeeded');
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:88000,frozen:0});
  const delivered=(await h.pool.query('SELECT result FROM bb_project_qa_runs WHERE run_id=$1',[started.run_id])).rows[0].result as QaResult;
  assert.equal(delivered.questions.length,7);assert.equal(delivered.answers.length,7);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[started.run_id])).rows[0].n,1);
  const taskRows=(await h.pool.query(`WITH members AS(SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2),tasks AS(${collectionTasksSql}) SELECT operation FROM tasks`,[h.owner,h.project])).rows;
  assert.deepEqual(taskRows.map(row=>row.operation),['qa_answer'],'recognition is not a separate user task');
  const fileRows=(await h.pool.query(`WITH members AS(SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2),files AS(${collectionFilesSql}) SELECT source,run_id FROM files WHERE source='artifact'`,[h.owner,h.project])).rows;
  assert.deepEqual(fileRows.map(row=>row.run_id),[started.run_id],'only the answered Word is a downloadable Q&A result');
 }finally{await h.close();}
});

test('QA automatic failure/cancel releases the exact hold; retry requires a newly accepted quote',{skip:!database,timeout:120000},async()=>{
 const h=await setup('automatic');
 try{
  const first=await h.start();h.fail=true;assert.equal(await h.execute(),'failed');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100000,frozen:0});
  const prior=await h.read(first.run_id);assert.deepEqual(await projectQaInputGate(h.pool,prior.run,prior.input),{kind:'fail',code:'INPUT_REVISION_CONFLICT'},'released funds cannot authorize a provider call');
  h.fail=false;const retry=await h.start();assert.notEqual(retry.run_id,first.run_id);assert.equal(retry.points,8526);
  await action(h.pool,h.owner,retry.run_id,'cancel',uid());assert.deepEqual(await creditBalance(h.pool,h.owner),{available:100000,frozen:0});
  const final=await h.start();assert.equal(final.points,8526);assert.equal(await h.execute(),'succeeded');assert.deepEqual(await creditBalance(h.pool,h.owner),{available:91474,frozen:0});
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1 AND kind='settle'",[h.owner])).rows[0].n,1);
 }finally{await h.close();}
});
