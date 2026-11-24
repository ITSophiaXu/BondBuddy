import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startLeaseHeartbeat,type LeaseHeartbeatEvent} from './lease-heartbeat.js';

const wait = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
const dbError = (code:string) => Object.assign(new Error('private database detail'), {code});

test('a transient connection reset retries under the same lease and keeps work running', async () => {
  const events:LeaseHeartbeatEvent[] = [];
  let calls=0, aborted=false;
  const heartbeat=startLeaseHeartbeat({leaseMs:1500,claimedAtMs:Date.now(),
    renew:async()=>{if(++calls===1)throw dbError('ECONNRESET');},
    abort:()=>{aborted=true;},onEvent:event=>events.push(event)});
  try {
    await wait(900);
    assert.equal(calls,2);
    assert.equal(aborted,false);
    assert.deepEqual(events.map(event=>event.outcome),['renew_retry','renewed_after_retry']);
    assert.equal(events[0]?.error_code,'ECONNRESET');
    assert.equal(events[1]?.last_successful_renew_at!==null,true);
    assert.equal(JSON.stringify(events).includes('private database detail'),false);
  } finally { heartbeat.stop(); }
});

test('confirmed lease loss aborts immediately without retry', async () => {
  const events:LeaseHeartbeatEvent[]=[];
  let calls=0,aborted=false;
  const heartbeat=startLeaseHeartbeat({leaseMs:1000,claimedAtMs:Date.now(),
    renew:async()=>{calls++;throw dbError('ALREADY_TERMINAL');},
    abort:()=>{aborted=true;},onEvent:event=>events.push(event)});
  try {
    await wait(480);
    assert.equal(calls,1);
    assert.equal(aborted,true);
    assert.equal(events.at(-1)?.reason,'lease_lost');
  } finally {heartbeat.stop();}
});

test('sustained connection failure aborts before the conservative lease boundary', async () => {
  const events:LeaseHeartbeatEvent[]=[];
  let abortedAt=0;
  const started=Date.now();
  const heartbeat=startLeaseHeartbeat({leaseMs:1200,claimedAtMs:started,
    renew:async()=>{throw new Error('TIMEOUTconnect exceeded');},
    abort:()=>{abortedAt=Date.now();},onEvent:event=>events.push(event)});
  try {
    await wait(1200);
    assert.ok(abortedAt>=started);
    assert.ok(abortedAt<=started+1200);
    assert.equal(events.at(-1)?.reason,'lease_safety_deadline');
    assert.equal(events[0]?.error_code,'DB_CONNECTION_INTERRUPTED');
  } finally {heartbeat.stop();}
});

test('an in-flight renewal cannot continue work past the lease boundary', async () => {
  let release!:()=>void,aborted=false,calls=0;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const heartbeat=startLeaseHeartbeat({leaseMs:800,claimedAtMs:Date.now(),
    renew:async()=>{calls++;await pending;},abort:()=>{aborted=true;}});
  try {
    await wait(820);
    assert.equal(aborted,true);
    release();
    await wait(20);
    assert.equal(calls,1);
  } finally {release();heartbeat.stop();}
});
