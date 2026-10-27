// Real PostgreSQL over synthetic originals. No paid-successor authority or
// financial gate is disabled. Migration replay removes only its own scaffold
// inside a rolled-back private-clone transaction.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import {INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'run-billing-segments-sql');
const migrationConnection=await isolatedTestDatabase(undefined,'run-billing-segments-backfill');
const migration=await readFile(new URL('../../../db/migrations/0138_run_billing_segments.sql',import.meta.url),'utf8');
const options={skip:!connection,timeout:60000};
type Origin={owner:string;project:string;run:string;hash:string;quote:string;reservation:string;price:string};
async function origin(c:PoolClient,paid=true):Promise<Origin>{
  const owner=uid(),project=uid(),run=uid(),quote=uid(),reservation=uid(),price=uid();
  const manifest={synthetic:true,revision:1},hash=inputManifestHash(manifest);
  await c.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`fee_${uid().replaceAll('-','').slice(0,16)}`]);
  await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic original fee','update')",[project,owner]);
  await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,'[]','[]')`,[project,owner,hash,manifest]);
  await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued','queued')`,[run,owner,project,hash]);
  await c.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1)',[owner]);
  // Distinct effective timestamps are serialized locally, independent of the
  // template's active public catalog. These raw SQL cases never choose a price.
  await c.query(`INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason)
    SELECT $1,$2,COALESCE(max(effective_at),'2000-01-01'::timestamptz)+interval '1 second','synthetic-test','Frozen SQL fee'
    FROM bb_credit_price_versions`,[price,{...INITIAL_FIXED_PRICES,new_authoring:4500}]);
  await c.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
    VALUES($1,$2,$3,1,$4,$5,'new_authoring',4500,'Synthetic original fee')`,[quote,owner,project,hash,price]);
  if(paid)await bind(c,{owner,project,run,hash,quote,reservation,price});
  return {owner,project,run,hash,quote,reservation,price};
}
async function bind(c:PoolClient,f:Origin){
  await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points,created_at)
    VALUES($1,$2,$3,$4,4500,'authoring_balance_v2',0,'2026-10-25T01:02:03.123456Z')`,[f.reservation,f.owner,f.run,f.quote]);
  await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[f.run,f.reservation]);
}
async function fixture(){
  const pool=new Pool({connectionString:connection}),c=await pool.connect();
  try{await c.query('BEGIN');const f=await origin(c);await c.query('COMMIT');c.release();return {pool,...f};}
  catch(error){await c.query('ROLLBACK');c.release();await pool.end();throw error;}
}
async function mirrored(c:Pool|PoolClient,f:Origin){
  const row=(await c.query(`SELECT ROW(m.active_ms,m.work_bps,m.accrued_points,m.clock_at,m.lease_until,m.last_activity_at)
    IS NOT DISTINCT FROM ROW(a.active_ms,a.work_bps,a.accrued_points,a.clock_at,a.lease_until,a.last_activity_at) AS exact
    FROM bb_run_billing_progress m JOIN bb_authoring_progress a ON a.run_id=m.run_id AND a.owner_user_id=m.owner_user_id
    WHERE m.billing_segment_id=$1`,[f.reservation])).rows[0];
  assert.equal(row?.exact,true);
}

test('reserve pointer UPDATE immediately captures exact V1 fee, meter and one outbox event',options,async()=>{
  const pool=new Pool({connectionString:connection}),c=await pool.connect();
  try{
    await c.query('BEGIN');const f=await origin(c,false);
    await c.query(`INSERT INTO bb_authoring_progress(run_id,owner_user_id,active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
      VALUES($1,$2,12345,400,123,'2026-10-25T01:02:03.654321Z','2026-10-25T01:02:33.654321Z','2026-10-25T01:02:00.654321Z')`,[f.run,f.owner]);
    await bind(c,f);
    const row=(await c.query(`SELECT s.*,b.execution_version,b.input_revision,b.input_hash,b.assignment_kind,
      s.created_at=c.created_at AS exact_time,to_char(s.created_at,'US') AS micros
      FROM bb_run_billing_segments s JOIN bb_credit_reservations c ON c.id=s.reservation_id
      JOIN bb_run_execution_billing_bindings b ON b.billing_segment_id=s.id WHERE s.id=$1`,[f.reservation])).rows[0];
    assert.equal(row.id,f.reservation);assert.equal(row.reservation_id,f.reservation);assert.equal(row.source_quote_id,f.quote);
    assert.equal(row.origin_execution_version,1);assert.equal(row.execution_version,1);assert.equal(row.input_revision,1);
    assert.equal(row.input_hash.trim(),f.hash);assert.equal(row.assignment_kind,'original');assert.equal(row.segment_number,1);
    assert.equal(Number(row.points),4500);assert.equal(row.billing_policy,'authoring_balance_v2');
    assert.equal(row.exact_time,true);assert.equal(row.micros,'123456');await mirrored(c,f);
    assert.equal(Number((await c.query('SELECT accrued_points FROM bb_run_billing_progress WHERE billing_segment_id=$1',[f.reservation])).rows[0].accrued_points),123);
    await c.query('SELECT bb_capture_original_run_billing($1,$2)',[f.owner,f.run]);
    const events=(await c.query("SELECT payload FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.billing_segment_bound'",[f.run])).rows;
    assert.equal(events.length,1);assert.deepEqual(events[0].payload,{run_id:f.run,billing_segment_id:f.reservation,
      execution_version:1,input_revision:1,input_hash:f.hash,source_quote_id:f.quote,billing_policy:'authoring_balance_v2',points:4500,capture_kind:'runtime_origin'});
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bb_credit_events WHERE run_id=$1',[f.run])).rows[0].n,0,'capture never creates a debit');
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  }finally{await c.query('ROLLBACK');c.release();await pool.end();}
});

test('canonical and legacy meter updates mirror all fields exactly without charging',options,async()=>{
  const f=await fixture();
  try{
    await f.pool.query(`UPDATE bb_run_billing_progress SET active_ms=12000,work_bps=400,accrued_points=234,
      clock_at='2026-10-25T01:02:03.123456Z',lease_until='2026-10-25T01:02:33.123456Z',last_activity_at='2026-10-25T01:02:00.123456Z'
      WHERE billing_segment_id=$1`,[f.reservation]);await mirrored(f.pool,f);
    await f.pool.query(`UPDATE bb_authoring_progress SET active_ms=24000,work_bps=2000,accrued_points=456,
      clock_at='2026-10-25T01:03:03.654321Z',lease_until=NULL,last_activity_at='2026-10-25T01:03:00.654321Z' WHERE run_id=$1`,[f.run]);
    await mirrored(f.pool,f);
    const row=(await f.pool.query("SELECT *,to_char(clock_at,'US') AS micros FROM bb_run_billing_progress WHERE billing_segment_id=$1",[f.reservation])).rows[0];
    assert.equal(Number(row.active_ms),24000);assert.equal(row.work_bps,2000);assert.equal(Number(row.accrued_points),456);assert.equal(row.micros,'654321');
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bb_credit_events WHERE run_id=$1',[f.run])).rows[0].n,0);
    await f.pool.query('SELECT bb_assert_original_run_billing($1,$2)',[f.owner,f.run]);
  }finally{await f.pool.end();}
});

test('original pointer, price, policy, identity and mirrored meter cannot be rewritten or removed',options,async()=>{
  const f=await fixture();
  try{
    for(const sql of ["UPDATE bb_runs SET reservation_id=NULL,billing_mode='platform_trial' WHERE id=$1",
      "UPDATE bb_runs SET billing_mode='metered_credits' WHERE id=$1"])
      await assert.rejects(f.pool.query(sql,[f.run]),{code:'23514',constraint:'bb_run_billing_origin_immutable'});
    for(const setter of ["quote_id='different-quote'","points=points+1","billing_policy='on_delivery'","run_id='different-run'",
      "owner_user_id='different-owner'","created_at=created_at+interval '1 second'"])
      await assert.rejects(f.pool.query(`UPDATE bb_credit_reservations SET ${setter} WHERE id=$1`,[f.reservation]),
        {code:'23514',constraint:'bb_run_billing_reservation_immutable'});
    for(const table of ['bb_run_billing_segments','bb_run_execution_billing_bindings']){
      await assert.rejects(f.pool.query(`DELETE FROM ${table} WHERE run_id=$1`,[f.run]),{code:'23514',constraint:'bb_run_billing_immutable'});
      await assert.rejects(f.pool.query(`UPDATE ${table} SET run_id=run_id WHERE run_id=$1`,[f.run]),{code:'23514',constraint:'bb_run_billing_immutable'});
    }
    for(const table of ['bb_authoring_progress','bb_run_billing_progress'])
      await assert.rejects(f.pool.query(`DELETE FROM ${table} WHERE run_id=$1`,[f.run]),{code:'23514',constraint:'bb_run_billing_meter_exact'});
    await assert.rejects(f.pool.query('UPDATE bb_run_billing_progress SET project_id=$2 WHERE billing_segment_id=$1',[f.reservation,uid()]),
      {code:'23514',constraint:'bb_run_billing_meter_exact'});
    await assert.rejects(f.pool.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy)
      VALUES($1,$2,$3,$4,4500,'authoring_balance_v2')`,[uid(),f.owner,f.run,f.quote]),{code:'23505',constraint:'bb_credit_reservations_run_id_key'});
    await mirrored(f.pool,f);
  }finally{await f.pool.end();}
});

test('deferred integrity rejects an unbound reservation and rolls it back',options,async()=>{
  const pool=new Pool({connectionString:connection}),c=await pool.connect();
  try{
    await c.query('BEGIN');const f=await origin(c,false);await c.query('COMMIT');
    await c.query('BEGIN');
    await c.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points)
      VALUES($1,$2,$3,$4,4500,'authoring_balance_v2',0)`,[f.reservation,f.owner,f.run,f.quote]);
    await assert.rejects(c.query('COMMIT'),{code:'23514',constraint:'bb_run_billing_capture_exact'});
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bb_credit_reservations WHERE id=$1',[f.reservation])).rows[0].n,0);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bb_run_billing_segments WHERE run_id=$1',[f.run])).rows[0].n,0);
  }finally{await c.query('ROLLBACK');c.release();await pool.end();}
});

test('free V1 legacy progress remains free and cannot manufacture a paid segment',options,async()=>{
  const pool=new Pool({connectionString:connection}),c=await pool.connect();
  try{
    await c.query('BEGIN');const f=await origin(c,false);
    await c.query('INSERT INTO bb_authoring_progress(run_id,owner_user_id,active_ms) VALUES($1,$2,100)',[f.run,f.owner]);
    await c.query('UPDATE bb_authoring_progress SET active_ms=200 WHERE run_id=$1',[f.run]);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bb_run_billing_segments WHERE run_id=$1',[f.run])).rows[0].n,0);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM bb_run_billing_progress WHERE run_id=$1',[f.run])).rows[0].n,0);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  }finally{await c.query('ROLLBACK');c.release();await pool.end();}
});

for(const direction of ['canonical-held','legacy-held'] as const)
  test(`meter mirror ${direction} fails promptly on reverse row locks and retries exactly`,options,async()=>{
    const f=await fixture(),held=await f.pool.connect(),writer=await f.pool.connect();
    const heldTable=direction==='canonical-held'?'bb_run_billing_progress':'bb_authoring_progress';
    const writeTable=direction==='canonical-held'?'bb_authoring_progress':'bb_run_billing_progress';
    try{
      await held.query('BEGIN');await held.query(`SELECT * FROM ${heldTable} WHERE run_id=$1 FOR UPDATE`,[f.run]);
      await writer.query('BEGIN');await writer.query("SET LOCAL statement_timeout='2s'");
      await assert.rejects(writer.query(`UPDATE ${writeTable} SET active_ms=active_ms+100 WHERE run_id=$1`,[f.run]),{code:'55P03'});
      await writer.query('ROLLBACK');await held.query('ROLLBACK');
      await writer.query(`UPDATE ${writeTable} SET active_ms=active_ms+100 WHERE run_id=$1`,[f.run]);await mirrored(writer,f);
      assert.equal(Number((await writer.query('SELECT active_ms FROM bb_run_billing_progress WHERE billing_segment_id=$1',[f.reservation])).rows[0].active_ms),100);
    }finally{await writer.query('ROLLBACK');await held.query('ROLLBACK');writer.release();held.release();await f.pool.end();}
  });

test('0138 backfill preserves historical price, charged prefix and microsecond meters atomically',
  {skip:!migrationConnection,timeout:60000},async()=>{
    const pool=new Pool({connectionString:migrationConnection,max:1}),c=await pool.connect();
    try{
      await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      // Reconstruct only the migration's predecessor definitions. All earlier
      // execution, quote, production and terminal-delivery gates stay enabled.
      for(const name of ['bb_credit_finalize_run','bb_m4_credit_finalize_run']){
        let definition=(await c.query('SELECT pg_get_functiondef($1::regprocedure) AS d',[`${name}()`])).rows[0].d as string;
        const canonical=/SELECT c\.\* INTO STRICT r FROM bb_run_execution_billing_bindings b[\s\S]*?FOR UPDATE OF c;/;
        assert.match(definition,canonical);
        definition=definition.replace(canonical,name==='bb_credit_finalize_run'
          ? 'SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id FOR UPDATE;'
          : 'SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND owner_user_id=NEW.owner_user_id AND run_id=NEW.id FOR UPDATE;');
        definition=definition.replace(/IF NEW\.reservation_id IS NOT NULL AND NEW\.state IN \('succeeded','failed','cancelled','rejected'\) AND OLD\.state IS DISTINCT FROM NEW\.state THEN PERFORM bb_assert_original_run_billing\(NEW\.owner_user_id,NEW\.id\); END IF;/,'');
        definition=definition.replace('SELECT accrued_points FROM bb_run_billing_progress WHERE billing_segment_id=r.id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id',
          'SELECT accrued_points FROM bb_authoring_progress WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id');
        await c.query(definition);
      }
      let supplement=(await c.query("SELECT pg_get_functiondef('bb_assert_supplement_quote_live(bb_run_supplement_quotes)'::regprocedure) AS d")).rows[0].d as string;
      supplement=supplement.replace('SELECT * INTO reservation FROM bb_credit_reservations WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id AND id=r.reservation_id;',
        'SELECT * INTO reservation FROM bb_credit_reservations WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id;');await c.query(supplement);
      await c.query('DROP TABLE bb_run_billing_progress,bb_run_execution_billing_bindings,bb_run_billing_segments CASCADE');
      const definitions=[...migration.matchAll(/CREATE FUNCTION (bb_[a-z_]+)\(/g)].map(match=>match[1]!);
      for(const name of definitions){
        const signatures=(await c.query('SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE proname=$1',[name])).rows;
        for(const row of signatures)await c.query(`DROP FUNCTION ${row.signature} CASCADE`);
      }
      await c.query("DELETE FROM bb_outbox WHERE event_type='run.billing_segment_bound'");
      const f=await origin(c);
      const lot=uid();
      await c.query(`INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,frozen)
        VALUES($1,$2,'purchase',$1,4500,3300,0)`,[lot,f.owner]);
      await c.query(`INSERT INTO bb_credit_allocations(reservation_id,lot_id,points,charged_points)
        VALUES($1,$2,1200,1200)`,[f.reservation,lot]);
      await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,actor,reason)
        VALUES($1,$2,$3,'grant',4500,$4,'synthetic-test','Synthetic historical purchase')`,[uid(),f.owner,`grant:${lot}`,lot]);
      await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
        VALUES($1,$2,$3,'settle',1200,$4,$5,'system','authoring_progress')`,[uid(),f.owner,`progress:${f.reservation}:1200`,f.reservation,f.run]);
      await c.query("UPDATE bb_credit_reservations SET charged_points=1200 WHERE id=$1",[f.reservation]);
      await c.query(`INSERT INTO bb_authoring_progress(run_id,owner_user_id,active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
        VALUES($1,$2,654321,2000,1200,'2026-10-25T01:02:03.123456Z',NULL,'2026-10-25T01:02:00.654321Z')`,[f.run,f.owner]);
      const snapshot=`SELECT jsonb_build_object('reservation',to_jsonb(c),
        'allocations',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.lot_id),'[]'::jsonb) FROM bb_credit_allocations a WHERE a.reservation_id=c.id),
        'events',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.event_key),'[]'::jsonb) FROM bb_credit_events e WHERE e.owner_user_id=c.owner_user_id),
        'lots',(SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM bb_credit_lots l WHERE l.owner_user_id=c.owner_user_id)) AS snapshot
        FROM bb_credit_reservations c WHERE c.id=$1`;
      const before=(await c.query(snapshot,[f.reservation])).rows[0].snapshot;
      await c.query('SAVEPOINT incomplete_origin');
      await c.query("UPDATE bb_runs SET reservation_id=NULL,billing_mode='platform_trial' WHERE id=$1",[f.run]);
      await assert.rejects(c.query(migration),{code:'23514',constraint:'bb_run_billing_capture_exact'});
      await c.query('ROLLBACK TO SAVEPOINT incomplete_origin');
      assert.equal((await c.query("SELECT to_regclass('bb_run_billing_segments') AS name")).rows[0].name,null);
      await c.query(migration);await mirrored(c,f);
      assert.deepEqual((await c.query(snapshot,[f.reservation])).rows[0].snapshot,before);
      const m=(await c.query("SELECT *,to_char(clock_at,'US') AS micros FROM bb_run_billing_progress WHERE billing_segment_id=$1",[f.reservation])).rows[0];
      assert.equal(Number(m.active_ms),654321);assert.equal(m.work_bps,2000);assert.equal(Number(m.accrued_points),1200);assert.equal(m.micros,'123456');
      const event=(await c.query("SELECT payload FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.billing_segment_bound'",[f.run])).rows;
      assert.equal(event.length,1);assert.equal(event[0].payload.capture_kind,'historical_backfill');
      await c.query('SELECT bb_assert_original_run_billing($1,$2)',[f.owner,f.run]);
    }finally{await c.query('ROLLBACK');c.release();await pool.end();}
  });
