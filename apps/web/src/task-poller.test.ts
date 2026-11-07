import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {TaskPoller} from './task-poller.js';
import {generationBatchActive} from '@bondbuddy/contracts';
class Visibility extends EventTarget {hidden=false;set(hidden:boolean){this.hidden=hidden;this.dispatchEvent(new Event('visibilitychange'));}}
const flush=()=>setImmediate();
test('terminal and paused queues stop; a paused in-flight item can settle',()=>{
 for(const state of ['complete','partial','cancelled','paused'])assert.equal(generationBatchActive({state,items:[{state:'queued',run_id:null}]}),false);
 assert.equal(generationBatchActive({state:'paused',items:[{state:'running',run_id:'r'}]}),true);
 assert.equal(generationBatchActive({state:'queued',items:[]}),true);
});
test('completed page has no recurring work; foreground resync discovers new work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const visibility=new Visibility();let active=false,calls=0;
 const poller=new TaskPoller({active:()=>active,live:()=>true,blocked:()=>false,refresh:async(_s,force)=>{calls++;assert.ok(force||active);}},visibility);
 poller.start();t.mock.timers.tick(86_400_000);await flush();assert.equal(calls,0);
 visibility.set(true);visibility.set(false);await flush();assert.equal(calls,1);
 active=true;poller.start();t.mock.timers.tick(10_000);await flush();assert.equal(calls,2);
 active=false;t.mock.timers.tick(10_000);await flush();t.mock.timers.tick(86_400_000);await flush();assert.equal(calls,2);
 poller.dispose();visibility.set(true);visibility.set(false);await flush();assert.equal(calls,2);
});
test('hidden pages abort requests, foreground resumes once, and slow requests never overlap',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const visibility=new Visibility();let calls=0,activeRequests=0,max=0;
 const poller=new TaskPoller({active:()=>true,live:()=>true,blocked:()=>false,refresh:async(signal)=>{
  calls++;activeRequests++;max=Math.max(max,activeRequests);
  try{await new Promise<void>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});setTimeout(resolve,30_000);});}
  finally{activeRequests--;}
 }},visibility);
 poller.start();t.mock.timers.tick(10_000);await flush();assert.equal(calls,1);
 poller.start();t.mock.timers.tick(10_000);await flush();assert.equal(calls,1);
 visibility.set(true);await flush();assert.equal(activeRequests,0);
 t.mock.timers.tick(86_400_000);await flush();assert.equal(calls,1);
 visibility.set(false);await flush();assert.equal(calls,2);assert.equal(max,1);
 poller.dispose();await flush();
});
test('transient failures back off and stop after five; user action resumes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const visibility=new Visibility();let calls=0,stopped=false,fail=true;
 const poller=new TaskPoller({active:()=>true,live:()=>true,blocked:()=>false,failed:value=>{stopped=value;},refresh:async()=>{calls++;if(fail)throw Error('offline');}},visibility);
 poller.start();
 for(const ms of [10_000,20_000,40_000,80_000,160_000]){t.mock.timers.tick(ms-1);await flush();const before=calls;t.mock.timers.tick(1);await flush();assert.equal(calls,before+1);}
 assert.equal(calls,5);assert.equal(stopped,true);t.mock.timers.tick(86_400_000);await flush();assert.equal(calls,5);
 fail=false;poller.start();t.mock.timers.tick(10_000);await flush();assert.equal(calls,6);poller.dispose();
});
test('mutations and download state block refresh and stale requests are aborted',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const visibility=new Visibility();let blocked=true,calls=0;
 const poller=new TaskPoller({active:()=>true,live:()=>true,blocked:()=>blocked,refresh:async()=>{calls++;}},visibility);
 poller.start();t.mock.timers.tick(10_000);await flush();assert.equal(calls,0);
 visibility.set(true);visibility.set(false);t.mock.timers.tick(10_000);await flush();assert.equal(calls,0,'foreground while blocked must not create a zero-delay loop');
 blocked=false;t.mock.timers.tick(10_000);await flush();assert.equal(calls,1);poller.pause();
 t.mock.timers.tick(86_400_000);await flush();assert.equal(calls,1);poller.dispose();
});
