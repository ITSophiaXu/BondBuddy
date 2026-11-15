import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startRunLeaseHeartbeat} from './run-lease-heartbeat.js';

const flush=async()=>{await Promise.resolve();await Promise.resolve();};

test('a blocked renewal does not accumulate calls and resumes after its acknowledgement',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,lost=0,complete!:()=>void;
  const heartbeat=startRunLeaseHeartbeat({intervalMs:100,renew:()=>{calls++;return new Promise<void>(resolve=>{complete=resolve;});},onLost:()=>{lost++;}});
  try{
    t.mock.timers.tick(100);assert.equal(calls,1);
    t.mock.timers.tick(10000);assert.equal(calls,1);assert.equal(lost,0);
    complete();await flush();t.mock.timers.tick(99);assert.equal(calls,1);
    t.mock.timers.tick(1);assert.equal(calls,2);
  }finally{heartbeat.stop();complete();await flush();}
});

test('a rejected renewal aborts once and does not schedule another request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,lost=0;
  const heartbeat=startRunLeaseHeartbeat({intervalMs:100,renew:async()=>{calls++;throw Error('synthetic lost lease');},onLost:()=>{lost++;}});
  t.mock.timers.tick(100);await flush();assert.equal(lost,1);
  t.mock.timers.tick(10000);assert.equal(calls,1);heartbeat.stop();
});

test('stopping an in-flight renewal ignores its late failure and never revives the loop',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,lost=0,reject!:()=>void;
  const heartbeat=startRunLeaseHeartbeat({intervalMs:100,renew:()=>{calls++;return new Promise<void>((_,fail)=>{reject=()=>fail(Error('late synthetic error'));});},onLost:()=>{lost++;}});
  t.mock.timers.tick(100);heartbeat.stop();reject();await flush();
  t.mock.timers.tick(10000);assert.equal(calls,1);assert.equal(lost,0);
});

test('stopping an in-flight renewal ignores its late success',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0,complete!:()=>void;
  const heartbeat=startRunLeaseHeartbeat({intervalMs:100,renew:()=>{calls++;return new Promise<void>(resolve=>{complete=resolve;});},onLost:()=>assert.fail('unexpected lease loss')});
  t.mock.timers.tick(100);heartbeat.stop();complete();await flush();
  t.mock.timers.tick(10000);assert.equal(calls,1);
});
