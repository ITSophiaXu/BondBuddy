// Canonical V1 compatibility only. Shadow tables model corrupt audit input in
// an isolated database without disabling or mutating production integrity gates.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { INITIAL_FIXED_PRICES } from '@bondbuddy/contracts';
import { auditCredits, correctSettlement } from './billing-ops.js';
import { consumptionHistory } from './credit-history.js';
import { creditBalance, publishPrices } from './billing.js';
import { debitAuthoringCredits } from './authoring-credit-debit.js';
import { action } from './queue.js';
import { Problem, transaction, uid } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { createRunSupplementPreparationFixture } from './run-supplement-preparation-test-fixture.js';
import { createRunSupplementFilePreparationFixture } from './run-supplement-file-preparation-test-fixture.js';

const connection = await isolatedTestDatabase(undefined, 'billing-segment-compatibility');
const options = { skip: !connection, timeout: 120000 };
async function fixture(kind: 'authoring'|'m4') {
  return kind === 'authoring'
    ? createRunSupplementPreparationFixture(connection!, { earlyPause: 'before_prompt' })
    : createRunSupplementFilePreparationFixture(connection!, 'm4', { earlyPause: 'before_prompt' });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function originalFee(f: Fixture, kind: 'authoring'|'m4') {
  const quote = uid(), reservation = uid(), points = 4500;
  if (kind === 'authoring') {
    const price = `canonical-fee-${uid()}`;
    await publishPrices(f.pool, { id: price, prices: { ...INITIAL_FIXED_PRICES, new_authoring: points },
      effectiveAt: new Date(Date.now() - 86400000).toISOString(), actor: 'synthetic-test', reason: 'Canonical V1 compatibility only' });
    await f.pool.query(`INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason)
      VALUES($1,$2,$3,1,$4,$5,'new_authoring',$6,'Synthetic original fee')`, [quote,f.owner,f.projectId,f.hash,price,points]);
  } else {
    const manifest = f.manifest as any;
    await f.pool.query(`INSERT INTO bb_m4_quotes(id,owner_user_id,topic_id,intent_hash,task_type,config_id,reserve_points,multiplier,
      snapshot,expires_at,billing_method,fixed_price_version,billing_policy)
      VALUES($1,$2,$3,$4,$5,NULL,$6,1,$7,clock_timestamp()+interval '5 minutes','fixed','m4-document-fixed-20261008-v1','authoring_balance_v2')`,
    [quote,f.owner,manifest.topic_id,f.hash,manifest.billing_task,points,f.manifest]);
  }
  await transaction(f.pool, async db => {
    await db.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points)
      VALUES($1,$2,$3,$4,$5,'authoring_balance_v2',0)`, [reservation,f.owner,f.runId,quote,points]);
    await db.query(`UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1`, [f.runId,reservation]);
  });
  return reservation;
}

/** Use normal SQL on private copies to exercise the audit's actual joins and
 * predicates. Integrity triggers and immutable original records stay enabled. */
async function shadow<T>(pool: Pool, tables: string[], work: (db: Pool, schema: string) => Promise<T>): Promise<T> {
  const schema = `synthetic_fee_${uid().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  let scoped: Pool|undefined;
  try {
    for (const table of tables) await pool.query(`CREATE TABLE ${schema}.${table} AS TABLE public.${table}`);
    scoped = new Pool({ connectionString: connection, options: `-c search_path=${schema},public` });
    return await work(scoped, schema);
  } finally {
    await scoped?.end();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

test('canonical V1 audit detects missing, changed and misbound fee provenance', options, async () => {
  const f = await fixture('authoring');
  try {
    const reservation = await originalFee(f, 'authoring');
    const clean = await auditCredits(f.pool);
    assert.equal(clean.consistent, true, JSON.stringify(clean));
    const changes = [
      ['missing segment', `DELETE FROM bb_run_billing_segments WHERE reservation_id=$1`],
      ['wrong source quote', `UPDATE bb_run_billing_segments SET source_quote_id='other-source' WHERE reservation_id=$1`],
      ['wrong policy', `UPDATE bb_run_billing_segments SET billing_policy='on_delivery' WHERE reservation_id=$1`],
      ['wrong cap', `UPDATE bb_run_billing_segments SET points=points+1 WHERE reservation_id=$1`],
      ['wrong input', `UPDATE bb_run_billing_segments SET origin_input_hash=repeat('a',64) WHERE reservation_id=$1`],
      ['missing binding', `DELETE FROM bb_run_execution_billing_bindings WHERE billing_segment_id=$1`],
      ['wrong binding', `UPDATE bb_run_execution_billing_bindings SET billing_segment_id='other-segment' WHERE billing_segment_id=$1`],
      ['different meter', `UPDATE bb_run_billing_progress SET active_ms=active_ms+1 WHERE billing_segment_id=$1`],
    ];
    for (const [label, sql] of changes) {
      await shadow(f.pool, ['bb_run_billing_segments','bb_run_execution_billing_bindings','bb_run_billing_progress'], async db => {
        await db.query(sql!, [reservation]);
        const report = await auditCredits(db);
        assert.equal(report.consistent, false, label);
        assert.ok(report.reservationDrift.some(row => row.id === reservation), label);
      });
    }
    assert.equal((await auditCredits(f.pool)).consistent, true, 'audit shadows never alter the canonical original fee');
  } finally { await f.cleanup(); }
});

test('M4 original fees are included in provenance and cap auditing', options, async () => {
  const f = await fixture('m4');
  try {
    const reservation = await originalFee(f, 'm4');
    const clean = await auditCredits(f.pool);
    assert.equal(clean.consistent, true, JSON.stringify(clean));
    await shadow(f.pool, ['bb_credit_reservations'], async db => {
      await db.query('UPDATE bb_credit_reservations SET points=points+1 WHERE id=$1', [reservation]);
      const report = await auditCredits(db);
      assert.equal(report.consistent, false);
      assert.ok(report.reservationDrift.some(row => row.id === reservation), 'an original M4 quote is not omitted by a credit-quotes inner join');
    });
  } finally { await f.cleanup(); }
});

test('history names the canonical fee input and retains the existing reservation DTO and cursor', options, async () => {
  const f = await fixture('authoring');
  try {
    const reservation = await originalFee(f, 'authoring');
    await shadow(f.pool, ['bb_runs','bb_input_revisions'], async db => {
      await db.query(`UPDATE bb_input_revisions SET manifest=manifest||'{"project_name":"Frozen fee input"}'::jsonb
        WHERE owner_user_id=$1 AND project_id=$2 AND revision=1`, [f.owner,f.projectId]);
      const original = (await db.query('SELECT to_jsonb(i) AS row FROM bb_input_revisions i WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',
        [f.owner,f.projectId])).rows[0].row;
      const decoy = { ...original, revision: 2, input_hash: 'b'.repeat(64), manifest: { ...f.manifest, project_name: 'Different run input' } };
      await db.query('INSERT INTO bb_input_revisions SELECT * FROM jsonb_populate_record(NULL::bb_input_revisions,$1::jsonb)', [JSON.stringify(decoy)]);
      await db.query('UPDATE bb_runs SET input_revision=2,input_hash=$2 WHERE id=$1', [f.runId,decoy.input_hash]);
      const result = await consumptionHistory(db,f.owner,{limit:'1'}), item = result.items[0]!;
      assert.equal(result.items.length,1);
      assert.equal(item.reservation_id,reservation);
      assert.equal(item.project_name,'Frozen fee input');
      assert.equal(item.task_name,'新项目编制');
      assert.equal(item.reserved_points,0);
      assert.equal(item.charged_points,0);
      assert.deepEqual(result.page,{has_more:false,next_cursor:null});
      assert.equal('billing_segment_id' in item,false);
      assert.equal('origin_input_hash' in item,false);
    });
  } finally { await f.cleanup(); }
});

test('correction explicitly selects the original reservation while retaining run-only idempotency', options, async () => {
  const f = await fixture('authoring');
  try {
    const reservation = await originalFee(f,'authoring');
    await transaction(f.pool, async db => {
      const run = (await db.query('SELECT * FROM bb_runs WHERE id=$1 FOR UPDATE',[f.runId])).rows[0];
      await db.query('SELECT id FROM bb_jobs WHERE run_id=$1 FOR UPDATE',[f.runId]);
      await debitAuthoringCredits(db,run,100);
    });
    await action(f.pool,f.owner,f.runId,'cancel');
    const before = await creditBalance(f.pool,f.owner);
    await assert.rejects(correctSettlement(f.pool,{runId:f.runId,reservationId:uid(),actor:'synthetic-test',reason:'Exact fee selection'}),
      error => error instanceof Problem && error.status === 404);
    assert.deepEqual(await creditBalance(f.pool,f.owner),before);
    const selected = await correctSettlement(f.pool,{runId:f.runId,reservationId:reservation,actor:'synthetic-test',reason:'Exact fee selection'});
    assert.equal(selected.length,1);
    const legacy = await correctSettlement(f.pool,{runId:f.runId,actor:'synthetic-test',reason:'Legacy run selection replay'});
    assert.deepEqual(legacy,selected);
    assert.equal((await creditBalance(f.pool,f.owner)).available,before.available+100);
    assert.equal((await auditCredits(f.pool)).consistent,true);
  } finally { await f.cleanup(); }
});
