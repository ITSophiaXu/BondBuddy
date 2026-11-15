import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {executionCapacityControl,executionCloudExpenseLedger,configureExecutionCapacity} from '@bondbuddy/api/execution-capacity';
import {quoteFixture} from './cloud-quote-refresh.test.mjs';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';

// Only a separately created local database. Cloud responses and clock rollover
// are synthetic; budget transactions and expense-ledger reads are actual PG.
test('real isolated PG closes/reopens admission across midnight and API outage without new cloud operations',
  {skip:!process.env.BB1389_TEST_DATABASE_URL},async t=>{
    const pool=new Pool({connectionString:process.env.BB1389_TEST_DATABASE_URL,max:2,connectionTimeoutMillis:5000,query_timeout:5000});
    t.after(()=>pool.end());assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'bb1389_quote');
    const f=await quoteFixture(t,{at:Date.parse('2026-11-15T15:59:00Z')});t.mock.timers.enable({apis:['Date'],now:f.state.at});
    const control=executionCapacityControl(pool),h=f.config.expense_policy_sha256;
    await configureExecutionCapacity(pool,(await control.snapshot()).policy.revision,
      {managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:false,expense_policy_sha256:h});
    const cloud={transport:f.transport,inventory:async()=>[]};
    const handler=createExecutionPoolOpsHandler({control,configPath:f.configPath,expenseLedger:async()=>({
      ...await executionCloudExpenseLedger(pool),captured_at:new Date(f.state.at).toISOString()}),dependencies:{now:()=>f.state.at,cloud}});
    await handler.tick();assert.equal((await control.snapshot()).policy.budget_available,true);
    f.state.at+=61000;t.mock.timers.setTime(f.state.at);
    await control.setAdmissionBudget((await control.snapshot()).policy.revision,false,h);
    await handler.tick();assert.equal((await control.snapshot()).policy.budget_available,true);
    f.state.at+=61000;t.mock.timers.setTime(f.state.at);cloud.transport={call:async()=>{throw Error('synthetic API failure');}};
    await handler.tick();assert.equal((await control.snapshot()).policy.budget_available,false);
    f.state.at+=61000;t.mock.timers.setTime(f.state.at);cloud.transport=f.transport;
    await handler.tick();assert.equal((await control.snapshot()).policy.budget_available,true);
    const ledger=await executionCloudExpenseLedger(pool);assert.equal(ledger.nodes.length,0);assert.equal(ledger.operations.length,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bb_model_capacity_holders')).rows[0].n,0);
  });
