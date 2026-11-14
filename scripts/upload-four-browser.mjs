// Real Chromium/XHR and HTTPS Azurite. This isolates transport and hashing;
// normal authenticated application input is verified by browser-input-chain.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {BlobServiceClient} from '@azure/storage-blob';
import {azureBlobs} from '../apps/api/dist/data.js';

const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
assert.ok(storage);
const client=BlobServiceClient.fromConnectionString(storage);
assert.ok(['127.0.0.1','localhost'].includes(new URL(client.url).hostname),'Only task-local storage');
const origin='https://localhost:25174',container='bb-four-browser-'+randomUUID().replaceAll('-','');
const blobs=azureBlobs(storage,container),output=process.argv[2];assert.ok(output);
const vite=await createServer({configFile:resolve('apps/web/vite.config.ts'),root:resolve('apps/web'),plugins:[{name:'transport-verification-page',configureServer(server){server.middlewares.use('/__upload-four',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Upload transport verification</title><body><div id="paint">ready</div></body>');});}}],server:{port:25174,strictPort:true,
  https:{cert:await readFile(process.env.BB_WEB_TLS_CERT),key:await readFile(process.env.BB_WEB_TLS_KEY)}}});
let browser;
try{
 await vite.listen();browser=await chromium.launch({headless:true});
 const page=await browser.newPage({ignoreHTTPSErrors:true});
 // The only browser network destinations are this Vite server and local Blob.
 const bad=[];page.on('request',r=>{const u=new URL(r.url());if(!['localhost','127.0.0.1'].includes(u.hostname))bad.push(u.hostname);});
 await page.goto(origin+'/__upload-four');
 const hashResult=await page.evaluate(async()=>{
  const {uploadFileSha256,UPLOAD_HASH_CHUNK_BYTES}=await import('/src/upload-file-digest.ts');
  const chunk=new Uint8Array(UPLOAD_HASH_CHUNK_BYTES).fill(120);
  const files=Array.from({length:4},(_,i)=>new File(Array(100).fill(chunk),`synthetic-${i}.pdf`,{type:'application/pdf'}));
  let reads=0,peakReads=0,maxChunk=0,wholeReads=0,maxGap=0,frames=0,last=performance.now();
  const original=Blob.prototype.arrayBuffer,whole=File.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer=async function(){reads++;peakReads=Math.max(peakReads,reads);maxChunk=Math.max(maxChunk,this.size);try{return await original.call(this);}finally{reads--;}};
  File.prototype.arrayBuffer=async function(){wholeReads++;throw Error('Whole file read forbidden');};
  let running=true;
  const frame=()=>{if(!running)return;const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;frames++;document.querySelector('#paint').textContent=String(frames);requestAnimationFrame(frame);};
  requestAnimationFrame(frame);const start=performance.now();
  try{
   const completed=[];
   const hashes=await Promise.all(files.map(async(file,index)=>{const hash=await uploadFileSha256(file);completed.push({index,elapsed_ms:performance.now()-start});return hash;}));
   return {hashes,completed,elapsed_ms:performance.now()-start,frames,max_frame_gap_ms:maxGap,peakReads,maxChunk,wholeReads,file_bytes:files[0].size};
  }finally{running=false;Blob.prototype.arrayBuffer=original;File.prototype.arrayBuffer=whole;}
 });
 const independent=createHash('sha256');for(let i=0;i<100;i++)independent.update(Buffer.alloc(1024*1024,120));
 assert.deepEqual(hashResult.hashes,Array(4).fill(independent.digest('hex')));
 assert.equal(hashResult.peakReads,1);assert.equal(hashResult.maxChunk,1024*1024);assert.equal(hashResult.wholeReads,0);
 assert.ok(hashResult.frames>10);assert.ok(hashResult.max_frame_gap_ms<500,'Hash work must yield for rendering');
 const batches=[];
 for(const concurrency of [1,4]){
  const keys=Array.from({length:6},(_,i)=>`synthetic/${concurrency}/${i}-${randomUUID()}`);
  const urls=await Promise.all(keys.map(key=>blobs.createUploadUrl(key,new Date(Date.now()+14*60000))));
  const measured=await page.evaluate(async({urls,concurrency})=>{
   const {ApiClient}=await import('/src/api.ts');
   const clients=Array.from({length:6},()=>new ApiClient(()=>{})),signal=new AbortController().signal;
   // Observe native sends and receipt events; all bytes go to real Blob storage.
   const send=XMLHttpRequest.prototype.send,open=XMLHttpRequest.prototype.open;let active=0,peak=0,count=0;
   XMLHttpRequest.prototype.open=function(...args){
    const result=open.apply(this,args);let ended=false;
    const release=()=>{if(!ended){ended=true;active--;}};
    // Register before the client's receipt listener. Browsers may run promise
    // microtasks between listeners, so a send-time observer runs too late.
    for(const kind of ['load','error','timeout','abort'])this.addEventListener(kind,release,{once:true});
    return result;
   };
   XMLHttpRequest.prototype.send=function(body){active++;count++;peak=Math.max(peak,active);return send.call(this,body);};
   const block=new Uint8Array(1024*1024).fill(121),files=urls.map((_,i)=>new File(Array(8).fill(block),`synthetic-${i}.pdf`,{type:'application/pdf'}));
   const start=performance.now();
   try{
    const task=i=>clients[i].uploadBytes(urls[i],files[i],()=>{},signal,'azure_blob');
    if(concurrency===1)for(let i=0;i<urls.length;i++)await task(i);else await Promise.all(urls.map((_,i)=>task(i)));
    return {concurrency,elapsed_ms:performance.now()-start,peak_actual_put:peak,put_count:count,active_at_end:active,byte_size:files[0].size};
   }finally{XMLHttpRequest.prototype.send=send;XMLHttpRequest.prototype.open=open;}
  },{urls,concurrency});
  assert.ok(measured.peak_actual_put<=4);assert.equal(measured.peak_actual_put,concurrency);assert.equal(measured.put_count,6);
  const proofs=[];for(const key of keys)proofs.push(await blobs.readToFile(key,null,8*1024*1024));
  const hash=createHash('sha256');for(let i=0;i<8;i++)hash.update(Buffer.alloc(1024*1024,121));const expected=hash.digest('hex');
  for(const p of proofs){assert.equal(p.sha256,expected);assert.equal(p.byteSize,8*1024*1024);assert.ok(p.etag);}
  batches.push({...measured,proofs});
 }
 assert.deepEqual(bad,[]);
 const receipt={schema:'upload-four-browser-v1',at:new Date().toISOString(),hash:hashResult,batches,
  scope:'Synthetic local storage; measured timing is not a domestic-network speed claim. No authenticated application behavior is replaced.',passed:true};
 await writeFile(output,JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify(receipt));
}finally{await browser?.close();await vite.close();await client.getContainerClient(container).deleteIfExists();}
