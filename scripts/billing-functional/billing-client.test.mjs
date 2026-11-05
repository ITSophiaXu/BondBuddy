import test from 'node:test';
import assert from 'node:assert/strict';
import {accountReturn,money,yuanToFen,send,storedAction} from './billing-client.js';

test('cashier preserves exact monetary strings and rejects ambiguous yuan input',()=>{
  assert.equal(money('9007199254740993'),'¥90,071,992,547,409.93');
  assert.equal(yuanToFen('12.18'),'1218');assert.equal(yuanToFen('0.01'),'1');assert.equal(yuanToFen('100'),'10000');
  for(const value of ['0','-1','1.234','1e3','1,000','Infinity','00.01','.01'])assert.equal(yuanToFen(value),null,value);
});

test('cashier return is same-origin account context for the exact original order',()=>{
  const origin='http://localhost:5189',fallback='/#/account?order=owned';
  const original='/#/account?order=owned&resume_request=original-task&return_to=%23qa%3Fproject%3Doriginal-project';
  assert.equal(accountReturn('owned',original,origin),original);
  for(const value of ['https://outside.invalid/#/account?order=owned','javascript:alert(1)','/__billing-test?order=owned','/#/account?order=other','/#/qa?order=owned','//outside.invalid/#/account?order=owned'])assert.equal(accountReturn('owned',value,origin),fallback,value);
});

async function mockedClient(work){
  const fetch=globalThis.fetch,descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
  globalThis.document={cookie:'bb_csrf=before-refresh'};
  try{await work();}finally{globalThis.fetch=fetch;if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else delete globalThis.document;}
}
const response=(status,data)=>({status,ok:status<400,json:async()=>data});

test('explicit expired session permits one refresh and identical financial-request replay',()=>mockedClient(async()=>{
  const calls=[];
  globalThis.fetch=async(path,options)=>{
    calls.push({path,body:options.body,csrf:options.headers['x-bb-csrf'],credentials:options.credentials});
    if(path==='/api/v1/auth/refresh'){document.cookie='bb_csrf=after-refresh';return response(200,{});}
    return calls.length===1?response(401,{code:'UNAUTHENTICATED'}):response(200,{synthetic:true});
  };
  assert.deepEqual(await send('refund/request',{id:'original',amount_fen:'9007199254740993',request_id:'unchanged'}),{synthetic:true});
  assert.equal(calls.length,3);assert.equal(calls[0].body,calls[2].body);assert.equal(calls[0].csrf,'before-refresh');assert.equal(calls[2].csrf,'after-refresh');
  assert.ok(calls.every(call=>call.credentials==='same-origin'));assert.match(calls[0].body,/"amount_fen":"9007199254740993"/);
}));

test('unknown or forbidden financial result is never automatically retried',()=>mockedClient(async()=>{
  for(const status of [403,500,'network']){
    let calls=0;globalThis.fetch=async()=>{calls++;if(status==='network')throw Error('Network failed');return response(status,{code:'SYNTHETIC_FAILURE'});};
    await assert.rejects(send('payment/outcome',{id:'original',outcome:'paid',delivery:'query'}));assert.equal(calls,1,String(status));
  }
}));

test('a second 401 stops after one refresh and one exact replay',()=>mockedClient(async()=>{
  const calls=[];globalThis.fetch=async(path,options)=>{calls.push({path,body:options.body});return path==='/api/v1/auth/refresh'?response(200,{}):response(401,{code:'UNAUTHENTICATED'});};
  await assert.rejects(send('payment/close',{id:'original'}),error=>error.status===401);
  assert.equal(calls.filter(call=>call.path==='/api/v1/auth/refresh').length,1);assert.equal(calls.length,3);assert.equal(calls[0].body,calls[2].body);
}));

test('lost financial-action response retains its exact event ID across a recreated UI',async()=>{
  const entries=new Map(),storage={getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
  let created=0;const calls=[];
  const options={key:'owner-and-subscription-event',storage,create:()=>({id:'stable-event-'+(++created)}),validate:intent=>typeof intent.id==='string',accepted:result=>result.synthetic===true};
  await assert.rejects(storedAction({...options,perform:async intent=>{calls.push(JSON.stringify(intent));throw Error('Response lost after application');}}));
  assert.equal(entries.size,1);
  await storedAction({...options,perform:async intent=>{calls.push(JSON.stringify(intent));return{synthetic:true};}});
  assert.equal(created,1);assert.equal(calls[0],calls[1]);assert.equal(entries.size,0);
});

test('unreliable storage blocks a financial request and mismatched acknowledgement retains the original event',async()=>{
  let calls=0;const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  await assert.rejects(storedAction({key:'event',storage,create:()=>({id:'original'}),validate:()=>true,accepted:()=>true,perform:async()=>{calls++;}}));
  assert.equal(calls,0);
  const entries=new Map(),reliable={getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};
  await assert.rejects(storedAction({key:'event',storage:reliable,create:()=>({id:'original'}),validate:()=>true,accepted:()=>false,perform:async()=>({wrongOwner:true})}));
  assert.equal(JSON.parse(entries.get('event')).id,'original');
});
