import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { ROOT } from '../lib/platform.mjs';
import { DemoAuth, normalizePhone } from '../lib/auth.mjs';
async function fixture(){const dir=join(ROOT,'qa','artifacts','auth-'+randomUUID());await mkdir(dir,{recursive:true});let now=Date.parse('2026-09-18T01:00:00Z');const path=join(dir,'accounts.json');return {auth:new DemoAuth(path,{now:()=>now}),advance:ms=>now+=ms,path};}
async function login(auth,phone='13800138000'){const c=await auth.requestCode(phone);return auth.verify(phone,c.demoCode,c.challengeId);}
test('demo phone signup creates an account, masks its phone and persists returning login',async()=>{
  const {auth,path}=await fixture();assert.equal(normalizePhone('+86 138-0013-8000'),'13800138000');assert.throws(()=>normalizePhone('12345'));
  const first=await login(auth);assert.equal(first.created,true);assert.equal(first.user.id,'primary');assert.equal(first.user.phoneMasked,'138****8000');assert(!first.user.phone);
  assert.equal((await auth.session(first.token)).id,first.user.id);await auth.logout(first.token);assert.equal(await auth.session(first.token),null);
  const second=await login(auth);assert.equal(second.created,false);assert.equal(second.user.id,first.user.id);const other=await login(auth,'13900139000');assert.notEqual(other.user.id,first.user.id);
  assert(!(await readFile(path,'utf8')).includes(second.token));
});
test('expired, reused or wrong-phone codes cannot create a session; resend invalidates old codes',async()=>{
  const {auth,advance}=await fixture();const c=await auth.requestCode('13800138000');await assert.rejects(auth.requestCode('13800138000'),e=>e.code==='CODE_COOLDOWN');
  await assert.rejects(auth.verify('13900139000',c.demoCode,c.challengeId),e=>e.code==='CODE_EXPIRED');advance(60001);const next=await auth.requestCode('13800138000');await assert.rejects(auth.verify('13800138000',c.demoCode,c.challengeId),e=>e.code==='CODE_EXPIRED');
  await auth.verify('13800138000',next.demoCode,next.challengeId);await assert.rejects(auth.verify('13800138000',next.demoCode,next.challengeId),e=>e.code==='CODE_EXPIRED');
  const expired=await auth.requestCode('13900139000');advance(300001);await assert.rejects(auth.verify('13900139000',expired.demoCode,expired.challengeId),e=>e.code==='CODE_EXPIRED');
});
test('incorrect-code attempt limit is persisted and sessions expire after thirty days',async()=>{
  const {auth,path,advance}=await fixture();const c=await auth.requestCode('13800138000');for(let i=0;i<5;i++)await assert.rejects(auth.verify('13800138000','000000',c.challengeId),e=>e.code==='CODE_INVALID');
  await assert.rejects(auth.verify('13800138000',c.demoCode,c.challengeId),e=>e.code==='CODE_LOCKED');assert.equal(JSON.parse(await readFile(path,'utf8')).challenges['13800138000'].attempts,5);
  advance(60001);const signed=await login(auth);advance(30*86400000+1);assert.equal(await auth.session(signed.token),null);
});
