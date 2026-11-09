// Only serve.mjs imports these loopback/owner/CSRF-protected simulation controls.
// Channel controls save synthetic facts; only product APIs write the actual ledger.
import {baseURL} from './config.mjs';
const prefix='/__billing-test/api/';
const identifier={type:'string',pattern:'^[a-f0-9]{32}$'};
const uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const schema=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const delivery={type:'string',enum:['query','callback']};
const fail=(statusCode,code,message)=>Object.assign(new Error(message),{statusCode,code});
const merchant=saved=>'synthetic-billing-functional-'+saved.id;

export async function paymentState(pool,user,saved){
  const rows=(await pool.query(`SELECT o.id,o.state,o.amount_fen::text,o.points::text,o.order_kind,o.created_at,
      COALESCE(p.automatic,false) automatic,c.state channel_state
    FROM bb_recharge_orders o LEFT JOIN bb_subscription_periods p ON p.order_id=o.id
    LEFT JOIN bb_local_billing_charges c ON c.order_id=o.id AND c.owner_user_id=o.owner_user_id
    WHERE o.owner_user_id=$1 AND o.merchant_id=$2 ORDER BY o.created_at DESC,o.id DESC LIMIT 50`,[user,merchant(saved)])).rows;
  const {paymentRefundEligibility}=await import('../../apps/api/dist/payment-refunds.js');
  // Use the product's exact eligibility rules, including consumed/held rights and subscriptions.
  const configured={name:'wechat',merchantId:merchant(saved),refunds:{}};
  const payments=[];
  for(const row of rows)payments.push({...row,refundable:await paymentRefundEligibility(pool,user,row.id,[configured])});
  const refunds=(await pool.query(`SELECT r.id,r.order_id,r.request_id,r.state,r.amount_fen::text,r.credit_points::text,r.created_at,
      c.state channel_state FROM bb_payment_refunds r
    LEFT JOIN bb_local_billing_refunds c ON c.refund_id=r.id AND c.owner_user_id=r.owner_user_id
    WHERE r.owner_user_id=$1 AND r.merchant_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,[user,merchant(saved)])).rows;
  return{payments,refunds};
}

export function installPaymentControls(app,{pool,saved,provider,owner,serial,product,state,origin=baseURL}){
  if(provider.merchantId!==merchant(saved)||!provider.synthetic)throw Error('Local simulation provider identity mismatch');
  async function payment(user,id){
    const row=(await pool.query('SELECT id FROM bb_recharge_orders WHERE id=$1 AND owner_user_id=$2 AND merchant_id=$3',[id,user,provider.merchantId])).rows[0];
    if(!row)throw fail(404,'NOT_FOUND','模拟订单不存在或不属于当前账号。');
  }
  async function refund(user,id){
    const row=(await pool.query('SELECT id FROM bb_payment_refunds WHERE id=$1 AND owner_user_id=$2 AND merchant_id=$3',[id,user,provider.merchantId])).rows[0];
    if(!row)throw fail(404,'NOT_FOUND','模拟退款不存在或不属于当前账号。');
  }
  function route(path,body,work){
    app.post(prefix+path,{schema:{body}},async request=>{
      const user=await owner(request);
      return serial(async()=>{
        try{await work(request,user,request.body);return await state(user);}
        catch(error){
          // The product error handler intentionally hides arbitrary Error fields.
          // Convert only our explicit local control errors to its normal Problem.
          if(Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<=599&&typeof error.code==='string'){
            const {Problem}=await import('../../apps/api/dist/data.js');
            throw new Problem(error.statusCode,error.code,error.message);
          }
          throw error;
        }
      });
    });
  }
  async function deliverCallback(kind,value){
    const envelope=await provider.synthetic.callback(kind,value);
    // Exercise the product's raw-body parser, signature verification and normal
    // applyVerifiedPayment/applyVerifiedRefund transaction, without an external socket.
    const response=await app.inject({method:'POST',url:`/api/v1/payments/${provider.name}/${kind==='payment'?'callback':'refund-callback'}`,
      remoteAddress:'127.0.0.1',headers:{host:new URL(origin).host,
        'content-type':'application/json',...envelope.headers},payload:envelope.body});
    if(response.statusCode>=400){
      let detail;try{detail=response.json();}catch{}
      throw fail(response.statusCode,detail?.code??'PAYMENT_INVALID',detail?.message??'模拟回调处理失败，请保留原单并重试。');
    }
  }
  route('payment/outcome',schema({id:identifier,outcome:{type:'string',enum:['paid','failed']},delivery}),async(_request,user,input)=>{
    const receipt=await provider.synthetic.paymentOutcome(user,input.id,input.outcome);
    // Query delivery deliberately leaves a channel-success/product-pending gap.
    // The explicit refresh action proves authenticated query recovery and once-only crediting.
    if(input.delivery==='callback')await deliverCallback('payment',receipt);
  });
  route('payment/refresh',schema({id:identifier}),async(request,user,input)=>{
    await payment(user,input.id);await product(request,'POST',`/api/v1/commerce/topups/${input.id}/refresh`,{});
  });
  route('payment/close',schema({id:identifier}),async(request,user,input)=>{
    await payment(user,input.id);await product(request,'POST',`/api/v1/credits/recharge-orders/${input.id}/close`,{});
  });
  route('refund/request',schema({id:identifier,amount_fen:{type:'string',pattern:'^[1-9][0-9]{0,6}$'},request_id:uuid}),async(request,user,input)=>{
    await payment(user,input.id);
    const amount=BigInt(input.amount_fen);
    if(amount>1078920n)throw fail(422,'VALIDATION_FAILED','模拟退款金额超出产品支持范围。');
    await product(request,'POST',`/api/v1/commerce/topups/${input.id}/refunds`,{request_id:input.request_id,amount_fen:input.amount_fen});
  });
  route('refund/outcome',schema({id:identifier,outcome:{type:'string',enum:['succeeded','failed']},delivery}),async(_request,user,input)=>{
    const receipt=await provider.synthetic.refundOutcome(user,input.id,input.outcome);
    if(input.delivery==='callback')await deliverCallback('refund',receipt);
  });
  route('refund/refresh',schema({id:identifier}),async(request,user,input)=>{
    await refund(user,input.id);await product(request,'POST',`/api/v1/commerce/refunds/${input.id}/refresh`,{});
  });
}
