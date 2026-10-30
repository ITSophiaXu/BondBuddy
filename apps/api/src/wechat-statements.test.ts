import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,verify} from 'node:crypto';
import {createWechatPayProvider,WechatPayError} from './wechat-pay.js';
import {syntheticWechatFixture} from './test-wechat-pay-fixtures.js';
import {syntheticTradeStatement,statementFixtureDate} from './test-payment-statements.js';
const f=syntheticWechatFixture(),bytes=Buffer.from(syntheticTradeStatement());
const manifest={hash_type:'SHA1',hash_value:createHash('sha1').update(bytes).digest('hex'),download_url:'https://api.mch.weixin.qq.com/v3/billdownload/file?token=synthetic-token'};
const input={billDate:statementFixtureDate,kind:'trade' as const};
const rejected=(error:unknown)=>error instanceof WechatPayError;

test('statement capability defaults off and signed manifest binds an authenticated bounded download',async()=>{
  assert.equal(createWechatPayProvider(f.options).downloadStatements,undefined);let calls=0;
  const provider=createWechatPayProvider({...f.options,statementsEnabled:true},{now:()=>f.now,fetch:async(url,init)=>{
    calls++;const target=new URL(String(url)),headers=new Headers(init?.headers),auth=headers.get('authorization')!;
    const fields=Object.fromEntries([...auth.matchAll(/([a-z_]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
    assert.equal(verify('RSA-SHA256',Buffer.from(`GET\n${target.pathname+target.search}\n${fields.timestamp}\n${fields.nonce_str}\n\n`),f.merchant.publicKey,Buffer.from(fields.signature,'base64')),true);
    assert.equal(init?.redirect,'error');
    if(calls===1){assert.equal(target.pathname,'/v3/bill/tradebill');assert.equal(target.searchParams.get('bill_type'),'ALL');assert.equal(target.searchParams.has('tar_type'),false);return f.response(manifest);}
    assert.equal(headers.get('accept-encoding'),'identity');return new Response(bytes); // Official file response intentionally has no response signature.
  }});
  const result=await provider.downloadStatements!(input);assert.equal(calls,2);assert.equal(result.provider,'wechat');assert.equal(result.sha1,manifest.hash_value);assert.equal(result.totals!.nominalFen,10000);
});
test('statement URL restrictions prevent forwarding merchant authorization to redirects, external hosts or other API paths',async()=>{
  for(const url of ['https://evil.example/v3/billdownload/file?token=x','https://api.mch.weixin.qq.com.evil.example/v3/billdownload/file?token=x',
    'http://api.mch.weixin.qq.com/v3/billdownload/file?token=x','https://api.mch.weixin.qq.com/v3/pay/transactions/native?token=x',
    'https://api.mch.weixin.qq.com/v3/billdownload/file?token=x&token=y','https://user:password@api.mch.weixin.qq.com/v3/billdownload/file?token=x']){
    let calls=0;const p=createWechatPayProvider({...f.options,statementsEnabled:true},{now:()=>f.now,fetch:async()=>{calls++;return f.response({...manifest,download_url:url});}});
    await assert.rejects(()=>p.downloadStatements!(input),rejected);assert.equal(calls,1);
  }
});
test('unsigned manifests, hash mismatches, compressed payloads and HTTP redirects are never accepted as statement evidence',async()=>{
  for(const mode of ['unsigned','hash','gzip','redirect']){
    let calls=0;const p=createWechatPayProvider({...f.options,statementsEnabled:true},{now:()=>f.now,fetch:async()=>{
      calls++;if(calls===1)return mode==='unsigned'?new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}}):f.response(manifest);
      if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.example/'}});
      if(mode==='gzip')return new Response(bytes,{headers:{'content-encoding':'gzip'}});
      return new Response(Buffer.from('tampered'));
    }});await assert.rejects(()=>p.downloadStatements!(input),rejected);assert.equal(calls,mode==='unsigned'?1:2);
  }
});
test('download stops on its first excessive chunk and authenticated absence differs from unsigned failure',async()=>{
  let calls=0,cancelled=false;
  const large=createWechatPayProvider({...f.options,statementsEnabled:true},{now:()=>f.now,fetch:async()=>++calls===1?f.response(manifest):new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(10*1024*1024+1));},cancel(){cancelled=true;}}))});
  await assert.rejects(()=>large.downloadStatements!(input),rejected);assert.equal(cancelled,true);
  const raw=JSON.stringify({code:'NO_STATEMENT_EXIST'});
  for(const signed of [false,true]){
    const p=createWechatPayProvider({...f.options,statementsEnabled:true},{now:()=>f.now,fetch:async()=>new Response(raw,{status:400,headers:{'content-type':'application/json',...(signed?f.signed(raw) as Record<string,string>:{})}})});
    if(signed)assert.equal((await p.downloadStatements!(input)).availability,'absent');else await assert.rejects(()=>p.downloadStatements!(input),rejected);
  }
});
test('close signs the original merchant order, verifies 204, and preserves a payment that wins the close race',async()=>{
  for(const state of ['CLOSED','SUCCESS']){
    let calls=0;const p=createWechatPayProvider(f.options,{now:()=>f.now,fetch:async(url,init)=>{
      calls++;if(calls===1){assert.equal(new URL(String(url)).pathname,`/v3/pay/transactions/out-trade-no/${f.order.id}/close`);assert.deepEqual(JSON.parse(String(init?.body)),{mchid:f.options.merchantId});return new Response(null,{status:204,headers:f.signed('') as Record<string,string>});}
      return f.response({...f.paid,trade_state:state});
    }});assert.equal((await p.closePayment!(f.order)).state,state==='SUCCESS'?'paid':'expired');assert.equal(calls,2);
  }
  let requests=0;const uncertain=createWechatPayProvider(f.options,{now:()=>f.now,fetch:async()=>{requests++;return new Response(null,{status:204});}});
  await assert.rejects(()=>uncertain.closePayment!(f.order),rejected);assert.equal(requests,2,'an unsigned close must not fabricate a closed receipt');
});
