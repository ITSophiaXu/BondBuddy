// Local sandbox acceptance only: shared production adapter, no application DB,
// wallet grants, production credentials, or production gateway are used here.
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createAlipayPayProvider,AlipayPayError} from '../apps/api/dist/alipay-pay.js';
import {alipaySandboxOptions} from '../apps/api/dist/payment-provider-config.js';
import {canReopenSandboxCheckout,prepareSandboxCheckout,withSandboxSession} from './alipay-sandbox-order.mjs';

const app=Fastify({logger:false,bodyLimit:1024});
const sessions=new Map();let provider,origin;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shell=body=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>BondBuddy 支付沙箱</title><style>body{font:16px/1.7 system-ui;background:#f7f8fb;color:#17233d;margin:0}main{max-width:620px;margin:7vh auto;padding:32px;background:white;border:1px solid #e1e6ee;border-radius:16px}button,a{display:inline-block;padding:12px 18px;margin:6px 0;border:0;border-radius:8px;background:#295bbd;color:white;text-decoration:none;font:inherit}form{display:inline-block;margin-right:8px}small{color:#526075}</style><main><p>BondBuddy · 支付沙箱</p>${body}</main></html>`;
const session=(request,reply,create=false)=>{
  const token=String(request.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('bb_alipay_sandbox='))?.slice(18);
  if(token&&sessions.has(token))return sessions.get(token);
  if(!create)return undefined;
  const key=randomUUID(),value={};sessions.set(key,value);
  reply.header('set-cookie',`bb_alipay_sandbox=${key}; Path=/; HttpOnly; SameSite=Lax`);return value;
};
const stateText={pending:'等待沙箱付款',paid:'已通过支付宝查询确认沙箱付款成功',expired:'订单已关闭或过期',unknown:'付款结果待核对',refunded:'已通过支付宝查询确认沙箱退款成功'};
const page=value=>shell(`<h1>网站支付测试</h1><p>本页使用支付宝沙箱测试资金，金额固定为 0.01 元。不会给正式账户充值。</p><p role="status">${stateText[value?.state]??'尚未创建测试订单'}</p>${value?.order?`<small>测试订单：${escape(value.order.id)}<br>有效期至：${escape(new Date(value.order.expires_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}（北京时间）</small><br>`:''}
  ${!value?.order||canReopenSandboxCheckout(value)?'<form method="post" action="/checkout"><button>进入支付宝沙箱收银台</button></form>':''}
  ${value?.order&&['pending','unknown'].includes(value.state)&&!canReopenSandboxCheckout(value)?'<p>订单已到期或即将到期。请先查询支付结果；确认已关闭或过期后，才能创建新测试订单。</p>':''}
  ${value?.state==='expired'?`<form method="post" action="/new-order"><input type="hidden" name="previous_order_id" value="${escape(value.order.id)}"><button>创建新测试订单并进入收银台</button></form>`:''}
  ${value?.order?'<form method="post" action="/query"><button>查询支付结果</button></form>':''}
  ${value?.order&&['pending','unknown'].includes(value.state)?'<form method="post" action="/close"><button>关闭未付款订单</button></form>':''}
  ${value?.state==='paid'?'<form method="post" action="/refund"><button>退回本笔沙箱付款</button></form>':''}
  <p>每笔测试订单有效期为 30 分钟，刷新收银台不会延长有效期。二维码不能使用时，可在收银台选择“使用电脑支付”，输入沙箱账号和支付密码。</p>
  <p>同步回跳和页面参数不表示付款成功，结果以服务端验签查询为准。这里验证支付接口，不验证正式账户的订阅与积分入账。</p>`);
const observe=async value=>{
  try{const receipt=await provider.query(value.order);value.state=receipt.state;value.receipt=receipt;
    process.stdout.write(JSON.stringify({event:'sandbox_query',state:receipt.state})+'\n');}
  catch(error){value.state='unknown';delete value.receipt;process.stdout.write(JSON.stringify({event:'sandbox_query',state:'unknown',code:error instanceof AlipayPayError?error.code:'UNKNOWN'})+'\n');}
};
app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_r,body,done)=>done(null,body));
app.addHook('onRequest',async(request,reply)=>{
  reply.header('cache-control','no-store').header('referrer-policy','same-origin').header('x-content-type-options','nosniff');
  if(origin&&request.headers.host!==new URL(origin).host)return reply.code(403).send('Invalid host');
  if(request.method==='POST'&&request.headers.origin!==origin)return reply.code(403).send('Invalid origin');
});
app.get('/',async(request,reply)=>reply.type('text/html').send(page(session(request,reply,true))));
app.get('/health',async()=>({sandbox:true,configured:!!provider,productionDatabase:false}));
app.get('/payment/alipay/return.html',async(request,reply)=>{
  const value=session(request,reply);
  if(value?.order)return withSandboxSession(value,async()=>{await observe(value);return reply.type('text/html').send(page(value));});
  return reply.type('text/html').send(readFileSync(new URL('../apps/web/public/payment/alipay/return.html',import.meta.url),'utf8'));
});
for(const route of ['/checkout','/new-order'])app.post(route,async(request,reply)=>{
  const value=session(request,reply);if(!value)return reply.code(403).send('Open the sandbox page first');
  return withSandboxSession(value,async()=>{
    const replaceOrderId=route==='/new-order'?new URLSearchParams(typeof request.body==='string'?request.body:'').get('previous_order_id')??'':undefined;
    if(!await prepareSandboxCheckout(value,{provider,observe,replaceOrderId}))return reply.type('text/html').send(page(value));
    return reply.type('text/html').send(await provider.createCheckoutForm(value.order));
  });
});
for(const action of ['query','close','refund'])app.post('/'+action,async(request,reply)=>{
  const value=session(request,reply);if(!value?.order)return reply.code(404).send('No sandbox order');
  return withSandboxSession(value,async()=>{
  if(action==='query')await observe(value);
  if(action==='close'){const result=await provider.closePayment(value.order);value.state=result.state;value.receipt=result;}
  if(action==='refund'){
    await observe(value);if(value.state!=='paid'||value.receipt?.payerCash?.amountFen!==1)return reply.redirect('/');
    value.refund??={id:'bb_sandbox_refund_'+randomUUID().replaceAll('-',''),order_id:value.order.id,merchant_id:provider.merchantId,
      provider_transaction_id:value.receipt.transactionId,currency:'CNY',order_amount_fen:1,amount_fen:1};
    const result=await provider.refunds.recoverSameRequest(value.refund);if(result.state==='succeeded')value.state='refunded';
  }
  return reply.type('text/html').send(page(value));
  });
});
app.setErrorHandler((error,_request,reply)=>{
  process.stdout.write(JSON.stringify({event:'sandbox_operation_unresolved',code:error instanceof AlipayPayError?error.code:'UNKNOWN'})+'\n');
  reply.code(503).type('text/html').send(shell('<h1>测试结果待核对</h1><p>请查询同一订单，不要重复创建付款或退款。</p><a href="/">返回测试页</a>'));
});
let startupStage='listen';
try{
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();origin=`http://127.0.0.1:${address.port}`;
  const returnUrl=origin+'/payment/alipay/return.html';
  startupStage='verified_config_load';
  const options=alipaySandboxOptions({NODE_ENV:'test',BB_ALIPAY_ENVIRONMENT:'sandbox',BB_ALIPAY_RETURN_URL:returnUrl,BB_ALIPAY_REFUND_ENABLED:'1'});
  startupStage='sdk_initialization';
  provider=createAlipayPayProvider(options);
  process.stdout.write(JSON.stringify({event:'sandbox_ready',url:origin,returnUrl,configSource:'verified_project_file',keyType:'PKCS1',productionDatabase:false})+'\n');
}catch(error){await app.close();process.stderr.write(JSON.stringify({event:'sandbox_start_failed',stage:startupStage,code:error instanceof AlipayPayError?error.code:'CONFIG_OR_RUNTIME_INVALID'})+'\n');process.exitCode=1;}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close());
