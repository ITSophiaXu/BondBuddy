import {generateKeyPairSync,sign,verify} from 'node:crypto';
import type {AlipayPayOptions} from './alipay-pay.js';

/** Generated keys and invented merchant/order data. No sandbox or merchant traffic. */
export function syntheticAlipayFixture(){
  const app=generateKeyPairSync('rsa',{modulusLength:2048}),platform=generateKeyPairSync('rsa',{modulusLength:2048}),now=Date.parse('2026-10-29T04:00:00Z');
  const options:AlipayPayOptions={appId:'2026000000000001',merchantId:'2088000000000001',webProduct:'page',
    appPrivateKeyPem:app.privateKey.export({type:'pkcs8',format:'pem'}).toString(),alipayPublicKeyPem:platform.publicKey.export({type:'spki',format:'pem'}).toString(),
    notifyUrl:'https://synthetic.bondbuddy.test/api/v1/payments/alipay/callback',returnUrl:'https://synthetic.bondbuddy.test/billing'};
  const order={id:'synthetic_alipay_order_1',merchant_id:options.merchantId,currency:'CNY' as const,amount_fen:10000,expires_at:new Date(now+1800000).toISOString()};
  const paid={code:'10000',msg:'Success',out_trade_no:order.id,trade_no:'synthetic_alipay_trade_1',total_amount:'100.00',buyer_pay_amount:'100.00',trade_status:'TRADE_SUCCESS',send_pay_date:'2026-10-29 12:01:00'};
  const refund={id:'synthetic_refund_1',order_id:order.id,merchant_id:options.merchantId,provider_transaction_id:paid.trade_no,currency:'CNY' as const,order_amount_fen:10000,amount_fen:2500};
  const refunded={code:'10000',msg:'Success',out_trade_no:order.id,trade_no:paid.trade_no,out_request_no:refund.id,total_amount:'100.00',refund_amount:'25.00',present_refund_buyer_amount:'25.00',refund_status:'REFUND_SUCCESS'};
  const signedResponse=(method:string,data:unknown,rawData=JSON.stringify(data),key=platform.privateKey)=>{
    const signature=sign('RSA-SHA256',Buffer.from(rawData),key).toString('base64');
    return `{"${method.replaceAll('.','_')}_response":${rawData},"sign":${JSON.stringify(signature)}}`;
  };
  const response=(method:string,data:unknown,rawData?:string)=>new Response(signedResponse(method,data,rawData),{headers:{'content-type':'application/json;charset=utf-8'}});
  const callback=(changes:Record<string,string|undefined>={})=>{
    const fields:Record<string,string>={app_id:options.appId,seller_id:options.merchantId,notify_type:'trade_status_sync',notify_id:'synthetic_notify_1',notify_time:'2026-10-29 12:00:10',charset:'utf-8',version:'1.0',
      out_trade_no:order.id,trade_no:paid.trade_no,trade_status:'TRADE_SUCCESS',total_amount:'100.00',buyer_pay_amount:'100.00',gmt_payment:'2026-10-29 12:00:00',subject:'synthetic % + 中文',sign_type:'RSA2'};
    for(const [key,value] of Object.entries(changes)){if(value===undefined)delete fields[key];else fields[key]=value;}
    const message=Object.keys(fields).filter(key=>!['sign','sign_type'].includes(key)).sort().map(key=>`${key}=${fields[key]}`).join('&');
    fields.sign=sign('RSA-SHA256',Buffer.from(message),platform.privateKey).toString('base64');
    return {raw:new URLSearchParams(fields).toString(),headers:{'content-type':'application/x-www-form-urlencoded; charset=utf-8'},fields};
  };
  const request=(input:unknown)=>{
    const fields=Object.fromEntries(new URLSearchParams(String(input))),signature=fields.sign;delete fields.sign;
    const message=Object.keys(fields).sort().map(key=>`${key}=${fields[key]}`).join('&');
    if(!verify('RSA-SHA256',Buffer.from(message),app.publicKey,Buffer.from(signature,'base64')))throw Error('Synthetic request signature invalid');
    return {fields,biz:JSON.parse(fields.biz_content)};
  };
  return {app,platform,now,options,order,paid,refund,refunded,signedResponse,response,callback,request};
}
