// Public production-channel protocol in private PG clones, synthetic private
// files and wallet lots. No external supplier or real payment is called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_FIXED_PRICES } from '@bondbuddy/contracts';
import { isolatedTestDatabase } from './test-database.js';
import { digest, transaction, uid } from './data.js';
import { creditBalance, grantCredits, publishPrices, reserveCredits } from './billing.js';
import { quoteM4, reserveM4 } from './m4-billing.js';
import { auditCredits, correctSettlement } from './billing-ops.js';
import { inputManifestHash } from './production-rule-pin.js';
import { createRunSupplementPreparationFixture, type RunSupplementBeforeClaim } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';
import { claim, checkpointStage, finish, renew } from './queue.js';
import { readRunBillingSegment } from './run-billing-segment.js';
import { debitAuthoringCredits } from './authoring-credit-debit.js';
import { readAuthoringProgress } from './authoring-progress.js';
import { attachInitialLegacyCreditPolicy } from './legacy-credit-policy-test-fixture.js';

const connection=await isolatedTestDatabase(undefined,'production-supplement-adoption');
const origin='http://bondbuddy.test';
type Kind='authoring'|'review'|'m4';
let priceSequence=0;
const ok=(response:{statusCode:number;body:string;json():any})=>{assert.equal(response.statusCode,200,response.body);return response.json();};
const raw=async(f:Fixture)=>(await f.pool.query('SELECT * FROM bb_runs WHERE id=$1',[f.runId])).rows[0];
async function prices(pool:Parameters<typeof publishPrices>[0],amount=1201){
  const id=uid();await publishPrices(pool,{id,prices:{...INITIAL_FIXED_PRICES,new_authoring:amount,full_review:amount,differential_review:amount},
    effectiveAt:new Date(Date.now()-86400000+(++priceSequence)*1000).toISOString(),actor:'synthetic',reason:'Isolated production supplement test price'});return id;
}
const paidSource=(kind:Kind):RunSupplementBeforeClaim=>async({pool,owner,projectId,runId,manifest})=>{
  const price=await prices(pool,1001);
  await transaction(pool,async db=>{
    await db.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE',[projectId]);
    const r=(await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
    await db.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[runId]);
    await grantCredits(db,{owner,points:50000,key:uid(),source:'existing_grant',expiresAt:null,actor:'synthetic',reason:'Private synthetic B1 wallet'});
    if(kind==='m4'){
      const hash=inputManifestHash(manifest),quote=await quoteM4(db,owner,manifest.topic_id,manifest.billing_task,hash,manifest);
      await reserveM4(db,owner,r,quote.quote.quote_id,manifest.topic_id,hash);
    }else{
      const id=uid(),intent=kind==='review'?digest(uid()):null;
      await db.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason,intent_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,1001,'Synthetic original paid source',$8)`,
      [id,owner,projectId,kind==='review'?manifest.draft_revision:r.input_revision,intent??r.input_hash,price,
        kind==='review'?manifest.review.operation:'new_authoring',intent]);
      const project=(await db.query('SELECT * FROM bb_projects WHERE id=$1',[projectId])).rows[0];
      if(kind==='authoring'){
        await db.query('UPDATE bb_projects SET draft_revision=$2 WHERE id=$1',[projectId,manifest.draft_revision]);
        project.draft_revision=manifest.draft_revision;
      }
      await reserveCredits(db,owner,r,id,{revision:r.input_revision,manifest},project,intent??undefined);
    }
  });
};
const legacySource=(policy:'on_delivery'|'authoring_progress_v1'):RunSupplementBeforeClaim=>async({pool,owner,projectId,runId,manifest})=>{
  const price=await prices(pool,1001),id=uid();
  await pool.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
    SELECT $1,owner_user_id,project_id,input_revision,input_hash,$2,'new_authoring',1001,'Synthetic first legacy fee' FROM bb_runs WHERE id=$3`,[id,price,runId]);
  await attachInitialLegacyCreditPolicy(pool,{owner,runId,quoteId:id,policy});
};
async function fixture(kind:Kind,paid=true,early=false,legacy?:'on_delivery'|'authoring_progress_v1'){
  const beforeClaim=legacy?legacySource(legacy):paid?paidSource(kind):undefined;
  if(kind==='authoring')return early?createRunSupplementPreparationFixture(connection!,{beforeClaim,earlyPause:'before_prompt'}):createRunSupplementPreparationFixture(connection!,{beforeClaim});
  return early?createRunSupplementFilePreparationFixture(connection!,kind,{beforeClaim,earlyPause:'before_prompt'}):createRunSupplementFilePreparationFixture(connection!,kind,{beforeClaim});
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function http(f:Fixture,owner=f.owner){
  const access=uid(),csrf=uid();
  await f.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),owner,digest(access),digest(uid()),digest(csrf)]);
  return (method:'GET'|'POST',url:string,payload?:unknown)=>f.app.inject({method,url,payload:payload as any,
    headers:{origin,cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf}});
}
async function close(f:Fixture){
  try{const r=await raw(f);if(!['succeeded','failed','cancelled','rejected'].includes(r.state)){const send=await http(f);ok(await send('POST',`/api/v1/runs/${f.runId}/cancel`,{reason:'synthetic cleanup'}));}}
  finally{await f.cleanup();}
}
async function quoted(f:Fixture){
  const send=await http(f),base=`/api/v1/runs/${f.runId}`;
  const response=ok(await send('POST',`${base}/supplement-quotes`,{request_id:uid(),supplement_revision:f.saved.revision,
    saved_request_id:f.saved.request_id,candidate_input_hash:f.saved.input_preview.candidate_input_hash}));
  const accepted=ok(await send('POST',`${base}/supplement-quotes/${response.quote.quote_id}/confirm`,{request_id:uid(),quote_hash:response.quote.quote_hash}));
  const request={request_id:uid(),quote_id:response.quote.quote_id,quote_hash:response.quote.quote_hash,confirmation_id:accepted.confirmation.confirmation_id};
  return {send,base,response,accepted,request,adopt:()=>send('POST',`${base}/supplement-adoptions`,request)};
}
async function account(f:Fixture){
  const result:Record<string,unknown>={};
  for(const name of ['bb_credit_reservations','bb_credit_events','bb_run_billing_segments','bb_run_execution_billing_bindings','bb_run_billing_progress'])
    result[name]=(await f.pool.query(`SELECT * FROM ${name} WHERE owner_user_id=$1 ORDER BY to_jsonb(${name})::text`,[f.owner])).rows;
  result.balance=await creditBalance(f.pool,f.owner);return result;
}
async function originalBytes(f:Fixture){return [...f.objects].map(([key,bytes])=>[key,digest(bytes)]).sort((a,b)=>a[0].localeCompare(b[0]));}

for(const kind of ['authoring','review','m4'] as const)test(`${kind}: public B1 adoption closes the original fee, starts an independent meter and refunds only failed rework`,
  {skip:!connection,timeout:120000},async()=>{
    const f=await fixture(kind);
    try{
      await prices(f.pool);
      const before=await raw(f),old=(await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[before.reservation_id])).rows[0];
      assert.ok(Number(old.charged_points)>0);const bytes=await originalBytes(f),prior=await account(f),q=await quoted(f);
      assert.ok(q.response.quote.total_points>0);assert.deepEqual(await account(f),prior,'confirmation alone cannot allocate or debit');
      assert.equal((await q.send('GET',`${q.base}/supplement-adoptions/current`)).statusCode,404);
      const receipt=ok(await q.adopt()).adoption;
      assert.deepEqual(ok(await q.send('GET',`${q.base}/supplement-adoptions/current`)).adoption,receipt,
        'a fresh browser can recover current adoption without its request journal');
      assert.equal(receipt.assignment_kind,'rework');assert.equal(receipt.run_id,f.runId);assert.equal(receipt.execution_version,2);
      assert.equal(receipt.additional_points,q.response.quote.total_points);assert.notEqual(receipt.reservation_id,old.id);
      const after=await raw(f);for(const field of ['input_revision','input_hash','reservation_id','billing_mode','execution_request_id'])assert.deepEqual(after[field],before[field]);
      const original=(await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[old.id])).rows[0];
      assert.equal(Number(original.charged_points),Number(old.charged_points));assert.equal(original.state,'settled');
      const fee=await readRunBillingSegment(f.pool,after);assert.ok(fee);assert.equal(fee.id,receipt.reservation_id);
      assert.equal(fee.points,q.response.quote.total_points);
      const currentCharge=ok(await q.send('GET',`${q.base}/credit-charge`));
      assert.equal(currentCharge.state,'held');assert.equal(currentCharge.progress.policy,'authoring_balance_v2');
      assert.equal(currentCharge.progress.charged_points,0);
      if(kind!=='m4'){
        assert.equal(currentCharge.quote.quote_id,receipt.quote_id);
        assert.equal(currentCharge.quote.points,receipt.additional_points);
        assert.equal(currentCharge.quote.input_revision,receipt.input_revision);
        assert.equal(currentCharge.quote.input_hash,receipt.input_hash);
      }
      const meter=(await f.pool.query('SELECT * FROM bb_run_billing_progress WHERE billing_segment_id=$1',[fee.id])).rows[0];
      assert.equal(Number(meter.active_ms),0);assert.equal(Number(meter.accrued_points),0);assert.equal(meter.work_bps,0);
      const adopted=await account(f);assert.deepEqual(ok(await q.adopt()).adoption,receipt);
      assert.deepEqual(ok(await q.send('GET',`${q.base}/supplement-adoptions?request_id=${q.request.request_id}`)).adoption,receipt);
      assert.deepEqual(await account(f),adopted,'lost-response recovery cannot requeue or reprice');
      if(kind==='authoring'){
        const foreign=uid();await f.pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[foreign,`foreign_${uid().replaceAll('-','').slice(0,20)}`]);
        const other=await http(f,foreign);
        assert.equal((await other('GET',`${q.base}/supplement-adoptions/current`)).statusCode,404);
        await assert.rejects(f.pool.query('UPDATE bb_credit_reservations SET state=\'held\' WHERE id=$1',[old.id]),{code:'23514'});
        await assert.rejects(f.pool.query('UPDATE bb_run_billing_progress SET accrued_points=accrued_points+1 WHERE billing_segment_id=$1',[old.id]),{code:'23514'});
        await assert.rejects(f.pool.query('DELETE FROM bb_run_supplement_adoptions WHERE id=$1',[receipt.adoption_id]),{code:'23514'});
        await assert.rejects(f.pool.query('DELETE FROM bb_run_billing_segment_closures WHERE billing_segment_id=$1',[old.id]),{code:'23514'});
      }
      for(const [key,hash] of bytes)assert.equal(digest(f.objects.get(key)!),hash,'original private history bytes survive');
      assert.equal((await auditCredits(f.pool)).consistent,true);
      const lease=await claim(f.pool,300,{runKinds:[kind==='authoring'?'update':kind==='review'?'review':'generation']});assert.ok(lease);assert.equal(lease.runId,f.runId);
      const balance=await creditBalance(f.pool,f.owner);
      await transaction(f.pool,async db=>{const r=(await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[f.runId])).rows[0];
        await db.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[f.runId]);await debitAuthoringCredits(db,r,17,lease);});
      assert.equal((await readAuthoringProgress(f.pool,f.owner,f.runId))!.charged_points,17);
      await finish(f.pool,lease,'failed',{errorCode:'DATA_UNAVAILABLE'});
      assert.deepEqual(await creditBalance(f.pool,f.owner),balance,'failure refunds exactly the new segment');
      assert.equal(Number((await f.pool.query('SELECT charged_points FROM bb_credit_reservations WHERE id=$1',[old.id])).rows[0].charged_points),Number(old.charged_points));
      const refunds=(await f.pool.query("SELECT * FROM bb_credit_events WHERE run_id=$1 AND kind='correction'",[f.runId])).rows;
      assert.ok(refunds.length>0);assert.ok(refunds.every(row=>row.reservation_id===fee.id));
      assert.equal((await auditCredits(f.pool)).consistent,true);
      await assert.rejects(correctSettlement(f.pool,{runId:f.runId,actor:'synthetic',reason:'ambiguous selection'}),{status:409});
      assert.deepEqual(ok(await q.adopt()).adoption,receipt,'terminal replay remains the original receipt');
      assert.deepEqual(ok(await q.send('GET',`${q.base}/supplement-adoptions/current`)).adoption,receipt,
        'current adoption receipt remains immutable after its execution terminates');
      const history=ok(await q.send('GET','/api/v1/credits/consumption-history')).items;
      assert.equal(history.length,2);assert.ok(history.find((row:any)=>row.reservation_id===fee.id).task_name.includes('补料续做'));
    }finally{await close(f);}
  });

for(const kind of ['authoring','review','m4'] as const)for(const paid of [true,false])test(`${kind}: genuine early pause ${paid?'carries the original fee':'stays unbilled'} with no additional charge`,
  {skip:!connection,timeout:120000},async()=>{
    const f=await fixture(kind,paid,true);
    try{
      const before=await raw(f),prior=await account(f),q=await quoted(f);assert.equal(q.response.quote.total_points,0);
      assert.equal((await q.send('GET',`${q.base}/supplement-adoptions/current`)).statusCode,404);
      const receipt=ok(await q.adopt()).adoption;assert.equal(receipt.assignment_kind,paid?'carry':'unbilled');
      assert.deepEqual(ok(await q.send('GET',`${q.base}/supplement-adoptions/current`)).adoption,receipt);
      assert.equal(receipt.additional_points,0);assert.equal(receipt.reservation_id,before.reservation_id);
      const after=await account(f);assert.deepEqual(after.bb_credit_reservations,prior.bb_credit_reservations);
      assert.deepEqual(after.bb_credit_events,prior.bb_credit_events);assert.deepEqual(after.balance,prior.balance);
      assert.deepEqual(after.bb_run_billing_segments,prior.bb_run_billing_segments);
      const selected=await readRunBillingSegment(f.pool,await raw(f));assert.equal(selected?.reservationId??null,before.reservation_id);
      const charge=ok(await q.send('GET',`${q.base}/credit-charge`));assert.equal(charge.state,paid?'held':null);
      assert.equal((await auditCredits(f.pool)).consistent,true);
      assert.deepEqual(ok(await q.adopt()).adoption,receipt);
    }finally{await close(f);}
  });

for(const policy of ['on_delivery','authoring_progress_v1'] as const)test(`${policy}: source retirement follows the original policy and rework failure never refunds the source`,
  {skip:!connection,timeout:120000},async()=>{
    const f=await fixture('authoring',true,false,policy);
    try{
      await prices(f.pool);
      const before=await raw(f),m=(await f.pool.query('SELECT * FROM bb_run_billing_progress WHERE billing_segment_id=$1',[before.reservation_id])).rows[0];
      const q=await quoted(f),receipt=ok(await q.adopt()).adoption;
      const old=(await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[before.reservation_id])).rows[0];
      assert.equal(Number(old.charged_points),policy==='on_delivery'?0:Number(m.accrued_points));
      assert.equal(old.state,policy==='on_delivery'?'released':'settled');
      const closed=await account(f),lease=await claim(f.pool,300,{runKinds:['update']});assert.ok(lease);
      await checkpointStage(f.pool,lease,'materials_ready',{synthetic:true});
      await finish(f.pool,lease,'failed',{errorCode:'DATA_UNAVAILABLE'});
      const retained=(await f.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[old.id])).rows[0];assert.deepEqual(retained,old);
      const refunds=(await f.pool.query("SELECT * FROM bb_credit_events WHERE run_id=$1 AND kind='correction'",[f.runId])).rows;
      assert.ok(refunds.every(row=>row.reservation_id===receipt.reservation_id));
      assert.deepEqual((await account(f)).balance,closed.balance);
      assert.equal((await auditCredits(f.pool)).consistent,true);
    }finally{await close(f);}
  });

test('a free production origin can accept positive B1 without minting a false original reservation',
  {skip:!connection,timeout:120000},async()=>{
    const f=await fixture('authoring',false);
    try{await prices(f.pool);const before=await raw(f),q=await quoted(f),receipt=ok(await q.adopt()).adoption;
      assert.equal(receipt.assignment_kind,'rework');const r=await raw(f);assert.equal(r.reservation_id,null);assert.equal(r.billing_mode,before.billing_mode);
      assert.equal((await readRunBillingSegment(f.pool,r))!.reservationId,receipt.reservation_id);assert.equal((await auditCredits(f.pool)).consistent,true);
      const currentCharge=ok(await q.send('GET',`${q.base}/credit-charge`));
      assert.equal(currentCharge.state,'held');assert.equal(currentCharge.quote.quote_id,receipt.quote_id);
      assert.equal(currentCharge.quote.points,receipt.additional_points);assert.equal(currentCharge.progress.policy,'authoring_balance_v2');
    }finally{await close(f);}
  });

test('an owned internal V1 run has no production adoption and stays readable by common desktop recovery',
  {skip:!connection,timeout:120000},async()=>{
    const previousTier=process.env.BB_DEPLOYMENT_TIER,previousChannel=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
    process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
    try{
      const f=await createRunSupplementPreparationFixture(connection!,{nonProduction:true,earlyPause:'before_prompt'});
      try{
        const send=await http(f),before=await account(f);
        assert.equal((await send('GET',`/api/v1/runs/${f.runId}/supplement-adoptions/current`)).statusCode,404);
        assert.deepEqual(await account(f),before);
      }finally{await close(f);}
    }finally{
      if(previousTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=previousTier;
      if(previousChannel===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=previousChannel;
    }
  });

test('wrong confirmation, insufficient funds, stale price and competing adoption cannot partially allocate or move the head',
  {skip:!connection,timeout:180000},async()=>{
    const f=await fixture('authoring');
    try{
      await prices(f.pool);const q=await quoted(f),before=await account(f);
      assert.equal((await q.send('POST',`${q.base}/supplement-adoptions`,{...q.request,confirmation_id:uid()})).statusCode,409);
      assert.deepEqual(await account(f),before);
      // Spend the remaining synthetic wallet through an independent granted lot
      // expiry, preserving every gross original fee/allocation/event.
      await f.pool.query("UPDATE bb_credit_lots SET expires_at=now()-interval '1 second' WHERE owner_user_id=$1",[f.owner]);
      const exhausted=await account(f);assert.equal((await q.adopt()).statusCode,402);assert.deepEqual(await account(f),exhausted);
      await transaction(f.pool,db=>grantCredits(db,{owner:f.owner,source:'existing_grant',key:uid(),points:50000,expiresAt:null,actor:'synthetic',reason:'Restore synthetic wallet'}));
      await prices(f.pool,1301);const stale=await account(f);assert.equal((await q.adopt()).statusCode,409);assert.deepEqual(await account(f),stale);
      const fresh=await quoted(f),results=await Promise.all([fresh.adopt(),fresh.send('POST',`${fresh.base}/supplement-adoptions`,{...fresh.request,request_id:uid()})]);
      assert.equal(results.filter(row=>row.statusCode===200).length,1);assert.equal(results.filter(row=>row.statusCode===409).length,1);
      assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_run_supplement_adoptions WHERE run_id=$1',[f.runId])).rows[0].n,1);
      assert.equal((await auditCredits(f.pool)).consistent,true);
    }finally{await close(f);}
  });
