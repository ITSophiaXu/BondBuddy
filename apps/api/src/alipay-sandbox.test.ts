import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {installPayments} from './payments.js';
import {alipaySandboxConfigPath,alipaySandboxOptions,paymentProvidersFromEnv} from './payment-provider-config.js';
import {createAlipayPayProvider,AlipayPayError} from './alipay-pay.js';
import {syntheticAlipayFixture} from './test-alipay-pay-fixtures.js';

const f=syntheticAlipayFixture();
const app={appId:f.options.appId,pid:f.options.merchantId,
  appPrivatePkcsKey:f.app.privateKey.export({type:'pkcs1',format:'der'}).toString('base64'),
  alipayPublicKey:f.platform.publicKey.export({type:'spki',format:'der'}).toString('base64')};
const config=JSON.stringify({appIds:[app],sandboxAccounts:{partner:{userId:app.pid}}});
const env={NODE_ENV:'test',BB_ALIPAY_PAY_ENABLED:'1',BB_ALIPAY_ENVIRONMENT:'sandbox',BB_ALIPAY_RETURN_URL:'http://127.0.0.1:32100/payment/alipay/return.html'};
const read=(path:string)=>{assert.equal(path,alipaySandboxConfigPath);return config;};

test('verified sandbox source maps original PKCS1 values and signs both checkout forms and queries on the sandbox only',async()=>{
  const options=alipaySandboxOptions(env,read);
  assert.equal(options.appPrivateKeyPem,app.appPrivatePkcsKey);assert.equal(options.alipayPublicKeyPem,app.alipayPublicKey);
  let requests=0;
  const provider=createAlipayPayProvider(options,{now:()=>f.now,fetch:async(input,init)=>{
    requests++;assert.equal(String(input),'https://openapi-sandbox.dl.alipaydev.com/gateway.do');
    const request=f.request(init?.body);assert.equal(request.fields.method,'alipay.trade.query');
    return f.response('alipay.trade.query',f.paid);
  }});
  const checkout=await provider.create(f.order),url=new URL(checkout.checkoutUrl),signed=f.request(url.search.slice(1));
  assert.equal(url.origin,'https://openapi-sandbox.dl.alipaydev.com');assert.equal(signed.fields.method,'alipay.trade.page.pay');
  assert.equal(signed.fields.notify_url,undefined);assert.equal(signed.fields.return_url,env.BB_ALIPAY_RETURN_URL);
  assert.equal(signed.biz.total_amount,'100.00');assert.equal(requests,0);
  const form=await provider.createCheckoutForm(f.order);
  assert.match(form,/<form /);assert.match(form,/method="post"/i);assert.match(form,/openapi-sandbox\.dl\.alipaydev\.com/);
  assert.ok(!form.includes(app.appPrivatePkcsKey));assert.equal((await provider.query(f.order)).state,'paid');assert.equal(requests,1);
});

test('sandbox setup fails before reading secrets for production, mixed credentials, WAP or statements',()=>{
  for(const changes of [{NODE_ENV:'production'},{NODE_ENV:undefined},{BB_ALIPAY_ENVIRONMENT:'production'},
    {BB_ALIPAY_WEB_PRODUCT:'wap'},{BB_ALIPAY_APP_ID:app.appId},{BB_ALIPAY_PUBLIC_KEY_FILE:'private.pem'},{BB_ALIPAY_PAY_STATEMENTS_ENABLED:'1'}]){
    assert.throws(()=>alipaySandboxOptions({...env,...changes},()=>{assert.fail('must not read secrets');}));
  }
  const ready=paymentProvidersFromEnv(env,{readSecretFile:read,now:()=>f.now});assert.equal(ready.status,'ready');
  for(const source of ['{broken',JSON.stringify({appIds:[app],sandboxAccounts:{partner:{userId:'other'}}}),JSON.stringify({appIds:[{...app,appPrivatePkcsKey:'bad'}]})]){
    const result=paymentProvidersFromEnv(env,{readSecretFile:()=>source,now:()=>f.now});
    assert.deepEqual(result,{providers:[],status:'invalid'});assert.ok(!JSON.stringify(result).includes(app.appPrivatePkcsKey));
  }
});

test('only sandbox can omit HTTPS notify or return locally, and neither environment accepts arbitrary gateways',()=>{
  const options=alipaySandboxOptions(env,read);
  assert.ok(createAlipayPayProvider({...options,appId:'9021000000000001'}));
  for(const change of [{environment:'unknown'},{environment:'production'},{returnUrl:'http://remote.test/return'},
    {notifyUrl:''},{notifyUrl:'http://127.0.0.1/api/v1/payments/alipay/callback'},{webProduct:'wap'}]){
    assert.throws(()=>createAlipayPayProvider({...options,...change} as typeof options),AlipayPayError);
  }
});

test('authentic refund and non-payment event markers never credit a payment even with paid status',async()=>{
  const provider=createAlipayPayProvider(f.options,{now:()=>f.now});
  for(const status of ['TRADE_SUCCESS','TRADE_FINISHED'])for(const marker of ['out_biz_no','gmt_refund','refund_fee']){
    const callback=f.callback({trade_status:status,[marker]:'0'});
    await assert.rejects(()=>provider.verifyCallback(callback.headers,callback.raw),error=>error instanceof AlipayPayError&&error.code==='RECEIPT_INVALID');
  }
});

test('rejected Alipay HTTP callbacks return plain fail and never reach the ledger',async()=>{
  const server=Fastify(),provider=createAlipayPayProvider(f.options,{now:()=>f.now});
  const pool={query:()=>assert.fail('rejected callbacks must not reach the ledger')} as unknown as Pool;
  installPayments(server,pool,async()=>{throw new Error('No user session');},false,[provider]);
  try{
    const callback=f.callback({out_biz_no:'refund'});
    const response=await server.inject({method:'POST',url:'/api/v1/payments/alipay/callback',headers:callback.headers,payload:callback.raw});
    assert.equal(response.statusCode,401);assert.equal(response.body,'fail');assert.match(response.headers['content-type']??'',/^text\/plain/);
  }finally{await server.close();}
});
