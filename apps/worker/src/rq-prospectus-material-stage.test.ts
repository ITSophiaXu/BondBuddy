import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FactCandidateProductionResult } from './fact-candidate-producer.js';
import { createMaterialsReadyStage } from './run-pipeline.js';
import { RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256 } from './rq-prospectus-annual-fact-constants.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const materialId = 'db-generated-material-uuid-42';
const owner = 'owner-uuid-1';
const projectId = 'project-uuid-1';
const inputHash = 'a'.repeat(64);
const parseHash = 'b'.repeat(64);
const snapshotId = 'snapshot-uuid-1';

function readinessPool(
  options: { role?: string; hash?: string; mediaType?: string; snapshot?: string | null } = {},
) {
  const role = options.role ?? 'historical';
  const sourceHash = options.hash ?? RQ_PROSPECTUS_ANNUAL_SOURCE_SHA256;
  const mediaType = options.mediaType ?? DOCX;
  const snapshot = options.snapshot === undefined ? snapshotId : options.snapshot;
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      if (sql.includes('FROM bb_input_revisions'))
        return {
          rows: [
            {
              input_hash: inputHash,
              material_versions: [{ material_id: materialId, material_version: 1 }],
              manifest: {
                materials: [
                  { material_id: materialId, material_version: 1, role, sha256: sourceHash },
                ],
              },
            },
          ],
        };
      if (sql.includes('FROM bb_material_versions'))
        return { rows: [{ role, media_type: mediaType, sha256: sourceHash }] };
      if (sql.includes('FROM bb_jobs'))
        return {
          rows: [
            {
              state: 'succeeded',
              error_code: null,
              result: { outcome: 'parsed' },
              material_sha256: sourceHash,
              parser_version: 'bondbuddy-document-parser-1.0.6',
              checkpoint: snapshot
                ? { stages: { parse_evidence: { snapshot_id: snapshot } } }
                : { stages: {} },
            },
          ],
        };
      if (sql.includes('FROM bb_parse_snapshots'))
        return {
          rows: [
            {
              content_sha256: sourceHash,
              parser_version: 'bondbuddy-document-parser-1.0.6',
              response_status: 'needs_confirmation',
            },
          ],
        };
      if (sql.includes('FROM bb_fact_extraction_runs'))
        return {
          rows: [
            {
              input_hash: inputHash,
              parse_response_sha256: parseHash,
              candidate_ids: ['candidate-1'],
              needs_review: [],
            },
          ],
        };
      throw new Error(`unexpected SQL in synthetic readiness test: ${sql}`);
    },
  };
  return { pool: pool as never, calls };
}

function run() {
  return {
    id: 'run-uuid-1',
    owner_user_id: owner,
    project_id: projectId,
    input_revision: 1,
    input_hash: inputHash,
    task_kind: 'update',
  } as never;
}

function stageContext(pool: never) {
  return {
    pool,
    blobs: {} as never,
    lease: {} as never,
    signal: new AbortController().signal,
    run: run(),
    checkpoint: {},
    values: new Map(),
  };
}

function persistedResult(): FactCandidateProductionResult {
  return {
    extractionRunId: 'fact-extraction-uuid-1',
    snapshotId,
    responseSha256: parseHash,
    inserted: [{} as FactCandidateProductionResult['inserted'][number]],
    replayed: [],
    needsReview: [],
  };
}

test('readiness selects the exact authorized historical DOCX by content pins and verifies its parse snapshot', async () => {
  const { pool, calls } = readinessPool();
  const seen: string[] = [];
  const stage = createMaterialsReadyStage(async (context) => {
    seen.push(context.materialId);
    return persistedResult();
  });
  assert.deepEqual(await stage.run(stageContext(pool)), {
    kind: 'done',
    upgradeCheckpoint: false,
    checkpoint: {
      materials: [{ material_id: materialId, material_version: 1, outcome: 'parsed' }],
      extractions: [
        {
          material_id: materialId,
          material_version: 1,
          extraction_run_id: 'fact-extraction-uuid-1',
          snapshot_id: snapshotId,
          response_sha256: parseHash,
          candidate_count: 1,
          needs_review_count: 0,
        },
      ],
    },
  });
  assert.deepEqual(
    seen,
    [materialId],
    'the stage uses the generated DB material id, not the manifest sample id',
  );
  assert.ok(calls.some((sql) => sql.includes('FROM bb_parse_snapshots')));
});

test('an exact historical source without a pinned parse snapshot fails readiness before extraction', async () => {
  const { pool } = readinessPool({ snapshot: null });
  let called = false;
  const stage = createMaterialsReadyStage(async () => {
    called = true;
    return persistedResult();
  });
  assert.deepEqual(await stage.run(stageContext(pool)), { kind: 'fail', code: 'DATA_UNAVAILABLE' });
  assert.equal(called, false);
});

test('unrelated historical documents are not fact materials', async () => {
  const { pool, calls } = readinessPool({ hash: 'c'.repeat(64), snapshot: null });
  let called = false;
  const stage = createMaterialsReadyStage(async () => {
    called = true;
    return persistedResult();
  });
  const result = await stage.run(stageContext(pool));
  assert.equal(result.kind, 'done');
  assert.equal(called, false);
  assert.equal(
    calls.some((sql) => sql.includes('FROM bb_parse_snapshots')),
    false,
  );
});
