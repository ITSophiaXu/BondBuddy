import { uploadSyntheticReference } from './test-authoring-source.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {INITIAL_FIXED_PRICES,emptyUpdateDetails} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {creditBalance,grantCredits,publishPrices} from './billing.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {claim} from './queue.js';
import {trialConfigFromEnv} from './trial-guard.js';

const connection=await isolatedTestDatabase(undefined,'execute-quota-billing');
for(const automatic of [false,true])test('multiple paid updates queue, cancel and replay without waiting charge: '+(automatic?'automatic tariff':'historical progress'),{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),owner=`quota-paid-${randomUUID()}`;
  const bytes=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const v=bytes.get(k);assert.ok(v);return v;},
    getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bound');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
  const app=createServer({pool,historicalBillingFixture:!automatic,enableSubscriptionBilling:automatic,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),
    enableSyntheticQueue:true,enablePaidAuthoring:true,
    trial:{...trialConfigFromEnv({BB_TRIAL_GUARD:'on'}),active_runs_per_user:1,global_active_runs:1,
      runs_per_user_per_day:1,projects_per_user_per_day:1,upload_bytes_per_user_per_day:1,model_tokens_per_user_per_day:1}});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test',...headers}});
  const ready=async()=>{
    const created=await send('POST','/api/v1/projects',{kind:'update',name:'Synthetic paid retry',issuer_name:'Synthetic issuer',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
    assert.equal(created.statusCode,201,created.body);const id=created.json().project_id;
    const content=Buffer.from('Synthetic issuer information'),metadata={byte_size:content.length,sha256:digest(content)};
    const upload=await send('POST',`/api/v1/projects/${id}/materials/uploads`,{...metadata,filename:'synthetic.txt',media_type:'text/plain',role:'audit'});
    assert.equal(upload.statusCode,201,upload.body);
    assert.equal((await send('PUT',upload.json().upload_url,content,{'content-type':'application/octet-stream'})).statusCode,204);
    const material=await send('POST',`/api/v1/projects/${id}/materials/uploads/${upload.json().upload_id}/complete`,metadata);
    assert.equal(material.statusCode,200,material.body);
    const reference=await uploadSyntheticReference(app,id);
    const input=await send('POST',`/api/v1/projects/${id}/input-revisions`,{...reference,
      material_versions:[...reference.material_versions,{material_id:material.json().material_id,material_version:1}]});
    assert.equal(input.statusCode,201,input.body);const snapshot=input.json();
    const quote=await send('POST',`/api/v1/projects/${id}/credit-quote`,{input_revision:snapshot.input_revision,input_hash:snapshot.input_hash});
    assert.equal(quote.statusCode,200,quote.body);
    return {execution_request_id:randomUUID(),project_id:id,input_revision:snapshot.input_revision,input_hash:snapshot.input_hash,
      task_kind:'update',input_manifest_ref:snapshot.input_hash,storage_origin:'cloud',workspace_id:id,quote_id:quote.json().quote.quote_id};
  };
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`quota_paid_${randomUUID().slice(0,8)}`]);
    if(!automatic)await publishPrices(pool,{id:`quota-${randomUUID()}`,prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'synthetic-only'});
    await transaction(pool,c=>grantCredits(c,{owner,points:10_000_000,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    const requests:Awaited<ReturnType<typeof ready>>[]=[];for(let i=0;i<12;i++)requests.push(await ready());
    const source=randomUUID();await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic shared source','generation')",[source,owner]);
    await pool.query('UPDATE bb_projects SET execution_scope_project_id=$2 WHERE id=ANY($1::text[])',[requests.map(r=>r.project_id),source]);
    const inputBefore=(await pool.query('SELECT project_id,revision,input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 ORDER BY project_id,revision',[owner])).rows;
    const responses=await Promise.all(requests.map(request=>send('POST','/api/v1/runs/execute',request)));
    responses.forEach(r=>assert.equal(r.statusCode,202,r.body));
    const ids=responses.map(r=>r.json().run_id);assert.equal(new Set(ids).size,12);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,12);
    const reserved=await creditBalance(pool,owner);
    const replay=await Promise.all(Array.from({length:3},()=>send('POST','/api/v1/runs/execute',requests[0])));
    replay.forEach(r=>{assert.equal(r.statusCode,202,r.body);assert.equal(r.json().run_id,ids[0]);});
    assert.deepEqual(await creditBalance(pool,owner),reserved);
    const lease=await claim(pool,60,{runKinds:['update']});assert.ok(lease);
    const control=ids.find(id=>id!==lease.runId)!;
    assert.equal((await send('POST','/api/v1/runs/'+control+'/pause',{reason:'synthetic'})).statusCode,200);
    assert.equal((await send('POST','/api/v1/runs/'+control+'/resume',{reason:'synthetic'})).statusCode,200);
    assert.deepEqual(await creditBalance(pool,owner),reserved);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1 AND kind='settle'",[owner])).rows[0].n,0,'queueing and control do not settle credits');
    assert.equal((await send('POST','/api/v1/runs/'+control+'/cancel',{reason:'synthetic'})).statusCode,200);
    const cancelled=(await pool.query('SELECT state,billing_policy,charged_points,points FROM bb_credit_reservations WHERE run_id=$1',[control])).rows[0];
    assert.equal(cancelled.state,'released');assert.equal(cancelled.charged_points,'0');
    assert.equal(cancelled.billing_policy,automatic?'on_delivery':'authoring_balance_v2');
    const afterCancel=await creditBalance(pool,owner),released=automatic?Number(cancelled.points):0;
    assert.deepEqual(afterCancel,{available:reserved.available+released,frozen:reserved.frozen-released},'queued cancellation releases exactly its original hold, with no charge');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE run_id=ANY($1::text[]) AND state='queued'",[ids])).rows[0].n,10);
    assert.deepEqual((await pool.query('SELECT project_id,revision,input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 ORDER BY project_id,revision',[owner])).rows,inputBefore);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,12);
  }finally{
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_user_id=$1",[owner]);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE owner_user_id=$1",[owner]);
    await app.close();await pool.end();
  }
});
