import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import {M1_UPLOAD_LIMITS} from '@bondbuddy/contracts';
import {uploadFileDigest,uploadFileSha256,UPLOAD_HASH_CHUNK_BYTES} from './upload-file-digest.js';

for(const length of [1,55,56,63,64,65,UPLOAD_HASH_CHUNK_BYTES-1,UPLOAD_HASH_CHUNK_BYTES+17])test(`incremental original-byte SHA matches independent SHA at ${length}`,async()=>{
 const bytes=randomBytes(length),file=new Blob([bytes]);
 assert.equal(await uploadFileSha256(file),createHash('sha256').update(bytes).digest('hex'));
});

test('four files hash using one bounded read at a time, never a whole-file arrayBuffer',async()=>{
 let reading=0,peak=0,largest=0,whole=0;
 const bytes=randomBytes(2*UPLOAD_HASH_CHUNK_BYTES+7),expected=createHash('sha256').update(bytes).digest('hex');
 const files=Array.from({length:4},()=>{
  const file=new Blob([bytes]);
  file.arrayBuffer=async()=>{whole++;throw new Error('whole-file read forbidden');};
  const slice=file.slice.bind(file);
  file.slice=(start,end,type)=>{
   const part=slice(start,end,type),read=part.arrayBuffer.bind(part);
   part.arrayBuffer=async()=>{reading++;peak=Math.max(peak,reading);largest=Math.max(largest,part.size);try{await new Promise(r=>setTimeout(r,1));return await read();}finally{reading--;}};
   return part;
  };return file;
 });
 assert.deepEqual(await Promise.all(files.map(f=>uploadFileSha256(f))),Array(4).fill(expected));
 assert.equal(peak,1);assert.equal(whole,0);assert.equal(largest,UPLOAD_HASH_CHUNK_BYTES);
});

test('cancelled active and queued hashes release capacity without hashing the queued file',async()=>{
 const first=new Blob([randomBytes(2*UPLOAD_HASH_CHUNK_BYTES)]),waiting=new Blob(['waiting']);
 const controller=new AbortController(),queued=new AbortController();let reads=0;
 const slice=first.slice.bind(first);first.slice=(...args)=>{reads++;controller.abort();return slice(...args);};
 waiting.slice=()=>{throw new Error('cancelled waiter was read');};
 const a=uploadFileDigest(first,controller.signal),b=uploadFileDigest(waiting,queued.signal);queued.abort();
 await Promise.all([assert.rejects(a,{name:'AbortError'}),assert.rejects(b,{name:'AbortError'})]);assert.equal(reads,1);
 assert.equal(await uploadFileSha256(new Blob(['abc'])),createHash('sha256').update('abc').digest('hex'));
});

test('invalid/oversized original file is refused before any file read',async()=>{
 for(const size of [0,M1_UPLOAD_LIMITS.fileBytes+1]){
  let calls=0;const file={size,slice(){calls++;throw Error();}}as unknown as Blob;
  await assert.rejects(uploadFileDigest(file),RangeError);assert.equal(calls,0);
 }
});
