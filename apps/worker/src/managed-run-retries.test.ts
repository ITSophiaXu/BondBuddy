import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedRunRetries} from './managed-run-retries.js';
import {nativeExecutionProcesses,nativeExecutionChildren} from './execution-node-runtime.js';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const lease={jobId:'synthetic',runId:'synthetic',owner:'synthetic',token:'old',checkpoint:{},attempts:2};
test('A retains its exact retry lease while B can claim and run; unrelated activity does not block clean A',async()=>{
 let native=1,released=0;
 const retries=new ManagedRunRetries(async()=>native,async()=>{released++;return 'queued';});
 const first=retries.enter()!,second=retries.enter()!;
 retries.defer(lease);first();await retries.flush();assert.equal(released,0);
 const third=retries.enter();assert.ok(third,'B can claim while A is pending');
 second();await retries.flush();assert.equal(released,0,'live/orphan native process blocks release');
 native=0;await Promise.all([retries.flush(),retries.flush()]);assert.equal(released,1);
 third();const next=retries.enter();assert.ok(next);next();
});
test('inventory and database failure retain only the failed task, stale receipts are discarded',async()=>{
 let failure=true,blocked=true,databaseFailure=true;
 const retries=new ManagedRunRetries(async()=>{if(failure)throw Error('inventory unreadable');return 0;},async()=>{if(databaseFailure)throw Error('database unavailable');return blocked?'blocked':'stale';});
 retries.defer(lease);await assert.rejects(retries.flush(),/TASK_RETRY_RELEASE_BLOCKED/);assert.ok(retries.enter());
 failure=false;await assert.rejects(retries.flush(),/TASK_RETRY_RELEASE_BLOCKED/);assert.ok(retries.enter());
 databaseFailure=false;await retries.flush();assert.equal(retries.pendingCount,1);
 blocked=false;await retries.flush();assert.equal(retries.pendingCount,0);
});
test('new work enters during asynchronous A proof/release; concurrent flush releases A once',async()=>{
 let inspect!:()=>void,release!:()=>void;
 const retries=new ManagedRunRetries(()=>new Promise<number>(r=>{inspect=()=>r(0);}),()=>new Promise<string>(r=>{release=()=>r('queued');}));
 retries.defer(lease);const flushing=retries.flush(),another=retries.flush();assert.ok(retries.enter());
 await Promise.resolve();inspect();await Promise.resolve();await Promise.resolve();assert.ok(retries.enter());
 release();await Promise.all([flushing,another]);assert.equal(retries.pendingCount,0);
});
test('pending A inventory failure or slow cleanup does not prevent independent B release',async()=>{
 let unblock!:()=>void;const released:string[]=[];
 const retries=new ManagedRunRetries(l=>l.jobId==='synthetic'?new Promise<number>(r=>{unblock=()=>r(1);}):Promise.resolve(0),
  async l=>{released.push(l.jobId);return 'queued';});
 retries.defer(lease);retries.defer({...lease,jobId:'B'});
 const work=retries.flush();await Promise.resolve();await Promise.resolve();await Promise.resolve();
 assert.deepEqual(released,['B']);assert.ok(retries.enter());unblock();await work;assert.equal(retries.pendingCount,1);
 const failures=new ManagedRunRetries(async l=>{if(l.jobId==='synthetic')throw Error('unreadable');return 0;},
  async l=>{released.push(l.jobId);return 'queued';});
 failures.defer(lease);failures.defer({...lease,jobId:'C'});
 await assert.rejects(failures.flush(),/TASK_RETRY_RELEASE_BLOCKED/);assert.deepEqual(released,['B','C']);assert.equal(failures.pendingCount,1);
});
test('two attempts of the same job cannot overwrite each other or confuse exact token proof',async()=>{
 const tokens:string[]=[];
 const retries=new ManagedRunRetries(async l=>l.token==='old'?1:0,async l=>{tokens.push(l.token);return 'stale';});
 retries.defer(lease);retries.defer({...lease,token:'new'});await retries.flush();
 assert.deepEqual(tokens,['new']);assert.equal(retries.pendingCount,1);
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
  assert.ok(await nativeExecutionChildren()>before,'orphan also blocks idle and final drain');
 }finally{process.kill(orphan,'SIGKILL');}
});


test('Linux drain ignores an unreaped zombie but still counts its live parent',{skip:process.platform!=='linux'},async()=>{
 const before=await nativeExecutionProcesses();
 const launcher=spawn('python3',['-c',`import os,time
pid=os.fork()
if pid==0: os._exit(0)
print(pid,flush=True)
time.sleep(30)
`],{stdio:['ignore','pipe','inherit']});
 const child=await new Promise<number>((resolve,reject)=>{let output='';launcher.once('error',reject);launcher.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(Number(output.trim()));});});
 try{
  let zombie=false;
  for(let i=0;i<100;i++){
   const raw=await readFile(`/proc/${child}/stat`,'utf8');
   if(raw.slice(raw.lastIndexOf(')')+2).split(' ')[0]==='Z'){zombie=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(zombie,'fixture must contain a real unreaped zombie');
  assert.equal(await nativeExecutionProcesses(),before+1,'only the live launcher counts');
  assert.equal(await nativeExecutionChildren(),before+1,'heartbeat and final drain use the same proof');
 }finally{
  const closed=new Promise<void>(resolve=>launcher.once('close',()=>resolve()));launcher.kill('SIGTERM');await closed;
 }
});
