import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool,PoolClient} from 'pg';
import {creditBalanceExact,legacyCreditBalance,reserveCreditLots} from './billing.js';
import {consumption} from './log-ops.js';
import {trialUsage,costLedger,tokensSince,type TrialConfig} from './trial-guard.js';

test('exact account read supports balances above MAX_SAFE while legacy narrowing fails explicitly',async()=>{
  const db={query:async()=>({rows:[{available:'9007199254740993',frozen:'2'}]})} as unknown as Pool;
  const exact=await creditBalanceExact(db,'synthetic');assert.deepEqual(exact,{available:9007199254740993n,frozen:2n});
  assert.throws(()=>legacyCreditBalance(exact),/Legacy numeric client/);
  const overflowing={query:async()=>({rows:[{available:'9223372036854775807',frozen:'1'}]})} as unknown as Pool;
  await assert.rejects(creditBalanceExact(overflowing,'synthetic'),/int64/);
});
test('int64 lot with large original and frozen values allocates the exact small difference',async()=>{
  const writes:Array<{sql:string;args:unknown[]}>=[];
  const c={query:async(sql:string,args:unknown[])=>{
    if(sql.startsWith('SELECT * FROM bb_credit_lots'))return {rows:[{id:'synthetic-large-lot',remaining:'9007199254740993',frozen:'9007199254740991'}]};
    writes.push({sql,args});return {rows:[]};
  }} as unknown as PoolClient;
  await reserveCreditLots(c,'synthetic-owner','synthetic-reservation',2n);
  assert.deepEqual(writes.find(w=>w.sql.startsWith('UPDATE bb_credit_lots'))!.args,['synthetic-large-lot','2']);
  assert.deepEqual(writes.find(w=>w.sql.startsWith('INSERT INTO bb_credit_allocations'))!.args,['synthetic-reservation','synthetic-large-lot','2']);
});
test('multiple source slices preserve query order and never reallocate existing holds',async()=>{
  const allocations:unknown[][]=[];let query='';
  const c={query:async(sql:string,args:unknown[])=>{
    if(sql.startsWith('SELECT * FROM bb_credit_lots')){query=sql;return {rows:[{id:'soon-expiring',remaining:'3',frozen:'1'},{id:'purchase',remaining:'10',frozen:'0'}]};}
    if(sql.startsWith('INSERT INTO bb_credit_allocations'))allocations.push(args);return {rows:[]};
  }} as unknown as PoolClient;
  await reserveCreditLots(c,'synthetic-owner','synthetic-reservation',5n);
  assert.match(query,/ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE/);
  assert.deepEqual(allocations,[['synthetic-reservation','soon-expiring','2'],['synthetic-reservation','purchase','3']]);
});
test('usage aggregates preserve MAX_SAFE+1 and distinguish unknown counts from measured zero',()=>{
 const base={usage_status:'measured',call_status:'completed',attempt_no:1,cached_input_tokens:null,reasoning_tokens:null};
 assert.deepEqual(consumption([{...base,input_tokens:'9007199254740992',output_tokens:'0'},{...base,input_tokens:'1',output_tokens:'0'}]),
  {attempts:'2',measured_attempts:'2',unresolved_attempts:'0',input_tokens:'9007199254740993',output_tokens:'0',cached_input_tokens:null,reasoning_tokens:null});
 assert.equal(consumption([{...base,usage_status:'unknown',input_tokens:null,output_tokens:null}]).input_tokens,null);
});
test('trial usage and platform ledger keep exact cumulative and per-attempt token strings',async()=>{
 const config={day_time_zone:'UTC',unknown_usage_tokens_per_attempt:600} as TrialConfig;
 const row={d:'2026-10-29',u:'synthetic',n:'2',measured:'1',unresolved:'1',ms:'0',i:'9007199254740993',o:'1',c:'0',rsn:'0',cons:'9007199254741594'};
 const record={attempt_id:'attempt',owner_user_id:'synthetic',job_id:'job',run_id:null,logical_call_id:'call',attempt_no:1,model_id:null,model_provider:null,
  call_status:'completed',usage_status:'measured',input_tokens:'9007199254740993',output_tokens:'1',cached_input_tokens:null,reasoning_tokens:null,
  duration_ms:0,billable:true,cost_bearer:'platform',rate_ref:null,pricing_status:'unknown',cost_amount:null,created_at:new Date('2026-10-29T00:00:00Z'),cursor_at:'2026-10-29T00:00:00.000000Z'};
 const client={query:async(sql:string)=>({rows:sql.includes('FROM bb_platform_cost_ledger')?(sql.includes('GROUP BY')?[row,{...row,u:'synthetic-two',i:'1',o:'0',cons:'1'}]:[record]):sql.includes('usage_budget')?[{tokens:'9007199254740993'}]:[]}),release(){}};
 const db={connect:async()=>client,query:client.query} as unknown as Pool;
 const usage=await trialUsage(db,config,'operator',{from:'2026-10-29',to:'2026-10-29'});
 assert.equal(usage.totals[0].measured_tokens.input_tokens,'9007199254740994');assert.equal(usage.totals[0].conservative_tokens,'9007199254741595');assert.equal(usage.totals[0].attempts,'4');
 const ledger=await costLedger(db,config,'operator',{});assert.equal(ledger.items[0].conservative_tokens,'9007199254740994');assert.equal(ledger.items[0].cached_input_tokens,null);
 assert.equal(await tokensSince(db,config,'synthetic',new Date()),9007199254740993n);
});
