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
import {trialConfigFromEnv} from './trial-guard.js';

const connection=await isolatedTestDatabase(undefined,'execute-quota-billing');
test('paid quota retry reserves only one task and never charges a rejected attempt',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),owner=`quota-paid-${randomUUID()}`;
  const bytes=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const v=bytes.get(k);assert.ok(v);return v;},
    getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bound');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
  const app=createServer({pool,historicalBillingFixture:true,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),
    enableSyntheticQueue:true,enablePaidAuthoring:true,
    trial:{...trialConfigFromEnv({BB_TRIAL_GUARD:'on'}),active_runs_per_user:1,global_active_runs:100,
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
    await publishPrices(pool,{id:`quota-${randomUUID()}`,prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'synthetic-only'});
    await transaction(pool,c=>grantCredits(c,{owner,points:1_000_000,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    const occupied=await ready(),target=await ready();
    const first=await send('POST','/api/v1/runs/execute',occupied);assert.equal(first.statusCode,202,first.body);
    const before=await creditBalance(pool,owner);
    for(let attempt=0;attempt<2;attempt++){
      const rejected=await send('POST','/api/v1/runs/execute',target);assert.equal(rejected.statusCode,429,rejected.body);
      assert.equal(rejected.json().code,'TRIAL_QUOTA_EXCEEDED');
    }
    assert.deepEqual(await creditBalance(pool,owner),before);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[target.project_id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,1);
    assert.equal((await send('POST',`/api/v1/runs/${first.json().run_id}/cancel`,{reason:'synthetic-capacity-release'})).statusCode,200);
    const concurrent=await Promise.all([send('POST','/api/v1/runs/execute',target),send('POST','/api/v1/runs/execute',target)]);
    concurrent.forEach(r=>assert.equal(r.statusCode,202,r.body));
    const runId=concurrent[0].json().run_id;assert.equal(concurrent[1].json().run_id,runId);
    assert.equal(concurrent[0].json().billing_mode,'fixed_credits');assert.ok(concurrent[0].json().reservation_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[runId])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1 AND kind='settle'",[owner])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1',[target.project_id])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE project_id=$1',[target.project_id])).rows[0].n,2);
  }finally{await app.close();await pool.end();}
});
