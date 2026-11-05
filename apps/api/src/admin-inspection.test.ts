import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {Problem} from './data.js';
import {installAdminInspectionRoutes} from './admin-inspection.js';
import {collectAdminInspection} from './admin-inspection-data.js';
function fake(allowed:boolean){const calls:string[]=[];const query=async(sql:string)=>{calls.push(sql);if(sql.includes('bb_operator_grants'))return {rows:allowed?[{role:'log_reader'}]:[]};if(sql.includes('information_schema'))return {rows:[{table_name:'bb_runs'},{table_name:'bb_users'},{table_name:'bb_projects'}]};if(sql==='SELECT now() AS captured_at')return {rows:[{captured_at:'2026-11-04T00:00:00Z'}]};if(sql.startsWith('SELECT count(*)'))return {rows:[{n:'0'}]};return {rows:[]};};const client={query,release(){}};return {calls,pool:{query,connect:async()=>client} as unknown as Pool};}
async function appFor(allowed:boolean,loggedIn=true){const {pool,calls}=fake(allowed),app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status??500).send({code:e.code}));installAdminInspectionRoutes(app,{db:()=>pool,owner:async()=>{if(!loggedIn)throw new Problem(401,'UNAUTHENTICATED','Login required');return 'operator';}});return {app,calls};}
test('account navigation checks only the current authenticated operator grant without exporting rows',async()=>{
 for(const [allowed,loggedIn,status] of [[true,true,200],[false,true,200],[true,false,401]] as const){
  const {app,calls}=await appFor(allowed,loggedIn);try{const r=await app.inject('/api/v1/admin/inspection/access');assert.equal(r.statusCode,status);if(status===200){assert.deepEqual(r.json(),{allowed});assert.match(r.headers['cache-control'] as string,/no-store/);}assert.equal(calls.some(c=>c.includes('information_schema')),false);}finally{await app.close();}
 }
});
test('anonymous and ungranted accounts cannot read any operational rows',async()=>{for(const [allowed,loggedIn,status] of [[true,false,401],[false,true,404]] as const){const {app,calls}=await appFor(allowed,loggedIn);try{assert.equal((await app.inject('/api/v1/admin/inspection/snapshot')).statusCode,status);assert.equal(calls.some(c=>c.includes('information_schema')),false);}finally{await app.close();}}});
test('snapshot access is audited before a repeatable read only transaction and is non-cacheable',async()=>{const {app,calls}=await appFor(true);try{const r=await app.inject('/api/v1/admin/inspection/snapshot');assert.equal(r.statusCode,200,r.body);assert.match(r.headers['cache-control'] as string,/no-store/);assert.equal(r.json().source,'live_database');assert.ok(calls.findIndex(c=>c.startsWith('INSERT INTO bb_log_access_audit'))<calls.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));assert.ok(calls.includes('COMMIT'));assert.equal(calls.some(c=>/^UPDATE |^DELETE /.test(c)),false);}finally{await app.close();}});
test('snapshot rejects arbitrary SQL-like filter parameters before export',async()=>{const {app,calls}=await appFor(true);try{assert.equal((await app.inject('/api/v1/admin/inspection/snapshot?user_id=all')).statusCode,422);assert.equal(calls.some(c=>c.includes('information_schema')),false);}finally{await app.close();}});
test('missing optional tables are visible, never fabricated as observed zero',async()=>{const {pool}=fake(true);const s=await collectAdminInspection(pool);assert.equal(s.tables.find(t=>t.name==='bb_codex_exec_logs')?.available,false);assert.equal(s.tables.find(t=>t.name==='bb_runs')?.available,true);assert.equal(s.scope.run_count,0);});

test('only one export may occupy memory and the slot is released after sending',async()=>{
 const {pool}=fake(true),connect=pool.connect.bind(pool);let entered!:()=>void,unblock!:()=>void;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>unblock=r);
 pool.connect=(async()=>{entered();await gate;return connect();}) as typeof pool.connect;
 const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status??500).send({code:e.code}));installAdminInspectionRoutes(app,{db:()=>pool,owner:async()=> 'operator'});
 try{await app.ready();const first=app.inject('/api/v1/admin/inspection/snapshot').then(r=>r);await started;const second=await app.inject('/api/v1/admin/inspection/snapshot');assert.equal(second.statusCode,503);assert.equal(second.headers['retry-after'],'5');unblock();assert.equal((await first).statusCode,200);assert.equal((await app.inject('/api/v1/admin/inspection/snapshot')).statusCode,200);}finally{unblock();await app.close();}
});
