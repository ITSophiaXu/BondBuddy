import type { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { ProjectFileOperationSchema, type ProjectFileOperation } from '@bondbuddy/contracts';
import { readProjectFileAsset, projectFileSource } from '@bondbuddy/api/project-file-storage';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import type { InputRevisionRow, RunRow, StageOutcome, StageContext } from './run-pipeline.js';
export const isProjectFileInput = (v: unknown): v is ProjectFileOperation =>
  Value.Check(ProjectFileOperationSchema, v);
export async function projectFileInputGate(
  pool: Pool,
  run: RunRow,
  input: InputRevisionRow,
): Promise<Extract<StageOutcome, { kind: 'fail' }> | null> {
  const fail = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' } as const,
    m = input.manifest;
  if (
    !isProjectFileInput(m) ||
    run.task_kind !== 'generation' ||
    inputManifestHash(m) !== run.input_hash.trim() ||
    input.input_hash.trim() !== run.input_hash.trim()
  )
    return fail;
  const stored = (
    await pool.query(
      `SELECT o.*,j.subtype FROM bb_project_file_operations o JOIN bb_jobs j ON j.owner_user_id=o.owner_user_id AND j.run_id=o.run_id
    WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.run_id=$3`,
      [run.owner_user_id, run.project_id, run.id],
    )
  ).rows[0];
  if (
    !stored ||
    stored.input_hash.trim() !== run.input_hash.trim() ||
    inputManifestHash(stored.manifest) !== run.input_hash.trim() ||
    stored.subtype !== 'project_file_v1'
  )
    return fail;
  try {
    const source = await projectFileSource(
      pool,
      run.owner_user_id,
      run.project_id,
      m.source.version_id,
    );
    if (!source || inputManifestHash(source.asset) !== inputManifestHash(m.source.asset))
      return fail;
    await readProjectFileAsset(pool, run.owner_user_id, m.source.asset);
    const files = m.operation === 'check' ? m.files : [m];
    for (const f of files) {
      const v = (
        await pool.query(
          `SELECT v.asset FROM bb_project_file_versions v JOIN bb_project_files f ON f.owner_user_id=v.owner_user_id AND f.id=v.file_id
        WHERE v.owner_user_id=$1 AND f.project_id=$2 AND f.id=$3 AND v.id=$4`,
          [run.owner_user_id, run.project_id, f.file_id, f.file_version_id],
        )
      ).rows[0];
      if (!v || inputManifestHash(v.asset) !== inputManifestHash(f.asset)) return fail;
      await readProjectFileAsset(pool, run.owner_user_id, f.asset);
    }
    if (m.operation === 'patch') {
      const check = (
        await pool.query(
          `SELECT o.result_hash,o.result,o.manifest FROM bb_project_file_operations o JOIN bb_runs r ON r.id=o.run_id AND r.owner_user_id=o.owner_user_id
        WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.run_id=$3 AND r.state='succeeded'`,
          [run.owner_user_id, run.project_id, m.check_run_id],
        )
      ).rows[0];
      if (
        !check ||
        check.result_hash?.trim() !== m.check_sha256 ||
        inputManifestHash(check.result) !== m.check_sha256 ||
        inputManifestHash(check.manifest.source) !== inputManifestHash(m.source)
      )
        return fail;
      const original = check.manifest.files.find(
        (f: any) => f.file_version_id === m.file_version_id && f.file_id === m.file_id,
      );
      const findings = check.result.files.find(
        (f: any) => f.file_version_id === m.file_version_id,
      )?.findings;
      if (
        !original ||
        inputManifestHash(original.asset) !== inputManifestHash(m.asset) ||
        !findings ||
        new Set(m.findings.map((f) => f.id)).size !== m.findings.length ||
        m.findings.some(
          (f) =>
            f.kind !== 'conflict' ||
            !findings.some((v: unknown) => inputManifestHash(v) === inputManifestHash(f)),
        )
      )
        return fail;
      if (
        m.manual_findings?.some(
          (f) =>
            f.kind !== 'manual' ||
            !findings.some((v: unknown) => inputManifestHash(v) === inputManifestHash(f)),
        )
      )
        return fail;
    }
  } catch {
    return fail;
  }
  return null;
}
export async function loadProjectFileInput(ctx: StageContext) {
  const row = (
    await ctx.pool.query(
      'SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
      [ctx.run.owner_user_id, ctx.run.project_id, ctx.run.input_revision],
    )
  ).rows[0];
  if (!row || (await projectFileInputGate(ctx.pool, ctx.run, row)))
    throw Error('INPUT_REVISION_CONFLICT');
  return row.manifest as ProjectFileOperation;
}
