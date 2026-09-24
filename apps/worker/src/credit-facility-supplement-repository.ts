import { createHash, randomUUID } from 'node:crypto';
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

/** Values and source IDs must be resolved by a trusted worker caller in this owner/project scope. */
export interface TrustedCreditFacilitySupplementContext {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly requestId: string;
}

export interface CreditFacilitySupplementInput {
  readonly total: CreditFacilitySupplementAmount;
  readonly used: CreditFacilitySupplementAmount;
  readonly unused: CreditFacilitySupplementAmount;
}

export interface StoredCreditFacilitySupplement {
  readonly supplementId: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly result: CreditFacilitySupplementResult;
  readonly createdAt: string;
  readonly replayed: boolean;
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
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isoDayOrNull(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (Number(value.slice(0, 4)) < 1) return null;
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

function validateInput(context: TrustedCreditFacilitySupplementContext, input: CreditFacilitySupplementInput): string {
  if (![context.ownerUserId, context.projectId, context.requestId].every((value) => typeof value === 'string' && identifier.test(value))) {
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_CONTEXT');
  }
  if (!isRecord(input) || Object.keys(input).some((key) => !['total', 'used', 'unused'].includes(key)) ||
    !['total', 'used', 'unused'].every((key) => key in input)) throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT');
  validateAmount(input.total);
  validateAmount(input.used);
  validateAmount(input.unused);
  try {
    // Keep all three original amount assertions and let the shared domain rule
    // derive status; no persistence status can promote this result to verified.
    const result = validateCreditFacilitySupplement(input.total, input.used, input.unused);
    if (result.eligibleForManuscript !== false || !['user_asserted', 'needs_confirmation', 'conflicted'].includes(result.status)) {
      throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_RESULT');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'CreditFacilitySupplementRepositoryError') throw error;
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT');
  }
  return sha256(canonical(input));
}

function mapRow(row: Record<string, unknown>, replayed: boolean): StoredCreditFacilitySupplement {
  const result = parseJson(row.supplement);
  if (!isRecord(result) || !isRecord(result.amounts) || result.eligibleForManuscript !== false ||
    !['user_asserted', 'needs_confirmation', 'conflicted'].includes(String(result.status)) ||
    typeof row.id !== 'string' || typeof row.owner_user_id !== 'string' || typeof row.project_id !== 'string' ||
    typeof row.request_id !== 'string' || typeof row.request_hash !== 'string' ||
    !(row.created_at instanceof Date || typeof row.created_at === 'string')) throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
  const parsedAt = dateString(row.created_at);
  return {
    supplementId: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    requestId: row.request_id,
    requestHash: row.request_hash.trim(),
    result: result as unknown as CreditFacilitySupplementResult,
    createdAt: parsedAt,
    replayed,
  };
}

const columns = `id, owner_user_id, project_id, request_id, request_hash, supplement, created_at`;

/** Persist an internal user assertion; no public/API read path is provided here. */
export async function appendCreditFacilitySupplement(
  dependencies: CreditFacilitySupplementDependencies,
  context: TrustedCreditFacilitySupplementContext,
  input: CreditFacilitySupplementInput,
): Promise<StoredCreditFacilitySupplement> {
  const requestHash = validateInput(context, input);
  const validation = validateCreditFacilitySupplement(input.total, input.used, input.unused);
  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `credit-facility-supplement:${context.ownerUserId}:${context.projectId}:${context.requestId}`,
    ]);
    const project = await client.query(
      `SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [context.ownerUserId, context.projectId],
    );
    if (project.rows.length !== 1) throw fail('CREDIT_SUPPLEMENT_PROJECT_NOT_FOUND');

    const prior = await client.query(
      `SELECT ${columns} FROM bb_credit_facility_supplements
        WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`,
      [context.ownerUserId, context.projectId, context.requestId],
    );
    if (prior.rows.length > 0) {
      const existing = mapRow(prior.rows[0]!, true);
      if (existing.requestHash !== requestHash) throw fail('CREDIT_SUPPLEMENT_IDEMPOTENCY_MISMATCH');
      await client.query('COMMIT');
      transactionOpen = false;
      return existing;
    }

    const id = dependencies.newId?.() ?? randomUUID();
    const inserted = await client.query(
      `INSERT INTO bb_credit_facility_supplements
        (id, owner_user_id, project_id, request_id, request_hash, status,
         total_source_id, total_statement_date, used_source_id, used_statement_date,
         unused_source_id, unused_statement_date, supplement)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::date,$11,$12::date,$13::jsonb)
       RETURNING ${columns}`,
      [id, context.ownerUserId, context.projectId, context.requestId, requestHash, validation.status,
        input.total.sourceId, isoDayOrNull(input.total.statementDate), input.used.sourceId, isoDayOrNull(input.used.statementDate),
        input.unused.sourceId, isoDayOrNull(input.unused.statementDate), JSON.stringify(validation)],
    );
    if (inserted.rows.length !== 1) throw fail('CREDIT_SUPPLEMENT_NOT_STORED');
    await client.query(
      `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'credit_facility_supplement',$3,'credit.facility_supplement.appended',$4::jsonb)`,
      [dependencies.newId?.() ?? randomUUID(), context.ownerUserId, id, JSON.stringify({
        supplement_id: id, project_id: context.projectId, request_id: context.requestId, status: validation.status,
      })],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return mapRow(inserted.rows[0]!, false);
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Read one supplement only through the trusted owner/project pair and active project. */
export async function getCreditFacilitySupplement(
  dependencies: CreditFacilitySupplementDependencies,
  context: TrustedCreditFacilitySupplementContext,
): Promise<StoredCreditFacilitySupplement | null> {
  if (![context.ownerUserId, context.projectId, context.requestId].every((value) => typeof value === 'string' && identifier.test(value))) {
    throw fail('INVALID_CREDIT_FACILITY_SUPPLEMENT_CONTEXT');
  }
  const result = await dependencies.pool.query(
    `SELECT s.${columns.replaceAll(', ', ', s.')}
       FROM bb_credit_facility_supplements s
       JOIN bb_projects p ON p.owner_user_id=s.owner_user_id AND p.id=s.project_id
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.request_id=$3 AND p.deleted_at IS NULL`,
    [context.ownerUserId, context.projectId, context.requestId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw fail('INVALID_CREDIT_SUPPLEMENT_ROW');
  return mapRow(result.rows[0]!, false);
}
