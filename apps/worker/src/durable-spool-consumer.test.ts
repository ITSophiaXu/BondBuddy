import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withDurableSpoolPumpLock} from './durable-spool-consumer.js';

test('kernel pump lock excludes another session and releases after failed owner work',{skip:process.platform!=='linux'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'bb-spool-pump-lock-'));
 let entered!:()=>void,enterFailed!:(error:unknown)=>void,release!:()=>void;
 const entry=new Promise<void>((resolve,reject)=>{entered=resolve;enterFailed=reject;}),hold=new Promise<void>(resolve=>{release=resolve;});
 try{
  const first=withDurableSpoolPumpLock(root,async assertLock=>{assertLock();entered();await hold;assertLock();throw Error('synthetic_owner_failed');},async()=>{assert.fail('first owner acquires');});
  void first.catch(enterFailed);
  await entry;
  const second=await withDurableSpoolPumpLock(root,async()=>{assert.fail('concurrent owner cannot upload/register/GC');},async()=> 'busy');
  assert.equal(second,'busy');release();await assert.rejects(first,/synthetic_owner_failed/);
  assert.equal(await withDurableSpoolPumpLock(root,async assertLock=>{assertLock();return 'recovered';},async()=>{assert.fail('kernel lock released with owner');}),'recovered');
 }finally{release?.();await rm(root,{recursive:true,force:true});}
});
