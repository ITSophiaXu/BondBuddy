import assert from 'node:assert/strict';
import {verify} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {createWechatPayProvider,WechatPayError} from './wechat-pay.js';
import {paymentProvidersFromEnv} from './payment-provider-config.js';
import {syntheticWechatFixture} from './test-wechat-pay-fixtures.js';
import type {RefundOrder} from './payment-refunds.js';

const f=syntheticWechatFixture(),options={...f.options,refundNotifyUrl:'https://bondbuddy.example/api/v1/payments/wechat/refund-callback'};
const order:RefundOrder={id:'synthetic_refund_1',order_id:f.order.id,merchant_id:options.merchantId,
  provider_transaction_id:f.paid.transaction_id,currency:'CNY',order_amount_fen:10000,amount_fen:3000};
const value={out_refund_no:order.id,out_trade_no:order.order_id,transaction_id:order.provider_transaction_id,refund_id:'synthetic_channel_refund_1',
  status:'PROCESSING',channel:'ORIGINAL',amount:{total:10000,refund:3000,payer_total:10000,payer_refund:3000,currency:'CNY'}};
const rejected=(error:unknown)=>error instanceof WechatPayError;
const callback=(v:Record<string,unknown>={...value,mchid:options.merchantId,refund_status:'SUCCESS'},event='REFUND.SUCCESS')=>f.envelope(v,{event_type:event},{original_type:'refund'});

test('synthetic refund mock HTTP signs original transaction, exact nominal total and same out_refund_no for query',async()=>{
  let requests=0;
  const server=createServer(async(req,res)=>{
    try{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks).toString('utf8'),auth=String(req.headers.authorization);
      const fields=Object.fromEntries([...auth.matchAll(/([a-z_]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
      assert.equal(fields.mchid,options.merchantId);
      assert.equal(verify('RSA-SHA256',Buffer.from(`${req.method}\n${req.url}\n${fields.timestamp}\n${fields.nonce_str}\n${body}\n`),f.merchant.publicKey,Buffer.from(fields.signature,'base64')),true);
      if(req.method==='POST'){
        assert.equal(req.url,'/v3/refund/domestic/refunds');
        assert.deepEqual(JSON.parse(body),{transaction_id:order.provider_transaction_id,out_refund_no:order.id,notify_url:options.refundNotifyUrl,
          amount:{refund:3000,total:10000,currency:'CNY'}});
      }else{assert.equal(req.url,`/v3/refund/domestic/refunds/${order.id}`);assert.equal(body,'');}
      requests++;const raw=JSON.stringify(value);res.writeHead(200,{'content-type':'application/json',...f.signed(raw) as Record<string,string>});res.end(raw);
    }catch{res.statusCode=500;res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const fetcher:typeof fetch=(url,init)=>{assert.match(String(url),/^https:\/\/api\.mch\.weixin\.qq\.com\//);return fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`,init);};
  try{
    const p=createWechatPayProvider(options,{now:()=>f.now,fetch:fetcher});assert.ok(p.refunds);
    const first=await p.refunds.create(order);assert.equal(first.state,'processing');assert.equal(first.amountFen,3000);assert.equal(first.payerRefundFen,3000);
    assert.deepEqual(await p.refunds.query(order),first);assert.equal(requests,2);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('refund status mapping retains ABNORMAL as unresolved and only CLOSED is explicit failure',async()=>{
  for(const [status,state] of [['SUCCESS','succeeded'],['PROCESSING','processing'],['ABNORMAL','processing'],['CLOSED','failed']]){
    const p=createWechatPayProvider(options,{now:()=>f.now,fetch:async()=>f.response({...value,status})});
    const receipt=await p.refunds!.query(order);assert.equal(receipt.state,state);assert.equal(receipt.failureCode,status==='CLOSED'?'CLOSED':undefined);
  }
  const p=createWechatPayProvider(options,{now:()=>f.now,fetch:async()=>{throw Error('must not fetch');}});
  for(const changes of [{amount_fen:0},{amount_fen:10001},{order_amount_fen:1.5},{merchant_id:'1900000002'},{order_id:'../foreign'},{id:'../foreign'},{provider_transaction_id:''}])await assert.rejects(()=>p.refunds!.create({...order,...changes}),rejected);
});

test('RSA/AES refund callbacks validate event/status, merchant, channel identities and payer cash fields',async()=>{
  const p=createWechatPayProvider(options,{now:()=>f.now,fetch:async()=>{throw Error('No callback network lookup');}}),valid=callback();
  const verified=await p.refunds!.verifyCallback(valid.headers,valid.raw);assert.equal(verified.state,'succeeded');assert.equal(verified.refundId,order.id);
  assert.deepEqual(await p.refunds!.verifyCallback(valid.headers,valid.raw),verified);
  const malformed=[callback({...value,mchid:'1900000002',refund_status:'SUCCESS'}),callback({...value,mchid:options.merchantId,refund_status:'CLOSED'}),
    callback({...value,mchid:options.merchantId,refund_status:'SUCCESS'},'TRANSACTION.SUCCESS'),
    f.envelope({...value,mchid:options.merchantId,refund_status:'SUCCESS'},{event_type:'REFUND.SUCCESS'}),
    f.envelope({...value,mchid:options.merchantId,refund_status:'SUCCESS'},{event_type:'REFUND.SUCCESS'},{original_type:'refund',associated_data:'altered'}),
  ];
  for(const envelope of malformed)await assert.rejects(()=>p.refunds!.verifyCallback(envelope.headers,envelope.raw),rejected);
  await assert.rejects(()=>p.refunds!.verifyCallback({...valid.headers,'wechatpay-signature':'invalid'},valid.raw),rejected);
  await assert.rejects(()=>p.refunds!.verifyCallback(f.signed(valid.raw,{timestamp:Math.floor(f.now/1000)-301}),valid.raw),rejected);
  await assert.rejects(()=>p.refunds!.verifyCallback(f.signed(valid.raw,{serial:'UNTRUSTED_1234'}),valid.raw),rejected);
  for(const changes of [{out_refund_no:'foreign_refund'},{out_trade_no:'foreign_order'},{transaction_id:'foreign_txn'},{mchid:'1900000002'},{status:'UNKNOWN'},
    {amount:{...value.amount,currency:'USD'}},{amount:{...value.amount,total:9999}},{amount:{...value.amount,refund:1}},
    {amount:{...value.amount,payer_total:9999}},{amount:{...value.amount,payer_refund:1}},{amount:{...value.amount,payer_refund:'3000'}}]){
    const q=createWechatPayProvider(options,{now:()=>f.now,fetch:async()=>f.response({...value,...changes})});
    await assert.rejects(()=>q.refunds!.query(order),rejected);
  }
});

test('cash proof is independent from valid nominal payment; missing evidence is unknown and discounts still pay',async()=>{
  for(const [amount,expected] of [[{total:10000,currency:'CNY'},undefined],[f.paid.amount,1],[{...f.paid.amount,payer_total:10000},10000],[{...f.paid.amount,payer_total:0},0]] as const){
    const p=createWechatPayProvider(f.options,{now:()=>f.now,fetch:async()=>f.response({...f.paid,amount})});
    const receipt=await p.query(f.order);assert.equal(receipt.state,'paid');assert.equal(receipt.amountFen,10000);assert.equal(receipt.payerCash?.amountFen,expected);
  }
});

test('refund capability defaults off; explicit verified configuration enables it; unknown transport results throw',async()=>{
  assert.equal(createWechatPayProvider(f.options,{now:()=>f.now}).refunds,undefined);
  assert.throws(()=>createWechatPayProvider({...f.options,refundNotifyUrl:'http://example.test/unsafe'},{now:()=>f.now}),rejected);
  const env={BB_WECHAT_PAY_ENABLED:'1',BB_WECHAT_PAY_MERCHANT_ID:f.options.merchantId,BB_WECHAT_PAY_APP_ID:f.options.appId,
    BB_WECHAT_PAY_MERCHANT_CERT_SERIAL:f.options.merchantCertificateSerial,BB_WECHAT_PAY_PRIVATE_KEY:f.options.merchantPrivateKeyPem,
    BB_WECHAT_PAY_API_V3_KEY:f.options.apiV3Key,BB_WECHAT_PAY_NOTIFY_URL:f.options.notifyUrl,BB_WECHAT_PAY_PLATFORM_SERIAL:f.platformSerial,
    BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY:f.options.platformKeys[0].publicKeyPem,BB_WECHAT_PAY_REFUND_NOTIFY_URL:options.refundNotifyUrl};
  assert.equal(paymentProvidersFromEnv(env,{now:()=>f.now}).providers[0]?.refunds,undefined);
  assert.ok(paymentProvidersFromEnv({...env,BB_WECHAT_PAY_REFUND_ENABLED:'1'},{now:()=>f.now}).providers[0]?.refunds);
  for(const response of [()=>new Response('not found',{status:404}),()=>new Response('private provider error',{status:500}),()=>new Response('{}',{headers:{'content-type':'application/json'}})]){
    const p=createWechatPayProvider(options,{now:()=>f.now,fetch:async()=>response()});await assert.rejects(()=>p.refunds!.query(order),rejected);
  }
  const timeout=createWechatPayProvider({...options,timeoutMs:20},{now:()=>f.now,fetch:async()=>new Promise(()=>{})});await assert.rejects(()=>timeout.refunds!.create(order),rejected);
});
