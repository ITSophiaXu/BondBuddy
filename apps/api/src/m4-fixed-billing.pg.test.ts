import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { M4_DOCUMENT_BILLING_TASKS, M4_DOCUMENT_FIXED_PRICE } from '@bondbuddy/contracts';
import { transaction } from './data.js';
import { creditBalance, grantCredits } from './billing.js';
import { quoteM4, reserveM4, settleM4Metering } from './m4-billing.js';
import { isolatedTestDatabase } from './test-database.js';

const database=await isolatedTestDatabase(undefined,'m4-fixed-billing');
test('synthetic fixed M4: no rate dependency, immutable terms, competing wallets, full release and old quotation rejection',
  {skip:!database,timeout:120000},async()=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID(),hash='a'.repeat(64);
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`synthetic_fixed_${owner.slice(0,8)}`]);
    const seed=async()=>{
      const project=randomUUID(),topic=randomUUID(),id=randomUUID();
      await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic fixed-price project','generation')",[project,owner]);
      await pool.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash) VALUES($1,$2,$3,'Synthetic fixed-price topic',$1,$4)",[topic,owner,project,hash]);
      await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
      await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')",[id,owner,project,hash]);
      return {topic,run:{id}};
    };
    const first=await seed(),second=await seed();
    for(const task of Object.values(M4_DOCUMENT_BILLING_TASKS)) {
      const {quote}=await transaction(pool,c=>quoteM4(c,owner,first.topic,task,hash,{}));
      assert.equal(quote.points,M4_DOCUMENT_FIXED_PRICE.points);assert.equal(quote.billing_method,'fixed');
      assert.equal(quote.price_version,M4_DOCUMENT_FIXED_PRICE.version);assert.equal(quote.amount_semantics,'fixed_price');
    }
    const quotes=await Promise.all([first,second].map(s=>transaction(pool,c=>quoteM4(c,owner,s.topic,'m4_G02',hash,{}))));
    await transaction(pool,c=>grantCredits(c,{owner,points:4500,key:'synthetic-exact-fund',source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    const competition=await Promise.allSettled([first,second].map((s,i)=>transaction(pool,c=>reserveM4(c,owner,s.run,quotes[i].quote.quote_id,s.topic,hash))));
    assert.equal(competition.filter(r=>r.status==='fulfilled').length,1);
    const rejected=competition.find(r=>r.status==='rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code,'CREDITS_INSUFFICIENT');
    assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:4500});
    const winner=competition[0].status==='fulfilled'?first:second;
    assert.deepEqual(await settleM4Metering(pool,owner,winner.run.id),{ready:true,charged_points:4500});
    await assert.rejects(pool.query("UPDATE bb_m4_quotes SET reserve_points=1 WHERE id=$1",[quotes[0].quote.quote_id]),/append only/);
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[winner.run.id]);
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[winner.run.id]);
    assert.deepEqual(await creditBalance(pool,owner),{available:4500,frozen:0});
    const events=(await pool.query('SELECT kind,points FROM bb_credit_events WHERE run_id=$1 ORDER BY kind',[winner.run.id])).rows;
    assert.deepEqual(events.map(e=>[e.kind,Number(e.points)]),[['release',4500],['reserve',4500]]);
    // A pre-migration quote retains the legacy default and cannot start a newly repriced document.
    const legacy=await seed(),quoteId=randomUUID();
    await pool.query("INSERT INTO bb_m4_quotes(id,owner_user_id,topic_id,intent_hash,task_type,reserve_points,multiplier,snapshot,expires_at) VALUES($1,$2,$3,$4,'m4_G02',100,12,'{}',now()+interval '5 minutes')",[quoteId,owner,legacy.topic,hash]);
    assert.equal((await pool.query('SELECT billing_method FROM bb_m4_quotes WHERE id=$1',[quoteId])).rows[0].billing_method,'metered_capped');
    await assert.rejects(transaction(pool,c=>reserveM4(c,owner,legacy.run,quoteId,legacy.topic,hash)),e=>(e as {code:string}).code==='QUOTE_CHANGED');
    assert.deepEqual(await creditBalance(pool,owner),{available:4500,frozen:0});
    // Seed an already-running legacy reservation, as persisted before this migration.
    const rid=randomUUID(),lot=(await pool.query('SELECT id FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0].id;
    await transaction(pool,async c=>{
      await c.query('INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points) VALUES($1,$2,$3,$4,100)',[rid,owner,legacy.run.id,quoteId]);
      await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,100)',[rid,lot]);
      await c.query('UPDATE bb_credit_lots SET frozen=frozen+100 WHERE id=$1',[lot]);
      await c.query("UPDATE bb_runs SET billing_mode='metered_credits',reservation_id=$2 WHERE id=$1",[legacy.run.id,rid]);
      await c.query("INSERT INTO bb_m4_metering(run_id,owner_user_id,status,actual_points,charged_points,evidence) VALUES($1,$2,'verified',7,7,'{\"synthetic\":true}')",[legacy.run.id,owner]);
    });
    assert.deepEqual(await settleM4Metering(pool,owner,legacy.run.id),{ready:true,charged_points:7});
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[legacy.run.id]);
    assert.deepEqual(await creditBalance(pool,owner),{available:4500,frozen:0});
    assert.equal(Number((await pool.query('SELECT charged_points FROM bb_credit_reservations WHERE id=$1',[rid])).rows[0].charged_points),0);
  } finally {await pool.end();}
});
