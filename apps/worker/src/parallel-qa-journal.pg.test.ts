import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uid } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import {
  QaAnswerSchema,
  QaInputSchema,
  PROJECT_QA_PRICE,
  type QaInput,
} from '@bondbuddy/contracts';
import { transaction, digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { reserveQaCredits, readQa } from '@bondbuddy/api/project-qa';
import { enqueue, claim, finish, pauseRun } from '@bondbuddy/api/queue';
import { grantCredits, creditBalance } from '../../api/dist/billing.js';
import { Value } from '@sinclair/typebox/value';
import { DeferredQaJournal } from './deferred-qa-journal.js';
import { boundedItems } from './bounded-items.js';
import { isolatedTestDatabase } from './test-database.js';
const database = await isolatedTestDatabase(undefined, 'parallel-qa-journal');
for (const unknown of [false, true])
  test(
    `four question journals drain three successes after one ${unknown ? 'unknown' : 'measured failure'}, retaining costs and recovery`,
    { skip: !database, timeout: 60000 },
    async () => {
      const pool = new Pool({ connectionString: database, max: 6 }),
        owner = uid(),
        project = uid(),
        runId = uid();
      const objects = new Map<string, Buffer>();
      const blobs: PrivateBlobs = {
        put: async (k, b) => {
          objects.set(k, b);
        },
        get: async (k) => objects.get(k)!,
        getIfExists: async (k) => objects.get(k) ?? null,
        getIfExistsBounded: async (k, n) => {
          const b = objects.get(k);
          return b && b.length <= n ? b : null;
        },
        delete: async (k) => {
          objects.delete(k);
        },
        exists: async (k) => objects.has(k),
      };
      try {
        await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [
          owner,
          'q4_' + owner.slice(0, 8),
        ]);
        await pool.query(
          "INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic four questions','generation')",
          [project, owner],
        );
        await transaction(pool, (c) =>
          grantCredits(c, {
            owner,
            points: 1000,
            key: uid(),
            source: 'purchase',
            expiresAt: null,
            actor: 'synthetic',
            reason: 'Isolated four question regression',
          }),
        );
        const input: QaInput = {
          version: 'project-qa-v1',
          operation: 'answer',
          project_name: 'Synthetic four questions',
          source: {
            filename: 'synthetic.docx',
            asset: {
              kind: 'material',
              pin: {
                source_project_id: project,
                material_id: 'synthetic-material',
                material_version: 1,
                sha256: 'a'.repeat(64),
              },
            },
          },
          preparation_id: null,
          questions: Array.from({ length: 4 }, (_, i) => ({
            id: 'q' + i,
            start: i,
            end: i,
            question: 'Synthetic question ' + i,
          })),
          materials: [],
          requirements: 'Synthetic evidence only',
          cases: [],
          price_version: PROJECT_QA_PRICE.version,
          points: 240,
        };
        const hash = inputManifestHash(input);
        await transaction(pool, async (c) => {
          await c.query(
            "INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",
            [project, owner, hash, input],
          );
          const run = (
            await c.query(
              "INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *",
              [runId, owner, project, hash],
            )
          ).rows[0];
          await c.query(
            "INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,1,'answer',$4,$5)",
            [runId, owner, project, input, hash],
          );
          await reserveQaCredits(c, owner, run, input);
          await enqueue(c, run, 'project_qa_v1');
        });
        const publicRun = (await readQa(pool, owner, project)).runs[0];
        assert.ok(Value.Check(QaInputSchema, publicRun.manifest));
        assert.equal(
          Object.hasOwn(publicRun.manifest, 'max_parallel'),
          false,
          'old strict response schema sees no execution metadata',
        );
        assert.equal(
          inputManifestHash(publicRun.manifest),
          hash,
          'public exact manifest keeps its original hash',
        );
        const execution = (
          await pool.query('SELECT max_parallel FROM bb_project_qa_runs WHERE run_id=$1', [runId])
        ).rows[0];
        assert.equal(execution.max_parallel, 4);
        await assert.rejects(
          pool.query('UPDATE bb_project_qa_runs SET max_parallel=NULL WHERE run_id=$1', [runId]),
          { code: '23514' },
        );
        const lease = await claim(pool, 120, { runKinds: ['generation'] });
        assert.ok(lease);
        assert.equal(lease.runId, runId);
        const journal = new DeferredQaJournal({
          pool,
          blobs,
          lease,
          validateResult: (v) => Value.Check(QaAnswerSchema, v),
        });
        const snapshots = await Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            savePromptSnapshot(pool, blobs, {
              owner,
              projectId: project,
              runId,
              kind: 'model_request',
              body: 'Synthetic question ' + i,
              inputRevision: 1,
              inputHash: hash,
              templateVersion: 'synthetic-parallel-v1',
            }),
          ),
        );
        const refs = (
          await pool.query(
            'SELECT version,content_sha256,object_key FROM bb_snapshot_refs WHERE id=ANY($1::text[]) ORDER BY version',
            [snapshots],
          )
        ).rows;
        assert.deepEqual(
          refs.map((r) => r.version),
          [1, 2, 3, 4],
        );
        assert.equal(new Set(refs.map((r) => r.content_sha256)).size, 4);
        for (const ref of refs)
          assert.equal(digest(await blobs.get(ref.object_key)), ref.content_sha256);
        const intents = snapshots.map((snapshot, i) => ({
          owner_user_id: owner,
          project_id: project,
          job_id: lease.jobId,
          run_id: runId,
          trace_id: runId,
          logical_call_id: 'qa-q' + i,
          call_id: uid(),
          attempt_no: 1,
          model_id: 'synthetic',
          model_config_version: 'synthetic-v1',
          prompt_snapshot_ref: snapshot,
        }));
        await pool.query('UPDATE bb_jobs SET user_pause_requested=true WHERE id=$1', [lease.jobId]);
        await assert.rejects(journal.recordIntent(intents[0]), { code: 'CAPABILITY_NOT_READY' });
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1', [
              lease.jobId,
            ])
          ).rows[0].n,
          0,
        );
        await pool.query('UPDATE bb_jobs SET user_pause_requested=false WHERE id=$1', [
          lease.jobId,
        ]);
        for (const intent of intents) await journal.recordIntent(intent);
        let peak = 0,
          active = 0;
        const outcomes = await boundedItems(
          intents,
          4,
          new AbortController().signal,
          async (intent, index) => {
            peak = Math.max(peak, ++active);
            await delay(index === 0 ? 5 : 40);
            const measured = {
              status: 'measured' as const,
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_tokens: 0,
              total_tokens: 120,
            };
            if (index === 0) {
              await journal.recordObservation({
                ...intent,
                provider_request_id: null,
                finish_reason: null,
                outcome: unknown ? 'pending_reconcile' : 'failed',
                result_ref: null,
                result_sha256: null,
                result_schema_version: null,
                result_byte_size: null,
                error_code: unknown ? 'MODEL_PROCESS_FAILED' : 'MODEL_OUTPUT_SCHEMA_INVALID',
                usage: unknown
                  ? {
                      status: 'unknown',
                      input_tokens: null,
                      cached_input_tokens: null,
                      output_tokens: null,
                      reasoning_tokens: null,
                      total_tokens: null,
                    }
                  : measured,
              });
              const row = (
                await pool.query('SELECT state,lease_token FROM bb_jobs WHERE id=$1', [lease.jobId])
              ).rows[0];
              assert.equal(row.state, 'running');
              assert.equal(row.lease_token, lease.token);
              active--;
              return { kind: unknown ? 'unknown' : 'failed' };
            }
            const answer = {
              question_id: 'q' + index,
              answer: 'Synthetic saved answer ' + index,
              status: 'draft',
              missing_materials: [],
              citations: [{ asset_index: 0, span_id: 'p0', quote: 'Synthetic disclosed fact' }],
              case_ids: [],
              approach: 'Synthetic verification',
            };
            const ref = await journal.storeResult(
              intent,
              Buffer.from(JSON.stringify(answer)),
              'project-qa-answer-v1',
            );
            await journal.recordObservation({
              ...intent,
              ...ref,
              provider_request_id: null,
              finish_reason: 'stop',
              outcome: 'completed',
              usage: measured,
              error_code: null,
            });
            await pool.query(
              'INSERT INTO bb_project_qa_answers(owner_user_id,run_id,question_id,answer,sha256) VALUES($1,$2,$3,$4,$5)',
              [owner, runId, answer.question_id, answer, inputManifestHash(answer)],
            );
            active--;
            return { kind: 'completed' };
          },
          (o) => o.kind === 'completed',
        );
        assert.equal(peak, 4);
        assert.equal(active, 0);
        assert.equal(outcomes.filter((o) => o?.kind === 'completed').length, 3);
        for (const intent of intents.slice(1)) {
          assert.ok(await journal.readCompleted(intent.logical_call_id, 1));
        }
        const attempts = (
          await pool.query('SELECT status FROM bb_model_call_attempts WHERE job_id=$1', [
            lease.jobId,
          ])
        ).rows;
        assert.equal(attempts.filter((a) => a.status === 'completed').length, 3);
        assert.equal(
          attempts.filter((a) => a.status === (unknown ? 'pending_reconcile' : 'failed')).length,
          1,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM bb_provider_result_refs WHERE job_id=$1',
              [lease.jobId],
            )
          ).rows[0].n,
          3,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM bb_call_usage WHERE attempt_id=ANY($1::text[])',
              [intents.map((i) => i.call_id)],
            )
          ).rows[0].n,
          4,
        );
        if (unknown) {
          await pauseRun(pool, lease, 'provider_reconcile', 'provider_result_pending');
          assert.deepEqual(await creditBalance(pool, owner), { available: 760, frozen: 240 });
        } else {
          assert.equal(
            (await finish(pool, lease, 'failed', { errorCode: 'MODEL_OUTPUT_SCHEMA_INVALID' }))
              .state,
            'failed',
          );
          assert.deepEqual(await creditBalance(pool, owner), { available: 1000, frozen: 0 });
        }
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM bb_project_qa_answers WHERE run_id=$1', [
              runId,
            ])
          ).rows[0].n,
          3,
        );
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1', [
              lease.jobId,
            ])
          ).rows[0].n,
          4,
          'recovery reads accepted siblings without issuing calls',
        );
      } finally {
        await pool.end();
      }
    },
  );
