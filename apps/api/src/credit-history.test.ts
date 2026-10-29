import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createServer } from './server.js';
const now='2026-10-09T02:00:00.000000Z';
test('history whitelist, ledger totals, microsecond pagination and owner-scoped cursors',async()=>{
  let owner='owner';const queries:unknown[][]=[];
  const pool={query:async(sql:string,values:unknown[])=>{
    queries.push(values);assert.equal(values[0],owner);
    if(sql.includes('bb_credit_reservations'))return {rows:[2,1].map(i=>({id:'hold-'+i,run_id:'run-'+i,project_id:'project',project_kind:'update',project_name:'冻结项目',task_type:'interim',state:i===2?'settled':'held',points:'17900',charged:i===2?'12000':'0',released:i===2?'5900':'0',corrected:'0',created_at:now,finalized_at:i===2?now:null,cursor_time:now,owner_user_id:owner,secret:'not public'}))};
    return {rows:[]};
  }} as unknown as Pool;
  const app=createServer({pool,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://test.invalid'});
  try{
    const first=await app.inject('/api/v1/credits/consumption-history?limit=1');assert.equal(first.statusCode,200,first.body);
    const data=first.json();assert.equal(data.items.length,1);assert.equal(data.items[0].charged_points,'12000');assert.equal(data.items[0].released_points,'5900');assert.equal(data.items[0].task_name,'一期更新');
    assert.ok(!first.body.includes('owner_user_id')&&!first.body.includes('secret'));assert.equal(first.headers['cache-control'],'private, no-store');
    assert.equal((await app.inject('/api/v1/credits/consumption-history?cursor='+data.page.next_cursor)).statusCode,200);
    assert.equal(queries.at(-1)?.[1],now);assert.equal(queries.at(-1)?.[2],'hold-2');
    for(const url of ['/api/v1/credits/recharge-history?cursor='+data.page.next_cursor,'/api/v1/credits/consumption-history?limit=51','/api/v1/credits/consumption-history?limit=0','/api/v1/credits/consumption-history?cursor=bad'])assert.equal((await app.inject(url)).statusCode,422);
    owner='another-owner';assert.equal((await app.inject('/api/v1/credits/consumption-history?cursor='+data.page.next_cursor)).statusCode,422);
    const orders=await app.inject('/api/v1/credits/recharge-history');assert.equal(orders.statusCode,200,orders.body);assert.deepEqual(orders.json(),{items:[],page:{has_more:false,next_cursor:null}});
  }finally{await app.close();}
});
