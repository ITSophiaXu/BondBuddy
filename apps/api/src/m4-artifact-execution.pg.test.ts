// Synthetic materials, DOCX bytes and answers; real PostgreSQL registrations,
// mirrors, receipts and queue settlement. Corruption seams roll back in private clones.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {grantCredits} from './billing.js';
import {digest,transaction,uid,type PrivateBlobs} from './data.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {removeM4ArtifactExecutionScaffold} from './m4-artifact-migration-test-fixture.js';
import {completeM4Qa,emptyM4Draft,lockM4ArtifactTopic,readM4ArtifactPin,registerM4Artifacts,type M4ArtifactRegistration} from './m4-workspace.js';
import {inputManifestHash} from './production-rule-pin.js';
import {checkpointStage,claim,finish,promoteWordArtifact,resumePausedRun,type Lease} from './queue.js';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'m4-artifact-execution');
const migrationConnection=await isolatedTestDatabase(undefined,'m4-artifact-execution-migration');
const migration=await readFile(new URL('../../../db/migrations/0130_m4_execution_artifacts.sql',import.meta.url),'utf8');
type Db=Pool|PoolClient;
type Kind='document'|'preparation_note';
type Artifact={artifactId:string;artifactVersion:number;bytes:Buffer};
const timestamp='2026-01-02T03:04:05.123456Z';
const rejectedWrite=(error:unknown)=>['23502','23503','23505','23514','P0002','P0003'].includes((error as {code?:string}).code??'');
const canonicalSql=`INSERT INTO bb_m4_execution_artifacts(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  topic_id,artifact_id,artifact_version,kind,filename,byte_size,document_type,base_artifact,body_content,preview_content,created_at,revision_number)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;
const legacySql=`INSERT INTO bb_m4_artifacts(owner_user_id,topic_id,run_id,artifact_id,artifact_version,kind,filename,byte_size,
  document_type,base_artifact,input_hash,body_content,preview_content,created_at,revision_number)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`;
const reply={content:'Synthetic retained QA answer',citations:[],requirements:[],fields:{},intent:'answer' as const,
  document_type:null,target_business:null,retrieval:'not_performed' as const};

function memoryBlobs():PrivateBlobs{
  const values=new Map<string,Buffer>();
  return {put:async(key,bytes)=>{values.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=values.get(key);assert.ok(bytes);return bytes;},
    getIfExists:async key=>values.get(key)??null,
    getIfExistsBounded:async(key,max)=>{const bytes=values.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},
    exists:async key=>values.has(key),delete:async key=>{values.delete(key);}};
}

async function source(db:Db,owner:string,projectId:string){
  const material=uid(),upload=uid(),hash=digest(`Synthetic M4 material ${material}`),key=`synthetic/m4-artifacts/${material}`;
  await db.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-source.pdf','application/pdf',64,$4,'other',$5,now()+interval '1 day','completed')`,[upload,owner,projectId,hash,key]);
  await db.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic-source.pdf','application/pdf',64,$5,$6,'persisted')`,[material,owner,projectId,upload,hash,key]);
  return {source_project_id:projectId,material_id:material,material_version:1,sha256:hash};
}

async function fixture(db:Db,kind:'document'|'qa'|'word'='document',existingOwner?:string){
  const owner=existingOwner??uid(),projectId=uid(),runId=uid(),jobId=uid(),topicId=uid(),messageId=uid(),token=uid();
  if(!existingOwner)await db.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`ma_${uid().replaceAll('-','').slice(0,20)}`]);
  await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic M4 Word origin',$3)",[projectId,owner,kind==='word'?'update':'generation']);
  const material=await source(db,owner,projectId);
  const context={document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:null};
  let manifest:Record<string,unknown>={name:'Synthetic general delivered Word',synthetic:true};
  if(kind!=='word'){
    await db.query(`INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash)
      VALUES($1,$2,$3,'Synthetic M4 registry',$4,$5)`,[topicId,owner,projectId,uid(),digest(uid())]);
    manifest=kind==='qa'?{version:'m4-qa-input-v1',kind:'qa',topic_id:topicId,message_id:messageId,content:'Synthetic question',
      context,context_snapshot:{draft:null,messages:[]},materials:[],billing_task:'m4_Q01'}:
      {version:'m4-document-input-v1',kind:'document',topic_id:topicId,execution_scope_project_id:projectId,
        draft_version:1,market:'sse',offering:'private',billing_task:'m4_G01',template_material:null,
        input:{document_type:'init',source_material:material,materials:[material],template:null,edit_base:null,scope:'whole',
          fields:{issuer_name:'Synthetic issuer'},requirements:[]}};
  }
  const hash=inputManifestHash(manifest);
  await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,'[]','[]')`,[projectId,owner,hash,manifest]);
  await db.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,$6,$7,'running','word_delivery')`,[runId,owner,projectId,hash,uid(),kind==='qa'?'qa':kind==='document'?'generation':'update',digest(uid())]);
  await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
    VALUES($1,$2,$3,$4,$5,'running','word_delivery',$6,now()+interval '10 minutes',1)`,
  [jobId,owner,runId,kind==='qa'?'qa':kind==='document'?'generation':'update',kind==='qa'?'m4_qa_v1':kind==='document'?'m4_document_v1':'default',token]);
  if(kind!=='word'){
    await db.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[runId,owner,topicId,manifest,hash]);
    if(kind==='qa')await db.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,run_id,reply_status)
      VALUES($1,$2,$3,'user','Synthetic question',$4,$5,'running')`,[messageId,owner,topicId,context,runId]);
  }
  const lease:Lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash:hash};
  return {owner,projectId,runId,jobId,topicId,hash,manifest,material,lease};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function word(pool:Pool,f:Fixture,blobs:PrivateBlobs,label:string):Promise<Artifact>{
  const bytes=makeSyntheticDocxFixture({text:`Synthetic ${label} ${uid()}`});
  const result=await promoteWordArtifact(pool,f.lease,bytes,blobs,'generated_pair_v1');
  assert.equal(result.status,'available');
  if(result.status!=='available')throw Error('Synthetic M4 Word promotion failed');
  return {...result,bytes};
}
function canonicalValues(f:Fixture,a:Artifact,kind:Kind='document'):unknown[]{
  return [f.owner,f.projectId,f.runId,1,1,f.hash,f.topicId,a.artifactId,a.artifactVersion,kind,`合成-${kind}-😀.docx`,a.bytes.length,'init',null,null,null,timestamp,null];
}
function legacyValues(f:Fixture,a:Artifact,kind:Kind='document'):unknown[]{
  const c=canonicalValues(f,a,kind);
  return [c[0],c[6],c[2],c[7],c[8],c[9],c[10],c[11],c[12],c[13],c[5],c[14],c[15],c[16],c[17]];
}
function registration(a:Artifact,kind:Kind='document',preview?:string):M4ArtifactRegistration{
  return {kind,artifact_id:a.artifactId,artifact_version:a.artifactVersion,filename:`ignored-${kind}.docx`,byte_size:a.bytes.length,
    ...(preview===undefined?{}:{preview_content:preview})};
}
async function register(pool:Pool,f:Fixture,entries:M4ArtifactRegistration[]){
  return transaction(pool,async db=>{
    await lockM4ArtifactTopic(db,f.owner,f.runId,f.lease);
    await db.query('SELECT id FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[f.owner,f.runId]);
    assert.equal((await db.query(`SELECT id FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 AND id=$3 AND state='running'
      AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[f.owner,f.runId,f.jobId,f.lease.token])).rowCount,1);
    await registerM4Artifacts(db,f.owner,f.runId,entries,f.lease);
  });
}
async function pair(pool:Pool,f:Fixture,blobs:PrivateBlobs){
  const document=await word(pool,f,blobs,'document'),note=await word(pool,f,blobs,'preparation note');
  await register(pool,f,[registration(document),registration(note,'preparation_note')]);return {document,note};
}
const rows=async(db:Db,f:Fixture)=>(await db.query('SELECT *,created_at::text AS exact_created_at FROM bb_m4_execution_artifacts WHERE run_id=$1 ORDER BY kind',[f.runId])).rows;
const receipts=async(db:Db,f:Fixture,phase='m4_durable')=>(await db.query('SELECT * FROM bb_run_execution_deliveries WHERE run_id=$1 AND delivery_phase=$2',[f.runId,phase])).rows;
const published=async(db:Db,f:Fixture)=>(await db.query('SELECT id,version FROM bb_delivered_artifact_versions WHERE run_id=$1 ORDER BY id,version',[f.runId])).rows;
async function assertMirror(db:Db,f:Fixture){
  const result=await db.query(`SELECT (to_jsonb(c)-ARRAY['project_id','execution_version','input_revision'])=to_jsonb(l) AS exact,
    c.created_at=l.created_at AS same_timestamp,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS precise_time
    FROM bb_m4_execution_artifacts c LEFT JOIN bb_m4_artifacts l ON l.run_id=c.run_id AND l.kind=c.kind WHERE c.run_id=$1 ORDER BY c.kind`,[f.runId]);
  assert.ok(result.rowCount);for(const row of result.rows){assert.equal(row.exact,true);assert.equal(row.same_timestamp,true);}return result.rows;
}
async function rolledBack(pool:Pool,work:(db:PoolClient)=>Promise<void>){
  const db=await pool.connect();try{await db.query('BEGIN');await work(db);}finally{await db.query('ROLLBACK');db.release();}
}
async function rejectWork(db:PoolClient,work:()=>Promise<unknown>,predicate:(error:unknown)=>boolean=rejectedWrite){
  await db.query('SAVEPOINT expected_rejection');
  try{await assert.rejects(work,predicate);}finally{await db.query('ROLLBACK TO SAVEPOINT expected_rejection');await db.query('RELEASE SAVEPOINT expected_rejection');}
}
async function api(db:Db,owner:string,blobs:PrivateBlobs){
  const app=createServer({pool:db as Pool,blobs,enableSyntheticQueue:true,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://bondbuddy.test'});
  await app.ready();return app;
}

test('M4 Word registry rejects wrong six/seven/eight-field origins, topic, document type and edit base',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),foreign=await fixture(pool,'document',f.owner),blobs=memoryBlobs();
    const a=await word(pool,f,blobs,'owned'),other=await word(pool,foreign,blobs,'other run');
    await rolledBack(pool,async db=>{
      const defects:Record<string,[number,unknown]>={owner:[0,uid()],project:[1,foreign.projectId],run:[2,foreign.runId],execution:[3,2],
        inputRevision:[4,2],hash:[5,digest('wrong input')],topic:[6,foreign.topicId],artifact:[7,other.artifactId],artifactVersion:[8,2],
        kind:[9,'qa_text'],documentType:[12,'underwriter'],base:[13,{source_project_id:foreign.projectId,artifact_id:other.artifactId,artifact_version:1,sha256:digest(other.bytes)}]};
      for(const [name,[index,value]] of Object.entries(defects)){
        const values=canonicalValues(f,a);values[index]=value;
        await rejectWork(db,()=>db.query(canonicalSql,values));assert.deepEqual(await rows(db,f),[],name);
      }
      await rejectWork(db,()=>db.query(legacySql,legacyValues(f,other)));
      assert.equal((await db.query('SELECT 1 FROM bb_m4_artifacts WHERE run_id=$1',[f.runId])).rowCount,0);
    });
    await pool.query(canonicalSql,canonicalValues(f,a));await assertMirror(pool,f);
  });

test('old and new INSERT writers preserve all metadata, NULL history and PostgreSQL microseconds in exact mirrors',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),a=await word(pool,f,blobs,'legacy body'),b=await word(pool,f,blobs,'canonical note');
    const old=legacyValues(f,a);old[11]='Retained historical body 😀';old[12]='Retained historical preview';
    await pool.query(legacySql,old);await pool.query(canonicalSql,canonicalValues(f,b,'preparation_note'));
    const mirror=await assertMirror(pool,f);assert.equal(mirror.length,2);
    for(const row of mirror)assert.equal(row.precise_time,'2026-01-02 03:04:05.123456');
    const saved=await rows(pool,f);assert.equal(saved[0].revision_number,null);assert.equal(saved[0].body_content,old[11]);
    assert.equal(saved[0].preview_content,old[12]);assert.equal(saved[0].base_artifact,null);
    assert.equal(saved[1].body_content,null);assert.equal(saved[1].preview_content,null);
    assert.deepEqual(await receipts(pool,f),[],'metadata INSERT alone never invents delivery');
  });

test('immutable Word slots reject UPDATE and DELETE while registrar replays compare nullable previews and frozen identity',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),a=await word(pool,f,memoryBlobs(),'immutable registration');
    await register(pool,f,[registration(a)]);const before=await rows(pool,f);
    await register(pool,f,[registration(a)]);assert.deepEqual(await rows(pool,f),before);
    await assert.rejects(register(pool,f,[registration(a,'document','changed preview')]),{code:'IDEMPOTENCY_CONFLICT'});
    await rolledBack(pool,async db=>{
      for(const table of ['bb_m4_artifacts','bb_m4_execution_artifacts']){
        await rejectWork(db,()=>db.query(`UPDATE ${table} SET preview_content='changed' WHERE run_id=$1`,[f.runId]));
        await rejectWork(db,()=>db.query(`UPDATE ${table} SET filename=filename WHERE run_id=$1`,[f.runId]));
        await rejectWork(db,()=>db.query(`DELETE FROM ${table} WHERE run_id=$1`,[f.runId]));
      }
      await rejectWork(db,()=>registerM4Artifacts(db,f.owner,f.runId,[registration(a)],{...f.lease,executionVersion:2}),
        error=>(error as {code?:string}).code==='INPUT_REVISION_CONFLICT');
      await db.query('INSERT INTO bb_m4_artifacts SELECT * FROM bb_m4_artifacts WHERE run_id=$1 ON CONFLICT DO NOTHING',[f.runId]);
      await rejectWork(db,()=>db.query(`INSERT INTO bb_m4_artifacts
        SELECT (jsonb_populate_record(NULL::bb_m4_artifacts,to_jsonb(a)||jsonb_build_object('preview_content','changed'))).*
        FROM bb_m4_artifacts a WHERE run_id=$1 ON CONFLICT DO NOTHING`,[f.runId]));
    });
    assert.deepEqual(await rows(pool,f),before);await assertMirror(pool,f);
  });

test('split real registration waits for the Word pair, publishes durable nonterminal files and freezes a distinct final receipt',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),document=await word(pool,f,blobs,'split document'),note=await word(pool,f,blobs,'split note');
    const abandoned=await word(pool,f,blobs,'unselected candidate');
    await register(pool,f,[registration(document,'document','Synthetic body preview')]);
    assert.deepEqual(await receipts(pool,f),[]);assert.deepEqual(await published(pool,f),[]);
    await register(pool,f,[registration(note,'preparation_note')]);
    const [durable]=await receipts(pool,f);assert.ok(durable);assert.equal(durable.terminal_state,null);assert.equal(durable.event_cursor,null);
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[f.runId])).rows[0].state,'running');
    assert.equal((await published(pool,f)).length,2);
    assert.equal((await pool.query('SELECT 1 FROM bb_delivered_artifact_versions WHERE id=$1',[abandoned.artifactId])).rowCount,0);
    const app=await api(pool,f.owner,blobs);t.after(()=>app.close());
    const downloaded=await app.inject({method:'GET',url:`/api/v1/m4/artifacts/${document.artifactId}/versions/1/bytes`});
    assert.equal(downloaded.statusCode,200,downloaded.body);assert.equal(digest(downloaded.rawPayload),digest(document.bytes));
    assert.equal((await app.inject({method:'GET',url:`/api/v1/m4/artifacts/${document.artifactId}/versions/1/preview`})).json().content,'Synthetic body preview');
    assert.equal((await finish(pool,f.lease,'succeeded',{artifactId:document.artifactId,artifactVersion:1,blobs})).state,'succeeded');
    const [final]=await receipts(pool,f,'final');assert.ok(final);assert.equal(final.primary_artifact_id,document.artifactId);
    assert.equal(final.primary_artifact_version,1);assert.equal(final.terminal_state,'succeeded');
    assert.deepEqual(await receipts(pool,f),[durable]);assert.equal((await published(pool,f)).length,2);
  });

test('typed M4 reads work with canonical-only Word rows and fail closed without them while frozen generic pins remain valid',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),selected=await pair(pool,f,blobs);
    const pin={source_project_id:f.projectId,artifact_id:selected.document.artifactId,artifact_version:1,sha256:digest(selected.document.bytes)};
    for(const remove of ['legacy','canonical'] as const)await rolledBack(pool,async db=>{
      const table=remove==='legacy'?'bb_m4_artifacts':'bb_m4_execution_artifacts';
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);await db.query(`DELETE FROM ${table} WHERE run_id=$1`,[f.runId]);
      assert.equal((await db.query('SELECT 1 FROM bb_m4_execution_artifact_versions WHERE run_id=$1',[f.runId])).rowCount,remove==='legacy'?2:0);
      assert.equal((await db.query('SELECT 1 FROM bb_m4_artifact_execution_versions WHERE run_id=$1',[f.runId])).rowCount,remove==='legacy'?2:0);
      const app=await api(db,f.owner,blobs);
      try{const result=await app.inject({method:'GET',url:`/api/v1/m4/artifacts/${pin.artifact_id}/versions/1/bytes`});
        assert.equal(result.statusCode,remove==='legacy'?200:404,result.body);
        if(remove==='legacy')assert.equal(digest(result.rawPayload),pin.sha256);
      }finally{await app.close();}
      assert.equal((await readM4ArtifactPin(db,f.owner,pin)).id,pin.artifact_id,'generic receipt authority stays independent of the typed registry');
    });
    await assertMirror(pool,f);
  });

test('a revoked registered preparation note prevents both actual finish and a final typed M4 delivery plan',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),selected=await pair(pool,f,blobs);
    const before=await receipts(pool,f);
    const unavailable=await promoteWordArtifact(pool,f.lease,selected.note.bytes,{...blobs,getIfExistsBounded:async()=>null},'generated_pair_v1');
    assert.equal(unavailable.status,'unavailable');
    assert.equal((await pool.query('SELECT delivery_status FROM bb_artifact_versions WHERE id=$1',[selected.note.artifactId])).rows[0].delivery_status,'revoked');
    assert.equal((await pool.query('SELECT 1 FROM bb_m4_execution_artifact_versions WHERE run_id=$1',[f.runId])).rowCount,2,
      'origin provenance retains the revoked registration');
    await assert.rejects(finish(pool,f.lease,'succeeded',{artifactId:selected.document.artifactId,artifactVersion:1,blobs}),{code:'DELIVERY_FAILED'});
    assert.deepEqual(await receipts(pool,f,'final'),[]);
    await rolledBack(pool,async db=>{
      // Exercise the SQL planner independently of the earlier queue readiness
      // guard. The terminal-state seam never commits or manufactures a receipt.
      await db.query('ALTER TABLE bb_runs DISABLE TRIGGER USER');await db.query('ALTER TABLE bb_jobs DISABLE TRIGGER USER');
      await db.query("UPDATE bb_runs SET state='succeeded',stage='succeeded',artifact_id=$2,artifact_version=1,updated_at=now() WHERE id=$1",[f.runId,selected.document.artifactId]);
      await db.query("UPDATE bb_jobs SET state='succeeded',stage='succeeded',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[f.runId]);
      await rejectWork(db,()=>db.query("SELECT bb_run_execution_delivery_plan($1,$2,'terminal_transition','final')",[f.owner,f.runId]));
      assert.deepEqual(await receipts(db,f,'final'),[]);
    });
    assert.deepEqual(await receipts(pool,f),before);
  });

test('generic delivered Word pins from another business remain readable and never become typed M4 edit bases',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool,'word'),blobs=memoryBlobs(),a=await word(pool,f,blobs,'generic primary');
    await finish(pool,f.lease,'succeeded',{artifactId:a.artifactId,artifactVersion:1,blobs});
    const pin={source_project_id:f.projectId,artifact_id:a.artifactId,artifact_version:1,sha256:digest(a.bytes)};
    assert.equal((await readM4ArtifactPin(pool,f.owner,pin)).id,a.artifactId);
    assert.equal((await pool.query('SELECT 1 FROM bb_m4_execution_artifact_versions WHERE artifact_id=$1',[a.artifactId])).rowCount,0);
    const app=await api(pool,f.owner,blobs);t.after(()=>app.close());
    assert.equal((await app.inject({method:'GET',url:`/api/v1/m4/artifacts/${a.artifactId}/versions/1/bytes`})).statusCode,404);
    const target=await fixture(pool,'document',f.owner);
    const rejectedBase=await app.inject({method:'PUT',url:`/api/v1/m4/topics/${target.topicId}/drafts/init`,headers:{origin:'http://bondbuddy.test'},
      payload:{expected_version:0,input:{...emptyM4Draft('init'),source_material:target.material,materials:[target.material],edit_base:pin}}});
    assert.equal(rejectedBase.statusCode,422,rejectedBase.body);assert.match(rejectedBase.body,/全文改稿/);
    await assert.rejects(readM4ArtifactPin(pool,uid(),pin));
    await assert.rejects(readM4ArtifactPin(pool,f.owner,{...pin,sha256:digest('wrong bytes')}));
  });

test('QA compatibility requires exact QA subtype, immutable snapshot and authenticated plaintext evidence',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool,'qa'),answer=await transaction(pool,db=>completeM4Qa(db,f.owner,f.runId,reply));
    const evidence=(await pool.query(`SELECT e.content,e.sha256,e.byte_size,a.sha256 AS artifact_sha256
      FROM bb_m4_text_delivery_evidence e JOIN bb_artifact_versions a ON a.m4_text_delivery_evidence_id=e.id
        AND a.owner_user_id=e.owner_user_id AND a.run_id=e.run_id AND a.id=e.artifact_id AND a.version=e.artifact_version
      WHERE e.owner_user_id=$1 AND e.run_id=$2 AND e.artifact_id=$3 AND e.artifact_version=$4`,
    [f.owner,f.runId,answer.artifactId,answer.artifactVersion])).rows;
    assert.equal(evidence.length,1);const expected=evidence[0].content as string,sha=evidence[0].sha256.trim();
    assert.ok(expected.includes(reply.content));assert.equal(digest(expected),sha);
    assert.equal(evidence[0].artifact_sha256.trim(),sha);assert.equal(Buffer.byteLength(expected,'utf8'),Number(evidence[0].byte_size));
    const select='SELECT kind,body_content FROM bb_m4_artifact_execution_versions WHERE run_id=$1';
    assert.deepEqual((await pool.query(select,[f.runId])).rows,[{kind:'qa_text',body_content:expected}]);
    assert.deepEqual(await rows(pool,f),[],'QA never enters the canonical Word registry');
    const faults=[
      {table:'bb_jobs',sql:"UPDATE bb_jobs SET subtype='default' WHERE run_id=$1"},
      {table:'bb_m4_execution_snapshots',sql:"UPDATE bb_m4_execution_snapshots SET manifest=jsonb_set(manifest,'{content}','\"Changed frozen QA question\"') WHERE run_id=$1"},
      {table:'bb_m4_artifacts',sql:"UPDATE bb_m4_artifacts SET body_content=body_content||'changed' WHERE run_id=$1"},
      {table:'bb_m4_artifacts',sql:"UPDATE bb_m4_artifacts SET kind='document',document_type='init' WHERE run_id=$1"},
      {table:'bb_m4_text_delivery_evidence',sql:"UPDATE bb_m4_text_delivery_evidence SET sha256=repeat('0',64) WHERE run_id=$1"},
      {table:'bb_m4_text_delivery_evidence',sql:"UPDATE bb_m4_text_delivery_evidence SET content=repeat('x',octet_length(content)) WHERE run_id=$1"}
    ];
    for(const fault of faults)await rolledBack(pool,async db=>{
      await db.query(`ALTER TABLE ${fault.table} DISABLE TRIGGER USER`);await db.query(fault.sql,[f.runId]);
      assert.deepEqual((await db.query(select,[f.runId])).rows,[],fault.sql);
    });
    const pin={source_project_id:f.projectId,artifact_id:answer.artifactId,artifact_version:answer.artifactVersion,sha256:sha};
    assert.equal((await readM4ArtifactPin(pool,f.owner,pin)).media_type,'text/plain');
    assert.equal((await receipts(pool,f)).length,1);assert.deepEqual(await receipts(pool,f,'final'),[]);
    const app=await api(pool,f.owner,memoryBlobs());t.after(()=>app.close());
    const bytes=await app.inject({method:'GET',url:`/api/v1/m4/artifacts/${answer.artifactId}/versions/1/bytes`});
    assert.equal(bytes.statusCode,200,bytes.body);assert.equal(bytes.body,expected);
    assert.equal(bytes.rawPayload.length,Number(evidence[0].byte_size));assert.equal(digest(bytes.rawPayload),sha);
  });

test('a legacy Word masquerading as qa_text cannot enter the QA fallback or produce M4 delivery',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),a=await word(pool,f,memoryBlobs(),'forged QA origin');
    await rolledBack(pool,async db=>{
      const values=legacyValues(f,a);values[5]='qa_text';values[8]=null;values[11]='Counterfeit plaintext';
      await db.query('ALTER TABLE bb_m4_artifacts DISABLE TRIGGER USER');await db.query(legacySql,values);
      assert.equal((await db.query('SELECT 1 FROM bb_m4_artifact_execution_versions WHERE run_id=$1',[f.runId])).rowCount,0);
      await db.query('SELECT bb_capture_m4_durable_delivery($1,$2)',[f.owner,f.runId]);
      assert.deepEqual(await receipts(db,f),[]);assert.deepEqual(await published(db,f),[]);
    });
  });

test('dynamic saved canonical Word remains private until real recharge and final settlement, reusing the saved pair',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const owner=uid(),blobs=memoryBlobs();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`md_${uid().replaceAll('-','').slice(0,20)}`]);
    const app=await api(pool,owner,blobs);t.after(()=>app.close());
    const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test'}});
    const ok=(response:any)=>{assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);return response.json();};
    const fund=(points:number)=>transaction(pool,db=>grantCredits(db,{owner,source:'existing_grant',key:uid(),points,expiresAt:null,actor:'synthetic',reason:'M4 registry settlement test'}));
    const topic=ok(await send('POST','/api/v1/m4/topics',{creation_request_id:uid(),name:'Synthetic dynamic canonical pair'})).topic;
    const base=`/api/v1/m4/topics/${topic.topic_id}`,material=await source(pool,owner,topic.project_id);
    ok(await send('PUT',`${base}/drafts/underwriter`,{expected_version:0,input:{...emptyM4Draft('underwriter'),materials:[material],fields:{market:'sse',issuer_name:'Synthetic issuer'}}}));
    const quote=ok(await send('POST',`${base}/quote`,{kind:'document',document_type:'underwriter',expected_draft_version:1}));
    assert.equal(quote.quote.billing_policy,'authoring_balance_v2');await fund(1);
    const run=ok(await send('POST',`${base}/execute`,{execution_request_id:uid(),document_type:'underwriter',expected_draft_version:1,quote_id:quote.quote.quote_id,entrypoint:'workspace'})).run;
    const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run.run_id);
    await checkpointStage(pool,lease,'input_lock',{synthetic:true});
    const documentBytes=makeSyntheticDocxFixture({text:'Synthetic paid document'}),noteBytes=makeSyntheticDocxFixture({text:'Synthetic paid preparation note'});
    const document=await promoteWordArtifact(pool,lease,documentBytes,blobs),note=await promoteWordArtifact(pool,lease,noteBytes,blobs);
    assert.equal(document.status,'available');assert.equal(note.status,'available');
    if(document.status!=='available'||note.status!=='available')throw Error('Synthetic paid pair unavailable');
    await transaction(pool,db=>registerM4Artifacts(db,owner,run.run_id,[registration({...document,bytes:documentBytes}),registration({...note,bytes:noteBytes},'preparation_note')],lease));
    await checkpointStage(pool,lease,'word_delivery',{artifact:document.artifactId});
    const bytesUrl=`/api/v1/m4/artifacts/${document.artifactId}/versions/1/bytes`;
    assert.equal((await finish(pool,lease,'succeeded',{artifactId:document.artifactId,artifactVersion:1,blobs})).state,'paused');
    assert.equal((await pool.query('SELECT 1 FROM bb_run_execution_deliveries WHERE run_id=$1',[run.run_id])).rowCount,0);
    assert.equal((await send('GET',bytesUrl)).statusCode,404);
    const saved=(await pool.query('SELECT *,created_at::text AS exact_created_at FROM bb_m4_execution_artifacts WHERE run_id=$1 ORDER BY kind',[run.run_id])).rows;
    assert.equal(saved.length,2);await fund(Number(quote.quote.points));assert.equal(await resumePausedRun(pool,owner,run.run_id,'credits_recharged'),true);
    const resumed=await claim(pool);assert.ok(resumed);assert.equal(resumed.runId,run.run_id);
    assert.equal((resumed.checkpoint.stages as any).word_delivery.artifact,document.artifactId);
    assert.equal((await finish(pool,resumed,'succeeded',{artifactId:document.artifactId,artifactVersion:1,blobs})).state,'succeeded');
    assert.deepEqual((await pool.query('SELECT *,created_at::text AS exact_created_at FROM bb_m4_execution_artifacts WHERE run_id=$1 ORDER BY kind',[run.run_id])).rows,saved);
    assert.deepEqual((await pool.query('SELECT delivery_phase FROM bb_run_execution_deliveries WHERE run_id=$1',[run.run_id])).rows,[{delivery_phase:'final'}]);
    const downloaded=await send('GET',bytesUrl);assert.equal(downloaded.statusCode,200,downloaded.body);assert.equal(digest(downloaded.rawPayload),digest(documentBytes));
    const reservation=(await pool.query('SELECT state,points,charged_points FROM bb_credit_reservations WHERE run_id=$1',[run.run_id])).rows[0];
    assert.equal(reservation.state,'settled');assert.equal(Number(reservation.charged_points),Number(quote.quote.points));
  });

test('0130 replay installs exact six/seven/eight-field foreign keys and retains nullable historical metadata',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:10000});t.after(()=>pool.end());
    await rolledBack(pool,async db=>{
      await removeM4ArtifactExecutionScaffold(db);await db.query(migration);
      const constraints=(await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='bb_m4_execution_artifacts'::regclass")).rows.map(r=>r.definition as string);
      assert.ok(constraints.some(d=>d.includes('PRIMARY KEY (run_id, execution_version, kind)')));
      for(const [fields,table] of [
        ['owner_user_id, project_id, run_id, execution_version, input_revision, input_hash','bb_run_execution_versions'],
        ['owner_user_id, project_id, run_id, execution_version, input_revision, input_hash, topic_id','bb_m4_execution_snapshots'],
        ['owner_user_id, project_id, run_id, execution_version, input_revision, input_hash, artifact_id, artifact_version','bb_artifact_execution_bindings']
      ])assert.ok(constraints.some(d=>d.includes(`FOREIGN KEY (${fields})`)&&d.includes(`REFERENCES ${table}(`)),table);
      const nullable=(await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
        AND table_name='bb_m4_execution_artifacts' AND is_nullable='YES'`)).rows.map(r=>r.column_name);
      for(const column of ['revision_number','base_artifact','body_content','preview_content'])assert.ok(nullable.includes(column),column);
      assert.equal((await db.query('SELECT count(*)::int n FROM bb_m4_execution_artifacts')).rows[0].n,0);
    });
  });

test('0130 backfills every old field with real microseconds and NULL revision without manufacturing publication',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),blobs=memoryBlobs(),a=await word(pool,f,blobs,'historical document'),b=await word(pool,f,blobs,'rolling note');
    await rolledBack(pool,async db=>{
      await removeM4ArtifactExecutionScaffold(db);
      const values=legacyValues(f,a);values[11]='Historical body 😀';values[12]='Historical preview';await db.query(legacySql,values);
      const before=(await db.query('SELECT to_jsonb(a) AS row FROM bb_m4_artifacts a WHERE run_id=$1',[f.runId])).rows;
      const gaps=(await db.query('SELECT * FROM bb_run_execution_delivery_gaps ORDER BY run_id')).rows;
      await db.query(migration);const mirror=await assertMirror(db,f);assert.equal(mirror[0].precise_time,'2026-01-02 03:04:05.123456');
      assert.deepEqual((await db.query('SELECT to_jsonb(a) AS row FROM bb_m4_artifacts a WHERE run_id=$1',[f.runId])).rows,before);
      const saved=await rows(db,f);assert.equal(saved[0].revision_number,null);assert.equal(saved[0].body_content,values[11]);
      assert.equal(saved[0].preview_content,values[12]);assert.equal(saved[0].base_artifact,null);
      assert.deepEqual(await receipts(db,f),[]);assert.deepEqual(await published(db,f),[]);
      assert.deepEqual((await db.query('SELECT * FROM bb_run_execution_delivery_gaps ORDER BY run_id')).rows,gaps);
      await db.query(legacySql,legacyValues(f,b,'preparation_note'));assert.equal((await assertMirror(db,f)).length,2);
    });
  });

test('0130 rejects incompatible historical Word origins atomically instead of skipping or adopting another run',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:migrationConnection,statement_timeout:10000});t.after(()=>pool.end());
    for(const defect of ['missing-snapshot','missing-binding','wrong-run','wrong-document-type'] as const){
      const f=await fixture(pool),foreign=await fixture(pool,'document',f.owner),blobs=memoryBlobs();
      const a=await word(pool,f,blobs,'bad historical origin'),other=await word(pool,foreign,blobs,'foreign artifact');
      await rolledBack(pool,async db=>{
        await removeM4ArtifactExecutionScaffold(db);
        const values=legacyValues(f,defect==='wrong-run'?other:a);if(defect==='wrong-document-type')values[8]='underwriter';
        await db.query(legacySql,values);
        if(defect==='missing-snapshot'){
          await db.query('ALTER TABLE bb_m4_execution_snapshots DISABLE TRIGGER USER');await db.query('DELETE FROM bb_m4_execution_snapshots WHERE run_id=$1',[f.runId]);
        }
        if(defect==='missing-binding'){
          await db.query('ALTER TABLE bb_artifact_execution_bindings DISABLE TRIGGER USER');await db.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1',[a.artifactId]);
        }
        const before=(await db.query('SELECT to_jsonb(a) AS row FROM bb_m4_artifacts a WHERE run_id=$1',[f.runId])).rows;
        await rejectWork(db,()=>db.query(migration));
        assert.equal((await db.query("SELECT to_regclass('bb_m4_execution_artifacts') AS relation")).rows[0].relation,null,defect);
        assert.deepEqual((await db.query('SELECT to_jsonb(a) AS row FROM bb_m4_artifacts a WHERE run_id=$1',[f.runId])).rows,before,defect);
        assert.equal((await db.query('SELECT run_id FROM bb_artifact_versions WHERE id=$1',[other.artifactId])).rows[0].run_id,foreign.runId);
      });
    }
  });

test('0130 NOWAIT aborts behind an old registry writer and can replay only after that writer releases its lock',
  {skip:!migrationConnection,timeout:30000},async t=>{
    const isolated=await isolatedTestDatabase(undefined,'m4-artifact-execution-lock');
    const pool=new Pool({connectionString:isolated,statement_timeout:10000});t.after(()=>pool.end());
    const setup=await pool.connect(),writer=await pool.connect(),migrator=await pool.connect();
    try{
      await setup.query('BEGIN');await removeM4ArtifactExecutionScaffold(setup);await setup.query('COMMIT');
      await writer.query('BEGIN');await writer.query('LOCK TABLE bb_m4_artifacts IN ROW EXCLUSIVE MODE');
      await migrator.query('BEGIN');await rejectWork(migrator,()=>migrator.query(migration),error=>(error as {code?:string}).code==='55P03');
      assert.equal((await migrator.query("SELECT to_regclass('bb_m4_execution_artifacts') AS relation")).rows[0].relation,null);
      assert.equal((await migrator.query("SELECT to_regprocedure('bb_check_m4_execution_artifact()') AS fn")).rows[0].fn,null);
      await writer.query('COMMIT');await migrator.query(migration);
      assert.equal((await migrator.query("SELECT to_regclass('bb_m4_execution_artifacts') AS relation")).rows[0].relation,'bb_m4_execution_artifacts');
      await migrator.query('COMMIT');
    }finally{
      await Promise.allSettled([setup.query('ROLLBACK'),writer.query('ROLLBACK'),migrator.query('ROLLBACK')]);
      setup.release();writer.release();migrator.release();
    }
  });

test('legacy INSERT fails NOWAIT before occupying a slot needed by a canonical writer holding the run lock',
  {skip:!connection,timeout:30000},async t=>{
    const pool=new Pool({connectionString:connection,statement_timeout:10000});t.after(()=>pool.end());
    const f=await fixture(pool),a=await word(pool,f,memoryBlobs(),'concurrent rolling writer');
    const canonical=await pool.connect(),old=await pool.connect();
    try{
      await canonical.query('BEGIN');await canonical.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE',[f.runId]);
      await old.query('BEGIN');
      await rejectWork(old,()=>old.query(legacySql,legacyValues(f,a)),error=>(error as {code?:string}).code==='55P03');
      assert.equal((await old.query('SELECT 1 FROM bb_m4_artifacts WHERE run_id=$1',[f.runId])).rowCount,0);
      // If the legacy INSERT reserved the unique slot before the NOWAIT
      // provenance guard, this real canonical mirror would block here.
      await canonical.query(canonicalSql,canonicalValues(f,a));await assertMirror(canonical,f);await canonical.query('COMMIT');
      await old.query(legacySql+' ON CONFLICT DO NOTHING',legacyValues(f,a));await old.query('COMMIT');
      assert.equal((await rows(pool,f)).length,1);await assertMirror(pool,f);
    }finally{
      await Promise.allSettled([canonical.query('ROLLBACK'),old.query('ROLLBACK')]);canonical.release();old.release();
    }
  });
