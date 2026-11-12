// Real isolated PostgreSQL and HTTP injection; synthetic documents/credits, no worker or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {grantCredits,creditBalance} from './billing.js';
import {emptyM4Draft} from './m4-workspace.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';

const database=await isolatedTestDatabase(undefined,'m4-fixture-boundary');
for(const historicalFirst of [false,true])test(`current and historical HTTP pricing remain isolated on one Pool (historical first: ${historicalFirst})`,{skip:!database,timeout:90000},async()=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID(),files=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>files.get(k)!,getIfExists:async k=>files.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=files.get(k);assert.ok(!b||b.length<=n);return b??null;},exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
  const server=(historical:boolean)=>createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true,
    // Retired toggles cannot disable current billing unless the explicit test-only seam is used.
    enableSubscriptionBilling:false,enableOutcomePricing:false,...(historical?{historicalBillingFixture:true}:{})});
  const first=server(historicalFirst),second=server(!historicalFirst),current=historicalFirst?second:first,historical=historicalFirst?first:second;
  const ok=async(app:ReturnType<typeof createServer>,method:string,url:string,payload?:unknown)=>{
    const r=await app.inject({method:method as never,url,payload:payload as never,headers:{origin:'http://bondbuddy.test'}});assert.equal(r.statusCode,200,r.body);return r.json();
  };
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'fixture_'+owner.slice(0,8)]);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:10000,expiresAt:null,actor:'synthetic-test',reason:'Isolated current/historical pricing boundary'}));
    const fixture=async(app:ReturnType<typeof createServer>)=>{
      const topic=(await ok(app,'POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic price boundary'})).topic;
      const material=randomUUID(),upload=randomUUID(),key='synthetic/'+material,body=makeSyntheticDocxFixture({text:'Synthetic issuer evidence for price boundary.'}),sha=digest(body);files.set(key,body);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$4,$5,'historical',$6,now()+interval '1 hour','completed')`,[upload,owner,topic.project_id,body.length,sha,key]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$5,$6,$7,'persisted')`,[material,owner,topic.project_id,upload,body.length,sha,key]);
      const source={source_project_id:topic.project_id,material_id:material,material_version:1,sha256:sha},path=`/api/v1/m4/topics/${topic.topic_id}`;
      await ok(app,'PUT',`${path}/drafts/private_summary`,{expected_version:0,input:{...emptyM4Draft('private_summary'),source_material:source,materials:[source],fields:{market:'sse'}}});
      return {app,path};
    };
    const modern=await fixture(current),old=await fixture(historical);
    const quote=async(f:typeof modern)=>(await ok(f.app,'POST',`${f.path}/quote`,{kind:'document',document_type:'private_summary',expected_draft_version:1})).quote;
    for(const f of [modern,old,modern,old]){
      const q=await quote(f);assert.equal(q.points,f===modern?'7965':'4500');assert.equal(q.billing_policy,f===modern?'on_delivery':'authoring_balance_v2');
    }
    const accepted=[];
    for(const f of [modern,old]){
      const q=await quote(f),request={execution_request_id:randomUUID(),document_type:'private_summary',expected_draft_version:1,quote_id:q.quote_id,entrypoint:'workspace'};
      const run=(await ok(f.app,'POST',`${f.path}/execute`,request)).run;
      assert.equal((await ok(f.app,'POST',`${f.path}/execute`,request)).run.run_id,run.run_id);
      accepted.push(run.run_id);
      assert.deepEqual(await creditBalance(pool,owner),{available:2035,frozen:7965},'only current on-delivery work reserves its immutable price');
      const rows=(await pool.query('SELECT state,billing_policy,points::text,charged_points::text FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2',[owner,run.run_id])).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].state,'held');assert.equal(rows[0].billing_policy,f===modern?'on_delivery':'authoring_balance_v2');
      assert.equal(rows[0].points,f===modern?'7965':'4500');assert.equal(rows[0].charged_points,f===modern?null:'0','unsettled current charge stays unknown; historical progress starts at zero');
    }
    assert.equal(new Set(accepted).size,2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  }finally{await first.close();await second.close();await pool.end();}
});