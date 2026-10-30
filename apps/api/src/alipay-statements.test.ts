import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAlipayPayProvider} from './alipay-pay.js';
import {createAlipayStatementDownloader,AlipayStatementError} from './alipay-statements.js';
import {statementFixture,syntheticStatementZip,syntheticTradeCsv} from './alipay-statements-fixtures.js';
import {ALIPAY_STATEMENT_ARCHIVE_LIMIT} from './alipay-statements-archive.js';

const gateway='https://openapi.alipay.com/gateway.do';
const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const coded=(code:string)=>(error:unknown)=>error instanceof Error&&'code' in error&&error.code===code;
type Fixture=ReturnType<typeof statementFixture>;
function provider(f:Fixture,options:{data?:Record<string,unknown>;metadataResponse?:()=>Response;download?:(url:string,init:RequestInit)=>Promise<Response>;timeoutMs?:number}={}){
  const calls:{url:string;init:RequestInit}[]=[];
  const adapter=createAlipayPayProvider({...f.options,statementsEnabled:true,timeoutMs:options.timeoutMs??10000},{now:()=>f.now,
    fetch:(async(input,init={})=>{const url=String(input);calls.push({url,init});
      if(url===gateway){const request=f.request(init.body);assert.equal(request.fields.method,f.method);assert.deepEqual(request.biz,{bill_type:'trade',bill_date:f.billDate,secure:'true'});
        return options.metadataResponse?.()??f.response(f.method,options.data??f.data);}
      return options.download?options.download(url,init):f.bytesResponse();}) as typeof fetch});
  return {adapter,calls,run:()=>adapter.downloadStatements!({billDate:f.billDate,kind:'trade'})};
}

test('Alipay statements default off; explicit enable advertises only trade and the request app',()=>{
  const f=statementFixture(),fetcher=(async()=>{throw Error('must not fetch');}) as typeof fetch;
  for(const statementsEnabled of [undefined,false]){
    const adapter=createAlipayPayProvider({...f.options,statementsEnabled},{now:()=>f.now,fetch:fetcher});
    assert.equal(adapter.downloadStatements,undefined);assert.equal(adapter.statementKinds,undefined);
  }
  const {adapter}=provider(f);assert.deepEqual(adapter.statementKinds,['trade']);assert.deepEqual(adapter.statementAccounts,[]);assert.equal(adapter.statementAppId,f.options.appId);
  assert.throws(()=>createAlipayPayProvider({...f.options,statementsEnabled:'1' as unknown as boolean}),coded('CONFIG_INVALID'));
});

test('verified RSA2 URL and bounded ZIP retain local evidence only, with unresolved normalization',async()=>{
  const f=statementFixture(),{run,calls}=provider(f),result=await run();
  assert.equal(result.provider,'alipay');if(result.provider!=='alipay')throw Error('wrong provider');
  assert.equal(result.merchantId,f.options.merchantId);assert.equal(result.requestAppId,f.options.appId);assert.equal(result.sha1,null);
  assert.equal(result.sha256,digest(f.archive));assert.equal(result.byteLength,f.archive.length);
  assert.deepEqual(result.evidence,{kind:'alipay_rsa2_download_url',signedResponseSha256:digest(f.signedResponse(f.method,f.data)),downloadSha256:digest(f.archive),signedUrlMerchantId:f.options.merchantId,requestedBillDate:f.billDate,requestBillType:'trade'});
  assert.deepEqual(result.normalization,{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']});assert.deepEqual(result.entries,[]);assert.equal(result.totals,null);assert.equal(result.documents.length,1);
  const persisted=JSON.stringify(result);for(const privateValue of ['synthetic-unverified.csv','synthetic_download_token','not_a_payment',f.url,'dwbillcenter'])assert.equal(persisted.includes(privateValue),false);
  assert.equal(calls.length,2);assert.equal(calls[1].url,f.url);assert.equal(calls[1].init.redirect,'error');assert.equal(calls[1].init.method,'GET');
  assert.deepEqual(calls[1].init.headers,{accept:'application/zip,application/octet-stream'});assert.equal(calls[1].init.signal?.aborted,true);
  assert.equal('dispatcher' in calls[1].init,false);assert.equal('agent' in calls[1].init,false);
});

test('authenticated documented detail CSV produces normalized evidence without retaining raw CSV, account, filename or guessed APPID/cash',async()=>{
  const f=statementFixture(),archive=syntheticStatementZip([{name:'synthetic-private-detail.csv',bytes:Buffer.from(syntheticTradeCsv({preamble:true}))}]);
  const {run,calls}=provider(f,{download:async()=>f.bytesResponse(archive)}),result=await run();
  assert.equal(result.provider,'alipay');if(result.provider!=='alipay')throw Error('wrong provider');
  assert.equal(result.sha256,digest(archive));assert.equal(result.evidence.downloadSha256,digest(archive));
  assert.deepEqual(result.normalization,{status:'normalized',format:'alipay-trade-cn-v1'});assert.equal(result.entries.length,2);
  assert.equal(result.totals?.refund.amountFen,'2000');assert.equal(result.requestAppId,f.options.appId);
  for(const entry of result.entries){assert.equal('appId' in entry,false);assert.equal('payerCash' in entry,false);}
  const persisted=JSON.stringify(result);for(const privateValue of ['synthetic-private-detail.csv','synthetic-account','synthetic product',f.url,'dwbillcenter'])assert.equal(persisted.includes(privateValue),false);
  assert.equal(calls.length,2);
});

test('one malformed detail row keeps the authenticated archive unresolved without partial financial entries',async()=>{
  const f=statementFixture(),archive=syntheticStatementZip([{bytes:Buffer.from(syntheticTradeCsv().replace('-20.00,-19.00,-1.00','-20.00,19.00,-1.00'))}]);
  const result=await provider(f,{download:async()=>f.bytesResponse(archive)}).run();
  assert.equal(result.provider,'alipay');if(result.provider!=='alipay')throw Error('wrong provider');
  assert.deepEqual(result.normalization,{status:'unresolved',reasons:['ALIPAY_CSV_FORMAT_UNVERIFIED']});assert.deepEqual(result.entries,[]);assert.equal(result.totals,null);
  assert.equal(result.documents.length,1);assert.equal(result.sha256,digest(archive));
});

test('forged or changed metadata cannot cause a download',async()=>{
  const f=statementFixture(),altered=f.signedResponse(f.method,f.data).replace('synthetic_download_token','changed_token');
  const {run,calls}=provider(f,{metadataResponse:()=>new Response(altered,{headers:{'content-type':'application/json'}})});
  await assert.rejects(run,coded('SIGNATURE_INVALID'));assert.equal(calls.length,1);
});

test('signed metadata permits only exact HTTPS resource and one matching merchant PID',async()=>{
  const f=statementFixture();
  const invalid=[f.url.replace('https:','http:'),f.url.replace('dwbillcenter.alipay.com','dwbillcenter.alipay.com.evil.test'),
    f.url.replace('dwbillcenter.alipay.com','evil.test'),f.url.replace('dwbillcenter.alipay.com','dwbillcenter.alipay.com:444'),
    f.url.replace('dwbillcenter.alipay.com','dwbillcenter.alipay.com:443'),f.url.replace('https://','https://user@'),f.url+'#fragment',
    f.url.replace('/downloadBillFile.resource','/other.resource'),f.url.replace('/downloadBillFile.resource','/a/../downloadBillFile.resource'),
    f.url.replace('/downloadBillFile.resource','/%64ownloadBillFile.resource'),f.url+'&pid='+f.options.merchantId,
    f.url.replace('pid='+f.options.merchantId,'pid=2088000000000002'),f.url.replace('pid='+f.options.merchantId+'&',''),f.url+'&fileId=duplicate'];
  for(const url of invalid){const {run,calls}=provider(f,{data:{...f.data,bill_download_url:url}});await assert.rejects(run,AlipayStatementError);assert.equal(calls.length,1);}
});

test('unavailable, unsupported or empty-file metadata never pretends that zero business occurred',async()=>{
  const f=statementFixture();
  for(const data of [{code:'40004',sub_code:'BILL_NOT_EXIST'}, {...f.data,bill_file_code:'UNKNOWN'}, {code:'10000'}]){
    const {run,calls}=provider(f,{data});await assert.rejects(run);assert.equal(calls.length,1);
  }
  const {run}=provider(f,{data:{...f.data,bill_file_code:'EMPTY_DATA_WITH_BILL_FILE'}}),result=await run();
  assert.equal(result.provider,'alipay');if(result.provider!=='alipay')throw Error('wrong provider');
  assert.equal(result.normalization.status,'unresolved');assert.equal(result.totals,null);assert.equal(result.availability,'available');
});

test('unsupported funds/account requests and current/future/invalid dates fail before network access',async()=>{
  const f=statementFixture(),{adapter,calls}=provider(f);
  for(const input of [{billDate:f.billDate,kind:'funds' as const,accountType:'BASIC' as const},{billDate:f.billDate,kind:'trade' as const,accountType:'BASIC' as const},
    ...['2026-10-29','2026-10-30','2026-02-30','2026-1-01'].map(billDate=>({billDate,kind:'trade' as const}))])await assert.rejects(()=>adapter.downloadStatements!(input));
  assert.equal(calls.length,0);
});

test('redirects, content encodings, HTML, wrong sizes and excess declared bytes stay unresolved',async()=>{
  const f=statementFixture();
  const responses=[()=>new Response(null,{status:302,headers:{location:f.url}}),()=>f.bytesResponse(f.archive,{'content-type':'text/html'}),
    ()=>f.bytesResponse(f.archive,{'content-encoding':'gzip'}),()=>f.bytesResponse(f.archive,{'content-length':String(f.archive.length+1)}),
    ()=>f.bytesResponse(f.archive,{'content-length':String(ALIPAY_STATEMENT_ARCHIVE_LIMIT+1)}),()=>new Response(null,{headers:{'content-type':'application/zip'}})];
  for(const response of responses){const {run}=provider(f,{download:async()=>response()});await assert.rejects(run,AlipayStatementError);}
  const redirected=f.bytesResponse();Object.defineProperty(redirected,'redirected',{value:true});await assert.rejects(provider(f,{download:async()=>redirected}).run,coded('DOWNLOAD_HTTP_INVALID'));
});

test('actual response bytes have a hard cap and rejection cancels the stream',async()=>{
  const f=statementFixture();let cancelled=false;
  const {run}=provider(f,{download:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(ALIPAY_STATEMENT_ARCHIVE_LIMIT+1));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/zip'}})});
  await assert.rejects(run,coded('DOWNLOAD_TOO_LARGE'));assert.equal(cancelled,true);
});

test('download timeout aborts pending bodies and a late response is cancelled without reading',async()=>{
  const f=statementFixture();let cancelled=false,signal:AbortSignal|undefined;
  const pending=provider(f,{timeoutMs:20,download:async(_url,init)=>{signal=init.signal as AbortSignal;return new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;}}),{headers:{'content-type':'application/zip'}});}});
  await assert.rejects(pending.run,coded('DOWNLOAD_TIMEOUT'));assert.equal(cancelled,true);assert.equal(signal?.aborted,true);
  let lateCancelled=false;
  const late=provider(f,{timeoutMs:20,download:async()=>{await delay(60);return new Response(new ReadableStream<Uint8Array>({cancel(){lateCancelled=true;}}),{headers:{'content-type':'application/zip'}});}});
  await assert.rejects(late.run,coded('DOWNLOAD_TIMEOUT'));await delay(80);assert.equal(lateCancelled,true);
});

test('expired or future metadata is refused and signed URLs are queried afresh for each retry',async()=>{
  const f=statementFixture();let downloads=0;
  for(const verifiedAt of [new Date(f.now-30000).toISOString(),new Date(f.now+1).toISOString(),'invalid']){
    const run=createAlipayStatementDownloader({merchantId:f.options.merchantId,appId:f.options.appId,timeoutMs:10000,now:()=>f.now,
      query:async()=>({data:f.data,signedResponseSha256:'a'.repeat(64),verifiedAt}),fetch:(async()=>{downloads++;return f.bytesResponse();}) as typeof fetch});
    await assert.rejects(()=>run({billDate:f.billDate,kind:'trade'}),coded('METADATA_UNVERIFIED'));
  }
  assert.equal(downloads,0);
  const {run,calls}=provider(f);await run();await run();assert.equal(calls.filter(call=>call.url===gateway).length,2);assert.equal(calls.filter(call=>call.url===f.url).length,2);
});
