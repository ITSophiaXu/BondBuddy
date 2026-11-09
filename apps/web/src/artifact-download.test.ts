import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedDownload} from './artifact-download.js';

test('a stalled download aborts its read and releases the action with useful guidance',async()=>{
  let signal:AbortSignal|undefined;
  await assert.rejects(boundedDownload(new AbortController().signal,s=>{
    signal=s;return new Promise((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));
  },10),/下载准备超时.*无需重新生成/);
  assert.equal(signal!.aborted,true);
});

test('leaving the page cancels the same download without reporting a timeout',async()=>{
  const parent=new AbortController(),reason=new Error('left page');
  const read=boundedDownload(parent.signal,s=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true})),10_000);
  parent.abort(reason);await assert.rejects(read,e=>e===reason);
  assert.equal(await boundedDownload(new AbortController().signal,async()=>42,10_000),42);
});

test('timeout releases a reader that never reacts to abort, and a prior abort never starts a read',async()=>{
  let signal:AbortSignal|undefined;
  await assert.rejects(boundedDownload(new AbortController().signal,s=>{signal=s;return new Promise(()=>{});},10),/下载准备超时/);
  assert.equal(signal?.aborted,true);
  const parent=new AbortController(),reason=new Error('already left');parent.abort(reason);
  await assert.rejects(boundedDownload(parent.signal,async()=>assert.fail('aborted reads must not start')),error=>error===reason);
});
