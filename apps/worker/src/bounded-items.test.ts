import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {boundedItems} from './bounded-items.js';
test('four actual operations overlap, retain ordinal order and drain accepted siblings on failure',async()=>{
  let active=0,peak=0;const started:number[]=[],settled:number[]=[];
  const results=await boundedItems([0,1,2,3,4,5],4,new AbortController().signal,async n=>{
    started.push(n);peak=Math.max(peak,++active);await delay(n===0?5:20);
    settled.push(n);active--;return {kind:n===0?'failed':'completed',n};
  },r=>r.kind==='completed');
  assert.equal(peak,4);assert.deepEqual(started,[0,1,2,3]);assert.equal(active,0);
  assert.deepEqual(settled.sort(),[0,1,2,3]);assert.deepEqual(results.slice(0,4).map(r=>r?.n),[0,1,2,3]);
  assert.equal(results[4],undefined);
});
test('unknown exception closes new admission and waits for every accepted operation',async()=>{
  let completed=0;
  await assert.rejects(boundedItems([0,1,2,3,4],4,new AbortController().signal,async n=>{
    if(n===0)throw Error('UNKNOWN_CALL');await delay(15);completed++;return n;
  },()=>true),/UNKNOWN_CALL/);
  assert.equal(completed,3);
});
test('serial compatibility and cancellation avoid new operations',async()=>{
 const controller=new AbortController();let calls=0;
 const values=await boundedItems([1,2,3],1,controller.signal,async n=>{calls++;return n;},()=>true);
 assert.deepEqual(values,[1,2,3]);assert.equal(calls,3);
 controller.abort(Error('CANCELLED'));
 await assert.rejects(boundedItems([1,2],4,controller.signal,async n=>{calls++;return n;},()=>true),/CANCELLED/);
 assert.equal(calls,3);
});

for(const limit of [1,4,7,8,12])test(`resource window ${limit} is not capped at four`,async()=>{
 let active=0,peak=0;const values=await boundedItems(Array.from({length:25},(_,i)=>i),limit,new AbortController().signal,async n=>{
  peak=Math.max(peak,++active);await delay(5);active--;return n;
 },()=>true);assert.equal(peak,limit);assert.deepEqual(values,Array.from({length:25},(_,i)=>i));
});
test('resource window shrink and growth apply before pulling new items',async()=>{
 let active=0,peak=0,window=7,started=0,shrunkPeak=0;
 const values=await boundedItems(Array.from({length:20},(_,i)=>i),async()=>window,new AbortController().signal,async n=>{
  started++;peak=Math.max(peak,++active);if(n>=7&&n<10)shrunkPeak=Math.max(shrunkPeak,active);
  await delay(n===0?2:10);if(n===0)window=2;if(n===9)window=8;active--;return n;
 },()=>true);assert.equal(started,20);assert.equal(shrunkPeak,2);assert.equal(peak,8);assert.equal(values.length,20);
});
test('invalid resource capacity does not start callbacks',async()=>{
 for(const value of [0,-1,1.5,NaN,Infinity])await assert.rejects(boundedItems([1],value,new AbortController().signal,async()=>assert.fail('started'),()=>true),/INVALID_BATCH_PARALLELISM/);
});
