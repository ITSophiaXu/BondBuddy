// Test-only first binding for runs produced by the real unpaid HTTP executor.
// It reconstructs historical fixed policies before any worker claim; no already
// captured paid identity or production integrity trigger is changed.
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { creditBalance, lockCreditAccount } from './billing.js';
import { runDto, transaction, uid } from './data.js';

export async function attachInitialLegacyCreditPolicy(pool: Pool, input: {
  owner: string; runId: string; quoteId: string;
  policy: 'on_delivery'|'authoring_progress_v1'; lotId?: string;
}) {
  return transaction(pool, async db => {
    const seed = (await db.query('SELECT project_id FROM bb_runs WHERE owner_user_id=$1 AND id=$2', [input.owner,input.runId])).rows[0];
    assert.ok(seed);
    await db.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR UPDATE', [input.owner,seed.project_id]);
    const run = (await db.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE', [input.owner,input.runId])).rows[0];
    const job = (await db.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE', [input.owner,input.runId])).rows[0];
    assert.equal(run.state,'queued'); assert.equal(run.channel,'production');
    assert.equal(run.billing_mode,'platform_trial'); assert.equal(run.reservation_id,null);
    assert.equal(job.state,'queued'); assert.equal(job.lease_token,null); assert.equal(job.lease_until,null);
    assert.equal((await db.query('SELECT 1 FROM bb_model_call_attempts WHERE job_id=$1', [job.id])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM bb_credit_reservations WHERE run_id=$1', [run.id])).rowCount,0);
    const quote = (await db.query('SELECT * FROM bb_credit_quotes WHERE owner_user_id=$1 AND id=$2', [input.owner,input.quoteId])).rows[0];
    assert.ok(quote); assert.equal(quote.project_id,run.project_id);
    const frozen = (await db.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3 AND input_hash=$4',
      [input.owner,run.project_id,run.input_revision,run.input_hash])).rows[0].manifest;
    if (quote.intent_hash === null) {
      assert.equal(quote.input_revision,run.input_revision); assert.equal(quote.input_hash.trim(),run.input_hash.trim());
    } else {
      assert.equal(quote.task_type,frozen.review.operation); assert.equal(quote.input_revision,frozen.draft_revision);
      assert.equal(quote.input_hash.trim(),quote.intent_hash.trim());
    }
    await lockCreditAccount(db,input.owner);
    const points = Number(quote.points), reservation = uid();
    assert.ok(Number.isSafeInteger(points)&&points>0);
    assert.ok((await creditBalance(db,input.owner)).available>=points);
    await db.query(`INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points)
      VALUES($1,$2,$3,$4,$5,$6,NULL)`, [reservation,input.owner,run.id,quote.id,points,input.policy]);
    const lots = (await db.query(`SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 AND remaining>frozen
      AND (expires_at IS NULL OR expires_at>now()) AND ($2::text IS NULL OR id=$2)
      ORDER BY CASE WHEN source='purchase' THEN 1 ELSE 0 END,expires_at ASC NULLS LAST,created_at,id FOR UPDATE`, [input.owner,input.lotId??null])).rows;
    let remaining = points;
    for (const lot of lots) {
      const take = Math.min(remaining,Number(lot.remaining)-Number(lot.frozen));
      await db.query('UPDATE bb_credit_lots SET frozen=frozen+$2 WHERE id=$1', [lot.id,take]);
      await db.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,$3)', [reservation,lot.id,take]);
      remaining -= take;
      if (!remaining) break;
    }
    assert.equal(remaining,0);
    await db.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
      VALUES($1,$2,$3,'reserve',$4,$5,$6,'synthetic-test','legacy_policy_at_initial_binding')`,
    [uid(),input.owner,`reserve:${reservation}`,points,reservation,run.id]);
    // This is the first paid pointer: the ordinary capture trigger records the
    // original immutable policy and cap before claim/debit can observe the run.
    const bound = (await db.query(`UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1 RETURNING *`, [run.id,reservation])).rows[0];
    return runDto(bound);
  });
}
