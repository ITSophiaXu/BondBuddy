import type { QueryResultRow } from 'pg';
import type { CreditFacilitySupplementResponse } from '@bondbuddy/contracts';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';

export type CreditFacilitySupplementAssertionStatus = CreditFacilitySupplementResponse['status'];

export interface CreditFacilitySupplementInputLock {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly inputRevision: number;
  readonly inputHash: string;
}

export interface CreditFacilitySupplementUncertaintyAmount {
  readonly bank: string;
  readonly asOf: string;
  readonly amount: string | null;
  readonly currency: string;
  readonly unit: string;
  readonly basis: string;
  readonly scope: string;
  readonly sourceId: string;
  readonly statementDate: string;
}

/** User supplied context only. This projection is not a verified fact or manuscript input. */
export interface CreditFacilitySupplementUncertainty {
  readonly supplementId: string;
  readonly version: number;
  readonly requestHash: string;
  readonly status: CreditFacilitySupplementAssertionStatus;
  readonly eligibleForManuscript: false;
  readonly amounts: {
    readonly total: CreditFacilitySupplementUncertaintyAmount;
    readonly used: CreditFacilitySupplementUncertaintyAmount;
    readonly unused: CreditFacilitySupplementUncertaintyAmount;
  };
  readonly reason: string | null;
}

export type CreditFacilitySupplementInputLoad =
  | {
      readonly status: 'loaded';
      readonly projection: readonly CreditFacilitySupplementUncertainty[];
    }
  | { readonly status: 'needs_review'; readonly reason: string; readonly projection: readonly [] };

export interface CreditFacilitySupplementInputLoaderDatabase {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: QueryResultRow[] }>;
}

interface VersionRef {
  supplement_id: string;
  version: number;
  request_hash: string;
  status: CreditFacilitySupplementAssertionStatus;
  eligible_for_manuscript: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isStatus(value: unknown): value is CreditFacilitySupplementAssertionStatus {
  return value === 'user_asserted' || value === 'needs_confirmation' || value === 'conflicted';
}

function failed(reason: string): CreditFacilitySupplementInputLoad {
  return { status: 'needs_review', reason, projection: [] };
}

function parseRefs(manifest: unknown): VersionRef[] | null {
  if (!isRecord(manifest)) return null;
  if (!Object.hasOwn(manifest, 'credit_facility_supplements')) return [];
  const raw = manifest.credit_facility_supplements;
  if (!Array.isArray(raw) || raw.length > 60) return null;
  const seen = new Set<string>();
  const result: VersionRef[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(item.supplement_id ?? '')) ||
      !Number.isSafeInteger(item.version) ||
      Number(item.version) < 1 ||
      typeof item.request_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.request_hash) ||
      !isStatus(item.status) ||
      item.eligible_for_manuscript !== false
    )
      return null;
    const ref = {
      supplement_id: item.supplement_id as string,
      version: Number(item.version),
      request_hash: item.request_hash,
      status: item.status,
      eligible_for_manuscript: false as const,
    };
    if (seen.has(ref.supplement_id)) return null;
    seen.add(ref.supplement_id);
    result.push(ref);
  }
  return result;
}

function amount(value: unknown): CreditFacilitySupplementUncertaintyAmount | null {
  if (
    !isRecord(value) ||
    typeof value.bank !== 'string' ||
    typeof value.asOf !== 'string' ||
    !(value.amount === null || typeof value.amount === 'string') ||
    typeof value.currency !== 'string' ||
    typeof value.unit !== 'string' ||
    typeof value.basis !== 'string' ||
    typeof value.scope !== 'string' ||
    typeof value.sourceId !== 'string' ||
    typeof value.statementDate !== 'string'
  )
    return null;
  return {
    bank: value.bank,
    asOf: value.asOf,
    amount: value.amount,
    currency: value.currency,
    unit: value.unit,
    basis: value.basis,
    scope: value.scope,
    sourceId: value.sourceId,
    statementDate: value.statementDate,
  };
}

/**
 * Re-read the exact immutable input revision and its owner/project-scoped supplement rows.
 * A successful result is uncertainty context only; callers must never treat it as verified facts.
 */
export async function loadCreditFacilitySupplementUncertainty(
  database: CreditFacilitySupplementInputLoaderDatabase,
  lock: CreditFacilitySupplementInputLock,
): Promise<CreditFacilitySupplementInputLoad> {
  if (
    typeof lock.ownerUserId !== 'string' ||
    typeof lock.projectId !== 'string' ||
    !Number.isSafeInteger(lock.inputRevision) ||
    lock.inputRevision < 1 ||
    !/^[a-f0-9]{64}$/.test(lock.inputHash)
  ) {
    return failed('invalid_input_lock');
  }

  const inputResult = await database.query(
    `SELECT i.owner_user_id, i.project_id, i.revision, i.input_hash, i.manifest
       FROM bb_input_revisions i
       JOIN bb_projects p ON p.owner_user_id=i.owner_user_id AND p.id=i.project_id AND p.deleted_at IS NULL
      WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3`,
    [lock.ownerUserId, lock.projectId, lock.inputRevision],
  );
  if (inputResult.rows.length !== 1) return failed('input_revision_missing_or_foreign');
  const input = inputResult.rows[0]!;
  if (
    input.owner_user_id !== lock.ownerUserId ||
    input.project_id !== lock.projectId ||
    Number(input.revision) !== lock.inputRevision ||
    String(input.input_hash).trim() !== lock.inputHash
  ) {
    return failed('input_revision_lock_mismatch');
  }

  const manifest = parseJson(input.manifest);
  if (!isRecord(manifest)) return failed('input_manifest_invalid');
  try {
    if (inputManifestHash(manifest) !== lock.inputHash)
      return failed('input_manifest_hash_mismatch');
  } catch {
    return failed('input_manifest_hash_invalid');
  }
  const refs = parseRefs(manifest);
  if (!refs) return failed('input_manifest_supplement_refs_invalid');
  const projection: CreditFacilitySupplementUncertainty[] = [];
  for (const ref of refs) {
    const result = await database.query(
      `SELECT owner_user_id, project_id, id, supplement_version, request_hash, status, supplement
         FROM bb_credit_facility_supplements
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND supplement_version=$4`,
      [lock.ownerUserId, lock.projectId, ref.supplement_id, ref.version],
    );
    if (result.rows.length !== 1) return failed('supplement_missing_or_foreign');
    const row = result.rows[0]!;
    if (
      row.owner_user_id !== lock.ownerUserId ||
      row.project_id !== lock.projectId ||
      row.id !== ref.supplement_id ||
      Number(row.supplement_version) !== ref.version ||
      String(row.request_hash).trim() !== ref.request_hash
    ) {
      return failed('supplement_lock_mismatch');
    }
    const stored = parseJson(row.supplement);
    if (
      !isStatus(row.status) ||
      row.status !== ref.status ||
      !isRecord(stored) ||
      stored.status !== row.status ||
      stored.eligibleForManuscript !== false ||
      !isRecord(stored.amounts)
    ) {
      return failed('supplement_status_or_shape_changed');
    }
    const total = amount(stored.amounts.total);
    const used = amount(stored.amounts.used);
    const unused = amount(stored.amounts.unused);
    if (
      !total ||
      !used ||
      !unused ||
      !(stored.reason === undefined || stored.reason === null || typeof stored.reason === 'string')
    ) {
      return failed('supplement_projection_invalid');
    }
    projection.push({
      supplementId: ref.supplement_id,
      version: ref.version,
      requestHash: ref.request_hash,
      status: row.status,
      eligibleForManuscript: false,
      amounts: { total, used, unused },
      reason: typeof stored.reason === 'string' ? stored.reason : null,
    });
  }
  return { status: 'loaded', projection };
}
