import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import {AlipaySdk} from 'alipay-sdk';
import type {PaymentOrder,PaymentProvider,VerifiedPayment} from './payments.js';
import type {RefundOrder,VerifiedRefund} from './payment-refunds.js';
import {createAlipayStatementDownloader,type AlipayStatementMetadata} from './alipay-statements.js';

const gateways={production:'https://openapi.alipay.com/gateway.do',sandbox:'https://openapi-sandbox.dl.alipaydev.com/gateway.do'} as const,maxBody=65536;
export type AlipayWebProduct='page'|'wap';
export type AlipayPayOptions={appId:string;merchantId:string;webProduct:AlipayWebProduct;appPrivateKeyPem:string;alipayPublicKeyPem:string;
  environment?:keyof typeof gateways;appPrivateKeyType?:'PKCS1'|'PKCS8';
  notifyUrl?:string;returnUrl:string;refundsEnabled?:boolean;statementsEnabled?:boolean;timeoutMs?:number};
export type AlipayPaymentProvider=PaymentProvider & {createCheckoutForm(order:PaymentOrder):Promise<string>};
export type AlipayPayDependencies={fetch?:typeof fetch;now?:()=>number};
export class AlipayPayError extends Error{constructor(readonly code:string){super('Alipay payment '+code);this.name='AlipayPayError';}}
const fail=(code:string):never=>{throw new AlipayPayError(code);};
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value)?value:fail('RECEIPT_INVALID');
/** Official CNY fields are decimal strings, never floating point JSON numbers. */
export function alipayMoneyFen(value:unknown):number{
  if(typeof value!=='string'||!/^\d{1,9}(?:\.\d{1,2})?$/.test(value))return fail('RECEIPT_INVALID');
  const [whole,fraction='']=value.split('.'),amount=Number(BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')));
  if(!Number.isSafeInteger(amount)||amount>10000000000)return fail('RECEIPT_INVALID');return amount;
}
const yuan=(fen:number)=>`${Math.floor(fen/100)}.${String(fen%100).padStart(2,'0')}`;
const chinaTime=(time:number)=>new Date(time+8*3600000).toISOString().slice(0,19).replace('T',' ');
const paymentTime=(value:unknown)=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value))return fail('RECEIPT_INVALID');
  const time=Date.parse(value.replace(' ','T')+'+08:00');
  if(!Number.isFinite(time)||chinaTime(time)!==value)return fail('RECEIPT_INVALID');return new Date(time).toISOString();
};
function checkUrl(value:string,notify=false,sandbox=false){
  let url:URL;try{url=new URL(value);}catch{return fail('CONFIG_INVALID');}
  const localReturn=sandbox&&!notify&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(value.length>2048||url.protocol!=='https:'&&!localReturn||url.username||url.password||url.hash||url.search
    ||notify&&url.pathname!=='/api/v1/payments/alipay/callback')return fail('CONFIG_INVALID');
}
function jsonObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return fail('PAYLOAD_INVALID');return value as Record<string,unknown>;}

/** Preserve the exact response-object substring. Reject duplicate envelope keys,
 * escaped envelope names and trailing data before the official SDK verifies it.
 * JSON.parse/stringify must never reconstruct the text covered by the signature. */
function signedResponse(raw:string,key:string,sdk:AlipaySdk):Record<string,unknown>{
  let at=0;const parts=new Map<string,string>();
  const whitespace=()=>{while(/[\x20\t\r\n]/.test(raw[at]??'!'))at++;};
  const stringEnd=()=>{if(raw[at++]!=='"')return fail('PAYLOAD_INVALID');while(at<raw.length){const c=raw[at++];if(c==='"')return;if(c==='\\')at++;}return fail('PAYLOAD_INVALID');};
  whitespace();if(raw[at++]!=='{')return fail('PAYLOAD_INVALID');whitespace();
  while(at<raw.length&&raw[at]!=='}'){
    const start=at;stringEnd();const nameRaw=raw.slice(start,at);let name:unknown;
    try{name=JSON.parse(nameRaw);}catch{return fail('PAYLOAD_INVALID');}
    if(typeof name!=='string'||nameRaw!==JSON.stringify(name)||parts.has(name))return fail('PAYLOAD_INVALID');
    whitespace();if(raw[at++]!==':')return fail('PAYLOAD_INVALID');whitespace();const valueStart=at;
    if(raw[at]==='"')stringEnd();
    else if(raw[at]==='{'||raw[at]==='['){
      const stack:string[]=[];
      do{const c=raw[at];if(c==='"'){stringEnd();continue;}at++;
        if(c==='{'||c==='[')stack.push(c);else if(c==='}'||c===']'){if(stack.pop()!==(c==='}'?'{':'['))return fail('PAYLOAD_INVALID');}
      }while(stack.length&&at<raw.length);
      if(stack.length)return fail('PAYLOAD_INVALID');
    }else{while(at<raw.length&&raw[at]!==','&&raw[at]!=='}')at++;}
    parts.set(name,raw.slice(valueStart,at));whitespace();
    if(raw[at]===','){at++;whitespace();if(raw[at]==='}')return fail('PAYLOAD_INVALID');}
    else if(raw[at]!=='}')return fail('PAYLOAD_INVALID');
  }
  if(raw[at++]!=='}')return fail('PAYLOAD_INVALID');whitespace();if(at!==raw.length)return fail('PAYLOAD_INVALID');
  if(!parts.has(key)||parts.has('error_response')||[...parts.keys()].some(name=>![key,'sign','sign_type','alipay_cert_sn'].includes(name)))return fail('PAYLOAD_INVALID');
  let signature:unknown,payload:unknown;
  try{signature=JSON.parse(parts.get('sign')??'null');payload=JSON.parse(parts.get(key)!);
    if(parts.has('sign_type')&&JSON.parse(parts.get('sign_type')!)!=='RSA2')return fail('SIGNATURE_INVALID');
  }catch(error){if(error instanceof AlipayPayError)throw error;return fail('PAYLOAD_INVALID');}
  if(typeof signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)||signature.length>1024)return fail('SIGNATURE_INVALID');
  try{if(!sdk.rsaCheck(parts.get(key)!,signature,'RSA2'))return fail('SIGNATURE_INVALID');}
  catch{return fail('SIGNATURE_INVALID');}
  return jsonObject(payload);
}

function callbackForm(headers:FastifyRequest['headers'],raw:string):Record<string,string>{
  if(typeof headers['content-type']!=='string'||!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(headers['content-type'])
    ||typeof raw!=='string'||Buffer.byteLength(raw)>maxBody||!raw)return fail('PAYLOAD_INVALID');
  const result:Record<string,string>=Object.create(null),pairs=raw.split('&');if(pairs.length>128)return fail('PAYLOAD_INVALID');
  for(const pair of pairs){const separator=pair.indexOf('=');if(separator<1)return fail('PAYLOAD_INVALID');let key:string,value:string;
    try{key=decodeURIComponent(pair.slice(0,separator).replaceAll('+',' '));value=decodeURIComponent(pair.slice(separator+1).replaceAll('+',' '));}catch{return fail('PAYLOAD_INVALID');}
    if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||['__proto__','prototype','constructor'].includes(key)||Object.hasOwn(result,key))return fail('PAYLOAD_INVALID');result[key]=value;
  }
  return result;
}

/** Direct-merchant public-key mode only. Web checkout is one payment, never a mandate. */
export function createAlipayPayProvider(options:AlipayPayOptions,dependencies:AlipayPayDependencies={}):AlipayPaymentProvider{
  const now=dependencies.now??Date.now,fetcher=dependencies.fetch??fetch,timeoutMs=options.timeoutMs??10000;
  const environment=options.environment??'production',gateway=gateways[environment];
  let sdk:AlipaySdk;
  try{
    if(!(environment==='sandbox'?/^\d{16}$/:/^20\d{14}$/).test(options.appId)||!/^2088\d{12}$/.test(options.merchantId)||!['page','wap'].includes(options.webProduct)
      ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||options.refundsEnabled!==undefined&&typeof options.refundsEnabled!=='boolean'
      ||options.statementsEnabled!==undefined&&typeof options.statementsEnabled!=='boolean'||!gateway
      ||environment==='sandbox'&&(options.webProduct!=='page'||options.statementsEnabled)
      ||options.appPrivateKeyType!==undefined&&!['PKCS1','PKCS8'].includes(options.appPrivateKeyType))return fail('CONFIG_INVALID');
    if(options.notifyUrl!==undefined)checkUrl(options.notifyUrl,true);
    else if(environment!=='sandbox')return fail('CONFIG_INVALID');
    checkUrl(options.returnUrl,false,environment==='sandbox');
    // Raw Skill keys go unchanged into the SDK. PEM is constructed only for
    // native crypto validation, never persisted or substituted into SDK config.
    const raw=options.appPrivateKeyType!==undefined;
    if(raw&&![options.appPrivateKeyPem,options.alipayPublicKeyPem].every(value=>/^[A-Za-z0-9+/]+={0,2}$/.test(value)))return fail('CONFIG_INVALID');
    const privateKey=createPrivateKey(raw?`-----BEGIN ${options.appPrivateKeyType==='PKCS1'?'RSA ':''}PRIVATE KEY-----\n${options.appPrivateKeyPem}\n-----END ${options.appPrivateKeyType==='PKCS1'?'RSA ':''}PRIVATE KEY-----`:options.appPrivateKeyPem);
    const publicKey=createPublicKey(raw?`-----BEGIN PUBLIC KEY-----\n${options.alipayPublicKeyPem}\n-----END PUBLIC KEY-----`:options.alipayPublicKeyPem);
    for(const key of [privateKey,publicKey])if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)return fail('CONFIG_INVALID');
    if(createPublicKey(privateKey).export({type:'spki',format:'pem'})===publicKey.export({type:'spki',format:'pem'}))return fail('CONFIG_INVALID');
    sdk=new AlipaySdk({appId:options.appId,privateKey:raw?options.appPrivateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),keyType:options.appPrivateKeyType??'PKCS8',
      alipayPublicKey:raw?options.alipayPublicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString(),signType:'RSA2',charset:'utf-8',gateway,camelcase:false,timeout:timeoutMs});
  }catch{return fail('CONFIG_INVALID');}
  const orderValid=(order:PaymentOrder,creating=false)=>{
    if(order.merchant_id!==options.merchantId||order.currency!=='CNY'||!Number.isSafeInteger(order.amount_fen)||order.amount_fen<1||order.amount_fen>10000000000
      ||!Number.isFinite(Date.parse(order.expires_at))||!order.id||!/^[A-Za-z0-9_]{1,64}$/.test(order.id)
      ||creating&&(Date.parse(order.expires_at)-now()<60000||Date.parse(order.expires_at)-now()>15*86400000))return fail('ORDER_INVALID');
  };
  const requestEvidence=async(method:string,bizContent:Record<string,unknown>):Promise<AlipayStatementMetadata>=>{
    const controller=new AbortController(),resources:{body:ReadableStream<Uint8Array>|null}={body:null};let timeout:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([(async()=>{
      // SDK creates the exact form signature; fetch keeps the established Node
      // environment-proxy policy and a bound on both headers and response bytes.
      const body=sdk.sdkExecute(method,{bizContent,timestamp:chinaTime(now())},{bizContentAutoSnakeCase:false});
      const response=await fetcher(gateway,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=utf-8',accept:'application/json'},body,signal:controller.signal,redirect:'error'});
      resources.body=response.body;
      // Alipay's gateway also labels signed JSON as text/html. Both MIME types
      // still require the bounded JSON envelope and exact-byte RSA2 verification.
      if(response.status!==200||!/^(?:application\/json|text\/html)(?:\s*;|$)/i.test(response.headers.get('content-type')??''))return fail('HTTP_INVALID');
      const contentLength=response.headers.get('content-length');if(contentLength&&(!/^\d+$/.test(contentLength)||Number(contentLength)>maxBody))return fail('PAYLOAD_TOO_LARGE');
      if(!response.body)return fail('PAYLOAD_INVALID');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maxBody){cancel();return fail('PAYLOAD_TOO_LARGE');}chunks.push(item.value);}}
      finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock();}
      let raw:string;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return fail('PAYLOAD_INVALID');}
      const data=signedResponse(raw,method.replaceAll('.','_')+'_response',sdk);
      return {data,signedResponseSha256:createHash('sha256').update(raw).digest('hex'),verifiedAt:new Date(now()).toISOString()};
    })(),new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new AlipayPayError('TIMEOUT'));},timeoutMs);})]);}
    catch(error){if(error instanceof AlipayPayError)throw error;return fail('NETWORK_INVALID');}
    finally{controller.abort();if(resources.body&&!resources.body.locked)void resources.body.cancel().catch(()=>{});if(timeout)clearTimeout(timeout);}
  };
  const request=async(method:string,bizContent:Record<string,unknown>)=>(await requestEvidence(method,bizContent)).data;
  const downloadStatements=options.statementsEnabled?createAlipayStatementDownloader({merchantId:options.merchantId,appId:options.appId,
    timeoutMs,now,fetch:fetcher,query:billDate=>requestEvidence('alipay.data.dataservice.bill.downloadurl.query',{bill_type:'trade',bill_date:billDate,secure:'true'})}):undefined;
  const original=async(order:PaymentOrder)=>{
    orderValid(order);const data=await request('alipay.trade.query',{out_trade_no:order.id});
    if(data.code!=='10000')return {data,matched:false};
    if(id(data.out_trade_no)!==order.id||alipayMoneyFen(data.total_amount)!==order.amount_fen||data.seller_id!==undefined&&data.seller_id!==options.merchantId
      ||data.app_id!==undefined&&data.app_id!==options.appId)return fail('RECEIPT_INVALID');
    for(const field of ['trans_currency','pay_currency','settle_currency','currency'])if(data[field]!==undefined&&data[field]!=='CNY')return fail('RECEIPT_INVALID');
    if(data.credit_pay_mode||data.auth_trade_pay_mode||data.alipay_sub_merchant_id)return fail('RECEIPT_INVALID');
    return {data,matched:true};
  };
  const payment=async(order:PaymentOrder,verifiedClose=false):Promise<VerifiedPayment>=>{
    const {data,matched}=await original(order);
    const base={orderId:order.id,merchantId:options.merchantId,amountFen:order.amount_fen,currency:'CNY'};
    if(!matched){if(data.code==='40004'&&data.sub_code==='ACQ.TRADE_NOT_EXIST'&&now()>=Date.parse(order.expires_at))return {...base,transactionId:null,state:'expired'};return fail('CHANNEL_UNRESOLVED');}
    const transactionId=id(data.trade_no),status=data.trade_status;
    if(status==='WAIT_BUYER_PAY')return {...base,transactionId,state:'pending'};
    // TRADE_CLOSED also denotes a fully refunded old payment. Do not turn that
    // into a newly failed/unpaid order based on status alone.
    if(status==='TRADE_CLOSED'){
      if((data.buyer_pay_amount!==undefined&&alipayMoneyFen(data.buyer_pay_amount)===0||verifiedClose&&data.buyer_pay_amount===undefined)&&!data.send_pay_date&&!data.gmt_payment)
        return {...base,transactionId,state:'expired'};
      return fail('CLOSED_PAYMENT_REQUIRES_RECONCILIATION');
    }
    if(status!=='TRADE_SUCCESS'&&status!=='TRADE_FINISHED')return fail('RECEIPT_INVALID');
    const cash=data.buyer_pay_amount===undefined?undefined:alipayMoneyFen(data.buyer_pay_amount);if(cash!==undefined&&cash>order.amount_fen)return fail('RECEIPT_INVALID');
    // send_pay_date is seller transfer time, not customer payment time.
    return {...base,transactionId,state:'paid',...(cash!==undefined?{payerCash:{amountFen:cash,currency:'CNY'}}:{})};
  };
  const refundOrderValid=(order:RefundOrder)=>{
    if(order.merchant_id!==options.merchantId||order.currency!=='CNY'||!Number.isSafeInteger(order.order_amount_fen)||!Number.isSafeInteger(order.amount_fen)
      ||order.amount_fen<1||order.amount_fen>order.order_amount_fen||order.order_amount_fen>10000000000)return fail('ORDER_INVALID');
    id(order.id);id(order.order_id);id(order.provider_transaction_id);
  };
  const originalCash=async(order:RefundOrder,creating=false)=>{
    refundOrderValid(order);const {data,matched}=await original({id:order.order_id,merchant_id:order.merchant_id,currency:'CNY',amount_fen:order.order_amount_fen,expires_at:new Date(now()).toISOString()});
    if(!matched||data.trade_no!==order.provider_transaction_id||!['TRADE_SUCCESS',...(creating?[]:['TRADE_FINISHED','TRADE_CLOSED'])].includes(String(data.trade_status)))return fail('REFUND_UNRESOLVED');
    if(data.buyer_pay_amount===undefined||alipayMoneyFen(data.buyer_pay_amount)!==order.order_amount_fen)return fail('REFUND_CASH_EVIDENCE_MISSING');
    return alipayMoneyFen(data.buyer_pay_amount);
  };
  const queryRefund=async(order:RefundOrder):Promise<VerifiedRefund>=>{
    const payerTotalFen=await originalCash(order),data=await request('alipay.trade.fastpay.refund.query',{
      out_trade_no:order.order_id,trade_no:order.provider_transaction_id,out_request_no:order.id,query_options:['refund_detail_item_list','refund_voucher_detail_list','gmt_refund_pay']});
    if(data.code!=='10000'||data.refund_status!=='REFUND_SUCCESS')return fail('REFUND_UNRESOLVED');
    if(id(data.out_trade_no)!==order.order_id||id(data.trade_no)!==order.provider_transaction_id||id(data.out_request_no)!==order.id
      ||alipayMoneyFen(data.total_amount)!==order.order_amount_fen||alipayMoneyFen(data.refund_amount)!==order.amount_fen
      ||data.refund_currency!==undefined&&data.refund_currency!=='CNY')return fail('RECEIPT_INVALID');
    // Neither refund_fee (cumulative) nor send_back_fee (merchant funds) proves
    // this refund's buyer cash. A missing negotiated field leaves the hold intact.
    if(data.present_refund_buyer_amount===undefined)return fail('REFUND_CASH_EVIDENCE_MISSING');
    const payerRefundFen=alipayMoneyFen(data.present_refund_buyer_amount);if(payerRefundFen!==order.amount_fen)return fail('REFUND_CASH_EVIDENCE_MISSING');
    // Alipay identifies this refund by a pair, rather than a standalone ordinary
    // merchant refund transaction ID. Normalize the authenticated pair without
    // ambiguous separators or changing the ledger's allowed identifier alphabet.
    const providerRefundId='alipay_'+createHash('sha256').update(JSON.stringify([id(data.trade_no),id(data.out_request_no)])).digest('hex');
    return {refundId:order.id,orderId:order.order_id,merchantId:options.merchantId,transactionId:order.provider_transaction_id,providerRefundId,
      currency:'CNY',orderAmountFen:order.order_amount_fen,amountFen:order.amount_fen,payerTotalFen,payerRefundFen,state:'succeeded',
      // Official refund-query option: execution success time, not the request
      // time or merchant transfer time. An absent value remains unknown.
      ...(data.gmt_refund_pay===undefined?{}:{providerSucceededAt:paymentTime(data.gmt_refund_pay)})};
  };
  const createRefund=async(order:RefundOrder):Promise<VerifiedRefund>=>{
    await originalCash(order,true);
    const data=await request('alipay.trade.refund',{out_trade_no:order.order_id,trade_no:order.provider_transaction_id,out_request_no:order.id,refund_amount:yuan(order.amount_fen),
      refund_reason:'Unused BondBuddy service balance',query_options:['refund_detail_item_list','refund_voucher_detail_list']});
    if(data.code!=='10000')return fail('REFUND_UNRESOLVED');
    if(id(data.out_trade_no)!==order.order_id||id(data.trade_no)!==order.provider_transaction_id)return fail('RECEIPT_INVALID');
    // fund_change=N may be a successful idempotent replay. Always query the same
    // original out_request_no; never use cumulative refund_fee as this receipt.
    return queryRefund(order);
  };
  const checkout=(order:PaymentOrder,method:'GET'|'POST')=>{
    orderValid(order,true);const page=options.webProduct==='page';
    return sdk.pageExecute(page?'alipay.trade.page.pay':'alipay.trade.wap.pay',method,{
      timestamp:chinaTime(now()),...(options.notifyUrl?{notifyUrl:options.notifyUrl}:{}),returnUrl:options.returnUrl,
      // Use the official SDK's default cashier presentation. qr_pay_mode=2
      // explicitly forces the QR redirect surface; neither mode is our UI.
      bizContent:{out_trade_no:order.id,total_amount:yuan(order.amount_fen),subject:'BondBuddy 券商助手 · 积分服务',product_code:page?'FAST_INSTANT_TRADE_PAY':'QUICK_WAP_WAY',
        time_expire:chinaTime(Date.parse(order.expires_at)),...(!page?{seller_id:options.merchantId,quit_url:options.returnUrl}:{})}});
  };
  const provider:AlipayPaymentProvider={name:'alipay',merchantId:options.merchantId,acknowledgement:'success',
    createCheckoutForm:async order=>checkout(order,'POST'),
    ...(downloadStatements?{downloadStatements,statementAppId:options.appId,statementKinds:['trade'] as const,statementAccounts:[]}:{}),
    create:async order=>{
      const checkoutUrl=checkout(order,'GET');
      const url=new URL(checkoutUrl);if(url.origin!==new URL(gateway).origin||url.pathname!=='/gateway.do'||url.username||url.password||url.hash||checkoutUrl.length>4096)return fail('CHECKOUT_INVALID');
      return {checkoutUrl};
    },query:order=>payment(order),
    closePayment:async order=>{
      orderValid(order);let closed=false;
      try{const data=await request('alipay.trade.close',{out_trade_no:order.id});closed=data.code==='10000'&&id(data.out_trade_no)===order.id;}
      catch{/* Only an independently authenticated original query can resolve a close race. */}
      return payment(order,closed);
    },
    verifyCallback:async(headers,raw)=>{
      const data=callbackForm(headers,raw);
      if(data.sign_type!=='RSA2'||!data.sign||data.sign.length>1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.sign))return fail('SIGNATURE_INVALID');
      try{if(!sdk.checkNotifySignV2(data))return fail('SIGNATURE_INVALID');}catch{return fail('SIGNATURE_INVALID');}
      if(data.app_id!==options.appId||data.seller_id!==options.merchantId||data.notify_type!=='trade_status_sync'||data.charset?.toLowerCase()!=='utf-8'
        ||data.version!==undefined&&data.version!=='1.0'||!['TRADE_SUCCESS','TRADE_FINISHED'].includes(data.trade_status)
        ||['out_biz_no','gmt_refund','refund_fee'].some(field=>Object.hasOwn(data,field)))return fail('RECEIPT_INVALID');
      for(const key of ['currency','trans_currency','pay_currency','settle_currency'])if(data[key]!==undefined&&data[key]!=='CNY')return fail('RECEIPT_INVALID');
      const amountFen=alipayMoneyFen(data.total_amount),cash=data.buyer_pay_amount===undefined?undefined:alipayMoneyFen(data.buyer_pay_amount);
      if(amountFen<1||cash!==undefined&&cash>amountFen||data.credit_pay_mode||data.auth_trade_pay_mode)return fail('RECEIPT_INVALID');
      // Valid retries can arrive much later. Original-order ledger idempotency,
      // not a short callback timestamp window, prevents duplicate crediting.
      return {orderId:id(data.out_trade_no),merchantId:options.merchantId,amountFen,currency:'CNY',transactionId:id(data.trade_no),state:'paid',
        ...(cash!==undefined?{payerCash:{amountFen:cash,currency:'CNY'}}:{}),...(data.gmt_payment?{paidAt:paymentTime(data.gmt_payment)}:{})};
    }};
  return options.refundsEnabled?{...provider,refunds:{create:createRefund,query:queryRefund,recoverSameRequest:async order=>{
    try{return await queryRefund(order);}catch(error){if(!(error instanceof AlipayPayError)||error.code!=='REFUND_UNRESOLVED')throw error;}
    return createRefund(order);
  },verifyCallback:async()=>fail('REFUND_CALLBACK_UNSUPPORTED')}}:provider;
}
