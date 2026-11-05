import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

// Local-only synthetic channel state. Product orders, contracts and wallets are
// never edited here: authenticated product handlers consume these receipts.
async function transaction(pool,work){const c=await pool.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
const same=(a,b)=>String(a)===String(b),required=(condition,message)=>{if(!condition)throw Error('Synthetic provider: '+message);};
const instant=value=>new Date(value).toISOString();
const controlError=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode,code:statusCode===404?'NOT_FOUND':'INPUT_REVISION_CONFLICT'});

/** Domain separation prevents a signed payment from becoming a signed refund. */
export function callbackAuthenticator(secret){
  required(typeof secret==='string'&&/^[a-f0-9]{64}$/.test(secret),'invalid callback key');
  const signature=(kind,body)=>{required(['payment','refund'].includes(kind)&&typeof body==='string'&&Buffer.byteLength(body)<=65536,'invalid callback envelope');return createHmac('sha256',secret).update(kind+'\n'+body).digest('hex');};
  return {
    sign:(kind,body)=>({'x-bb-synthetic-signature':signature(kind,body)}),
    verify:(kind,headers,body)=>{
      const received=headers['x-bb-synthetic-signature'];
      required(typeof received==='string'&&/^[a-f0-9]{64}$/.test(received),'invalid callback signature');
      required(timingSafeEqual(Buffer.from(received,'hex'),Buffer.from(signature(kind,body),'hex')),'invalid callback signature');
      return JSON.parse(body);
    }
  };
}

/** A terminal channel outcome is immutable; repeating it is a safe replay. */
export function paymentTransition(current,outcome){
  if(!['pending','paid','failed','expired'].includes(current)||!['paid','failed','expired'].includes(outcome))throw controlError('Unknown simulated payment state');
  if(current!=='pending'&&current!==outcome)throw controlError('该模拟订单已有终态，请沿用原结果或新建订单。');
  return outcome;
}
export function refundTransition(current,outcome){
  if(!['processing','succeeded','failed'].includes(current)||!['succeeded','failed'].includes(outcome))throw controlError('Unknown simulated refund state');
  if(current!=='processing'&&current!==outcome)throw controlError('该模拟退款已有终态，请沿用原结果或新建退款申请。');
  return outcome;
}

export async function installLocalProviderState(pool,saved){
  required(/^bb_billing_functional_[a-f0-9]{16}$/.test(saved.database),'invalid local database name');
  required(/^[-a-f0-9]{36}$/.test(saved.id),'invalid instance ID');
  const actual=(await pool.query('SELECT current_database() database,instance_id FROM bb_local_billing_instance')).rows;
  required(actual.length===1&&actual[0].database===saved.database&&actual[0].instance_id===saved.id,'isolated database marker mismatch');
  await transaction(pool,async c=>{
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_mandates(
      request_id text PRIMARY KEY,owner_user_id text NOT NULL REFERENCES bb_users(id),subscription_id text NOT NULL REFERENCES bb_subscriptions(id),
      merchant_id text NOT NULL,amount_fen bigint NOT NULL CHECK(amount_fen>0),currency text NOT NULL CHECK(currency='CNY'),
      interval text NOT NULL CHECK(interval IN ('month','year')),mandate_id text NOT NULL UNIQUE,
      state text NOT NULL CHECK(state IN ('pending','active','cancelled')),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_charges(
      order_id text PRIMARY KEY REFERENCES bb_recharge_orders(id),owner_user_id text NOT NULL REFERENCES bb_users(id),merchant_id text NOT NULL,
      amount_fen bigint NOT NULL CHECK(amount_fen>0),currency text NOT NULL CHECK(currency='CNY'),mandate_id text REFERENCES bb_local_billing_mandates(mandate_id),
      automatic boolean NOT NULL,state text NOT NULL CHECK(state IN ('pending','paid','failed')),transaction_id text NOT NULL UNIQUE,
      paid_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    // Upgrade only this marker-verified local table; never alter product migrations.
    await c.query('ALTER TABLE bb_local_billing_charges DROP CONSTRAINT IF EXISTS bb_local_billing_charges_state_check');
    await c.query("ALTER TABLE bb_local_billing_charges ADD CONSTRAINT bb_local_billing_charges_state_check CHECK(state IN ('pending','paid','failed','expired'))");
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_callback_keys(instance_id text PRIMARY KEY,secret text NOT NULL CHECK(secret ~ '^[a-f0-9]{64}$'))`);
    await c.query('INSERT INTO bb_local_billing_callback_keys(instance_id,secret) VALUES($1,$2) ON CONFLICT(instance_id) DO NOTHING',[saved.id,randomBytes(32).toString('hex')]);
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_refunds(
      refund_id text PRIMARY KEY REFERENCES bb_payment_refunds(id),order_id text NOT NULL REFERENCES bb_recharge_orders(id),
      owner_user_id text NOT NULL REFERENCES bb_users(id),merchant_id text NOT NULL,transaction_id text NOT NULL,
      provider_refund_id text NOT NULL UNIQUE,order_amount_fen bigint NOT NULL CHECK(order_amount_fen>0),amount_fen bigint NOT NULL CHECK(amount_fen>0),
      currency text NOT NULL CHECK(currency='CNY'),state text NOT NULL CHECK(state IN ('processing','succeeded','failed')),
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),succeeded_at timestamptz)`);
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_clock(owner_user_id text PRIMARY KEY REFERENCES bb_users(id),
      now_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_controls(owner_user_id text PRIMARY KEY REFERENCES bb_users(id),
      next_charge_outcome text NOT NULL DEFAULT 'paid' CHECK(next_charge_outcome IN ('paid','pending','failed')),updated_at timestamptz NOT NULL DEFAULT now())`);
    await c.query(`CREATE TABLE IF NOT EXISTS bb_local_billing_advances(owner_user_id text NOT NULL REFERENCES bb_users(id),request_id text NOT NULL,
      target_at timestamptz NOT NULL,event_kind text NOT NULL CHECK(event_kind IN ('renewal','release')),created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner_user_id,request_id))`);
    required((await c.query("SELECT to_regprocedure('bb_subscription_clock(text)') present")).rows[0].present,'apply current subscription migration before starting');
    // Only this strictly identified local DB receives the override. Production
    // migrations use the real clock truncated to JS Date precision; no HTTP
    // input supplies SQL or changes another account's clock.
    await c.query(`CREATE OR REPLACE FUNCTION bb_subscription_clock(p_owner text) RETURNS timestamptz
      LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT now_at FROM bb_local_billing_clock WHERE owner_user_id=$1),date_trunc('milliseconds',now())) $$`);
  });
}

export function syntheticPaymentProvider(pool,saved){
  const merchantId='synthetic-billing-functional-'+saved.id;
  async function order(c,input){
    const row=(await c.query(`SELECT o.*,p.automatic,p.subscription_id FROM bb_recharge_orders o
      LEFT JOIN bb_subscription_periods p ON p.order_id=o.id WHERE o.id=$1 FOR UPDATE OF o`,[input.id])).rows[0];
    required(row&&row.merchant_id===merchantId&&input.merchant_id===merchantId&&same(row.amount_fen,input.amount_fen)&&row.currency===input.currency,'order identity or amount mismatch');return row;
  }
  async function savedCharge(c,row,mandateId=null,create=true){
    let charge=(await c.query('SELECT * FROM bb_local_billing_charges WHERE order_id=$1 FOR UPDATE',[row.id])).rows[0];
    if(!charge&&!create)return null;
    if(!charge){
      charge=(await c.query(`INSERT INTO bb_local_billing_charges(order_id,owner_user_id,merchant_id,amount_fen,currency,mandate_id,automatic,state,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING *`,[row.id,row.owner_user_id,merchantId,row.amount_fen,row.currency,mandateId,!!row.automatic,'synthetic-'+row.id])).rows[0];
    }
    required(charge.owner_user_id===row.owner_user_id&&same(charge.amount_fen,row.amount_fen)&&charge.merchant_id===merchantId&&charge.automatic===!!row.automatic&&(!mandateId||charge.mandate_id===mandateId),'stored charge mismatch');return charge;
  }
  const receipt=charge=>({orderId:charge.order_id,merchantId:charge.merchant_id,amountFen:Number(charge.amount_fen),currency:charge.currency,state:charge.state,
    transactionId:charge.state==='paid'?charge.transaction_id:null,...(charge.state==='paid'?{payerCash:{amountFen:Number(charge.amount_fen),currency:charge.currency},...(charge.paid_at?{paidAt:instant(charge.paid_at)}:{})}:{})});
  async function result(c,charge,outcome){
    if(charge.state!=='pending')return charge;
    return(await c.query(`UPDATE bb_local_billing_charges SET state=$2,paid_at=CASE WHEN $2='paid' THEN now() ELSE NULL END,updated_at=now()
      WHERE order_id=$1 RETURNING *`,[charge.order_id,outcome])).rows[0];
  }
  async function takeOutcome(c,owner){
    const control=(await c.query('SELECT next_charge_outcome FROM bb_local_billing_controls WHERE owner_user_id=$1 FOR UPDATE',[owner])).rows[0];
    if(control)await c.query("UPDATE bb_local_billing_controls SET next_charge_outcome='paid',updated_at=now() WHERE owner_user_id=$1",[owner]);
    return control?.next_charge_outcome??'paid';
  }
  async function getMandate(c,input){
    const row=(await c.query('SELECT * FROM bb_local_billing_mandates WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
    required(row&&row.subscription_id===input.subscriptionId&&row.merchant_id===merchantId&&input.merchantId===merchantId&&same(row.amount_fen,input.amountFen)&&row.currency===input.currency&&row.interval===input.interval&&(!input.mandateId||row.mandate_id===input.mandateId),'mandate identity, amount or interval mismatch');return row;
  }
  const mandateReceipt=row=>({requestId:row.request_id,subscriptionId:row.subscription_id,merchantId:row.merchant_id,amountFen:Number(row.amount_fen),currency:row.currency,interval:row.interval,mandateId:row.mandate_id,state:row.state});
  async function authenticator(){
    const key=(await pool.query('SELECT secret FROM bb_local_billing_callback_keys WHERE instance_id=$1',[saved.id])).rows[0];
    required(key,'missing local callback key');return callbackAuthenticator(key.secret);
  }
  async function paymentOutcome(owner,id,outcome){
    if(!['paid','failed'].includes(outcome))throw controlError('Unknown simulated payment outcome');
    return transaction(pool,async c=>{
      const row=(await c.query(`SELECT o.*,p.automatic,p.subscription_id FROM bb_recharge_orders o
        LEFT JOIN bb_subscription_periods p ON p.order_id=o.id WHERE o.id=$1 AND o.owner_user_id=$2 FOR UPDATE OF o`,[id,owner])).rows[0];
      if(!row||row.merchant_id!==merchantId)throw controlError('模拟订单不存在或不属于当前账号。',404);
      if(row.automatic)throw controlError('自动续费订单请使用订阅续费测试控制，不能模拟交互付款。');
      const charge=await savedCharge(c,row);
      if(row.close_requested_at&&charge.state!=='paid')throw controlError('原订单已请求关闭，不能再模拟付款。');
      paymentTransition(charge.state,outcome);
      return receipt(await result(c,charge,outcome));
    });
  }
  async function refund(c,input,create=false){
    const row=(await c.query('SELECT * FROM bb_payment_refunds WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
    required(row&&row.merchant_id===merchantId&&input.merchant_id===merchantId&&row.order_id===input.order_id&&row.provider_txn_id===input.provider_transaction_id&&
      same(row.order_amount_fen,input.order_amount_fen)&&same(row.amount_fen,input.amount_fen)&&row.currency===input.currency,'refund identity or amount mismatch');
    let stored=(await c.query('SELECT * FROM bb_local_billing_refunds WHERE refund_id=$1 FOR UPDATE',[row.id])).rows[0];
    if(!stored&&create){
      const charge=(await c.query('SELECT * FROM bb_local_billing_charges WHERE order_id=$1',[row.order_id])).rows[0];
      required(charge&&charge.state==='paid'&&charge.transaction_id===row.provider_txn_id&&charge.owner_user_id===row.owner_user_id,'refund has no matching simulated payment');
      stored=(await c.query(`INSERT INTO bb_local_billing_refunds(refund_id,order_id,owner_user_id,merchant_id,transaction_id,provider_refund_id,order_amount_fen,amount_fen,currency,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing') RETURNING *`,[row.id,row.order_id,row.owner_user_id,merchantId,row.provider_txn_id,'synthetic-refund-'+row.id,row.order_amount_fen,row.amount_fen,row.currency])).rows[0];
    }
    required(stored&&stored.owner_user_id===row.owner_user_id&&stored.order_id===row.order_id&&stored.merchant_id===merchantId&&stored.transaction_id===row.provider_txn_id&&
      same(stored.order_amount_fen,row.order_amount_fen)&&same(stored.amount_fen,row.amount_fen)&&stored.currency===row.currency,'unknown or mismatched simulated refund');
    return stored;
  }
  const refundReceipt=row=>({refundId:row.refund_id,orderId:row.order_id,merchantId:row.merchant_id,transactionId:row.transaction_id,providerRefundId:row.provider_refund_id,
    currency:row.currency,orderAmountFen:Number(row.order_amount_fen),amountFen:Number(row.amount_fen),payerTotalFen:Number(row.order_amount_fen),payerRefundFen:Number(row.amount_fen),
    state:row.state,...(row.state==='failed'?{failureCode:'CLOSED'}:{}),providerCreatedAt:instant(row.created_at),...(row.succeeded_at?{providerSucceededAt:instant(row.succeeded_at)}:{})});
  async function refundOutcome(owner,id,outcome){
    return transaction(pool,async c=>{
      const row=(await c.query('SELECT * FROM bb_local_billing_refunds WHERE refund_id=$1 AND owner_user_id=$2 FOR UPDATE',[id,owner])).rows[0];
      if(!row||row.merchant_id!==merchantId)throw controlError('模拟退款不存在或不属于当前账号。',404);
      refundTransition(row.state,outcome);
      if(row.state===outcome)return refundReceipt(row);
      return refundReceipt((await c.query(`UPDATE bb_local_billing_refunds SET state=$2,succeeded_at=CASE WHEN $2='succeeded' THEN now() ELSE NULL END,updated_at=now()
        WHERE refund_id=$1 RETURNING *`,[id,outcome])).rows[0]);
    });
  }
  async function callback(kind,value){const body=JSON.stringify(value);return{body,headers:(await authenticator()).sign(kind,body)};}
  async function verifyPaymentCallback(headers,raw){
    const value=(await authenticator()).verify('payment',headers,raw);
    const row=(await pool.query('SELECT * FROM bb_local_billing_charges WHERE order_id=$1 AND merchant_id=$2',[value?.orderId,merchantId])).rows[0];
    required(row&&JSON.stringify(receipt(row))===JSON.stringify(value),'callback differs from persisted simulated payment');return receipt(row);
  }
  async function verifyRefundCallback(headers,raw){
    const value=(await authenticator()).verify('refund',headers,raw);
    const row=(await pool.query('SELECT * FROM bb_local_billing_refunds WHERE refund_id=$1 AND merchant_id=$2',[value?.refundId,merchantId])).rows[0];
    required(row&&JSON.stringify(refundReceipt(row))===JSON.stringify(value),'callback differs from persisted simulated refund');return refundReceipt(row);
  }
  return {name:'wechat',merchantId,acknowledgement:{code:'SUCCESS'},
    create:async input=>transaction(pool,async c=>{const row=await order(c,input);required(!row.automatic,'automatic order must use charge');await savedCharge(c,row);return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-local-'+row.id};}),
    // A query reports the saved channel fact. Refreshing a product page is not payment.
    query:async input=>transaction(pool,async c=>{
      const row=await order(c,input),charge=await savedCharge(c,row,null,!row.automatic);
      // An automatic intent can be visible before its mandate dispatch. A
      // read must not create a charge without that dispatch's mandate identity.
      return charge?receipt(charge):{orderId:row.id,merchantId,amountFen:Number(row.amount_fen),currency:row.currency,state:'pending',transactionId:null};
    }),
    closePayment:async input=>transaction(pool,async c=>{const charge=await savedCharge(c,await order(c,input));return receipt(charge.state==='pending'?await result(c,charge,'expired'):charge);}),
    verifyCallback:verifyPaymentCallback,
    refunds:{create:async input=>transaction(pool,async c=>refundReceipt(await refund(c,input,true))),
      query:async input=>transaction(pool,async c=>refundReceipt(await refund(c,input))),
      recoverSameRequest:async input=>transaction(pool,async c=>refundReceipt(await refund(c,input,true))),verifyCallback:verifyRefundCallback},
    // This extra seam is imported only by the local harness, never production configuration.
    synthetic:{paymentOutcome,refundOutcome,callback},
    recurring:{
      createMandate:async input=>transaction(pool,async c=>{
        const s=(await c.query('SELECT * FROM bb_subscriptions WHERE id=$1',[input.subscriptionId])).rows[0];
        required(s&&s.merchant_id===merchantId&&input.merchantId===merchantId&&s.mandate_request_id===input.requestId&&input.currency==='CNY'&&['month','year'].includes(input.interval)&&Number.isSafeInteger(input.amountFen)&&input.amountFen>0,'unknown mandate request');
        await c.query(`INSERT INTO bb_local_billing_mandates(request_id,owner_user_id,subscription_id,merchant_id,amount_fen,currency,interval,mandate_id,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT(request_id) DO NOTHING`,[input.requestId,s.owner_user_id,s.id,merchantId,input.amountFen,input.currency,input.interval,'synthetic-mandate-'+input.requestId]);
        // Preserve the production HTTPS requirement. The local Vite harness
        // replaces this reserved-domain link with its account route and handles
        // clicks through the real "refresh mandate" button; no network follows it.
        await getMandate(c,input);return{authorizationUrl:'https://billing-functional.invalid/mandates/'+encodeURIComponent(input.requestId)};
      }),
      queryMandate:async input=>transaction(pool,async c=>{let row=await getMandate(c,input);if(row.state==='pending')row=(await c.query("UPDATE bb_local_billing_mandates SET state='active',updated_at=now() WHERE request_id=$1 RETURNING *",[row.request_id])).rows[0];return mandateReceipt(row);}),
      cancelMandate:async input=>transaction(pool,async c=>{const row=await getMandate(c,input);return mandateReceipt((await c.query("UPDATE bb_local_billing_mandates SET state='cancelled',updated_at=now() WHERE request_id=$1 RETURNING *",[row.request_id])).rows[0]);}),
      charge:async input=>transaction(pool,async c=>{
        const row=await order(c,input),old=(await c.query('SELECT * FROM bb_local_billing_charges WHERE order_id=$1 FOR UPDATE',[row.id])).rows[0];
        if(old){required(old.mandate_id===input.mandateId&&old.automatic,'charge replay mismatch');return receipt(old);}
        const mandate=(await c.query('SELECT * FROM bb_local_billing_mandates WHERE mandate_id=$1 FOR UPDATE',[input.mandateId])).rows[0];
        required(row.automatic&&mandate&&mandate.state==='active'&&mandate.subscription_id===row.subscription_id&&mandate.owner_user_id===row.owner_user_id&&same(mandate.amount_fen,row.amount_fen),'inactive or mismatched recurring mandate');
        const charge=await savedCharge(c,row,mandate.mandate_id);return receipt(await result(c,charge,await takeOutcome(c,row.owner_user_id)));
      })
    }
  };
}
