import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import test from 'node:test';
import {alipayMoneyFen,createAlipayPayProvider,AlipayPayError} from './alipay-pay.js';
import {syntheticAlipayFixture} from './test-alipay-pay-fixtures.js';

const f=syntheticAlipayFixture(),dependencies={now:()=>f.now};
const rejected=(code:string)=>(error:unknown)=>error instanceof AlipayPayError&&error.code===code;

test('explicit PC and WAP products create official SDK signed Web checkout with immutable amount and absolute expiry, no network or mandate',async()=>{
  for(const webProduct of ['page','wap'] as const){
    const p=createAlipayPayProvider({...f.options,webProduct},{...dependencies,fetch:async()=>{throw Error('No checkout network call');}});
    const {checkoutUrl}=await p.create(f.order),url=new URL(checkoutUrl),{fields,biz}=f.request(url.search.slice(1));
    assert.equal(url.origin,'https://openapi.alipay.com');assert.equal(url.pathname,'/gateway.do');assert.equal(fields.sign_type,'RSA2');
    assert.equal(fields.app_id,f.options.appId);assert.equal(fields.timestamp,'2026-10-29 12:00:00');assert.equal(fields.notify_url,f.options.notifyUrl);assert.equal(fields.return_url,f.options.returnUrl);
    assert.equal(fields.method,webProduct==='page'?'alipay.trade.page.pay':'alipay.trade.wap.pay');
    assert.equal(biz.product_code,webProduct==='page'?'FAST_INSTANT_TRADE_PAY':'QUICK_WAP_WAY');assert.equal(biz.out_trade_no,f.order.id);assert.equal(biz.total_amount,'100.00');assert.equal(biz.time_expire,'2026-10-29 12:30:00');
    assert.equal(p.recurring,undefined);assert.equal(p.refunds,undefined);assert.equal(p.acknowledgement,'success');
    assert.equal(biz.agreement_sign_params,undefined);
  }
});

test('query posts SDK-signed form through bounded fetch and verifies the exact response bytes, not reserialized JSON',async()=>{
  const raw=' { "code" : "10000", "msg":"Success \\u4e2d", "out_trade_no":"'+f.order.id+'", "trade_no":"'+f.paid.trade_no+'", "total_amount":"100.00", "buyer_pay_amount":"100.00", "trade_status":"TRADE_SUCCESS" } ';
  // Whitespace outside the object is not part of the field value; whitespace
  // inside and escaped Unicode are, and would be lost by JSON.stringify.
  const body=raw.trim();let calls=0;
  const p=createAlipayPayProvider(f.options,{...dependencies,fetch:async(input,init)=>{
    calls++;assert.equal(String(input),'https://openapi.alipay.com/gateway.do');assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error');
    const {fields,biz}=f.request(init?.body);assert.equal(fields.method,'alipay.trade.query');assert.deepEqual(biz,{out_trade_no:f.order.id});
    return f.response(fields.method,{},body);
  }});
  assert.deepEqual(await p.query(f.order),{orderId:f.order.id,merchantId:f.options.merchantId,amountFen:10000,currency:'CNY',transactionId:f.paid.trade_no,state:'paid',payerCash:{amountFen:10000,currency:'CNY'}});
  assert.equal(calls,1);
});

test('signed callbacks decode form once, preserve percent/plus, accept delayed retries and reject forgery, duplicate fields, wrong product identities and currency',async()=>{
  const p=createAlipayPayProvider(f.options,dependencies),callback=f.callback();
  const result=await p.verifyCallback(callback.headers,callback.raw);assert.equal(result.paidAt,'2026-10-29T04:00:00.000Z');assert.equal(result.payerCash?.amountFen,10000);
  assert.deepEqual(await p.verifyCallback(callback.headers,callback.raw),result);
  const delayed=f.callback({notify_time:'2026-10-28 01:00:00'});assert.equal((await p.verifyCallback(delayed.headers,delayed.raw)).state,'paid');
  await assert.rejects(()=>p.verifyCallback(callback.headers,callback.raw.replace('100.00','1.00')),rejected('SIGNATURE_INVALID'));
  for(const raw of [callback.raw+'&total_amount=1.00',callback.raw+'&%74otal_amount=1.00',callback.raw+'&bad=%ff',callback.raw+'&constructor=x'])await assert.rejects(()=>p.verifyCallback(callback.headers,raw),rejected('PAYLOAD_INVALID'));
  for(const changes of [{app_id:'2026000000000002'},{seller_id:'2088000000000002'},{currency:'USD'},{trade_status:'TRADE_CLOSED'},{trade_status:'WAIT_BUYER_PAY'},{buyer_pay_amount:'101.00'},{total_amount:'1e2'},{gmt_payment:'2026-02-30 01:00:00'},{credit_pay_mode:'creditAdvanceV2'}]){
    const c=f.callback(changes);await assert.rejects(()=>p.verifyCallback(c.headers,c.raw),rejected('RECEIPT_INVALID'));
  }
  const rsa=f.callback({sign_type:'RSA'});await assert.rejects(()=>p.verifyCallback(rsa.headers,rsa.raw),rejected('SIGNATURE_INVALID'));
  await assert.rejects(()=>p.verifyCallback({'content-type':'application/json'},callback.raw),rejected('PAYLOAD_INVALID'));
});

test('query validates original identity/currency/amount and keeps cash proof separate from nominal and seller transfer date',async()=>{
  const p=(changes:Record<string,unknown>)=>createAlipayPayProvider(f.options,{...dependencies,fetch:async()=>f.response('alipay.trade.query',{...f.paid,...changes})});
  const missing={...f.paid} as Record<string,unknown>;delete missing.buyer_pay_amount;
  const noCash=createAlipayPayProvider(f.options,{...dependencies,fetch:async()=>f.response('alipay.trade.query',missing)});
  assert.equal((await noCash.query(f.order)).payerCash,undefined);assert.equal((await noCash.query(f.order)).paidAt,undefined);
  assert.equal((await p({buyer_pay_amount:'90.00'}).query(f.order)).payerCash?.amountFen,9000);
  assert.equal((await p({trade_status:'WAIT_BUYER_PAY'}).query(f.order)).state,'pending');
  assert.equal((await p({trade_status:'TRADE_FINISHED'}).query(f.order)).state,'paid');
  for(const changes of [{out_trade_no:'other_order'},{total_amount:'99.00'},{seller_id:'2088000000000002'},{app_id:'2026000000000002'},{trans_currency:'USD'},{buyer_pay_amount:100},{buyer_pay_amount:'100.001'},{trade_status:'constructor'}])await assert.rejects(()=>p(changes).query(f.order),rejected('RECEIPT_INVALID'));
  await assert.rejects(()=>p({trade_status:'TRADE_CLOSED'}).query(f.order),rejected('CLOSED_PAYMENT_REQUIRES_RECONCILIATION'));
  assert.equal((await p({trade_status:'TRADE_CLOSED',buyer_pay_amount:'0.00',send_pay_date:undefined}).query(f.order)).state,'expired');
});

test('only authenticated absent query after immutable expiry resolves missing order, and close follows original-order query across payment races',async()=>{
  const absent=createAlipayPayProvider(f.options,{...dependencies,fetch:async()=>f.response('alipay.trade.query',{code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'})});
  await assert.rejects(()=>absent.query(f.order),rejected('CHANNEL_UNRESOLVED'));
  assert.equal((await absent.query({...f.order,expires_at:new Date(f.now-1000).toISOString()})).state,'expired');
  const methods:string[]=[];
  const p=createAlipayPayProvider(f.options,{...dependencies,fetch:async(_input,init)=>{
    const {fields,biz}=f.request(init?.body);methods.push(fields.method);assert.equal(biz.out_trade_no,f.order.id);
    return f.response(fields.method,fields.method==='alipay.trade.close'?{code:'10000',out_trade_no:f.order.id,trade_no:f.paid.trade_no}:f.paid);
  }});
  assert.equal((await p.closePayment!(f.order)).state,'paid');assert.deepEqual(methods,['alipay.trade.close','alipay.trade.query']);
});

test('strict original response envelope rejects unsigned, tampered, duplicate-key and method-substitution responses without leaking details',async()=>{
  const valid=f.signedResponse('alipay.trade.query',f.paid);
  const values=[valid.replace('100.00','1.00'),JSON.stringify({alipay_trade_query_response:f.paid}),
    valid.replace('{','{"alipay_trade_query_response":{},'),valid.replace('{','{"sign":"fake",'),
    f.signedResponse('alipay.trade.refund',f.paid),f.signedResponse('alipay.trade.query',f.paid,undefined,f.app.privateKey),
    valid+' trailing',valid.replace('"alipay_trade_query_response"','"alipay_trade_query_respon\\u0073e"'),
    JSON.stringify({error_response:{code:'40004',sub_msg:'synthetic-private-detail'}})];
  for(const raw of values){const p=createAlipayPayProvider(f.options,{...dependencies,fetch:async()=>new Response(raw,{headers:{'content-type':'application/json'}})});
    await assert.rejects(()=>p.query(f.order),error=>error instanceof AlipayPayError&&!error.message.includes('synthetic-private-detail'));
  }
});

test('fetch fails closed on redirects, HTTP errors, oversized streams and timeouts including response bodies',async()=>{
  const factories=[()=>new Response('{}',{status:302,headers:{location:'https://other.test'}}),()=>new Response('{}',{status:500}),
    ()=>new Response('{}',{headers:{'content-type':'text/html'}}),()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}})];
  for(const factory of factories)await assert.rejects(()=>createAlipayPayProvider(f.options,{...dependencies,fetch:async()=>factory()}).query(f.order),error=>error instanceof AlipayPayError);
  let signal:AbortSignal|undefined;
  const p=createAlipayPayProvider({...f.options,timeoutMs:20},{...dependencies,fetch:async(_url,init)=>{signal=init?.signal as AbortSignal;return new Promise(()=>{});}});
  await assert.rejects(()=>p.query(f.order),rejected('TIMEOUT'));assert.equal(signal?.aborted,true);
  let bodyCancelled=false;
  const slow=createAlipayPayProvider({...f.options,timeoutMs:20},{...dependencies,fetch:async()=>new Response(new ReadableStream({start(){},cancel(){bodyCancelled=true;}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>slow.query(f.order),rejected('TIMEOUT'));assert.equal(bodyCancelled,true);
  bodyCancelled=false;
  const oversized=createAlipayPayProvider(f.options,{...dependencies,fetch:async()=>new Response(new ReadableStream({cancel(){bodyCancelled=true;}}),{headers:{'content-type':'application/json','content-length':'65537'}})});
  await assert.rejects(()=>oversized.query(f.order),rejected('PAYLOAD_TOO_LARGE'));assert.equal(bodyCancelled,true);
});

test('cash refund validates independent buyer fields, queries original request and never treats cumulative refund_fee as this refund',async()=>{
  const calls:Array<{method:string;biz:any}>=[];
  const p=createAlipayPayProvider({...f.options,refundsEnabled:true},{...dependencies,fetch:async(_url,init)=>{
    const {fields,biz}=f.request(init?.body);calls.push({method:fields.method,biz});
    const data=fields.method==='alipay.trade.query'?f.paid:fields.method==='alipay.trade.refund'?{code:'10000',out_trade_no:f.order.id,trade_no:f.paid.trade_no,refund_fee:'65.00',fund_change:'N'}:f.refunded;
    return f.response(fields.method,data);
  }});
  const result=await p.refunds!.create(f.refund);assert.equal(result.amountFen,2500);assert.equal(result.payerRefundFen,2500);assert.equal(result.payerTotalFen,10000);assert.equal(result.state,'succeeded');
  assert.equal(result.providerRefundId,'alipay_'+createHash('sha256').update(JSON.stringify([f.paid.trade_no,f.refund.id])).digest('hex'));
  const refundCall=calls.find(c=>c.method==='alipay.trade.refund')!;assert.equal(refundCall.biz.out_request_no,f.refund.id);assert.equal(refundCall.biz.refund_amount,'25.00');
  assert.equal(calls.filter(c=>c.method==='alipay.trade.fastpay.refund.query').length,1);
  assert.equal((await p.refunds!.recoverSameRequest!(f.refund)).state,'succeeded');assert.equal(calls.filter(c=>c.method==='alipay.trade.refund').length,1,'successful query recovery sends no second refund');
  await assert.rejects(()=>p.refunds!.verifyCallback({},'refund_fee=65.00'),rejected('REFUND_CALLBACK_UNSUPPORTED'));
});

test('refund refuses missing/discounted original cash before dispatch and leaves missing or mismatched per-request cash unresolved',async()=>{
  for(const buyer_pay_amount of [undefined,'90.00']){let refunds=0;
    const p=createAlipayPayProvider({...f.options,refundsEnabled:true},{...dependencies,fetch:async(_url,init)=>{const {fields}=f.request(init?.body);if(fields.method==='alipay.trade.refund')refunds++;return f.response(fields.method,{...f.paid,buyer_pay_amount});}});
    await assert.rejects(()=>p.refunds!.create(f.refund),rejected('REFUND_CASH_EVIDENCE_MISSING'));assert.equal(refunds,0);
  }
  for(const changes of [{present_refund_buyer_amount:undefined},{present_refund_buyer_amount:'24.00'},{out_request_no:'other_refund'},{refund_amount:'24.00'},{total_amount:'99.00'},{refund_status:undefined}]){
    const p=createAlipayPayProvider({...f.options,refundsEnabled:true},{...dependencies,fetch:async(_url,init)=>{const {fields}=f.request(init?.body);return f.response(fields.method,fields.method==='alipay.trade.query'?f.paid:{...f.refunded,...changes});}});
    await assert.rejects(()=>p.refunds!.query(f.refund),error=>error instanceof AlipayPayError);
  }
});

test('refund query requests and preserves authenticated completion time without fabricating missing or invalid dates',async()=>{
  const query=(gmt_refund_pay:unknown)=>createAlipayPayProvider({...f.options,refundsEnabled:true},{...dependencies,fetch:async(_url,init)=>{
    const {fields,biz}=f.request(init?.body);
    if(fields.method==='alipay.trade.query')return f.response(fields.method,f.paid);
    assert.equal(fields.method,'alipay.trade.fastpay.refund.query');
    assert.equal(biz.out_request_no,f.refund.id);
    assert.ok(biz.query_options.includes('gmt_refund_pay'));
    return f.response(fields.method,{...f.refunded,gmt_refund_pay});
  }}).refunds!.query(f.refund);
  const receipt=await query('2026-10-29 00:00:01');
  assert.equal(receipt.providerSucceededAt,'2026-10-28T16:00:01.000Z');
  assert.equal(receipt.providerCreatedAt,undefined);
  assert.equal((await query(undefined)).providerSucceededAt,undefined);
  for(const value of [null,'','2026-02-30 12:00:00','2026-10-29 24:00:00','2026-10-29T00:00:01Z',1793232001000])
    await assert.rejects(()=>query(value),rejected('RECEIPT_INVALID'));
});

test('refund recovery retries only the same signed original request when the channel has not yet recorded it',async()=>{
  let submitted=false;const requests:string[]=[];
  const p=createAlipayPayProvider({...f.options,refundsEnabled:true},{...dependencies,fetch:async(_url,init)=>{
    const {fields,biz}=f.request(init?.body);
    if(fields.method==='alipay.trade.query')return f.response(fields.method,f.paid);
    if(fields.method==='alipay.trade.refund'){
      requests.push(biz.out_request_no);assert.equal(biz.trade_no,f.refund.provider_transaction_id);assert.equal(biz.out_trade_no,f.refund.order_id);assert.equal(biz.refund_amount,'25.00');submitted=true;
      return f.response(fields.method,{code:'10000',out_trade_no:f.order.id,trade_no:f.paid.trade_no,refund_fee:'25.00',fund_change:'Y'});
    }
    assert.equal(biz.out_request_no,f.refund.id);
    return f.response(fields.method,submitted?f.refunded:{code:'10000',out_trade_no:f.order.id,trade_no:f.paid.trade_no,out_request_no:f.refund.id});
  }});
  assert.equal((await p.refunds!.recoverSameRequest!(f.refund)).state,'succeeded');
  assert.deepEqual(requests,[f.refund.id]);
  assert.equal((await p.refunds!.recoverSameRequest!(f.refund)).state,'succeeded');assert.deepEqual(requests,[f.refund.id]);
});

test('configuration and minor-unit conversion reject weak keys, unsupported products, guessed callback endpoints and unsafe money',()=>{
  const weak=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
  for(const changes of [{webProduct:'app' as any},{webProduct:'' as any},{merchantId:'bad'},{appId:'bad'},{appPrivateKeyPem:weak},{notifyUrl:'http://synthetic.test/api/v1/payments/alipay/callback'},
    {notifyUrl:'https://synthetic.test/other/callback'},{returnUrl:'https://user:password@synthetic.test/billing'},{alipayPublicKeyPem:f.app.publicKey.export({type:'spki',format:'pem'}).toString()},{timeoutMs:0},{timeoutMs:30001}])
    assert.throws(()=>createAlipayPayProvider({...f.options,...changes},dependencies),rejected('CONFIG_INVALID'));
  assert.equal(alipayMoneyFen('0.01'),1);assert.equal(alipayMoneyFen('100.1'),10010);assert.equal(alipayMoneyFen('100000000.00'),10000000000);
  for(const value of ['1e2','1.001','-0.01','NaN',Infinity,1.01,'100000001.00'])assert.throws(()=>alipayMoneyFen(value),rejected('RECEIPT_INVALID'));
});
