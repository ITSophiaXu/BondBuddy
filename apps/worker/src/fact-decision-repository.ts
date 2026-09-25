import { createHash, randomUUID } from 'node:crypto';
import { factIdentityKey, type FactIdentity } from '@bondbuddy/domain/facts';

export interface FactDecisionClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface FactDecisionPool {
  connect(): Promise<FactDecisionClient>;
}

export interface TrustedFactDecisionContext {
  /** Authenticated worker/API context. Never derive these from decision JSON. */
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly actorKind: 'user' | 'internal_reviewer' | 'system';
}

export interface FactDecisionInput {
  /** Server-issued stable identifiers, reused unchanged when retrying the request. */
  readonly decisionId: string;
  readonly requestId: string;
  readonly identity: FactIdentity;
  readonly resolution: 'selected' | 'unresolved';
  readonly selectedCandidateId?: string;
  readonly reason: string;
}

export interface StoredFactDecision {
  readonly decisionId: string;
  readonly requestId: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly factKeyHash: string;
  readonly identity: FactIdentity;
  readonly version: number;
  readonly resolution: 'selected' | 'unresolved';
  readonly selectedCandidateId: string | null;
  readonly selectedCandidateProvenance: Record<string, unknown> | null;
  readonly reason: string;
  readonly actorId: string;
  readonly actorKind: TrustedFactDecisionContext['actorKind'];
  readonly createdAt: string;
  readonly replayed: boolean;
}

export interface FactDecisionDependencies {
  readonly pool: FactDecisionPool;
  readonly newId?: () => string;
}

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'FactDecisionRepositoryError';
  return error;
}

function hashIdentity(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_FACT_DECISION_ROW'); }
}

function mapDecision(row: Record<string, unknown>, replayed: boolean): StoredFactDecision {
  const identity = parseJson(row.fact_key);
  const provenance = row.selected_candidate_provenance === null ? null : parseJson(row.selected_candidate_provenance);
  if (!isRecord(identity) || (provenance !== null && !isRecord(provenance)) ||
    (row.resolution !== 'selected' && row.resolution !== 'unresolved') ||
    (row.actor_kind !== 'user' && row.actor_kind !== 'internal_reviewer' && row.actor_kind !== 'system') ||
    typeof row.id !== 'string' || typeof row.request_id !== 'string' || typeof row.owner_user_id !== 'string' ||
    typeof row.project_id !== 'string' || typeof row.fact_key_hash !== 'string' || !Number.isSafeInteger(Number(row.version)) ||
    !(row.selected_candidate_id === null || typeof row.selected_candidate_id === 'string') ||
    typeof row.reason !== 'string' || typeof row.actor_id !== 'string' || !(row.created_at instanceof Date || typeof row.created_at === 'string')) {
    throw fail('INVALID_FACT_DECISION_ROW');
  }
  const parsedCreatedAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  if (!Number.isFinite(parsedCreatedAt.getTime())) throw fail('INVALID_FACT_DECISION_ROW');
  const createdAt = parsedCreatedAt.toISOString();
  return {
    decisionId: row.id,
    requestId: row.request_id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    factKeyHash: row.fact_key_hash,
    identity: identity as unknown as FactIdentity,
    version: Number(row.version),
    resolution: row.resolution,
    selectedCandidateId: row.selected_candidate_id,
    selectedCandidateProvenance: provenance,
    reason: row.reason,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    createdAt,
    replayed,
  };
}

function validate(context: TrustedFactDecisionContext, input: FactDecisionInput): string {
  if (!context.ownerUserId.trim() || !context.projectId.trim() || !context.actorId.trim() ||
    !input.decisionId.trim() || !input.requestId.trim() || input.reason.trim().length === 0 || input.reason.length > 2000) {
    throw fail('INVALID_FACT_DECISION');
  }
  if (!['user', 'internal_reviewer', 'system'].includes(context.actorKind)) throw fail('INVALID_FACT_DECISION_ACTOR');
  if (typeof input.identity.accountId !== 'string' || input.identity.accountId !== context.ownerUserId ||
    typeof input.identity.entityId !== 'string' || !input.identity.entityId.trim() ||
    typeof input.identity.scope !== 'string' || !input.identity.scope.trim() ||
    typeof input.identity.metric !== 'string' || !input.identity.metric.trim() ||
    typeof input.identity.unit !== 'string' || !input.identity.unit.trim() ||
    typeof input.identity.basis !== 'string' || !input.identity.basis.trim() ||
    typeof input.identity.dataVersion !== 'string' || !input.identity.dataVersion.trim() ||
    !(input.identity.currency === null || (typeof input.identity.currency === 'string' && input.identity.currency.trim() !== '')) ||
    !input.identity.period || typeof input.identity.period !== 'object' || Array.isArray(input.identity.period)) {
    throw fail('INVALID_FACT_IDENTITY');
  }
  for (const date of [input.identity.period.start, input.identity.period.end, input.identity.period.asOf]) {
    if (date !== undefined && (typeof date !== 'string' || !validIsoDay(date))) throw fail('INVALID_FACT_PERIOD');
  }
  if (context.actorKind === 'system' && input.resolution === 'selected') throw fail('SYSTEM_CANNOT_SELECT_FACT');
  let key: string;
  try { key = factIdentityKey(input.identity); } catch { throw fail('INVALID_FACT_IDENTITY'); }
  if (input.resolution === 'selected' && !input.selectedCandidateId?.trim()) throw fail('FACT_CANDIDATE_REQUIRED');
  if (input.resolution === 'unresolved' && input.selectedCandidateId !== undefined) throw fail('UNRESOLVED_DECISION_HAS_CANDIDATE');
  if (input.resolution !== 'selected' && input.resolution !== 'unresolved') throw fail('INVALID_FACT_DECISION');
  return key;
}

const DECISION_COLUMNS = `id, request_id, owner_user_id, project_id, fact_key_hash, fact_key, version, resolution,
 selected_candidate_id, selected_candidate_provenance, reason, actor_kind, actor_id, created_at`;

/**
 * Appends an owner-scoped decision without changing any candidate. A selected
 * user statement remains its original user_asserted candidate; this seam does
 * not promote facts or decide whether a run may use them.
 */
export async function appendFactDecision(
  dependencies: FactDecisionDependencies,
  context: TrustedFactDecisionContext,
  input: FactDecisionInput,
): Promise<StoredFactDecision> {
  const identityKey = validate(context, input);
  const factKeyHash = hashIdentity(identityKey);
  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    // Serialize retries for the same idempotency key, then serialize version
    // assignment for the exact owner/project/fact identity.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `fact-decision-request:${context.ownerUserId}:${context.projectId}:${input.requestId}`,
    ]);
    const prior = await client.query(
      `SELECT ${DECISION_COLUMNS} FROM bb_fact_decisions
        WHERE owner_user_id = $1 AND project_id = $2 AND request_id = $3`,
      [context.ownerUserId, context.projectId, input.requestId],
    );
    if (prior.rows.length > 0) {
      const existing = mapDecision(prior.rows[0]!, true);
      const same = existing.decisionId === input.decisionId && existing.factKeyHash === factKeyHash &&
        factIdentityKey(existing.identity) === identityKey && existing.resolution === input.resolution &&
        existing.selectedCandidateId === (input.selectedCandidateId ?? null) && existing.reason === input.reason &&
        existing.actorId === context.actorId && existing.actorKind === context.actorKind;
      if (!same) throw fail('FACT_DECISION_IDEMPOTENCY_MISMATCH');
      await client.query('COMMIT');
      transactionOpen = false;
      return existing;
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `fact-decision-identity:${context.ownerUserId}:${context.projectId}:${factKeyHash}`,
    ]);

    let provenance: Record<string, unknown> | null = null;
    const candidateResult = input.resolution === 'selected'
      ? await client.query(
        `SELECT id, owner_user_id, project_id, entity_id, fact_key_hash, fact_key,
                source_kind, source_ref, status, source_observed_at, source_valid_as_of,
                material_id, material_version, created_at
           FROM bb_fact_candidates
          WHERE owner_user_id = $1 AND project_id = $2 AND id = $3`,
        [context.ownerUserId, context.projectId, input.selectedCandidateId],
      )
      : await client.query(
        `SELECT id, owner_user_id, project_id, entity_id, fact_key_hash, fact_key,
                source_kind, source_ref, status, source_observed_at, source_valid_as_of,
                material_id, material_version, created_at
           FROM bb_fact_candidates
          WHERE owner_user_id = $1 AND project_id = $2 AND fact_key_hash = $3
          ORDER BY created_at, id`,
        [context.ownerUserId, context.projectId, factKeyHash],
      );
    if (input.resolution === 'selected') {
      const candidate = candidateResult.rows[0];
      if (!candidate) throw fail('FACT_CANDIDATE_NOT_FOUND');
      if (candidate.fact_key_hash !== factKeyHash || factIdentityKey(parseJson(candidate.fact_key) as FactIdentity) !== identityKey ||
        candidate.entity_id !== input.identity.entityId) throw fail('FACT_CANDIDATE_IDENTITY_MISMATCH');
      // Snapshot a small provenance summary only; the candidate remains the
      // authority for amounts and evidence, avoiding duplicate sensitive text.
      provenance = {
        candidate_id: candidate.id,
        source_kind: candidate.source_kind,
        source_ref: candidate.source_ref,
        status: candidate.status,
        source_observed_at: candidate.source_observed_at,
        source_valid_as_of: candidate.source_valid_as_of,
        material_id: candidate.material_id,
        material_version: candidate.material_version,
        candidate_created_at: candidate.created_at,
      };
    } else if (!candidateResult.rows.some((candidate) => candidate.entity_id === input.identity.entityId &&
      factIdentityKey(parseJson(candidate.fact_key) as FactIdentity) === identityKey)) throw fail('FACT_CANDIDATE_NOT_FOUND');

    const versionResult = await client.query(
      `SELECT COALESCE(max(version), 0)::int AS version FROM bb_fact_decisions
        WHERE owner_user_id = $1 AND project_id = $2 AND fact_key_hash = $3`,
      [context.ownerUserId, context.projectId, factKeyHash],
    );
    const version = Number(versionResult.rows[0]?.version ?? 0) + 1;
    const id = input.decisionId;
    const inserted = await client.query(
      `INSERT INTO bb_fact_decisions
         (id, request_id, owner_user_id, project_id, fact_key_hash, fact_key, version, resolution,
          selected_candidate_id, selected_candidate_provenance, reason, actor_kind, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13)
       RETURNING ${DECISION_COLUMNS}`,
      [id, input.requestId, context.ownerUserId, context.projectId, factKeyHash, JSON.stringify(input.identity), version,
        input.resolution, input.selectedCandidateId ?? null, provenance === null ? null : JSON.stringify(provenance),
        input.reason, context.actorKind, context.actorId],
    );
    if (inserted.rows.length !== 1) throw fail('FACT_DECISION_NOT_STORED');
    const decision = inserted.rows[0]!;
    await client.query(
      `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,'fact_decision',$3,'fact.decision.appended',$4::jsonb)`,
      [dependencies.newId?.() ?? randomUUID(), context.ownerUserId, id, JSON.stringify({
        decision_id: id, project_id: context.projectId, fact_key_hash: factKeyHash, version,
        resolution: input.resolution, selected_candidate_id: input.selectedCandidateId ?? null,
      })],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return mapDecision(decision, false);
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Reads the latest immutable decision for one exact identity inside an authenticated owner/project scope. */
export async function getLatestFactDecision(
  dependencies: FactDecisionDependencies,
  context: Pick<TrustedFactDecisionContext, 'ownerUserId' | 'projectId'>,
  identity: FactIdentity,
): Promise<StoredFactDecision | null> {
  if (!context.ownerUserId.trim() || !context.projectId.trim() || identity.accountId !== context.ownerUserId) {
    throw fail('INVALID_FACT_DECISION_SCOPE');
  }
  let identityKey: string;
  try { identityKey = factIdentityKey(identity); } catch { throw fail('INVALID_FACT_IDENTITY'); }
  const client = await dependencies.pool.connect();
  try {
    const result = await client.query(
      `SELECT ${DECISION_COLUMNS} FROM bb_fact_decisions
        WHERE owner_user_id = $1 AND project_id = $2 AND fact_key_hash = $3
        ORDER BY version DESC LIMIT 1`,
      [context.ownerUserId, context.projectId, hashIdentity(identityKey)],
    );
    if (result.rows.length === 0) return null;
    const decision = mapDecision(result.rows[0]!, false);
    if (decision.ownerUserId !== context.ownerUserId || decision.projectId !== context.projectId ||
      decision.factKeyHash !== hashIdentity(identityKey) || factIdentityKey(decision.identity) !== identityKey) {
      throw fail('FACT_DECISION_SCOPE_OR_IDENTITY_MISMATCH');
    }
    return decision;
  } finally {
    client.release();
  }
}
