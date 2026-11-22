import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { digest, type PrivateBlobs } from '@bondbuddy/api/data';
import {
  FORMAT_JSON_MAX,
  WORD_FILE_MAX,
  readFormatFile,
  type FormatDiagnostic,
  type FormatFileRef,
} from './file-authoring-format.js';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
type Candidate = {
  id: string;
  run_id: string;
  owner_user_id: string;
  project_id: string;
  input_hash: string;
  project_deleted_at?: Date | null;
  diagnostic: FormatDiagnostic;
};

function reportKey(row: Candidate, sha256: string) {
  return `owners/${row.owner_user_id}/projects/${row.project_id}/runs/${row.run_id}/format-diagnostics/${sha256}/format-report.json`;
}

function validPendingReport(row: Candidate): boolean {
  const ref = row.diagnostic?.pending_report;
  return (
    row.diagnostic?.version === 'word-format-diagnostic-v1' &&
    row.diagnostic.input_hash === row.input_hash.trim() &&
    !!ref &&
    typeof ref.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(ref.sha256) &&
    typeof ref.key === 'string' &&
    !ref.key.includes('..') &&
    ref.key === reportKey(row, ref.sha256) &&
    Number.isSafeInteger(ref.byte_size) &&
    ref.byte_size > 0 &&
    ref.byte_size <= FORMAT_JSON_MAX
  );
}

async function saveDiagnostic(
  client: PoolClient,
  row: Candidate,
  next: FormatDiagnostic,
  liveOnly: boolean,
) {
  return (
    (
      await client.query(
        `UPDATE bb_jobs j SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair,format_diagnostic}',$3::jsonb)
    WHERE j.id=$1 AND j.owner_user_id=$2 AND checkpoint #> '{stages,word_delivery_pair,format_diagnostic}'=$4::jsonb
      AND (NOT $6::boolean OR EXISTS(SELECT 1 FROM bb_projects p WHERE p.id=$5 AND p.owner_user_id=$2 AND p.deleted_at IS NULL))`,
        [
          row.id,
          row.owner_user_id,
          JSON.stringify(next),
          JSON.stringify(row.diagnostic),
          row.project_id,
          liveOnly,
        ],
      )
    ).rowCount !== 0
  );
}

/** The caller holds the same advisory lock as the uploader, including across Blob IO. */
async function clearPendingReport(
  client: PoolClient,
  row: Candidate,
  blobs: PrivateBlobs,
): Promise<'cleared' | 'invalid' | 'stale'> {
  const next = { ...row.diagnostic };
  delete next.pending_report;
  if (!validPendingReport(row)) {
    next.status = 'failed';
    next.error_code = 'WORD_FORMAT_REPORT_REF_INVALID';
    return (await saveDiagnostic(client, row, next, false)) ? 'invalid' : 'stale';
  }
  // A failed delete or a process exit leaves the durable pin for another worker,
  // even after the project's normal content purge has already written its receipt.
  await blobs.delete(row.diagnostic.pending_report!.key);
  return (await saveDiagnostic(client, row, next, false)) ? 'cleared' : 'stale';
}

export function validFormatDiagnostic(row: Candidate): boolean {
  const d = row.diagnostic;
  const prefix = `owners/${row.owner_user_id}/projects/${row.project_id}/runs/${row.run_id}/file-authoring/`;
  return (
    d?.version === 'word-format-diagnostic-v1' &&
    d.status === 'pending' &&
    d.input_hash === row.input_hash.trim() &&
    typeof d.revision_author === 'string' &&
    d.revision_author.length > 0 &&
    d.revision_author.length <= 128 &&
    [
      'baseline',
      'tracked',
      'operations',
      ...(d.files && Object.hasOwn(d.files, 'plan') ? ['plan'] : []),
    ].every((name) => {
      const ref = d.files?.[name as keyof FormatDiagnostic['files']];
      return (
        ref &&
        typeof ref.key === 'string' &&
        ref.key.startsWith(prefix) &&
        !ref.key.includes('..') &&
        /^[a-f0-9]{64}$/.test(ref.sha256) &&
        Number.isSafeInteger(ref.byte_size) &&
        ref.byte_size > 0 &&
        ref.byte_size <=
          (name === 'operations' || name === 'plan' ? FORMAT_JSON_MAX : WORD_FILE_MAX)
      );
    })
  );
}

export async function diagnoseFormat(
  row: Candidate,
  blobs: PrivateBlobs,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!validFormatDiagnostic(row)) throw Error('WORD_FORMAT_INPUT_INVALID');
  const root = await mkdtemp(join(tmpdir(), 'bb-format-diagnostic-'));
  try {
    await mkdir(join(root, 'materials'), { mode: 0o700 });
    for (const [name, path] of [
      ['baseline', 'materials/baseline.docx'],
      ['tracked', 'tracked.docx'],
      ['operations', 'operations.json'],
    ] as const) {
      const ref = row.diagnostic.files[name];
      const bytes = await blobs.getIfExistsBounded(
        ref.key,
        name === 'operations' ? FORMAT_JSON_MAX : WORD_FILE_MAX,
      );
      if (!bytes || bytes.length !== ref.byte_size || digest(bytes) !== ref.sha256)
        throw Error('WORD_FORMAT_BLOB_MISMATCH');
      await writeFile(join(root, path), bytes);
    }
    await writeFile(
      join(root, 'input.json'),
      JSON.stringify({
        input_hash: row.input_hash.trim(),
        baseline_path: 'materials/baseline.docx',
        baseline_sha256: row.diagnostic.files.baseline.sha256,
        revision_author: row.diagnostic.revision_author,
        revision_date: row.diagnostic.revision_date,
      }),
    );
    await promisify(execFile)(
      process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
      [
        '-B',
        '-s',
        '-m',
        'bondbuddy_file_authoring.format_diff',
        '--baseline',
        join(root, 'materials/baseline.docx'),
        '--tracked',
        join(root, 'tracked.docx'),
        '--author',
        row.diagnostic.revision_author,
        '--input',
        join(root, 'input.json'),
        '--operations',
        join(root, 'operations.json'),
        '--output',
        join(root, 'report.json'),
      ],
      {
        cwd: repo,
        env: { ...process.env, PYTHONPATH: join(repo, 'python'), PYTHONIOENCODING: 'utf-8' },
        timeout: 300000,
        maxBuffer: FORMAT_JSON_MAX,
        signal,
      },
    );
    return await readFormatFile(root, 'report.json', FORMAT_JSON_MAX);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Durable sidecar on an already delivered pair. It never owns or changes a run lease/state. */
export async function runFormatDiagnosticOnce(options: {
  pool: Pool;
  blobs: PrivateBlobs;
  signal?: AbortSignal;
  diagnose?: typeof diagnoseFormat;
}): Promise<'idle' | 'completed' | 'failed'> {
  const client = await options.pool.connect();
  let lock: string | undefined;
  try {
    const select = `SELECT j.id,j.run_id,j.owner_user_id,r.project_id,r.input_hash,p.deleted_at AS project_deleted_at,
      j.checkpoint #> '{stages,word_delivery_pair,format_diagnostic}' AS diagnostic
      FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
      JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
      WHERE r.state IN ('succeeded','test_completed') AND j.state IN ('succeeded','test_completed')
      AND ((p.deleted_at IS NULL AND j.checkpoint #>> '{stages,word_delivery_pair,format_diagnostic,status}'='pending')
        OR (j.checkpoint #> '{stages,word_delivery_pair,format_diagnostic}') ? 'pending_report')`;
    const rows = (await client.query(`${select} ORDER BY j.updated_at LIMIT 20`))
      .rows as Candidate[];
    for (const candidate of rows) {
      const key = `word-format-v1:${candidate.id}`;
      if (
        !(
          await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [
            key,
          ])
        ).rows[0]?.acquired
      )
        continue;
      lock = key;
      // A second worker may have completed while this worker acquired its lock.
      const reload = async () =>
        (
          await client.query(`${select} AND j.id=$1 AND j.owner_user_id=$2`, [
            candidate.id,
            candidate.owner_user_id,
          ])
        ).rows[0] as Candidate | undefined;
      let row = await reload();
      if (!row) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]);
        lock = undefined;
        continue;
      }
      if (Object.hasOwn(row.diagnostic, 'pending_report')) {
        const cleanup = await clearPendingReport(client, row, options.blobs);
        if (cleanup !== 'cleared') return cleanup === 'invalid' ? 'failed' : 'idle';
        row = await reload();
        if (!row) return 'completed';
      }
      // Deleted projects are eligible only for the cleanup branch above.
      if (row.project_deleted_at) return 'idle';
      let next: FormatDiagnostic;
      let failed = false;
      let pendingReport: FormatFileRef | undefined;
      try {
        if (!validFormatDiagnostic(row)) throw Error('WORD_FORMAT_INPUT_INVALID');
        const reportBytes = await (options.diagnose ?? diagnoseFormat)(
          row,
          options.blobs,
          options.signal,
        );
        const report = JSON.parse(reportBytes.toString('utf8'));
        if (!['passed', 'warning', 'failed', 'not_run', 'unsupported'].includes(report.status))
          throw Error('WORD_FORMAT_REPORT_INVALID');
        const sha256 = digest(reportBytes);
        pendingReport = { key: reportKey(row, sha256), sha256, byte_size: reportBytes.length };
        const uploading = { ...row.diagnostic, pending_report: pendingReport };
        if (!(await saveDiagnostic(client, row, uploading, true))) return 'idle';
        row.diagnostic = uploading;
        await options.blobs.put(pendingReport.key, reportBytes, 'application/json');
        const saved = await options.blobs.getIfExistsBounded(pendingReport.key, FORMAT_JSON_MAX);
        if (!saved || digest(saved) !== sha256) throw Error('WORD_FORMAT_REPORT_STORE_FAILED');
        next = { ...row.diagnostic, status: report.status, report: pendingReport };
        delete next.pending_report;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const inputError =
          error instanceof Error &&
          /^WORD_FORMAT_(INPUT_INVALID|BLOB_MISMATCH|REPORT_INVALID)$/.test(error.message);
        const attempts = (row.diagnostic.attempts ?? 0) + 1;
        next = {
          ...row.diagnostic,
          status: inputError ? 'failed' : attempts >= 3 ? 'not_run' : 'pending',
          attempts,
          error_code: inputError ? (error as Error).message : 'WORD_FORMAT_CHECK_UNAVAILABLE',
        };
        failed = true;
      }
      if (!(await saveDiagnostic(client, row, next, true))) {
        const current = await reload();
        if (pendingReport && current?.diagnostic.pending_report?.key === pendingReport.key)
          await clearPendingReport(client, current, options.blobs);
        return 'idle';
      }
      return failed ? 'failed' : 'completed';
    }
    return 'idle';
  } finally {
    try {
      if (lock) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]);
    } finally {
      client.release();
    }
  }
}
