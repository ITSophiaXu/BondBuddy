// Local-only synthetic channel state. Product orders, contracts and wallets are
// never edited here: authenticated product handlers consume these receipts.
async function transaction(pool,work){const c=await pool.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
const same=(a,b)=>String(a)===String(b),required=(condition,message)=>{if(!condition)throw Error('Synthetic provider: '+message);};

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
      LEFT JOIN bb_subscription_periods p ON p.order_id=o.id WHERE o.id=$1`,[input.id])).rows[0];
    required(row&&row.merchant_id===merchantId&&input.merchant_id===merchantId&&same(row.amount_fen,input.amount_fen)&&row.currency===input.currency,'order identity or amount mismatch');return row;
  }
  async function savedCharge(c,row,mandateId=null){
    let charge=(await c.query('SELECT * FROM bb_local_billing_charges WHERE order_id=$1 FOR UPDATE',[row.id])).rows[0];
    if(!charge){
      charge=(await c.query(`INSERT INTO bb_local_billing_charges(order_id,owner_user_id,merchant_id,amount_fen,currency,mandate_id,automatic,state,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING *`,[row.id,row.owner_user_id,merchantId,row.amount_fen,row.currency,mandateId,!!row.automatic,'synthetic-'+row.id])).rows[0];
    }
    required(charge.owner_user_id===row.owner_user_id&&same(charge.amount_fen,row.amount_fen)&&charge.merchant_id===merchantId&&charge.automatic===!!row.automatic&&(!mandateId||charge.mandate_id===mandateId),'stored charge mismatch');return charge;
  }
  const receipt=charge=>({orderId:charge.order_id,merchantId:charge.merchant_id,amountFen:Number(charge.amount_fen),currency:charge.currency,state:charge.state,
    transactionId:charge.state==='paid'?charge.transaction_id:null,...(charge.state==='paid'?{payerCash:{amountFen:Number(charge.amount_fen),currency:charge.currency}}:{})});
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
  return {name:'wechat',merchantId,acknowledgement:{code:'SUCCESS'},
    create:async input=>transaction(pool,async c=>{const row=await order(c,input);required(!row.automatic,'automatic order must use charge');await savedCharge(c,row);return{checkoutUrl:'weixin://wxpay/bizpayurl?pr=synthetic-local-'+row.id};}),
    query:async input=>transaction(pool,async c=>{const row=await order(c,input),charge=await savedCharge(c,row);
      // Explicit payment refresh simulates manual payment. Automatic orders may
      // only report their persisted channel result; query never starts a charge.
      return receipt(!row.automatic&&charge.state==='pending'?await result(c,charge,await takeOutcome(c,row.owner_user_id)):charge);}),
    verifyCallback:async()=>{throw Error('No external callbacks are accepted by this synthetic provider');},
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
