import { Value } from '@sinclair/typebox/value';
import { FirstDraftConfirmationRequestSchema, NoneBaselineSnapshotSchema, HistoricalExclusionPinSchema, FIRST_DRAFT_EXCLUSION_SCOPE,
  type FirstDraftConfirmationRequest, type HistoricalExclusionPin, type NoneBaselineSnapshot,
  type SourceMaterialPin, type UnifiedAuthoringInput } from '@bondbuddy/contracts';
import type { Pool, PoolClient } from 'pg';

type Scope = { owner: string; projectId: string };
type Query = Pick<PoolClient, 'query'>;
type ProjectKind = 'update' | 'generation';
export class NoneBaselineConflict extends Error {
  constructor(public readonly code: 'INPUT_REVISION_CONFLICT' | 'HISTORICAL_BASELINE_REQUIRED' |
    'FIRST_DRAFT_CONFIRMATION_REQUIRED' | 'FIRST_DRAFT_EXCLUSION_STALE', message: string) { super(message); }
}
const reject = (message: string): never => { throw new NoneBaselineConflict('INPUT_REVISION_CONFLICT', message); };
const same = (a: HistoricalExclusionPin, b: HistoricalExclusionPin) => a.material_id === b.material_id &&
  a.material_version === b.material_version && a.sha256 === b.sha256;
const key = (p: HistoricalExclusionPin) => JSON.stringify([p.material_id, p.material_version, p.sha256]);
function canonical(pins: readonly HistoricalExclusionPin[]): HistoricalExclusionPin[] {
  if (new Set(pins.map(p => `${p.material_id}\0${p.material_version}`)).size !== pins.length) reject('历史稿排除集合包含重复版本。');
  return pins.map(p => ({ material_id: p.material_id, material_version: p.material_version, sha256: p.sha256 }))
    .sort((a, b) => key(a).localeCompare(key(b)));
}
const sameSet = (a: readonly HistoricalExclusionPin[], b: readonly HistoricalExclusionPin[]) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Used by both the input guard and the actual file-authoring source selector. */
export function legacyAuthoringSourcePin<T extends SourceMaterialPin>(materials: readonly T[],
  authoring: Pick<UnifiedAuthoringInput, 'source_prospectuses' | 'review_result'>): T | null {
  return [...materials].filter(m => ['project_output', 'historical', 'reference'].includes(m.role)).sort((a, b) => {
    const rank = (m: T) => m.material_id === authoring.review_result?.source_material.material_id ? -2 :
      m.role === 'project_output' ? -1 : authoring.source_prospectuses.find(s => s.material_id === m.material_id)?.relation === 'same_issuer' ? 0 : 1;
    return rank(a) - rank(b) || a.material_id.localeCompare(b.material_id);
  })[0] ?? null;
}
export function authoringBaselinePin(materials: readonly SourceMaterialPin[], authoring: UnifiedAuthoringInput): SourceMaterialPin | null {
  const exact = (pin: HistoricalExclusionPin) => {
    const matches = materials.filter(m => same(m, pin));
    if (matches.length !== 1) return reject('锁定的原稿版本不完整或不唯一。');
    return matches[0]!;
  };
  // Callers must retain the existing owner/project/quality/input/hash check for this artifact.
  if (authoring.previous_output) return { material_id: authoring.previous_output.artifact_id,
    material_version: authoring.previous_output.version, sha256: authoring.previous_output.sha256, role: 'project_output' };
  if (authoring.review_result) return exact(authoring.review_result.source_material);
  for (const source of authoring.source_prospectuses) exact(source);
  if (authoring.format_policy?.template?.kind === 'material') return exact(authoring.format_policy.template);
  return legacyAuthoringSourcePin(materials, authoring);
}

/** Project lock must be acquired first. Every undeleted version is included, without a latest-only shortcut. */
export async function historicalExclusions(client: Query, scope: Scope, materials: readonly SourceMaterialPin[]) {
  const result = await client.query(`SELECT id,version,sha256,filename FROM bb_material_versions
    WHERE owner_user_id=$1 AND project_id=$2 AND role='historical' AND deleted_at IS NULL
    ORDER BY id,version FOR SHARE`, [scope.owner, scope.projectId]);
  return result.rows.map(row => {
    const pin = { material_id: String(row.id), material_version: Number(row.version), sha256: String(row.sha256).trim() };
    if (!Value.Check(HistoricalExclusionPinSchema, pin)) throw Error('HISTORICAL_EXCLUSION_DATA_INVALID');
    return { ...pin, filename: String(row.filename) };
  })
    .filter(pin => !materials.some(m => m.role === 'historical' && same(m, pin)));
}

/** Called inside API input locking, after exact source/previous-output checks and before hashing/inserting. */
export async function lockNoneBaseline(client: Query, scope: Scope, projectKind: string, materials: readonly SourceMaterialPin[],
  authoring: UnifiedAuthoringInput, request: FirstDraftConfirmationRequest | undefined, at: string): Promise<NoneBaselineSnapshot | undefined> {
  if (authoringBaselinePin(materials, authoring)) {
    if (request) reject('已有准确基线，不能同时提交按首稿执行确认。');
    return undefined;
  }
  if (!['update', 'generation'].includes(projectKind) || !Number.isFinite(Date.parse(at))) reject('无法确认无原稿输入的项目类型或锁定时间。');
  if (request && (projectKind !== 'generation' || !Value.Check(FirstDraftConfirmationRequestSchema, request)))
    reject('首稿确认只适用于 generation 项目，且必须包含准确排除集合。');
  const excluded = canonical(await historicalExclusions(client, scope, materials));
  if (excluded.length && projectKind === 'update') throw new NoneBaselineConflict('HISTORICAL_BASELINE_REQUIRED', '项目仍有未包含的历史募集书，请纳入准确原稿后重新开始。');
  if (excluded.length && !request) throw new NoneBaselineConflict('FIRST_DRAFT_CONFIRMATION_REQUIRED', '项目仍有未包含的历史募集书。请核对排除集合并明确确认按首稿执行。');
  if (request && !sameSet(request.excluded_historical, excluded)) throw new NoneBaselineConflict('FIRST_DRAFT_EXCLUSION_STALE', '历史稿排除集合已变化，请刷新后重新确认。');
  return { version: 'none-baseline-v1', owner_user_id: scope.owner, project_id: scope.projectId,
    project_kind: projectKind as ProjectKind, checked_at: at, excluded_historical: excluded,
    first_draft_confirmation: request ? { decision: 'generate_first_draft', scope: FIRST_DRAFT_EXCLUSION_SCOPE,
      excluded_historical: structuredClone(excluded), confirmed_by: scope.owner, confirmed_at: at } : null };
}

/** Rechecked before generation and on delivery recovery. Current set changes invalidate old none inputs; never backfill. */
export async function validateNoneBaseline(pool: Pool, scope: Scope,
  manifest: { kind?: unknown; materials: SourceMaterialPin[]; authoring: UnifiedAuthoringInput }): Promise<void> {
  const snapshot = manifest.authoring.none_baseline;
  if (authoringBaselinePin(manifest.materials, manifest.authoring)) {
    if (snapshot !== undefined) reject('已有基线的输入不能含无原稿快照。');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = (await client.query(`SELECT kind FROM bb_projects
      WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`, [scope.owner, scope.projectId])).rows[0];
    if (!project || !['update', 'generation'].includes(project.kind)) reject('无原稿输入的项目归属或类型无法确认。');
    if (manifest.kind !== undefined && manifest.kind !== project.kind) reject('锁定输入的项目类型已变化。');
    const excluded = canonical(await historicalExclusions(client, scope, manifest.materials));
    if (excluded.length && project.kind === 'update') throw new NoneBaselineConflict('HISTORICAL_BASELINE_REQUIRED', '无原稿更新输入遗漏历史募集书。');
    if (snapshot === undefined) {
      // Safe legacy empty-source inputs may resume; an old target confirmation never authorizes exclusions.
      if (excluded.length) throw new NoneBaselineConflict('FIRST_DRAFT_CONFIRMATION_REQUIRED', '旧输入没有准确的首稿排除确认，请创建新的输入版本。');
    } else {
      if (!Value.Check(NoneBaselineSnapshotSchema, snapshot) || snapshot.owner_user_id !== scope.owner ||
          snapshot.project_id !== scope.projectId || snapshot.project_kind !== project.kind ||
          !Number.isFinite(Date.parse(snapshot.checked_at))) reject('无原稿快照归属、类型或结构不一致。');
      if (!sameSet(snapshot.excluded_historical, excluded)) throw new NoneBaselineConflict('FIRST_DRAFT_EXCLUSION_STALE', '锁定后的历史稿集合已变化，请创建新的输入版本。');
      const confirmation = snapshot.first_draft_confirmation;
      if (excluded.length && !confirmation) throw new NoneBaselineConflict('FIRST_DRAFT_CONFIRMATION_REQUIRED', '缺少不可变首稿排除确认。');
      if (confirmation && (project.kind !== 'generation' || confirmation.confirmed_by !== scope.owner ||
          confirmation.confirmed_at !== snapshot.checked_at || !sameSet(confirmation.excluded_historical, excluded)))
        reject('首稿确认主体、时间或排除范围不一致。');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
