import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { azureBlobs } from './data.js';
import { claim, finish, promoteWordArtifact } from './queue.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=process.env.BB_TEST_DATABASE_URL;
const runConnection=await isolatedTestDatabase();
const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin='http://bondbuddy.test';

test('#10 PostgreSQL global search, literal names, tied cursor pages, archive isolation and transaction rollback', {skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection});
  const a=`list-${randomUUID()}`,b=`list-${randomUUID()}`;
  let owner=a;
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try {
    // > one default page, with microsecond ties, and a search target outside the first page.
    const ids=Array.from({length:62},()=>randomUUID());
    for(let i=0;i<ids.length;i++)await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,updated_at)
      VALUES($1,$2,$3,$4,$5,'2026-09-20 12:00:00.123456+00')`,[ids[i],a,`合成项目 ${i}`,i===0?'review':'update',i===61?'目标发行人 %_公司':'普通发行人']);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'私人目标','update','目标发行人 %_公司')",[randomUUID(),b]);
    const first=await send('GET','/api/v1/projects');assert.equal(first.statusCode,200,first.body);
    assert.equal(first.json().items.length,50);assert.equal(first.json().page.has_more,true);
    const second=(await send('GET',`/api/v1/projects?cursor=${encodeURIComponent(first.json().page.next_cursor)}`)).json();
    const all=[...first.json().items,...second.items];assert.equal(new Set(all.map((p:any)=>p.project_id)).size,62);
    assert.equal(second.page.has_more,false);assert.ok(all.every((p:any)=>p.status==='draft' && p.latest_run===null && p.latest_artifact===null));
    const search=await send('GET',`/api/v1/projects?q=${encodeURIComponent('目标发行人 %_')}`);
    assert.deepEqual(search.json().items.map((p:any)=>p.project_id),[ids[61]]);
    assert.deepEqual((await send('GET','/api/v1/projects?kind=review')).json().items.map((p:any)=>p.project_id),[ids[0]]);
    assert.equal((await send('GET','/api/v1/projects?status=running')).json().items.length,0);
    for(const query of ['status=invented','kind=unknown','archive=invalid','limit=101','limit=0','cursor=broken','q='+ 'x'.repeat(201),'invented=1']) {
      assert.equal((await send('GET',`/api/v1/projects?${query}`)).statusCode,422,query);
    }
    const snapshot=await send('POST',`/api/v1/projects/${ids[0]}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
    assert.equal(snapshot.statusCode,201,snapshot.body);
    const archived=await send('POST',`/api/v1/projects/${ids[0]}/archive`,{archived:true});
    assert.equal(archived.statusCode,200,archived.body);assert.ok(archived.json().archived_at);assert.equal(archived.json().draft_revision,1);
    assert.equal(archived.json().input_hash,snapshot.json().input_hash);
    assert.equal((await send('GET','/api/v1/projects?kind=review')).json().items.length,0);
    assert.deepEqual((await send('GET','/api/v1/projects?archive=archived')).json().items.map((p:any)=>p.project_id),[ids[0]]);
    assert.equal((await send('GET',`/api/v1/projects/${ids[0]}`)).statusCode,200,'archive keeps direct access');
    await send('POST',`/api/v1/projects/${ids[0]}/archive`,{archived:true});
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='project.archived'",[ids[0]])).rows[0].n,1,'same action replay emits one event');
    owner=b;assert.equal((await send('POST',`/api/v1/projects/${ids[0]}/archive`,{archived:false})).statusCode,404);
    assert.equal((await send('GET','/api/v1/projects?archive=all')).json().items.length,1);
    owner=a;
    await pool.query("CREATE FUNCTION bb_list_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='project.restored' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER bb_list_fail_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_list_fail_outbox()');
    assert.equal((await send('POST',`/api/v1/projects/${ids[0]}/archive`,{archived:false})).statusCode,500);
    assert.ok((await send('GET',`/api/v1/projects/${ids[0]}`)).json().archived_at,'outbox failure rolls archive change back');
    await pool.query('DROP TRIGGER bb_list_fail_outbox ON bb_outbox');await pool.query('DROP FUNCTION bb_list_fail_outbox()');
    assert.equal((await send('POST',`/api/v1/projects/${ids[0]}/archive`,{archived:false})).json().archived_at,null);
    assert.equal((await send('GET','/api/v1/projects?kind=review')).json().items[0].input_revision,undefined);
    await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1',[ids[0]]);
    assert.equal((await send('POST',`/api/v1/projects/${ids[0]}/archive`,{archived:true})).statusCode,404);
    assert.equal((await send('GET','/api/v1/projects?archive=all&kind=review')).json().items.length,0);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS bb_list_fail_outbox ON bb_outbox');await pool.query('DROP FUNCTION IF EXISTS bb_list_fail_outbox()');
    await app.close();await pool.end();
  }
});

test('#10 actual run status and previous successful Word remain available after a newer failure and archive', {skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:runConnection});const owner=`list-${randomUUID()}`;
  const blobs=azureBlobs(blobConnection!);
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try {
    const p=(await send('POST','/api/v1/projects',{name:'合成任务状态',kind:'update',issuer_name:'合成发行人',market:null,offering:null})).json();
    const snapshot=(await send('POST',`/api/v1/projects/${p.project_id}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]})).json();
    const request={execution_request_id:randomUUID(),project_id:p.project_id,input_revision:1,input_hash:snapshot.input_hash,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
    const first=await send('POST','/api/v1/runs/execute',request);assert.equal(first.statusCode,202,first.body);
    const lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,first.json().run_id);
    const row=()=>send('GET','/api/v1/projects');
    assert.equal((await row()).json().items[0].status,'running');
    await send('POST',`/api/v1/projects/${p.project_id}/archive`,{archived:true});
    assert.equal((await send('GET','/api/v1/projects?archive=archived')).json().items[0].status,'running','archive does not cancel or pause the running job');
    await send('POST',`/api/v1/projects/${p.project_id}/archive`,{archived:false});
    const bytes=makeSyntheticDocxFixture();const artifact=await promoteWordArtifact(pool,lease,bytes,blobs);
    assert.equal((await row()).json().items[0].latest_artifact,null,'promotion alone is not a successful result');
    await finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs});
    assert.equal((await row()).json().items[0].status,'succeeded');
    const second=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()});assert.equal(second.statusCode,202,second.body);
    const secondLease=await claim(pool,30);assert.ok(secondLease);assert.equal(secondLease.runId,second.json().run_id);
    await finish(pool,secondLease,'failed',{errorCode:'DATA_UNAVAILABLE'});
    const latest=(await row()).json().items[0];assert.equal(latest.status,'failed');assert.equal(latest.latest_run.run_id,secondLease.runId);
    assert.equal(latest.latest_artifact.artifact_id,artifact.artifactId,'new failure keeps the earlier successful result');
    assert.equal((await send('GET','/api/v1/projects?status=failed')).json().items.length,1);
    await send('POST',`/api/v1/projects/${p.project_id}/archive`,{archived:true});
    const archived=(await send('GET','/api/v1/projects?archive=archived')).json().items[0];assert.equal(archived.latest_artifact.artifact_id,artifact.artifactId);
    const metadata=await send('GET',`/api/v1/artifacts/${artifact.artifactId}`);assert.equal(metadata.statusCode,200,metadata.body);
    assert.deepEqual((await send('GET',metadata.json().download_url)).rawPayload,bytes);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,2,'archive and download create no run');
  } finally {await app.close();await pool.end();}
});
