import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedRunRetries} from './managed-run-retries.js';
import {nativeExecutionProcesses} from './execution-node-runtime.js';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const lease={jobId:'synthetic',runId:'synthetic',owner:'synthetic',token:'old',checkpoint:{},attempts:2};
test('retry waits for all claim-capable work and native cleanup, with no expiry shortcut',async()=>{
 let native=1,released=0;
 const retries=new ManagedRunRetries(async()=>native,async()=>{released++;return 'queued';});
 const first=retries.enter()!,second=retries.enter()!;
 retries.defer(lease);first();await retries.flush();assert.equal(released,0);
 assert.equal(retries.enter(),null);
 second();await retries.flush();assert.equal(released,0,'live/orphan native process blocks release');
 native=0;await Promise.all([retries.flush(),retries.flush()]);assert.equal(released,1);
 const next=retries.enter();assert.ok(next);next();
});
test('inventory and database failure retain the barrier, stale receipts are discarded',async()=>{
 let failure=true,blocked=true,databaseFailure=true;
 const retries=new ManagedRunRetries(async()=>{if(failure)throw Error('inventory unreadable');return 0;},async()=>{if(databaseFailure)throw Error('database unavailable');return blocked?'blocked':'stale';});
 retries.defer(lease);await assert.rejects(retries.flush(),/unreadable/);assert.equal(retries.enter(),null);
 failure=false;await assert.rejects(retries.flush(),/database unavailable/);assert.equal(retries.enter(),null);
 databaseFailure=false;await retries.flush();assert.equal(retries.pendingCount,1);
 blocked=false;await retries.flush();assert.equal(retries.pendingCount,0);
});
test('new work cannot enter during asynchronous proof or release',async()=>{
 let inspect!:()=>void,release!:()=>void;
 const retries=new ManagedRunRetries(()=>new Promise<number>(r=>{inspect=()=>r(0);}),()=>new Promise<string>(r=>{release=()=>r('queued');}));
 retries.defer(lease);const flushing=retries.flush();assert.equal(retries.enter(),null);
 inspect();await Promise.resolve();await Promise.resolve();assert.equal(retries.enter(),null);
 release();await flushing;assert.equal(retries.pendingCount,0);
});

test('Linux release inventory sees an orphan after its launcher has exited',{skip:process.platform!=='linux'},async()=>{
 const before=await nativeExecutionProcesses();
 const launcher=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.stdout.write(String(child.pid));child.unref();`],{stdio:['ignore','pipe','inherit']});
 let output='';launcher.stdout.on('data',chunk=>{output+=chunk;});
 await new Promise<void>((resolve,reject)=>{launcher.once('error',reject);launcher.once('close',code=>code===0?resolve():reject(Error('synthetic launcher failed')));});
 const orphan=Number(output);assert.ok(Number.isInteger(orphan)&&orphan>1);
 try{
  const stat=await readFile(`/proc/${orphan}/stat`,'utf8');assert.equal(Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]),1);
  assert.ok(await nativeExecutionProcesses()>before,'orphan is still executable and blocks retry');
 }finally{process.kill(orphan,'SIGKILL');}
});
