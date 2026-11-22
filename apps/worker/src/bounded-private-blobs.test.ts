import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedStorageRequest} from './bounded-private-blobs.js';
test('a stalled storage child is killed and joined, with no orphan after timeout',async()=>{
  const started=Date.now();
  await assert.rejects(boundedStorageRequest({op:'get',key:'synthetic',max:1024},{connectionString:'synthetic-only',timeoutMs:150,command:[process.execPath,'-e','process.stdin.resume();setInterval(()=>{},1000);process.on("SIGTERM",()=>{});']}),/STORAGE_IO_TIMEOUT/);
  assert.ok(Date.now()-started<3000);
});
test('storage IO child receives no model, DB or enrollment credentials',async()=>{
  const bytes=await boundedStorageRequest({op:'get',key:'synthetic',max:1024},{connectionString:'synthetic-only',command:[process.execPath,'-e','process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k=>/DATABASE|DEEPSEEK|ENROLLMENT|COPILOT/.test(k)))));']});
  assert.deepEqual(JSON.parse(bytes!.toString()),[]);
});
