import { createHash, randomUUID } from 'node:crypto';
import type {
  CreditFacilitySupplementResponse,
  CreditFacilitySupplementVersionRef,
} from '@bondbuddy/contracts';
import {
  validateCreditFacilitySupplement,
  type CreditFacilitySupplementAmount,
  type CreditFacilitySupplementResult,
} from '@bondbuddy/domain/facts';

export interface CreditFacilitySupplementClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface CreditFacilitySupplementPool {
  connect(): Promise<CreditFacilitySupplementClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface CreditFacilitySupplementDependencies {
  readonly pool: CreditFacilitySupplementPool;
  readonly newId?: () => string;
}

/** Owner/project/request identity is always supplied by the trusted API seam, never the request body. */
export interface TrustedCreditFacilitySupplementContext {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly requestId: string;
}

export interface CreditFacilitySupplementPredecessor {
  readonly supplementId: string;
  readonly version: number;
}

export interface CreditFacilitySupplementInput {
  readonly total: CreditFacilitySupplementAmount;
  readonly used: CreditFacilitySupplementAmount;
  readonly unused: CreditFacilitySupplementAmount;
  readonly supersedes?: CreditFacilitySupplementPredecessor | null;
}

export interface StoredCreditFacilitySupplement {
  readonly supplementId: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly version: number;
  readonly supersedes: CreditFacilitySupplementPredecessor | null;
  readonly result: CreditFacilitySupplementResult;
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface ExactCreditFacilitySupplementReadContext {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly supplementId: string;
  readonly version: number;
}

export interface LockedCreditFacilitySupplementPin extends CreditFacilitySupplementVersionRef {
  readonly status: CreditFacilitySupplementResponse['status'];
  readonly eligible_for_manuscript: false;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const amountFields = ['bank', 'asOf', 'currency', 'unit', 'basis', 'scope', 'amount', 'sourceId', 'statementDate'] as const;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'CreditFacilitySupplementRepositoryError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT');
  return encoded;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isoDayOrNull(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_CREDIT_SUPPLEMENT_ROW'); }
}

function dateString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
  return date.toISOString();
}

function validateAmount(value: unknown): asserts value is CreditFacilitySupplementAmount {
  if (!isRecord(value) || Object.keys(value).some((key) => !(amountFields as readonly string[]).includes(key)) ||
    amountFields.some((field) => !(field in value)) ||
    amountFields.filter((field) => field !== 'amount').some((field) => typeof value[field] !== 'string') ||
    !(value.amount === null || typeof value.amount === 'string')) {
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT');
  }
}

function validatePredecessor(value: unknown): asserts value is CreditFacilitySupplementPredecessor | null | undefined {
  if (value === null || value === undefined) return;
  if (!isRecord(value) || Object.keys(value).some((key) => !['supplementId', 'version'].includes(key)) ||
    !identifier.test(String(value.supplementId ?? '')) || !Number.isSafeInteger(value.version) || Number(value.version) < 1) {
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_PREDECESSOR');
  }
}

function validateInput(context: TrustedCreditFacilitySupplementContext, input: CreditFacilitySupplementInput): string {
  if (![context.ownerUserId, context.projectId, context.requestId].every((value) => typeof value === 'string' && identifier.test(value))) {
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_CONTEXT');
  }
  if (!isRecord(input) || Object.keys(input).some((key) => !['total', 'used', 'unused', 'supersedes'].includes(key)) ||
    !['total', 'used', 'unused'].every((key) => key in input)) throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT');
  validatePredecessor(input.supersedes);
  validateAmount(input.total);
  validateAmount(input.used);
  validateAmount(input.unused);
  try {
    const result = validateCreditFacilitySupplement(input.total, input.used, input.unused);
    if (result.eligibleForManuscript !== false || !['user_asserted', 'needs_confirmation', 'conflicted'].includes(result.status)) {
      throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_RESULT');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'CreditFacilitySupplementRepositoryError') throw error;
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT');
  }
  const { supersedes, ...amounts } = input;
  return sha256(canonical({ amounts, supersedes: supersedes ?? null }));
}

function mapRow(row: Record<string, unknown>, replayed: boolean): StoredCreditFacilitySupplement {
  const result = parseJson(row.supplement);
  const version = Number(row.supplement_version);
  const predecessorId = row.supersedes_supplement_id;
  const predecessorVersion = row.supersedes_version;
  if (!isRecord(result) || !isRecord(result.amounts) || result.eligibleForManuscript !== false ||
    !['user_asserted', 'needs_confirmation', 'conflicted'].includes(String(result.status)) ||
    typeof row.id !== 'string' || typeof row.owner_user_id !== 'string' || typeof row.project_id !== 'string' ||
    typeof row.request_id !== 'string' || typeof row.request_hash !== 'string' || !Number.isSafeInteger(version) || version < 1 ||
    !(predecessorId === null || typeof predecessorId === 'string') ||
    !(predecessorVersion === null || (Number.isSafeInteger(Number(predecessorVersion)) && Number(predecessorVersion) >= 1)) ||
    (version === 1 && (predecessorId !== null || predecessorVersion !== null)) ||
    (version > 1 && (typeof predecessorId !== 'string' || Number(predecessorVersion) !== version - 1)) ||
    !(row.created_at instanceof Date || typeof row.created_at === 'string')) throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
  return {
    supplementId: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    requestId: row.request_id,
    requestHash: row.request_hash.trim(),
    version,
    supersedes: predecessorId === null ? null : { supplementId: predecessorId, version: Number(predecessorVersion) },
    result: result as unknown as CreditFacilitySupplementResult,
    createdAt: dateString(row.created_at),
    replayed,
  };
}

const columns = `id, owner_user_id, project_id, request_id, request_hash, supplement, supplement_version, supersedes_supplement_id, supersedes_version, created_at`;

/** Persist an immutable user assertion with exact optional predecessor and atomic outbox. */
export async function appendCreditFacilitySupplement(
  dependencies: CreditFacilitySupplementDependencies,
  context: TrustedCreditFacilitySupplementContext,
  input: CreditFacilitySupplementInput,
): Promise<StoredCreditFacilitySupplement> {
  const requestHash = validateInput(context, input);
  const validation = validateCreditFacilitySupplement(input.total, input.used, input.unused);
  const predecessor = input.supersedes ?? null;
  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN'); transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `credit-facility-supplement:${context.ownerUserId}:${context.projectId}:${context.requestId}`,
    ]);
    const project = await client.query(
      'SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
      [context.ownerUserId, context.projectId],
    );
    if (project.rows.length !== 1) throw fail('CREDIT_SUPPLEMENT_PROJECT_NOT_FOUND');

    const prior = await client.query(
      `SELECT ${columns} FROM bb_credit_facility_supplements WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`,
      [context.ownerUserId, context.projectId, context.requestId],
    );
    if (prior.rows.length > 0) {
      const existing = mapRow(prior.rows[0]!, true);
      if (existing.requestHash !== requestHash) throw fail('CREDIT_SUPPLEMENT_IDEMPOTENCY_MISMATCH');
      await client.query('COMMIT'); transactionOpen = false;
      return existing;
    }

    let version = 1;
    if (predecessor) {
      const parent = await client.query(
        `SELECT id, supplement_version FROM bb_credit_facility_supplements
          WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND supplement_version=$4 FOR UPDATE`,
        [context.ownerUserId, context.projectId, predecessor.supplementId, predecessor.version],
      );
      if (parent.rows.length !== 1) throw fail('CREDIT_SUPPLEMENT_PREDECESSOR_NOT_FOUND');
      const successor = await client.query(
        `SELECT 1 FROM bb_credit_facility_supplements
          WHERE owner_user_id=$1 AND project_id=$2 AND supersedes_supplement_id=$3 AND supersedes_version=$4 LIMIT 1`,
        [context.ownerUserId, context.projectId, predecessor.supplementId, predecessor.version],
      );
      if (successor.rows.length > 0) throw fail('CREDIT_SUPPLEMENT_REVISION_CONFLICT');
      version = Number(parent.rows[0]!.supplement_version) + 1;
    }

    const id = dependencies.newId?.() ?? randomUUID();
    const inserted = await client.query(
      `INSERT INTO bb_credit_facility_supplements
        (id, owner_user_id, project_id, request_id, request_hash, status,
         total_source_id, total_statement_date, used_source_id, used_statement_date,
         unused_source_id, unused_statement_date, supplement, supplement_version,
         supersedes_supplement_id, supersedes_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::date,$11,$12::date,$13::jsonb,$14,$15,$16)
       RETURNING ${columns}`,
      [id, context.ownerUserId, context.projectId, context.requestId, requestHash, validation.status,
        input.total.sourceId, isoDayOrNull(input.total.statementDate), input.used.sourceId, isoDayOrNull(input.used.statementDate),
        input.unused.sourceId, isoDayOrNull(input.unused.statementDate), JSON.stringify(validation), version,
        predecessor?.supplementId ?? null, predecessor?.version ?? null],
    );
    if (inserted.rows.length !== 1) throw fail('CREDIT_SUPPLEMENT_NOT_STORED');
    await client.query(
      `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'credit_facility_supplement',$3,'credit.facility_supplement.appended',$4::jsonb)`,
      [dependencies.newId?.() ?? randomUUID(), context.ownerUserId, id, JSON.stringify({
        supplement_id: id, project_id: context.projectId, request_id: context.requestId,
        version, supersedes: predecessor, status: validation.status,
      })],
    );
    await client.query('COMMIT'); transactionOpen = false;
    return mapRow(inserted.rows[0]!, false);
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ } }
    throw error;
  } finally { client.release(); }
}

/** Internal compatibility read by idempotency request ID. */
export async function getCreditFacilitySupplement(
  dependencies: CreditFacilitySupplementDependencies,
  context: TrustedCreditFacilitySupplementContext,
): Promise<StoredCreditFacilitySupplement | null> {
  if (![context.ownerUserId, context.projectId, context.requestId].every((value) => typeof value === 'string' && identifier.test(value))) {
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_CONTEXT');
  }
  const result = await dependencies.pool.query(
    `SELECT s.${columns.replaceAll(', ', ', s.')}
       FROM bb_credit_facility_supplements s JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.request_id=$3 AND p.deleted_at IS NULL`,
    [context.ownerUserId, context.projectId, context.requestId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
  return mapRow(result.rows[0]!, false);
}

/** Public route's exact historical read; scope, active project, ID and version all match. */
export async function getCreditFacilitySupplementVersion(
  dependencies: CreditFacilitySupplementDependencies,
  context: ExactCreditFacilitySupplementReadContext,
): Promise<StoredCreditFacilitySupplement | null> {
  if (![context.ownerUserId, context.projectId, context.supplementId].every((value) => typeof value === 'string' && identifier.test(value)) ||
      !Number.isSafeInteger(context.version) || context.version < 1) throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_CONTEXT');
  const result = await dependencies.pool.query(
    `SELECT s.${columns.replaceAll(', ', ', s.')}
       FROM bb_credit_facility_supplements s JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.id=$3 AND s.supplement_version=$4 AND p.deleted_at IS NULL`,
    [context.ownerUserId, context.projectId, context.supplementId, context.version],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
  return mapRow(result.rows[0]!, false);
}

/** Resolve exact public refs from trusted owner/project rows while the caller's input transaction is open. */
export async function lockCreditFacilitySupplementPins(
  client: Pick<CreditFacilitySupplementClient, 'query'>,
  context: Pick<TrustedCreditFacilitySupplementContext, 'ownerUserId' | 'projectId'>,
  references: readonly CreditFacilitySupplementVersionRef[],
): Promise<LockedCreditFacilitySupplementPin[]> {
  if (!Array.isArray(references) || references.length > 60 ||
      ![context.ownerUserId, context.projectId].every(value => typeof value === 'string' && identifier.test(value)))
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_PIN');
  const seen = new Set<string>();
  const normalized = references.map(reference => {
    if (!isRecord(reference) || Object.keys(reference).some(key => !['supplement_id', 'version', 'request_hash'].includes(key)) ||
        !identifier.test(String(reference.supplement_id ?? '')) || !Number.isSafeInteger(reference.version) || Number(reference.version) < 1 ||
        typeof reference.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(reference.request_hash))
      throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_PIN');
    return { supplement_id: reference.supplement_id as string, version: Number(reference.version), request_hash: reference.request_hash };
  });
  const sorted = normalized.sort((a, b) => a.supplement_id < b.supplement_id ? -1 : a.supplement_id > b.supplement_id ? 1 : 0);
  const pins: LockedCreditFacilitySupplementPin[] = [];
  for (const reference of sorted) {
    if (seen.has(reference.supplement_id)) throw fail('DUPLICATE_CREDIT_FACILITY_SUPPLEMENT_PIN');
    seen.add(reference.supplement_id);
    const row = await client.query(
      `SELECT s.id,s.supplement_version,s.request_hash,s.status,s.supplement
         FROM bb_credit_facility_supplements s
         JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
        WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.id=$3 AND s.supplement_version=$4
          AND p.deleted_at IS NULL FOR SHARE OF s,p`,
      [context.ownerUserId, context.projectId, reference.supplement_id, reference.version],
    );
    if (row.rows.length !== 1) throw fail('CREDIT_SUPPLEMENT_PIN_NOT_FOUND');
    const value = row.rows[0]!;
    const requestHash = typeof value.request_hash === 'string' ? value.request_hash.trim() : '';
    if (requestHash !== reference.request_hash) throw fail('CREDIT_SUPPLEMENT_PIN_HASH_MISMATCH');
    const stored = parseJson(value.supplement);
    if (!['user_asserted', 'needs_confirmation', 'conflicted'].includes(String(value.status)) ||
        !isRecord(stored) || stored.status !== value.status || stored.eligibleForManuscript !== false)
      throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
    pins.push({ supplement_id: reference.supplement_id, version: Number(value.supplement_version), request_hash: requestHash,
      status: value.status as LockedCreditFacilitySupplementPin['status'], eligible_for_manuscript: false });
  }
  return pins;
}
