import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UploadTransferQueue,orderedUploadPipeline,UploadPreparationError} from './upload-scheduler.js';
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function gate<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const live=()=>new AbortController().signal;

test('a synchronous transfer failure releases exactly one slot',async()=>{
 const queue=new UploadTransferQueue(1),error=new Error('send failed');
 await assert.rejects(queue.run(()=>{throw error;},live()),error);
 const first=gate(),started:number[]=[];
 const one=queue.run(()=>{started.push(1);return first.promise;},live());
 const two=queue.run(async()=>{started.push(2);},live());assert.deepEqual(started,[1]);
 first.resolve();await Promise.all([one,two]);assert.deepEqual(started,[1,2]);
});

test('two real transfer slots are FIFO and a cancelled waiter never sends',async()=>{
 const queue=new UploadTransferQueue(2),gates=[gate(),gate(),gate()],started:number[]=[];
 const tasks=gates.map((g,i)=>queue.run(()=>{started.push(i);return g.promise;},live()));
 const cancelled=new AbortController();const fourth=queue.run(async()=>{started.push(3);},cancelled.signal);
 const rejected=assert.rejects(fourth,{name:'AbortError'});cancelled.abort();
 assert.deepEqual(started,[0,1]);gates[0].resolve();await flush();assert.deepEqual(started,[0,1,2]);
 gates[1].resolve();gates[2].resolve();await Promise.all([...tasks,rejected]);
 await queue.run(async()=>{started.push(4);},live());assert.deepEqual(started,[0,1,2,4]);
});

test('slow confirmation does not hold PUT slots; the ordered window stays at four',async()=>{
 const queue=new UploadTransferQueue(),confirm=Array.from({length:6},()=>gate<number>()),started:number[]=[],adopted:number[]=[];
 let puts=0,maxPuts=0;
 const task=orderedUploadPipeline([0,1,2,3,4,5],async i=>{
  await queue.run(async()=>{puts++;maxPuts=Math.max(maxPuts,puts);started.push(i);await flush();puts--;},live());return confirm[i].promise;
 },async value=>{adopted.push(value);},live());
 await flush();await flush();await flush();assert.deepEqual(started,[0,1,2,3]);assert.equal(maxPuts,4);assert.deepEqual(adopted,[]);
 confirm[3].resolve(3);confirm[2].resolve(2);confirm[1].resolve(1);await flush();assert.deepEqual(adopted,[]);assert.equal(started.length,4);
 confirm[0].resolve(0);await flush();await flush();assert.deepEqual(adopted,[0,1,2,3]);assert.deepEqual(started,[0,1,2,3,4,5]);
 confirm[5].resolve(5);confirm[4].resolve(4);await task;assert.deepEqual(adopted,[0,1,2,3,4,5]);
});

test('a failed file keeps later saved files unadopted and cancels pending transports',async()=>{
 const first=gate<number>(),failure=gate<number>(),started:number[]=[],adopted:number[]=[],aborted:number[]=[];
 const error=new Error('original file rejected');
 const task=orderedUploadPipeline([0,1,2,3,4],async(i,_index,signal)=>{
  started.push(i);if(i===0)return first.promise;if(i===1)return failure.promise;if(i===2)return 2;
  return new Promise<number>((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted.push(i);reject(signal.reason);},{once:true}));
 },async value=>{adopted.push(value);},live());
 const rejected=assert.rejects(task,(e:unknown)=>e instanceof UploadPreparationError&&e.index===1&&e.original===error);
 await flush();failure.reject(error);first.resolve(0);await rejected;
 assert.deepEqual(started,[0,1,2,3]);assert.deepEqual(adopted,[0]);assert.deepEqual(aborted,[3]);
});

test('business conflict stops the look-ahead batch without adopting another saved file',async()=>{
 const started:number[]=[],adopted:number[]=[];
 const result=await orderedUploadPipeline([0,1,2,3,4],async i=>{started.push(i);return i;},async value=>{adopted.push(value);return false;},live());
 assert.equal(result,false);assert.deepEqual(started,[0,1,2,3]);assert.deepEqual(adopted,[0]);
});

test('an already cancelled batch starts no work',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(orderedUploadPipeline([0],async()=>++calls,async()=>{},controller.signal),{name:'AbortError'});assert.equal(calls,0);
});

test('default capacity is four actual transfers; a fifth waits and cancelled waiters never send',async()=>{
 const queue=new UploadTransferQueue(),gates=Array.from({length:6},()=>gate()),started:number[]=[];
 let active=0,peak=0;
 const tasks=gates.map((g,i)=>queue.run(async()=>{started.push(i);active++;peak=Math.max(peak,active);try{await g.promise;}finally{active--;}},live()));
 assert.deepEqual(started,[0,1,2,3]);assert.equal(peak,4);
 gates[1].resolve();await flush();assert.deepEqual(started,[0,1,2,3,4]);
 gates[0].resolve();await flush();assert.deepEqual(started,[0,1,2,3,4,5]);
 for(const g of gates)g.resolve();await Promise.all(tasks);assert.equal(peak,4);assert.equal(active,0);
 assert.throws(()=>new UploadTransferQueue(5),RangeError);
});
