// Synthetic document/report bytes; real PostgreSQL leases, advisory locks, checkpoints and delivery evidence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { claim, checkpointStage, finish, promoteWordArtifact } from '@bondbuddy/api/queue';
import { runDeletedContentPurge } from '@bondbuddy/api/deletion-lifecycle';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { type FormatDiagnostic } from './file-authoring-format.js';
import { isolatedTestDatabase } from './test-database.js';
import { runFormatDiagnosticOnce } from './word-format-diagnostic.js';

const connection = await isolatedTestDatabase(undefined, 'word-format-diagnostic');
const reportBytes = Buffer.from(
  JSON.stringify({
    version: 'source-format-v1',
    status: 'passed',
    differences: [],
    synthetic: true,
  }),
);

function memoryBlobs() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const writes: string[] = [];
  const deletes: string[] = [];
  const blobs: PrivateBlobs = {
    put: async (key, bytes) => {
      writes.push(key);
      objects.set(key, Buffer.from(bytes));
    },
    get: async (key) => {
      reads.push(key);
      const bytes = objects.get(key);
      if (!bytes) throw Error('BLOB_MISSING');
      return Buffer.from(bytes);
    },
    getIfExists: async (key) => {
      reads.push(key);
      const bytes = objects.get(key);
      return bytes ? Buffer.from(bytes) : null;
    },
    getIfExistsBounded: async (key, max) => {
      reads.push(key);
      const bytes = objects.get(key);
      if (bytes && bytes.length > max) throw Error('BLOB_TOO_LARGE');
      return bytes ? Buffer.from(bytes) : null;
    },
    exists: async (key) => objects.has(key),
    delete: async (key) => {
      deletes.push(key);
      objects.delete(key);
    },
    listPage: async (prefix, cursor, size) => {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
        .sort();
      const page = keys.slice(0, size);
      return {
        items: page.map((key) => ({
          key,
          bytes: objects.get(key)!.length,
          etag: 'synthetic-etag',
        })),
        ...(keys.length > page.length ? { continuation: page.at(-1) } : {}),
      };
    },
  };
  return { blobs, objects, reads, writes, deletes };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function completedFixture(pool: Pool, blobs: PrivateBlobs) {
  const owner = randomUUID(),
    project = randomUUID(),
    runId = randomUUID(),
    jobId = randomUUID();
  const inputHash = digest(`synthetic-format-input:${runId}`);
  await pool.query(
    "INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic format diagnostic','update')",
    [project, owner],
  );
  await pool.query(
    `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,'{}','[]','[]')`,
    [project, owner, inputHash],
  );
  await pool.query(
    `INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued')`,
    [runId, owner, project, inputHash],
  );
  await pool.query(
    `INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
    VALUES($1,$2,$3,'update','default','queued','queued')`,
    [jobId, owner, runId],
  );
  const lease = await claim(pool);
  assert.ok(lease);
  assert.equal(lease.runId, runId);
  const revision = await promoteWordArtifact(
    pool,
    lease,
    makeWorkerDocxFixture({ externalLink: false, text: 'Synthetic revised document' }),
    blobs,
    'generated_pair_v1',
  );
  const clean = await promoteWordArtifact(
    pool,
    lease,
    makeWorkerDocxFixture({ externalLink: false, text: 'Synthetic clean document' }),
    blobs,
    'generated_pair_v1',
  );
  assert.equal(revision.status, 'available');
  assert.equal(clean.status, 'available');
  const prefix = `owners/${owner}/projects/${project}/runs/${runId}/file-authoring/synthetic/`;
  const contents = {
    baseline: makeWorkerDocxFixture({ externalLink: false, text: 'Synthetic original document' }),
    tracked: makeWorkerDocxFixture({ externalLink: false, text: 'Synthetic revised document' }),
    operations: Buffer.from(JSON.stringify({ synthetic: true, operations: [] })),
  };
  const files = {} as FormatDiagnostic['files'];
  for (const name of ['baseline', 'tracked', 'operations'] as const) {
    const bytes = contents[name],
      key = `${prefix}${digest(bytes)}/${name}.${name === 'operations' ? 'json' : 'docx'}`;
    await blobs.put(
      key,
      bytes,
      name === 'operations'
        ? 'application/json'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    files[name] = { key, sha256: digest(bytes), byte_size: bytes.length };
  }
  const diagnostic: FormatDiagnostic = {
    version: 'word-format-diagnostic-v1',
    status: 'pending',
    input_hash: inputHash,
    revision_author: 'Synthetic BondBuddy',
    files,
  };
  await checkpointStage(pool, lease, 'word_delivery_pair', {
    revision_artifact_id: revision.artifactId,
    clean_artifact_id: clean.artifactId,
    format_diagnostic: diagnostic,
  });
  assert.equal(
    (
      await finish(pool, lease, 'succeeded', {
        artifactId: revision.artifactId,
        artifactVersion: 1,
        blobs,
      })
    ).state,
    'succeeded',
  );
  return { owner, project, runId, jobId, diagnostic };
}

type Fixture = Awaited<ReturnType<typeof completedFixture>>;
function reportRef(fixture: Fixture, bytes = reportBytes) {
  const sha256 = digest(bytes);
  return {
    key: `owners/${fixture.owner}/projects/${fixture.project}/runs/${fixture.runId}/format-diagnostics/${sha256}/format-report.json`,
    sha256,
    byte_size: bytes.length,
  };
}
async function checkpoint(pool: Pool, fixture: Fixture) {
  return (
    await pool.query(
      "SELECT checkpoint #> '{stages,word_delivery_pair,format_diagnostic}' AS diagnostic FROM bb_jobs WHERE id=$1",
      [fixture.jobId],
    )
  ).rows[0].diagnostic as FormatDiagnostic;
}

async function deliveryState(pool: Pool, fixture: Fixture) {
  const state = (
    await pool.query(
      `SELECT r.state AS run_state,r.stage AS run_stage,r.event_cursor,r.artifact_id,r.artifact_version,
    j.state AS job_state,j.stage AS job_stage,j.lease_token,j.lease_until,
    (SELECT count(*)::int FROM bb_model_call_attempts a WHERE a.job_id=j.id) AS model_calls,
    (SELECT count(*)::int FROM bb_run_events e WHERE e.run_id=r.id) AS events
    FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1`,
      [fixture.runId],
    )
  ).rows[0];
  assert.equal(state.run_state, 'succeeded');
  assert.equal(state.job_state, 'succeeded');
  assert.equal(state.lease_token, null);
  assert.equal(state.lease_until, null);
  assert.equal(state.model_calls, 0);
  return state;
}

test(
  'format diagnostic: PostgreSQL concurrency, durable retries, cancellation and private-input isolation',
  { skip: !connection, timeout: 60000 },
  async (t) => {
    let pool = new Pool({ connectionString: connection });
    try {
      await t.test(
        'two workers diagnose once; delivery and model-call state remain unchanged',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const entered = deferred(),
            release = deferred();
          const other = new Pool({ connectionString: connection });
          let calls = 0;
          const diagnose = async () => {
            calls++;
            entered.resolve();
            await release.promise;
            return reportBytes;
          };
          const first = runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose });
          try {
            await entered.promise;
            assert.equal(
              await runFormatDiagnosticOnce({ pool: other, blobs: store.blobs, diagnose }),
              'idle',
            );
            assert.equal(calls, 1);
            assert.equal((await checkpoint(pool, fixture)).status, 'pending');
            assert.deepEqual(await deliveryState(pool, fixture), before);
          } finally {
            release.resolve();
            await other.end();
          }
          assert.equal(await first, 'completed');
          const saved = await checkpoint(pool, fixture);
          assert.equal(saved.status, 'passed');
          assert.equal(saved.report?.sha256, digest(reportBytes));
          assert.equal(saved.report?.byte_size, reportBytes.length);
          assert.ok(
            saved.report?.key.startsWith(
              `owners/${fixture.owner}/projects/${fixture.project}/runs/${fixture.runId}/`,
            ),
          );
          assert.deepEqual(await store.blobs.get(saved.report!.key), reportBytes);
          assert.equal(store.writes.filter((key) => key.endsWith('/format-report.json')).length, 1);
          assert.equal(
            await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
            'idle',
          );
          assert.equal(calls, 1);
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'transient processor error survives a fresh pool and retries only diagnosis',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => {
                throw Error('SYNTHETIC_PROCESS_UNAVAILABLE');
              },
            }),
            'failed',
          );
          assert.deepEqual(await checkpoint(pool, fixture), {
            ...fixture.diagnostic,
            attempts: 1,
            error_code: 'WORD_FORMAT_CHECK_UNAVAILABLE',
          });
          await pool.end();
          pool = new Pool({ connectionString: connection });
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => reportBytes,
            }),
            'completed',
          );
          assert.equal((await checkpoint(pool, fixture)).status, 'passed');
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'report-storage failure retains pending input and permits idempotent recovery',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const unavailable = {
            ...store.blobs,
            getIfExistsBounded: async (key: string, max: number) =>
              key.endsWith('/format-report.json') ? null : store.blobs.getIfExistsBounded(key, max),
          };
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: unavailable,
              diagnose: async () => reportBytes,
            }),
            'failed',
          );
          assert.deepEqual(await checkpoint(pool, fixture), {
            ...fixture.diagnostic,
            attempts: 1,
            error_code: 'WORD_FORMAT_CHECK_UNAVAILABLE',
            pending_report: reportRef(fixture),
          });
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => reportBytes,
            }),
            'completed',
          );
          assert.equal((await checkpoint(pool, fixture)).pending_report, undefined);
          assert.equal((await checkpoint(pool, fixture)).status, 'passed');
          assert.equal(
            new Set(store.writes.filter((key) => key.endsWith('/format-report.json'))).size,
            1,
          );
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'three unavailable attempts stop diagnosis without reopening delivery or making model calls',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          let calls = 0;
          const diagnose = async () => {
            calls++;
            throw Error('SYNTHETIC_PROCESS_UNAVAILABLE');
          };
          for (let attempts = 1; attempts <= 3; attempts++) {
            assert.equal(
              await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
              'failed',
            );
            assert.deepEqual(await checkpoint(pool, fixture), {
              ...fixture.diagnostic,
              status: attempts === 3 ? 'not_run' : 'pending',
              attempts,
              error_code: 'WORD_FORMAT_CHECK_UNAVAILABLE',
            });
            assert.deepEqual(await deliveryState(pool, fixture), before);
          }
          assert.equal(
            await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
            'idle',
          );
          assert.equal(calls, 3);
        },
      );

      await t.test(
        'worker cancellation releases the advisory lock without failing the delivered run',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const controller = new AbortController(),
            entered = deferred();
          const running = runFormatDiagnosticOnce({
            pool,
            blobs: store.blobs,
            signal: controller.signal,
            diagnose: async (_row, _blobs, signal) => {
              entered.resolve();
              await new Promise<void>((_resolve, reject) =>
                signal!.addEventListener('abort', () => reject(Error('SYNTHETIC_ABORT')), {
                  once: true,
                }),
              );
              return reportBytes;
            },
          });
          const rejected = assert.rejects(running, /SYNTHETIC_ABORT/);
          await entered.promise;
          controller.abort();
          await rejected;
          assert.deepEqual(await checkpoint(pool, fixture), fixture.diagnostic);
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => reportBytes,
            }),
            'completed',
          );
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'foreign file reference is rejected before any diagnostic blob read',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const invalid = structuredClone(fixture.diagnostic);
          invalid.files.baseline.key = `owners/another-owner/projects/${fixture.project}/runs/${fixture.runId}/file-authoring/baseline.docx`;
          await pool.query(
            "UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,format_diagnostic}',$2::jsonb) WHERE id=$1",
            [fixture.jobId, JSON.stringify(invalid)],
          );
          const readCount = store.reads.length;
          let calls = 0;
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => {
                calls++;
                return reportBytes;
              },
            }),
            'failed',
          );
          assert.equal(calls, 0);
          assert.equal(store.reads.length, readCount);
          assert.equal((await checkpoint(pool, fixture)).error_code, 'WORD_FORMAT_INPUT_INVALID');
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'mismatched source bytes fail diagnosis while delivered artifacts remain usable',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          store.objects.set(
            fixture.diagnostic.files.baseline.key,
            Buffer.from('synthetic corrupted source'),
          );
          assert.equal(await runFormatDiagnosticOnce({ pool, blobs: store.blobs }), 'failed');
          assert.equal((await checkpoint(pool, fixture)).error_code, 'WORD_FORMAT_BLOB_MISMATCH');
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test('invalid report state is terminal only for diagnosis', async () => {
        const store = memoryBlobs(),
          fixture = await completedFixture(pool, store.blobs),
          before = await deliveryState(pool, fixture);
        assert.equal(
          await runFormatDiagnosticOnce({
            pool,
            blobs: store.blobs,
            diagnose: async () => Buffer.from('{"status":"invalid"}'),
          }),
          'failed',
        );
        assert.equal((await checkpoint(pool, fixture)).error_code, 'WORD_FORMAT_REPORT_INVALID');
        assert.deepEqual(await deliveryState(pool, fixture), before);
      });

      await t.test(
        'project deletion before the upload intent commits prevents all report Blob IO',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const writes = store.writes.length,
            reads = store.reads.length;
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => {
                await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [
                  fixture.project,
                ]);
                return reportBytes;
              },
            }),
            'idle',
          );
          assert.equal(store.writes.length, writes);
          assert.equal(store.reads.length, reads);
          assert.equal(store.deletes.length, 0);
          assert.deepEqual(await checkpoint(pool, fixture), fixture.diagnostic);
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      for (const readbackFails of [false, true]) {
        await t.test(
          `project deleted after report upload: CAS preserves checkpoint and removes report${readbackFails ? ' even when readback fails' : ''}`,
          async () => {
            const store = memoryBlobs(),
              fixture = await completedFixture(pool, store.blobs),
              before = await deliveryState(pool, fixture);
            const reportKey = `owners/${fixture.owner}/projects/${fixture.project}/runs/${fixture.runId}/format-diagnostics/${digest(reportBytes)}/format-report.json`;
            const otherReportKey = reportKey.replace(
              `owners/${fixture.owner}/`,
              'owners/synthetic-other-owner/',
            );
            await store.blobs.put(
              otherReportKey,
              Buffer.from('synthetic other-owner report'),
              'application/json',
            );
            const retained = new Set(store.objects.keys());
            let readbacks = 0,
              diagnoses = 0;
            const deleting = {
              ...store.blobs,
              getIfExistsBounded: async (key: string, max: number) => {
                if (key !== reportKey) return store.blobs.getIfExistsBounded(key, max);
                // This hook runs only after put resolves: use a separate real connection
                // to commit project deletion before the diagnostic compare-and-set.
                readbacks++;
                assert.ok(store.objects.has(reportKey), 'the report was uploaded before deletion');
                await pool.query(
                  'UPDATE bb_projects SET deleted_at=now() WHERE id=$1 AND owner_user_id=$2',
                  [fixture.project, fixture.owner],
                );
                return readbackFails ? null : store.blobs.getIfExistsBounded(key, max);
              },
            };
            const diagnose = async () => {
              diagnoses++;
              return reportBytes;
            };
            assert.equal(
              await runFormatDiagnosticOnce({ pool, blobs: deleting, diagnose }),
              'idle',
            );
            assert.equal(diagnoses, 1);
            assert.equal(readbacks, 1);
            assert.deepEqual(
              await checkpoint(pool, fixture),
              fixture.diagnostic,
              'failed CAS must not add a report or a retry to the stored checkpoint',
            );
            assert.deepEqual(
              store.deletes,
              [reportKey],
              'cleanup deletes only the report from this attempt',
            );
            assert.equal(store.objects.has(reportKey), false);
            assert.deepEqual(
              new Set(store.objects.keys()),
              retained,
              'source files, delivered artifacts and another owner remain untouched',
            );
            assert.deepEqual(await deliveryState(pool, fixture), before);
            assert.equal(
              await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
              'idle',
            );
            assert.equal(diagnoses, 1, 'a deleted project cannot be diagnosed again');
          },
        );
      }

      await t.test(
        'durable upload intent survives purge, interruption, failed delete and a worker restart',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const pending = reportRef(fixture),
            controller = new AbortController();
          let uploads = 0,
            diagnoses = 0;
          const interrupted = {
            ...store.blobs,
            put: async (key: string, bytes: Buffer, media: string) => {
              if (key !== pending.key) return store.blobs.put(key, bytes, media);
              uploads++;
              assert.deepEqual(
                await checkpoint(pool, fixture),
                { ...fixture.diagnostic, pending_report: pending },
                'the intent commits before Blob upload',
              );
              await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [
                fixture.project,
              ]);
              const purged = await runDeletedContentPurge(pool, store.blobs, {
                ownerScope: fixture.owner,
                deletedContentPurgeDays: 0,
              });
              assert.equal(purged.projectsPurged, 1);
              assert.equal(purged.failed, 0);
              await store.blobs.put(key, bytes, media); // The upload resolves after the normal purge has finished.
              controller.abort();
              throw Error('SYNTHETIC_UPLOAD_INTERRUPTED');
            },
          };
          await assert.rejects(
            runFormatDiagnosticOnce({
              pool,
              blobs: interrupted,
              signal: controller.signal,
              diagnose: async () => {
                diagnoses++;
                return reportBytes;
              },
            }),
            /SYNTHETIC_UPLOAD_INTERRUPTED/,
          );
          assert.equal(uploads, 1);
          assert.equal(diagnoses, 1);
          assert.ok(store.objects.has(pending.key));
          assert.deepEqual(await checkpoint(pool, fixture), {
            ...fixture.diagnostic,
            pending_report: pending,
          });
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM bb_deleted_content_purges WHERE project_id=$1 AND subject_kind='project'",
                [fixture.project],
              )
            ).rows[0].n,
            1,
          );
          await pool.end();
          pool = new Pool({ connectionString: connection });
          const diagnose = async () => {
            assert.fail('deleted project cleanup must never diagnose');
            return reportBytes;
          };
          const unavailable = {
            ...store.blobs,
            delete: async (key: string) => {
              assert.equal(key, pending.key);
              throw Error('SYNTHETIC_DELETE_UNAVAILABLE');
            },
          };
          await assert.rejects(
            runFormatDiagnosticOnce({ pool, blobs: unavailable, diagnose }),
            /SYNTHETIC_DELETE_UNAVAILABLE/,
          );
          assert.deepEqual(await checkpoint(pool, fixture), {
            ...fixture.diagnostic,
            pending_report: pending,
          });
          assert.ok(store.objects.has(pending.key));
          await pool.end();
          pool = new Pool({ connectionString: connection });
          assert.equal(
            await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
            'completed',
          );
          assert.equal(store.objects.has(pending.key), false);
          assert.deepEqual(await checkpoint(pool, fixture), fixture.diagnostic);
          assert.equal(
            await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
            'idle',
          );
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'an uncleared live report intent cannot be overwritten by a different report',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            before = await deliveryState(pool, fixture);
          const unavailable = {
            ...store.blobs,
            getIfExistsBounded: async (key: string, max: number) =>
              key === reportRef(fixture).key ? null : store.blobs.getIfExistsBounded(key, max),
          };
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: unavailable,
              diagnose: async () => reportBytes,
            }),
            'failed',
          );
          const saved = await checkpoint(pool, fixture),
            writeCount = store.writes.length;
          const changed = Buffer.from('{"status":"warning","synthetic":true}');
          let calls = 0;
          const diagnose = async () => {
            calls++;
            return changed;
          };
          const cleanupFails = {
            ...store.blobs,
            delete: async () => {
              throw Error('SYNTHETIC_DELETE_UNAVAILABLE');
            },
          };
          await assert.rejects(
            runFormatDiagnosticOnce({ pool, blobs: cleanupFails, diagnose }),
            /SYNTHETIC_DELETE_UNAVAILABLE/,
          );
          assert.equal(calls, 0);
          assert.equal(store.writes.length, writeCount);
          assert.deepEqual(await checkpoint(pool, fixture), saved);
          assert.equal(
            await runFormatDiagnosticOnce({ pool, blobs: store.blobs, diagnose }),
            'completed',
          );
          assert.equal(calls, 1);
          assert.equal(store.objects.has(reportRef(fixture).key), false);
          const completed = await checkpoint(pool, fixture);
          assert.deepEqual(completed.report, reportRef(fixture, changed));
          assert.equal(completed.pending_report, undefined);
          assert.deepEqual(await deliveryState(pool, fixture), before);
        },
      );

      await t.test(
        'two cleanup workers keep the upload intent until the one owned delete completes',
        async () => {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            pending = reportRef(fixture);
          await store.blobs.put(pending.key, reportBytes, 'application/json');
          await pool.query(
            "UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,format_diagnostic}',$2::jsonb) WHERE id=$1",
            [
              fixture.jobId,
              JSON.stringify({ ...fixture.diagnostic, status: 'not_run', pending_report: pending }),
            ],
          );
          await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [
            fixture.project,
          ]);
          const entered = deferred(),
            release = deferred(),
            other = new Pool({ connectionString: connection });
          let deletes = 0;
          const blobs = {
            ...store.blobs,
            delete: async (key: string) => {
              deletes++;
              entered.resolve();
              await release.promise;
              await store.blobs.delete(key);
            },
          };
          const diagnose = async () => {
            assert.fail('cleanup must not diagnose');
            return reportBytes;
          };
          const first = runFormatDiagnosticOnce({ pool, blobs, diagnose });
          try {
            await entered.promise;
            assert.equal(await runFormatDiagnosticOnce({ pool: other, blobs, diagnose }), 'idle');
            assert.equal(deletes, 1);
            assert.deepEqual((await checkpoint(pool, fixture)).pending_report, pending);
          } finally {
            release.resolve();
            await other.end();
          }
          assert.equal(await first, 'completed');
          assert.equal((await checkpoint(pool, fixture)).pending_report, undefined);
          assert.equal((await checkpoint(pool, fixture)).status, 'not_run');
          assert.equal(deletes, 1);
        },
      );

      await t.test('malformed or foreign cleanup references never reach Blob IO', async () => {
        for (const mutate of [
          (ref: ReturnType<typeof reportRef>) => ({
            ...ref,
            key: ref.key.replace('owners/', 'owners/foreign-'),
          }),
          (ref: ReturnType<typeof reportRef>) => ({
            ...ref,
            key: ref.key.replace('/format-diagnostics/', '/format-diagnostics/../'),
          }),
          (ref: ReturnType<typeof reportRef>) => ({ ...ref, sha256: '0'.repeat(64) }),
          (ref: ReturnType<typeof reportRef>) => ({ ...ref, byte_size: 0 }),
        ]) {
          const store = memoryBlobs(),
            fixture = await completedFixture(pool, store.blobs),
            invalid = mutate(reportRef(fixture));
          store.objects.set(invalid.key, Buffer.from('synthetic object must not be deleted'));
          await pool.query(
            "UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,format_diagnostic}',$2::jsonb) WHERE id=$1",
            [fixture.jobId, JSON.stringify({ ...fixture.diagnostic, pending_report: invalid })],
          );
          await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [
            fixture.project,
          ]);
          const readCount = store.reads.length;
          assert.equal(
            await runFormatDiagnosticOnce({
              pool,
              blobs: store.blobs,
              diagnose: async () => {
                assert.fail('invalid cleanup pin must not diagnose');
                return reportBytes;
              },
            }),
            'failed',
          );
          assert.equal(store.reads.length, readCount);
          assert.equal(store.deletes.length, 0);
          assert.ok(store.objects.has(invalid.key));
          const saved = await checkpoint(pool, fixture);
          assert.equal(saved.pending_report, undefined);
          assert.equal(saved.error_code, 'WORD_FORMAT_REPORT_REF_INVALID');
        }
      });

      await t.test('deleted project is skipped before diagnosis starts', async () => {
        const store = memoryBlobs(),
          fixture = await completedFixture(pool, store.blobs);
        await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [fixture.project]);
        let calls = 0;
        assert.equal(
          await runFormatDiagnosticOnce({
            pool,
            blobs: store.blobs,
            diagnose: async () => {
              calls++;
              return reportBytes;
            },
          }),
          'idle',
        );
        assert.equal(calls, 0);
        assert.equal((await checkpoint(pool, fixture)).status, 'pending');
      });
    } finally {
      await pool.end();
    }
  },
);
