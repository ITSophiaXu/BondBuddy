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
