// Isolated UI acceptance: real built web, synthetic in-memory API, no database,
// credentials, outbound requests or real payment. Never use as an application API.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SUBSCRIPTION_PLANS,SUBSCRIPTION_CATALOG_VERSION,AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TERMS,automaticTaskTariff,billingWireRoute,encodeBillingDto,DATA_POLICY_VERSION,DELETION_PURGED_CONTENT,DELETION_RETAINED_METADATA} from '@bondbuddy/contracts';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),dist=resolve(root,'apps/web/dist');
const port=5182,origin=`http://127.0.0.1:${port}`,now=()=>new Date().toISOString();
let state='pending',unavailable=false,amount='5000',credited=null;
const order=()=>({order_id:'preview-topup-975',provider:'alipay',state,amount_fen:amount,points:amount,currency:'CNY',checkout_url:'https://payments.example.invalid/synthetic-payment',project_id:null,expires_at:new Date(Date.now()+1800000).toISOString(),credited_at:credited});
const page=(title,body)=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f5f7f1;color:#203b33;font:14px/1.7 system-ui,sans-serif}header,main{padding:18px 24px}header{background:#173e33;color:white}button,a{display:inline-block;font:inherit;padding:9px 16px;margin:6px;border:1px solid #b5c5b6;border-radius:7px;background:white;color:#203b33;cursor:pointer;text-decoration:none}iframe{width:100%;height:calc(100vh - 130px);border:0;background:white}p{margin:0}</style>${body}</html>`;
const controls=()=>page('BondBuddy · 支付体验本地验收',`<header><strong>支付体验验收 · 仅本机模拟</strong><p>下方是真实前端；账号、订单、支付与积分均为合成数据。不连接生产服务或支付宝，不扣款。</p><a href="/#/account?order=preview-topup-975&payment_return=alipay" target="_blank">打开新版账户</a><a href="/__preview/cashier" target="_blank">模拟付款与返回</a><a href="/__preview/prototype" target="_blank">查看对应原型</a></header><iframe title="BondBuddy 本地验收页面" src="/#/account?order=preview-topup-975&payment_return=alipay"></iframe>`);
const cashier=()=>page('本地模拟付款',`<header><strong>本地测试工具 · 不是支付宝收银台</strong><p>只改变本机内存中的合成订单状态，不会付款或修改生产积分。</p></header><main><h1>选择返回页面的测试状态</h1><p>下单账号：payment_preview · 合成订单：preview-topup-975</p><form action="/__preview/state" method="post"><button name="state" value="paid">模拟付款成功并返回</button><button name="state" value="pending">模拟等待确认并返回</button><button name="state" value="expired">模拟订单过期并返回</button><button name="state" value="failed">模拟付款未完成并返回</button><button name="state" value="unavailable">模拟查单暂不可用</button></form></main>`);

const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(403);res.end();return;}
    const url=new URL(req.url,origin),path=url.pathname,method=req.method??'GET';
    if(!['GET','HEAD'].includes(method)&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384){res.writeHead(413);res.end();return;}}
    const send=(status,body,type='text/html; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);};
    if(path==='/__preview')return send(200,controls());
    if(path==='/__preview/cashier')return send(200,cashier());
    if(path==='/__preview/state'&&method==='POST'){
      const selected=new URLSearchParams(raw).get('state');
      if(!['paid','pending','expired','failed','unavailable'].includes(selected))return send(400,'Unknown preview state');
      unavailable=selected==='unavailable';state=unavailable?'pending':selected;credited=state==='paid'?now():null;
      res.writeHead(303,{Location:'/payment/alipay/return.html?out_trade_no=preview-topup-975'});res.end();return;
    }
    if(path==='/__preview/ui.js')return send(200,`document.addEventListener('click',e=>{const a=e.target.closest('a');if(a?.href.startsWith('https://payments.example.invalid/')){e.preventDefault();window.open('/__preview/cashier','_blank','noopener');}});`,'text/javascript; charset=utf-8');
    if(path.startsWith('/api/v1/')){
      const p=path.slice('/api/v1'.length),requestBody=raw?JSON.parse(raw):{},paid=state==='paid';
      let data,status=200;
      if(p==='/me')data={user_id:'payment-preview-owner',session_status:'active'};
      else if(p==='/account')data={user_id:'payment-preview-owner',username:'payment_preview',phone_masked:null,status:'active',created_at:now(),accepted_terms_version:'preview',current_terms_version:'preview',password_updated_at:null,self_service_recovery:'unavailable',support_contact:null};
      else if(p==='/account/sessions')data={items:[]};
      else if(p==='/account/recovery')data={enabled:false,support_operator:false,current:null,pending:null};
      else if(p==='/data-policy')data={policy_version:DATA_POLICY_VERSION,storage_location:'platform_private_cloud',server_side_processing:true,model_provider_processing:true,active_retention:'until_user_deletes',purge_enabled:false,deleted_content_purge_days:null,orphan_upload_purge_hours:null,log_content_retention_days:30,backup_retention_days:null,pinned_by_active_run:'retained_until_run_ends',purged_content:[...DELETION_PURGED_CONTENT],retained_metadata:[...DELETION_RETAINED_METADATA]};
      else if(p==='/billing/permissions')data={permissions:[]};
      else if(p==='/admin/inspection/access')data={allowed:false};
      else if(p==='/subscriptions/catalog')data={enabled:true,version:SUBSCRIPTION_CATALOG_VERSION,plans:SUBSCRIPTION_PLANS,providers:['alipay'],auto_renew_available:false};
      else if(p==='/subscriptions/account')data={subscription:null,available_points:paid?amount:'0',held_points:'0',task_held_points:'0',refund_held_points:'0',subscription_available_points:'0',topup_available_points:paid?amount:'0',other_available_points:'0',periods:[]};
      else if(p==='/subscriptions/orders/preview-topup-975/period')data={order_id:'preview-topup-975',period:null};
      else if(p==='/commerce/catalog')data={enabled:true,currency:'CNY',version:AUTOMATIC_PRICE_VERSION,model:'subscription_and_topup',items:Object.entries(automaticTaskTariff(AUTOMATIC_PRICE_VERSION)).map(([code,item])=>({code,label:item.label,unit:item.unit,price_fen:item.points,price_points:item.points,capability:'limited',...AUTOMATIC_TASK_TERMS[code]})),rules:[]};
      else if(p==='/commerce/quotations')data={items:[]};
      else if(p==='/credits/consumption-history')data={items:[],page:{next_cursor:null,has_more:false}};
      else if(p==='/credits/recharge-history')data={items:[{...order(),created_at:now(),pricing_mode:'outcome_cny_v1',price_version:AUTOMATIC_PRICE_VERSION}],page:{next_cursor:null,has_more:false}};
      else if(p==='/commerce/topups'&&method==='POST'){
        if(!/^\d{1,7}$/.test(requestBody.amount_fen)||BigInt(requestBody.amount_fen)<1n||BigInt(requestBody.amount_fen)>1000000n)return send(422,JSON.stringify({code:'INVALID_INPUT'}),'application/json');
        amount=requestBody.amount_fen;state='pending';credited=null;data=order();status=201;
      }
      else if(p==='/credits/recharge-orders/preview-topup-975/close'&&method==='POST'){if(state!=='paid')state='expired';data=order();}
      else if(p==='/commerce/topups/preview-topup-975'||p==='/commerce/topups/preview-topup-975/refresh'){if(unavailable){status=503;data={code:'PAYMENT_UNAVAILABLE'};}else data=order();}
      else if(p==='/commerce/topups/preview-topup-975/refund-eligibility')data={order_id:'preview-topup-975',currency:'CNY',order_amount_fen:amount,paid_amount_fen:paid?amount:'0',original_points:amount,refundable_points:'0',refunded_points:'0',request_unit:'amount_fen',refundable_fen:'0',held_refund_fen:'0',refunded_fen:'0',enabled:false,reason:'此本地预览不处理退款',refunds:[]};
      else{status=404;data={code:'NOT_FOUND'};}
      const wire=billingWireRoute(method,path)?.response;
      return send(status,JSON.stringify(status<400&&wire?encodeBillingDto(wire,data):data),'application/json; charset=utf-8');
    }
    let file=resolve(dist,'.'+(path==='/'?'/index.html':decodeURIComponent(path)));
    if(path==='/__preview/prototype')file=resolve(root,'product-prototype/public/payment-experience.html');
    if(path==='/__preview/payment-experience.css')file=resolve(root,'product-prototype/public/payment-experience.css');
    const prototypeAsset=path==='/__preview/prototype'||path==='/__preview/payment-experience.css';
    if(!prototypeAsset&&!file.startsWith(dist+sep))return send(403,'Forbidden');
    let content=await readFile(file);
    if(file===resolve(dist,'index.html'))content=Buffer.from(content.toString().replace('</body>','<script src="/__preview/ui.js"></script></body>'));
    const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'}[extname(file)]??'application/octet-stream';
    return send(200,content,type);
  }catch(error){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('本地预览内容暂不可用');console.error(error.message);}
});
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic UI preview: ${origin}/__preview\nNo production database or payment connection. Stop with Ctrl+C.`));
