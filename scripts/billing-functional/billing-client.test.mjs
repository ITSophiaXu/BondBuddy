import test from 'node:test';
import assert from 'node:assert/strict';
import {accountReturn,money,yuanToFen,send,storedAction,watchSessionChanges,persistStoredIntent,acknowledgeStoredIntent} from './billing-client.js';

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

test('a late 401 cannot refresh or replay a financial action after another account replaces its CSRF cookie',()=>mockedClient(async()=>{
  const calls=[];
  globalThis.fetch=async(path,options)=>{
    calls.push({path,body:options.body});
    if(calls.length===1){document.cookie='bb_csrf=other-account';return response(401,{code:'UNAUTHENTICATED'});}
    return response(200,{synthetic:true});
  };
  await assert.rejects(send('subscription/advance',{id:'original-account-event'}),error=>error.code==='SESSION_CHANGED');
  assert.equal(calls.length,1,'no new-account refresh or financial replay is permitted');
}));

test('a session change during refresh aborts the old financial replay even if its refresh response arrives late',()=>mockedClient(async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),events=new EventTarget(),calls=[];
  globalThis.window=new EventTarget();
  Object.assign(document,{visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)});
  const unwatch=watchSessionChanges(()=>{});
  let releaseRefresh,started;const refreshStarted=new Promise(resolve=>{started=resolve;});
  globalThis.fetch=async(path,options)=>{
    calls.push({path,body:options.body,signal:options.signal});
    if(path==='/api/v1/auth/refresh'){started();return new Promise(resolve=>{releaseRefresh=resolve;});}
    return response(401,{code:'UNAUTHENTICATED'});
  };
  try{
    const pending=send('subscription/advance',{id:'original-account-event'});
    await refreshStarted;window.dispatchEvent(new Event('focus'));
    releaseRefresh(response(200,{}));
    await assert.rejects(pending,error=>error.code==='SESSION_CHANGED');
    assert.equal(calls.length,2,'a late refresh cannot cause a second financial request');
    assert.ok(calls.every(call=>call.signal.aborted));
  }finally{unwatch();if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
}));

test('a refresh returning another owner cannot replay the original financial action even before a broadcast arrives',()=>mockedClient(async()=>{
  const calls=[];
  globalThis.fetch=async(path,options)=>{
    calls.push({path,headers:options.headers});
    if(path.endsWith('/state'))return response(200,{synthetic:true,owner_user_id:'owner-a'});
    if(path==='/api/v1/auth/refresh'){document.cookie='bb_csrf=owner-b';return response(200,{user_id:'owner-b'});}
    return response(401,{code:'UNAUTHENTICATED'});
  };
  await send('state');
  await assert.rejects(send('subscription/advance',{id:'original-event'}),error=>error.code==='SESSION_CHANGED');
  assert.equal(calls.filter(call=>call.path.endsWith('/subscription/advance')).length,1);
  assert.equal(calls[1].headers['x-bb-test-owner'],'owner-a');
  globalThis.fetch=async()=>response(200,{synthetic:true});await send('state');
}));

test('the financial replay keeps its original owner binding when cookies change before the refreshed body resolves',()=>mockedClient(async()=>{
  const calls=[];
  globalThis.fetch=async(path,options)=>{
    calls.push({path,headers:options.headers});
    if(path.endsWith('/state'))return response(200,{synthetic:true,owner_user_id:'owner-a'});
    if(path==='/api/v1/auth/refresh')return {status:200,ok:true,json:async()=>{document.cookie='bb_csrf=owner-b';return {user_id:'owner-a'};}};
    if(calls.length===2)return response(401,{code:'UNAUTHENTICATED'});
    assert.equal(options.headers['x-bb-test-owner'],'owner-a');assert.equal(options.headers['x-bb-csrf'],'owner-b');
    return response(403,{code:'CSRF_DENIED'});
  };
  await send('state');
  await assert.rejects(send('subscription/advance',{id:'original-event'}),error=>error.status===403);
  assert.equal(calls.filter(call=>call.path.endsWith('/subscription/advance')).length,2);
  assert.ok(calls.filter(call=>call.path.endsWith('/subscription/advance')).every(call=>call.headers['x-bb-test-owner']==='owner-a'));
  globalThis.fetch=async()=>response(200,{synthetic:true});await send('state');
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

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const memoryStorage=()=>{const entries=new Map();return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};};

test('two shared-storage callers accept the same successful receipt after the first clears the original intent',async()=>{
  const storage=memoryStorage(),firstReply=deferred(),secondReply=deferred(),bothStarted=deferred(),requests=[];let created=0;
  const options={key:'same-owner-advance',storage,create:()=>({id:'event-'+(++created)}),validate:()=>true,accepted:(result,intent)=>result.request_id===intent.id,
    perform:intent=>{requests.push(intent.id);if(requests.length===2)bothStarted.resolve();return requests.length===1?firstReply.promise:secondReply.promise;}};
  const first=storedAction(options),second=storedAction(options);await bothStarted.promise;
  firstReply.resolve({request_id:'event-1'});assert.deepEqual(await first,{request_id:'event-1'});assert.equal(storage.getItem(options.key),null);
  secondReply.resolve({request_id:'event-1'});assert.deepEqual(await second,{request_id:'event-1'});
  assert.deepEqual(requests,['event-1','event-1']);assert.equal(created,1);assert.equal(storage.getItem(options.key),null);
});

test('a late verified success keeps a newer pending intent and its unknown-result retry ID intact',async()=>{
  const storage=memoryStorage(),oldReply=deferred(),oldStarted=deferred(),nextReply=deferred(),nextStarted=deferred();let created=0;
  const options={key:'same-owner-advance',storage,create:()=>({id:'event-'+(++created)}),validate:()=>true,accepted:(result,intent)=>result.request_id===intent.id};
  const old=storedAction({...options,perform:()=>{oldStarted.resolve();return oldReply.promise;}});await oldStarted.promise;
  await storedAction({...options,perform:async()=>({request_id:'event-1'})});
  const successor=storedAction({...options,perform:async()=>{nextStarted.resolve();await nextReply.promise;throw Error('Unknown successor response');}}).catch(error=>error);
  await nextStarted.promise;assert.equal(JSON.parse(storage.getItem(options.key)).id,'event-2');
  try{
    oldReply.resolve({request_id:'event-1'});assert.deepEqual(await old,{request_id:'event-1'});
    assert.equal(JSON.parse(storage.getItem(options.key)).id,'event-2','old receipt must not remove or overwrite its successor');
  }finally{nextReply.resolve();await successor;}
  const retries=[];await storedAction({...options,perform:async intent=>{retries.push(intent.id);return {request_id:intent.id};}});
  assert.deepEqual(retries,['event-2']);assert.equal(created,2);assert.equal(storage.getItem(options.key),null);
});

test('Web Locks cover only the shared intent critical sections, allowing concurrent HTTP with one original ID',async()=>{
  const storage=memoryStorage(),calls=[],queue=new Map();let critical=0,created=0;const bothStarted=deferred(),reply=deferred(),requests=[];
  const locks={request(name,options,operation){
    calls.push({name,mode:options.mode});const previous=queue.get(name)??Promise.resolve();
    const pending=previous.then(async()=>{critical++;try{return await operation();}finally{critical--;}});queue.set(name,pending.catch(()=>{}));return pending;
  }};
  const options={key:'same-owner-advance',storage,locks,create:()=>({id:'event-'+(++created)}),validate:()=>true,accepted:(result,intent)=>result.request_id===intent.id,
    perform:async intent=>{assert.equal(critical,0,'HTTP must run after releasing the short storage lock');requests.push(intent.id);if(requests.length===2)bothStarted.resolve();await reply.promise;return {request_id:intent.id};}};
  const first=storedAction(options),second=storedAction(options);await bothStarted.promise;reply.resolve();await Promise.all([first,second]);
  assert.equal(created,1);assert.deepEqual(requests,['event-1','event-1']);assert.equal(calls.length,4);assert.equal(new Set(calls.map(call=>call.name)).size,1);assert.ok(calls.every(call=>call.mode==='exclusive'));
});

test('real browser localStorage without Web Locks blocks before persisting or submitting a financial action',async()=>{
  const storage=memoryStorage(),descriptors=Object.fromEntries(['window','localStorage','navigator'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));let calls=0,created=0;
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}});Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  try{
    await assert.rejects(storedAction({key:'same-owner-advance',create:()=>({id:'event-'+(++created)}),validate:()=>true,accepted:()=>true,perform:async()=>{calls++;return{};}}),/跨标签.*锁/);
    assert.equal(calls,0);assert.equal(created,0);assert.equal(storage.getItem('same-owner-advance'),null);
  }finally{for(const [name,descriptor] of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
});

test('a session change while awaiting the storage lock cannot perform an old financial action under the new account',()=>mockedClient(async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),events=new EventTarget(),storage=memoryStorage(),queued=deferred(),unlock=deferred();let calls=0;
  globalThis.window=new EventTarget();Object.assign(document,{visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)});
  const unwatch=watchSessionChanges(()=>{}),locks={request:async(_name,_options,operation)=>{queued.resolve();await unlock.promise;return operation();}};
  try{
    const pending=storedAction({key:'owner-a-advance',storage,locks,create:()=>({id:'original-a'}),validate:()=>true,accepted:()=>true,perform:async()=>{calls++;return{};}});
    await queued.promise;document.cookie='bb_csrf=owner-b';window.dispatchEvent(new Event('focus'));unlock.resolve();
    await assert.rejects(pending,error=>error.code==='SESSION_CHANGED');assert.equal(calls,0);
  }finally{unwatch();if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
}));

test('a session change before a financial receipt arrives retains the original intent and skips acknowledgement cleanup',()=>mockedClient(async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),events=new EventTarget(),storage=memoryStorage(),started=deferred(),reply=deferred();let acknowledgements=0;
  globalThis.window=new EventTarget();Object.assign(document,{visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)});
  const unwatch=watchSessionChanges(()=>{});
  try{
    const pending=storedAction({key:'owner-a-advance',storage,create:()=>({id:'original-a'}),validate:()=>true,accepted:()=>{acknowledgements++;return true;},perform:()=>{started.resolve();return reply.promise;}});
    await started.promise;document.cookie='bb_csrf=owner-b';window.dispatchEvent(new Event('focus'));reply.resolve({request_id:'original-a'});
    await assert.rejects(pending,error=>error.code==='SESSION_CHANGED');assert.equal(acknowledgements,0);assert.equal(JSON.parse(storage.getItem('owner-a-advance')).id,'original-a');
  }finally{unwatch();if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
}));

test('shared refund persistence adopts the original order, amount and UUID rather than overwriting an unknown application',async()=>{
  const storage=memoryStorage(),first={id:'original-order',amount_fen:'1000',request_id:'original-refund'},next={...first,amount_fen:'2000',request_id:'other-refund'};let created=0;
  const common={key:'same-owner-order-refund',storage,validate:intent=>intent.id==='original-order'&&typeof intent.request_id==='string'};
  const [a,b]=await Promise.all([
    persistStoredIntent({...common,create:()=>{created++;return first;}}),
    persistStoredIntent({...common,create:()=>{created++;return next;}}),
  ]);
  assert.equal(created,1);assert.deepEqual(a.intent,first);assert.deepEqual(b.intent,first);assert.equal(a.serialized,b.serialized);assert.equal(storage.getItem(common.key),a.serialized);
});

test('a refund acknowledgement preserves a newer unknown refund and that exact application can be restored',async()=>{
  const storage=memoryStorage(),key='same-owner-order-refund',old={id:'original-order',amount_fen:'1000',request_id:'settled-refund'},next={...old,amount_fen:'2000',request_id:'unknown-refund'};
  const original=JSON.stringify(old),successor=JSON.stringify(next);storage.setItem(key,successor);
  assert.equal(await acknowledgeStoredIntent({key,storage,serialized:original}),successor);assert.equal(storage.getItem(key),successor);
  const restored=await persistStoredIntent({key,storage,create:()=>{throw Error('must not replace the unknown refund');},validate:()=>true});
  assert.deepEqual(restored.intent,next);assert.equal(restored.serialized,successor);
});

test('a refund acknowledgement waiting for its lock cannot clear storage after an account switch',()=>mockedClient(async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'window'),events=new EventTarget(),storage=memoryStorage(),queued=deferred(),unlock=deferred(),key='owner-a-order-refund',serialized=JSON.stringify({id:'original-order',amount_fen:'1000',request_id:'original-refund'});
  storage.setItem(key,serialized);globalThis.window=new EventTarget();Object.assign(document,{visibilityState:'visible',addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)});
  const unwatch=watchSessionChanges(()=>{}),locks={request:async(_name,_options,operation)=>{queued.resolve();await unlock.promise;return operation();}};
  try{
    const pending=acknowledgeStoredIntent({key,storage,serialized,locks});await queued.promise;window.dispatchEvent(new Event('focus'));unlock.resolve();
    await assert.rejects(pending,error=>error.code==='SESSION_CHANGED');assert.equal(storage.getItem(key),serialized);
  }finally{unwatch();if(descriptor)Object.defineProperty(globalThis,'window',descriptor);else delete globalThis.window;}
}));
