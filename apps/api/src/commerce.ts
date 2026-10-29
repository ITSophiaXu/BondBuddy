import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import type {Static} from '@sinclair/typebox';
import {COMMERCE_RULES,OUTCOME_CATALOG,OUTCOME_PRICE_VERSION,automaticTaskTariff,AUTOMATIC_BILLING_RULES,AUTOMATIC_PRICE_VERSION,schemas,type CommerceTopup} from '@bondbuddy/contracts';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
import {creditBalance} from './billing.js';
import {createServiceTopup,rechargeDto,refreshRecharge,type PaymentProvider} from './payments.js';
import {digest,missing,Problem,transaction,uid} from './data.js';
import {readScopeQuotations,readScopeQuotation,declineScopeQuotation,requoteScopeQuotation} from './scope-quotations.js';

export function installCommerce(app:FastifyInstance,pool:Pool,owner:(r:FastifyRequest)=>Promise<string>,enabled:boolean,providers:readonly PaymentProvider[]){
  app.get('/api/v1/commerce/quotations',{schema:{response:{200:schemas.CommerceScopeQuotationsResponse}}},async(r,reply)=>{
    reply.header('cache-control','private, no-store');return readScopeQuotations(pool,await owner(r));
  });
  app.get('/api/v1/commerce/quotations/:quotation_id',{schema:{response:{200:schemas.CommerceScopeQuotationResponse}}},async(r,reply)=>{
    reply.header('cache-control','private, no-store');return readScopeQuotation(pool,await owner(r),(r.params as {quotation_id:string}).quotation_id);
  });
  app.post('/api/v1/commerce/quotations/:quotation_id/decline',{schema:{body:schemas.CommerceScopeDeclineRequest,response:{200:schemas.CommerceScopeQuotationResponse}}},async r=>declineScopeQuotation(pool,await owner(r),(r.params as {quotation_id:string}).quotation_id,r.body as Static<typeof schemas.CommerceScopeDeclineRequest>));
  app.post('/api/v1/commerce/quotations/:quotation_id/requote',{schema:{body:schemas.CommerceScopeRequoteRequest,response:{200:schemas.CommerceScopeQuotationResponse}}},async r=>requoteScopeQuotation(pool,await owner(r),(r.params as {quotation_id:string}).quotation_id,r.body as Static<typeof schemas.CommerceScopeRequoteRequest>));
  app.get('/api/v1/commerce/catalog',{schema:{response:{200:schemas.CommerceCatalogResponse}}},async(r,reply)=>{
    const user=await owner(r);reply.header('cache-control','private, no-store');
    if(automaticBillingEnabled(pool)){
      const version=await resolveAutomaticTaskPriceVersion(pool,user);
      return{enabled:true,currency:'CNY',version,model:'subscription_and_topup',
      items:Object.entries(automaticTaskTariff(version)).map(([code,item])=>({code,label:item.label+(code==='full_review'&&version!==AUTOMATIC_PRICE_VERSION?'（本期原价）':''),unit:item.unit,price_fen:item.points,price_points:item.points,capability:'limited',
        scope:code==='full_review'?['一份募集说明书与锁定材料的一轮全面复核，覆盖财务、交叉一致性、规则与格式，交付复核报告及批注。','另行委托的差异复核、原文修订各按14,900积分独立计费。']:[code==='integrity'?'每轮至多5个主体、每主体至多20个适用官网；按明确名单和截至时间执行':'用户明确提出并锁定的独立业务范围'],
        included:code==='full_review'?['本轮复核报告与批注的修复、平台重试包含在任务内。']:['原范围必要检查、修复、支撑材料及平台重试包含在任务内']})),rules:AUTOMATIC_BILLING_RULES};
    }
    return{enabled,currency:'CNY',version:OUTCOME_PRICE_VERSION,model:'pay_as_you_go',items:OUTCOME_CATALOG,rules:COMMERCE_RULES};
  });
  app.get('/api/v1/commerce/account',{schema:{response:{200:schemas.CommerceAccountResponse}}},async r=>{
    const balance=await creditBalance(pool,await owner(r)),automatic=automaticBillingEnabled(pool),payable=enabled||automatic;
    return{available_fen:balance.available,held_fen:balance.frozen,...(automatic?{available_points:balance.available,held_points:balance.frozen}:{}),
      payment_enabled:payable&&providers.length>0,providers:payable?providers.map(p=>p.name):[],
      legacy_balance_notice:automatic?'余额为可用积分，包含订阅额度及充值权益，不等于可退现金。旧批次权益继续有效，现金退款按原支付订单核算。':'旧余额权益继续有效，按原账本单位抵扣；历史任务保留原计费规则。'};
  });
  app.post('/api/v1/commerce/topups',{schema:{body:schemas.CommerceTopupRequest,response:{201:schemas.RechargeOrderResponse}}},async(r,reply)=>{
    const user=await owner(r);if(!enabled&&!automaticBillingEnabled(pool))throw new Problem(503,'PAYMENT_UNAVAILABLE','Outcome payments are not enabled');
    return reply.code(201).send(await createServiceTopup(pool,user,r.body as CommerceTopup,providers));
  });
  app.get('/api/v1/commerce/topups/:order_id',{schema:{response:{200:schemas.RechargeOrderResponse}}},async r=>{
    const user=await owner(r),id=(r.params as {order_id:string}).order_id;
    const row=(await pool.query('SELECT * FROM bb_recharge_orders WHERE owner_user_id=$1 AND id=$2',[user,id])).rows[0];if(!row)throw missing();return rechargeDto(row);
  });
  app.post('/api/v1/commerce/topups/:order_id/refresh',{schema:{body:{type:'object',additionalProperties:false},response:{200:schemas.RechargeOrderResponse}}},async r=>
    refreshRecharge(pool,await owner(r),(r.params as {order_id:string}).order_id,providers));
  app.post('/api/v1/commerce/feedback',{schema:{body:schemas.CommerceFeedbackRequest,response:{200:schemas.CommerceFeedbackResponse}}},async r=>{
    const user=await owner(r),b=r.body as Static<typeof schemas.CommerceFeedbackRequest>,hash=digest(JSON.stringify([b.run_id,b.outcome,b.reason??'']));
    return transaction(pool,async c=>{
      const run=(await c.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[user,b.run_id])).rows[0];if(!run)throw missing();
      if(run.state!=='succeeded')throw new Problem(409,'DELIVERY_FAILED','Feedback requires a delivered outcome');
      const row=(await c.query(`INSERT INTO bb_commerce_feedback(id,owner_user_id,request_id,request_hash,run_id,outcome,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_user_id,request_id) DO NOTHING RETURNING request_hash`,[uid(),user,b.request_id,hash,b.run_id,b.outcome,b.reason??''])).rows[0]
        ??(await c.query('SELECT request_hash FROM bb_commerce_feedback WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(row.request_hash.trim()!==hash)throw new Problem(409,'IDEMPOTENCY_CONFLICT','Feedback key already used');return{ok:true};
    });
  });
}
