import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {config,pgBase,runtime} from './config.mjs';
import {testClient} from './test-client.mjs';
import {syntheticPaymentProvider} from './provider.mjs';
import {advanceLocalSubscription,setLocalNextChargeOutcome} from './subscription-controls.mjs';
import {processDueSubscriptionRenewals,processDueSubscriptionCreditReleases} from '../../apps/api/dist/subscriptions.js';
import {auditCredits} from '../../apps/api/dist/billing-audit.js';

// Real HTTP purchases/mandates, real product scheduler and marker-verified local PG.
// The only injected fault throws before or after the synthetic channel persists its
// receipt. The script never writes product orders, dispatch flags, lots or journals.
const saved=config(),pool=new Pool({connectionString:pgBase+saved.database});
const startedAt=new Date().toISOString(),attempt=randomUUID(),checks=[],scenarios=[];
const record=name=>checks.push(name);
async function newMonthlyAccount(){
  const client=testClient(),identity=await client.register('billing_dispatch_');
  const checkout=await client.post('/api/v1/subscriptions',{request_id:randomUUID(),plan_id:'light',provider:'wechat',billing_cycle:'monthly'},201);
  await client.pay(checkout.order.order_id);
  await client.post(`/api/v1/subscriptions/${checkout.subscription.id}/auto-renew`,{request_id:randomUUID(),enabled:true});
  const authorized=await client.post(`/api/v1/subscriptions/${checkout.subscription.id}/auto-renew/refresh`);
  assert.equal(authorized.subscription.auto_renew,true);assert.equal(authorized.subscription.mandate_status,'active');
  return{client,...identity,subscriptionId:checkout.subscription.id};
}
async function snapshot(owner){
  const subscription=(await pool.query('SELECT id,status,auto_renew,mandate_status,current_period_end FROM bb_subscriptions WHERE owner_user_id=$1',[owner])).rows[0];
  const orders=(await pool.query(`SELECT o.id,o.state,o.amount_fen::text,p.automatic,p.payment_dispatch_started_at,c.state channel_state,c.mandate_id
    FROM bb_recharge_orders o JOIN bb_subscription_periods p ON p.order_id=o.id
    LEFT JOIN bb_local_billing_charges c ON c.order_id=o.id AND c.owner_user_id=o.owner_user_id
    WHERE o.owner_user_id=$1 ORDER BY p.cycle_index`,[owner])).rows;
  const ledger=(await pool.query(`SELECT count(*)::int lots,COALESCE(sum(remaining),0)::text remaining,
    COALESCE(sum(frozen),0)::text frozen FROM bb_credit_lots WHERE owner_user_id=$1`,[owner])).rows[0];
  const renewalFacts=(await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_local_billing_charges c JOIN bb_subscription_periods p ON p.order_id=c.order_id WHERE c.owner_user_id=$1 AND p.automatic) channel_charges,
    (SELECT count(*)::int FROM bb_credit_lots l JOIN bb_subscription_periods p ON l.source_key='recharge:'||p.order_id WHERE l.owner_user_id=$1 AND p.automatic) credit_lots`,[owner])).rows[0];
  const modelCalls=(await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n;
  return{subscription,orders,ledger,renewalFacts,modelCalls,auditConsistent:(await auditCredits(pool,owner)).consistent};
}
async function scenario(fault,{recoveryAllowed=true,pendingChannel=false,wrongQueryOrder=false}={}){
  const account=await newMonthlyAccount(),attempts=[],recoveries=[],queries=[],base=syntheticPaymentProvider(pool,saved);
  if(pendingChannel)await setLocalNextChargeOutcome(pool,account.owner,'pending');
  let faultInjected=false;
  const provider={...base,recurring:{...base.recurring,charge:async input=>{
    attempts.push({orderId:input.id,mandateId:input.mandateId});
    if(!faultInjected){
      faultInjected=true;
      if(fault==='after-channel-save')await base.recurring.charge(input);
      throw Error('Explicit synthetic '+fault+' dispatch interruption');
    }
    return base.recurring.charge(input);
  }}};
  const operation=randomUUID();
  await advanceLocalSubscription(pool,account.owner,operation,{processDueSubscriptionRenewals,processDueSubscriptionCreditReleases,providers:[provider]});
  const interrupted=await snapshot(account.owner),original=interrupted.orders.find(order=>order.automatic);
  assert.ok(faultInjected);assert.equal(attempts.length,1);assert.ok(original?.payment_dispatch_started_at);
  assert.equal(original.state,'pending');assert.equal(interrupted.ledger.remaining,'21000');
  assert.equal(original.channel_state,fault==='after-channel-save'?(pendingChannel?'pending':'paid'):null);
  record(fault+': durable original dispatch survives the injected interruption without granting a second month');
  // A fresh adapter and another production scheduler call model process restart.
  // Do not advance to another period or reuse any in-memory provider result.
  let releaseQueries;
  const concurrentQueries=new Promise(resolve=>{releaseQueries=resolve;});
  const reconstructed=()=>{
    const channel=syntheticPaymentProvider(pool,saved);
    if(!recoveryAllowed)delete channel.recurring.recoverSameRequest;
    else{
      const recover=channel.recurring.recoverSameRequest;
      if(recover)channel.recurring.recoverSameRequest=async input=>{recoveries.push({orderId:input.id,mandateId:input.mandateId});return recover(input);};
    }
    const query=channel.query;
    channel.query=async input=>{
      const receipt=await query(input);queries.push(input.id);
      // Force both schedulers to read the same interrupted original intent
      // before either can recover it; a mere Promise.all could run serially.
      if(queries.length<=2){if(queries.length===2)releaseQueries();await concurrentQueries;}
      return wrongQueryOrder?{...receipt,orderId:'f'.repeat(32)}:receipt;
    };
    return channel;
  };
  await Promise.all([processDueSubscriptionRenewals(pool,[reconstructed()],50,account.owner),
    processDueSubscriptionRenewals(pool,[reconstructed()],50,account.owner)]);
  const recovered=await snapshot(account.owner);
  await processDueSubscriptionRenewals(pool,[reconstructed()],50,account.owner);
  const replayed=await snapshot(account.owner);
  assert.deepEqual(replayed,recovered,'scheduler replay changes neither order identities nor balances');
  const automatic=recovered.orders.filter(order=>order.automatic),sameOriginal=automatic.length===1&&automatic[0].id===original.id;
  assert.ok(queries.length>=2&&queries.every(id=>id===original.id),'both schedulers query the same durable interrupted order');
  const expectedPaid=!pendingChannel&&!wrongQueryOrder&&(recoveryAllowed||fault==='after-channel-save');
  const expectedChannel=expectedPaid?'paid':pendingChannel?'pending':null;
  const recoveryBoundary=(recoveryAllowed&&!wrongQueryOrder)?true:recoveries.length===0;
  const originalRecoveryOnly=recoveries.every(input=>input.orderId===original.id&&input.mandateId===attempts[0].mandateId);
  const passed=sameOriginal&&automatic[0].state===(expectedPaid?'paid':'pending')&&automatic[0].channel_state===expectedChannel&&recovered.ledger.remaining===(expectedPaid?'42000':'21000')
    &&recovered.renewalFacts.channel_charges===(expectedChannel?1:0)&&recovered.renewalFacts.credit_lots===(expectedPaid?1:0)
    &&recovered.ledger.frozen==='0'&&recovered.auditConsistent&&recovered.modelCalls===0&&recoveryBoundary&&originalRecoveryOnly;
  scenarios.push({fault,recoveryAllowed,pendingChannel,wrongQueryOrder,username:account.username,owner:account.owner,subscriptionId:account.subscriptionId,operation,
    faultInjected,dispatchAttempts:attempts,queryAttempts:queries,recoveryAttempts:recoveries,interrupted,recovered,replayed,passed});
  if(passed)record(fault+(wrongQueryOrder?': wrong-order query is rejected before any recovery':pendingChannel?': persisted channel pending remains pending with one channel fact and no credit':recoveryAllowed?': concurrent reconstructed schedulers recover the same authorised order once':': a channel without an explicit same-request guarantee is never charged again'));
  // Stop these random test mandates through the real product API after capture;
  // the listening service's later timer must not advance an unfinished fixture.
  await account.client.post(`/api/v1/subscriptions/${account.subscriptionId}/auto-renew`,{request_id:randomUUID(),enabled:false});
}
let failure;
try{
  assert.deepEqual((await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows,[{database:saved.database,instance_id:saved.id}]);
  await scenario('before-channel-save');
  await scenario('after-channel-save');
  await scenario('before-channel-save',{recoveryAllowed:false});
  await scenario('after-channel-save',{pendingChannel:true});
  await scenario('before-channel-save',{wrongQueryOrder:true});
  assert.ok(scenarios.every(result=>result.passed),'an interrupted authorised renewal did not recover its original order exactly once');
}catch(error){failure=error;}
finally{
  const proof={synthetic:true,explicitFaultInjection:true,realHttp:true,realPostgres:true,realProductScheduler:true,
    realPaymentCallsPerformed:0,modelCallsPerformed:0,startedAt,finishedAt:new Date().toISOString(),attempt,checks,scenarios,
    passed:checks.length,failed:failure?1:0,skipped:0,...(failure?{error:String(failure),stack:failure.stack}:{})};
  await mkdir(runtime,{recursive:true});
  const evidence=join(runtime,'subscription-dispatch-recovery-'+startedAt.replace(/[:.]/g,'-')+'-'+attempt+'.json');
  await writeFile(evidence,JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify({...proof,evidence}));await pool.end();
}
if(failure)throw failure;
