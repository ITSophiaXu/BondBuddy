import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readDownloadBytes,downloadProgressText} from './download-progress.js';

for(const headers of [{},{'content-length':'5'},{'content-length':'99','content-encoding':'gzip'}] as Record<string,string>[])test(`stream progress counts received bytes without inventing a total: ${JSON.stringify(headers)}`,async()=>{
  const chunks=[new Uint8Array([1,2]),new Uint8Array([3,4,5])],seen:[number,number|undefined][]=[];
  const response=new Response(new ReadableStream({pull(controller){const chunk=chunks.shift();if(chunk)controller.enqueue(chunk);else controller.close();}}),{headers});
  const bytes=await readDownloadBytes(response,new AbortController().signal,(received,total)=>seen.push([received,total]));
  assert.deepEqual([...new Uint8Array(bytes)],[1,2,3,4,5]);
  const total=headers['content-length']==='5'?5:undefined;
  assert.deepEqual(seen,[[0,total],[2,total],[5,total]]);
  assert.equal(downloadProgressText(2,total).includes('%'),total!==undefined);
});
test('aborted body never produces downloadable bytes',async()=>{
  const abort=new AbortController();abort.abort();
  await assert.rejects(readDownloadBytes(new Response('partial'),abort.signal,()=>{}),{name:'AbortError'});
});
