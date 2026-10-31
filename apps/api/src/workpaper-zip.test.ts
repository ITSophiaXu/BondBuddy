import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkpaperZipCache,type WorkpaperZipFile} from './workpaper-zip.js';
import {digest,type PrivateBlobs} from './data.js';

const options={ttlMs:60_000,maxBytes:1024*1024,concurrency:4,timeoutMs:1000};
const file=(bytes:Buffer,path='可生成文件/1.docx'):WorkpaperZipFile=>({path,key:'private/key',sha256:digest(bytes),maxBytes:1000});
async function consume(stream:Readable){const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}

test('short polls share a bounded background build; a failed preparation is reported once and can retry',async()=>{
  const cache=new WorkpaperZipCache(options),bytes=Buffer.from('data');let reads=0,release!:()=>void,opened!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>opened=r);
  const blobs={openRead:async()=>{reads++;opened();await gate;return {body:Readable.from([bytes]),contentLength:bytes.length};}} as unknown as PrivateBlobs;
  try{
    assert.equal(cache.prepare('owner',[file(bytes)],blobs),false);await started;
    for(let i=0;i<5;i++)assert.equal(cache.prepare('owner',[file(bytes)],blobs),false);
    assert.equal(reads,1);release();
    await consume((await cache.open('owner',[file(bytes)],blobs)).body);
    assert.equal(cache.prepare('owner',[file(bytes)],blobs),true);assert.equal(reads,1);
    // No HTTP waiter remains to catch a background failure. It must still be
    // observed on the next poll, without an unhandled rejection or restart loop.
    const broken={openRead:async()=>null} as unknown as PrivateBlobs;
    assert.equal(cache.prepare('broken',[file(bytes)],broken),false);
    await assert.rejects(cache.open('broken',[file(bytes)],broken),/暂时无法读取/);
    assert.throws(()=>cache.prepare('broken',[file(bytes)],broken),/暂时无法读取/);
    assert.equal(cache.prepare('broken',[file(bytes)],blobs),false);
    await consume((await cache.open('broken',[file(bytes)],blobs)).body);
  }finally{release();await cache.close();}
});

test('abandoned polling builds retain deadlines, admission limits and shutdown cancellation',async()=>{
  const cache=new WorkpaperZipCache({...options,timeoutMs:40}),bytes=Buffer.from('data'),signals:AbortSignal[]=[];
  const blobs={openRead:async(_key:string,signal:AbortSignal)=>{signals.push(signal);return new Promise(()=>{});}} as unknown as PrivateBlobs;
  try{
    assert.equal(cache.prepare('one',[file(bytes)],blobs),false);
    assert.equal(cache.prepare('two',[file(bytes)],blobs),false);
    assert.throws(()=>cache.prepare('three',[file(bytes)],blobs),/正在准备/);
    await delay(80);assert.equal(signals.length,2);assert.ok(signals.every(s=>s.aborted));
    assert.throws(()=>cache.prepare('one',[file(bytes)],blobs),/暂时无法读取/);
    assert.equal(cache.prepare('three',[file(bytes)],blobs),false);
  }finally{await cache.close();}
  assert.ok(signals.every(s=>s.aborted));assert.throws(()=>cache.prepare('closed',[file(bytes)],blobs),/暂时无法读取/);
});

test('slow readers cannot retain an unlimited number of distinct archives',async()=>{
  const cache=new WorkpaperZipCache(options),bytes=Buffer.from('data'),streams:Readable[]=[];
  const blobs={openRead:async()=>({body:Readable.from([bytes]),contentLength:bytes.length})} as unknown as PrivateBlobs;
  try{
    for(let i=0;i<4;i++)streams.push((await cache.open('scope-'+i,[file(bytes)],blobs)).body);
    await assert.rejects(cache.open('fifth',[file(bytes)],blobs),/其他文件包正在下载/);
    await consume(streams.shift()!);
    await consume((await cache.open('fifth',[file(bytes)],blobs)).body);
    await Promise.all(streams.map(consume));
  }finally{for(const stream of streams)stream.destroy();await cache.close();}
});

test('a ZIP input filesystem error rejects the request and allows a clean retry',async t=>{
  const cache=new WorkpaperZipCache(options),bytes=Buffer.from('data');
  const original=fs.stat;
  const mock=t.mock.method(fs,'stat',((path:fs.PathLike,callback:(error:Error)=>void)=>{
    if(String(path).includes('bondbuddy-workpaper-zip-'))queueMicrotask(()=>callback(new Error('synthetic input unavailable')));
    else (original as any)(path,callback);
  }) as typeof fs.stat);
  const blobs={openRead:async()=>({body:Readable.from([bytes]),contentLength:bytes.length})} as unknown as PrivateBlobs;
  try{
    await assert.rejects(cache.open('owner',[file(bytes)],blobs),/暂时无法读取/);mock.mock.restore();
    await consume((await cache.open('owner',[file(bytes)],blobs)).body);
  }finally{await cache.close();}
});

test('coalesces overlapping downloads, streams storage once, and invalidates on pin/name/owner changes',async()=>{
  const cache=new WorkpaperZipCache(options);let bytes=Buffer.from('first'),reads=0;
  const blobs={openRead:async()=>{reads++;await delay(5);return {body:Readable.from([bytes]),contentLength:bytes.length};}} as unknown as PrivateBlobs;
  try{
    const [a,b]=await Promise.all([cache.open('owner:batch',[file(bytes)],blobs),cache.open('owner:batch',[file(bytes)],blobs)]);
    assert.equal(reads,1);const [one,two]=await Promise.all([consume(a.body),consume(b.body)]);assert.deepEqual(one,two);
    const warm=await cache.open('owner:batch',[file(bytes)],blobs);assert.equal(warm.cached,true);await consume(warm.body);assert.equal(reads,1);
    bytes=Buffer.from('second');await consume((await cache.open('owner:batch',[file(bytes)],blobs)).body);assert.equal(reads,2);
    await consume((await cache.open('owner:batch',[file(bytes,'不适用说明/2.docx')],blobs)).body);assert.equal(reads,3);
    await consume((await cache.open('another-owner:batch',[file(bytes)],blobs)).body);assert.equal(reads,4);
  }finally{await cache.close();}
});

test('rejects missing, truncated, oversized and corrupt files before returning a ZIP; a failure can retry',async()=>{
  const cache=new WorkpaperZipCache(options),bytes=Buffer.from('expected');let mode='missing';
  const blobs={openRead:async()=>mode==='missing'?null:{body:Readable.from([mode==='corrupt'?Buffer.from('wrong'):bytes]),contentLength:mode==='truncated'?bytes.length+1:undefined}} as unknown as PrivateBlobs;
  try{
    for(mode of ['missing','truncated','corrupt'])await assert.rejects(cache.open('owner',[file(bytes)],blobs),/暂时无法读取/);
    mode='ok';await assert.rejects(cache.open('owner',[{...file(bytes),maxBytes:1}],blobs),/暂时无法读取/);
    const ok=await cache.open('owner',[file(bytes)],blobs);assert.equal(ok.cached,false);assert.ok((await consume(ok.body)).length>22);
  }finally{await cache.close();}
});

test('bounds total bytes and aborts a stalled storage stream',async()=>{
  const small=new WorkpaperZipCache({...options,maxBytes:8}),bytes=Buffer.from('sixxxx');
  const blobs={openRead:async()=>({body:Readable.from([bytes]),contentLength:bytes.length})} as unknown as PrivateBlobs;
  try{await assert.rejects(small.open('owner',[file(bytes),file(bytes,'2.docx')],blobs),/暂时无法读取/);}finally{await small.close();}
  const timeout=new WorkpaperZipCache({...options,timeoutMs:25}),body=new Readable({read(){}});
  try{await assert.rejects(timeout.open('owner',[file(bytes)],{openRead:async()=>({body})} as unknown as PrivateBlobs),/暂时无法读取/);assert.equal(body.destroyed,true);}finally{await timeout.close();}
});

test('expired archives are rebuilt while active readers keep their own ZIP valid',async()=>{
  const cache=new WorkpaperZipCache({...options,ttlMs:10}),bytes=Buffer.from('data');let reads=0;
  const blobs={openRead:async()=>{reads++;return {body:Readable.from([bytes]),contentLength:bytes.length};}} as unknown as PrivateBlobs;
  try{
    const first=await cache.open('owner',[file(bytes)],blobs);await delay(20);
    const active=await cache.open('owner',[file(bytes)],blobs);assert.equal(reads,1);
    await Promise.all([consume(first.body),consume(active.body)]);await delay(20);
    const fresh=await cache.open('owner',[file(bytes)],blobs);await consume(fresh.body);assert.equal(reads,2);
  }finally{await cache.close();}
});

test('cancelling one shared request preserves the other; cancelling every waiter aborts storage',async()=>{
  const cache=new WorkpaperZipCache(options),bytes=Buffer.from('shared');
  let release!:()=>void,started!:()=>void,storageSignal:AbortSignal|undefined;
  const opening=new Promise<void>(r=>started=r);
  const gate=new Promise<void>(r=>release=r);
  const blobs={openRead:async(_key:string,signal:AbortSignal)=>{storageSignal=signal;started();await gate;return {body:Readable.from([bytes]),contentLength:bytes.length};}} as unknown as PrivateBlobs;
  const one=new AbortController(),two=new AbortController();
  try{
    const a=cache.open('shared',[file(bytes)],blobs,one.signal),b=cache.open('shared',[file(bytes)],blobs,two.signal);
    await opening;
    one.abort(new Error('left page'));await assert.rejects(a,/left page/);
    assert.equal(storageSignal?.aborted,false);release();await consume((await b).body);
    const stopped=new AbortController();let late:Readable|undefined,startedSecond!:()=>void;
    const openingSecond=new Promise<void>(r=>startedSecond=r);
    const pending=cache.open('cancelled',[file(bytes)],{openRead:async(_key:string,signal:AbortSignal)=>{
      storageSignal=signal;startedSecond();await delay(30);late=Readable.from([bytes]);return {body:late,contentLength:bytes.length};
    }} as unknown as PrivateBlobs,stopped.signal);
    await openingSecond;stopped.abort(new Error('cancel'));await assert.rejects(pending,/cancel/);
    await delay(50);assert.equal(storageSignal?.aborted,true);assert.equal(late?.destroyed,true);
  }finally{await cache.close();}
});

test('storage-open timeout releases a build slot and cleanup closes late streams',async()=>{
  const limits={...options,timeoutMs:10},cache=new WorkpaperZipCache(limits),bytes=Buffer.from('late');let late:Readable|undefined;
  try{
    await assert.rejects(cache.open('slow',[file(bytes)],{openRead:async()=>{
      await delay(40);late=Readable.from([bytes]);return {body:late,contentLength:bytes.length};
    }} as unknown as PrivateBlobs),/暂时无法读取/);
    await delay(60);assert.equal(late?.destroyed,true);
    limits.timeoutMs=options.timeoutMs;
    const archive=await cache.open('retry',[file(bytes)],{openRead:async()=>({body:Readable.from([bytes]),contentLength:bytes.length})} as unknown as PrivateBlobs);
    await consume(archive.body);
  }finally{await cache.close();}
});

