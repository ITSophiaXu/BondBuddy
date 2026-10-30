import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {AUTOMATIC_PRICE_VERSION} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {digest,uid,transaction,type PrivateBlobs} from './data.js';
import {creditBalance,grantCredits} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {claim,finish} from './queue.js';
import {syntheticReviewPair} from './review-delivery-test-fixture.js';

const connection=await isolatedTestDatabase(undefined,'automatic-full-review');
test('full review locks 27195 points, settles once on report delivery, and releases a failed retry',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),owner=uid(),bytes=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},getIfExists:async k=>bytes.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bound');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
  const origin='https://synthetic.invalid',app=createServer({pool,blobs,enablePaidReview:true,enableSubscriptionBilling:true,paymentProviders:[],principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
  const failures:string[]=[];app.addHook('onError',async(_request,_reply,error)=>{failures.push(String(error)+' '+((error as any).where??''));});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin}});
  const ok=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body+' '+failures.join('\n'));return r.json();};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_full_'+owner.slice(0,8)]);
    const project=ok(await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic full review',issuer_name:null,market:null,offering:null})).project_id,base=`/api/v1/projects/${project}`;
    const upload=uid(),material=uid(),sha=digest('synthetic full review');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')`,[upload,owner,project,sha,`synthetic/${upload}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')`,[material,owner,project,upload,sha,`synthetic/${material}`]);
    const pin={material_id:material,material_version:1,sha256:sha};
    ok(await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}}));
    const intent={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const quote=ok(await send('POST',`${base}/review-executions/quote`,intent)).quote;
    assert.equal(quote.points,'27195');assert.equal(quote.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(quote.auto_charge,true);
    assert.equal(quote.scope_lines[0].label,'独立全面复核');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,0);
    const request={...intent,quote_id:quote.quote_id};
    const short=await send('POST',`${base}/review-executions`,request);assert.equal(short.statusCode,402,short.body+' '+failures.join('\n'));
    assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,0);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-funding',points:60000,expiresAt:null,actor:'synthetic',reason:'test only'}));
    const submitted=await Promise.all([send('POST',`${base}/review-executions`,request),send('POST',`${base}/review-executions`,request)]);
    const run=ok(submitted[0]);assert.equal(ok(submitted[1]).run_id,run.run_id);
    assert.deepEqual(await creditBalance(pool,owner),{available:32805,frozen:27195});
    const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run.run_id);
    const report=await syntheticReviewPair(pool,lease,blobs);await finish(pool,lease,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs});
    assert.deepEqual(await creditBalance(pool,owner),{available:32805,frozen:0});
    const receipt=ok(await send('GET',`/api/v1/runs/${run.run_id}/credit-charge`));assert.equal(receipt.state,'settled');assert.equal(receipt.quote.points,'27195');
    assert.equal(ok(await send('POST',`${base}/review-executions`,request)).run_id,run.run_id);
    const followupIntent={execution_request_id:uid(),source_run_id:run.run_id,requirements:'Separately commissioned source revision'};
    const followup=ok(await send('POST',`${base}/review-updates/quote`,followupIntent));
    assert.equal(followup.quote.points,'14900');assert.equal(followup.quote.scope_lines[0].label,'复核后原文修订');
    const next={...intent,execution_request_id:uid()},nextQuote=ok(await send('POST',`${base}/review-executions/quote`,next)).quote;
    const failed=ok(await send('POST',`${base}/review-executions`,{...next,quote_id:nextQuote.quote_id}));
    assert.deepEqual(await creditBalance(pool,owner),{available:5610,frozen:27195});
    const binding=(await pool.query(`SELECT r.input_revision run_revision,q.input_revision quote_revision FROM bb_runs r
      JOIN bb_credit_reservations h ON h.id=r.reservation_id JOIN bb_credit_quotes q ON q.id=h.quote_id WHERE r.id=$1`,[failed.run_id])).rows[0];
    assert.equal(binding.run_revision,2);assert.equal(binding.quote_revision,1,'review intent pins draft revision, not the subsequently created run revision');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_commerce_scope_source_quotes($1,$2,$3)',[owner,quote.scope_quote_id,failed.run_id])).rows[0].n,0,'a prior quote cannot bind a different paid run');
    await assert.rejects(pool.query('INSERT INTO bb_automatic_scope_runs(owner_user_id,scope_quote_id,run_id) VALUES($1,$2,$3)',[owner,quote.scope_quote_id,failed.run_id]),{code:'23514'});
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[failed.run_id]);
    assert.deepEqual(await creditBalance(pool,owner),{available:32805,frozen:0});
    const revised=ok(await send('POST',`${base}/review-updates`,{...followupIntent,quote_id:followup.quote.quote_id}));
    assert.deepEqual(await creditBalance(pool,owner),{available:17905,frozen:14900});
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[revised.run_id]);
    assert.deepEqual(await creditBalance(pool,owner),{available:32805,frozen:0});
    assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await app.close();await pool.end();}
});
