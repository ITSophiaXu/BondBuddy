import { createHash, randomUUID } from 'node:crypto';
import {
  publishRulePackBundle,
  rulePackContentHash,
  validateRulePack,
  withdrawRulePack,
  type ChapterTemplate,
  type CoverageManifest,
  type ReviewAttestation,
  type RulePack,
} from '@bondbuddy/domain';

export interface RulePackLedgerClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface RulePackLedgerPool {
  connect(): Promise<RulePackLedgerClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface RulePackLedgerDependencies {
  readonly pool: RulePackLedgerPool;
  readonly newId?: () => string;
}

/** Internal persistence context. This seam accepts only test-channel writes. */
export interface RulePackLedgerActor {
  readonly actorId: string;
  readonly requestId: string;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface RulePackTestReleaseInput extends RulePackLedgerActor {
  readonly draft: RulePack;
  readonly template: ChapterTemplate;
  readonly coverage: CoverageManifest;
  /** These values are retained as test evidence only; they are not authenticated identities. */
  readonly reviews: ReviewAttestation[];
}

export interface StoredRulePackLedgerEvent {
  readonly eventId: string;
  readonly packId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly action: 'test_release' | 'test_withdrawal' | 'test_rollback';
  readonly releaseHash: string;
  readonly targetEventId: string | null;
  readonly pack: RulePack;
  readonly actorId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
}

export interface CurrentTestRulePack {
  readonly eventId: string;
  readonly action: StoredRulePackLedgerEvent['action'];
  readonly pack: RulePack;
  readonly active: boolean;
}

const PACK_OR_ACTOR_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const LEDGER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const EVENT_COLUMNS = `id, pack_id, request_id, sequence, action, release_hash, target_event_id,
  pack_snapshot, actor_id, reason, occurred_at`;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'RulePackReleaseLedgerError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const secondPrecision = value.replace(/(?:\.\d+)?Z$/, 'Z');
  const timestamp = Date.parse(secondPrecision);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace('.000Z', 'Z') === secondPrecision;
}

function validateActor(input: RulePackLedgerActor): void {
  if (!PACK_OR_ACTOR_ID.test(input.actorId) || !LEDGER_KEY.test(input.requestId) || !validUtc(input.occurredAt) ||
    typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 2000) {
    throw fail('INVALID_RULE_PACK_LEDGER_CONTEXT');
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_RULE_PACK_LEDGER_ROW'); }
}

function isoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_RULE_PACK_LEDGER_ROW');
  return date.toISOString();
}

function mapEvent(row: Record<string, unknown>, replayed = false): StoredRulePackLedgerEvent {
  const snapshot = parseJson(row.pack_snapshot);
  const checked = validateRulePack(snapshot);
  if (!checked.ok || typeof row.id !== 'string' || typeof row.pack_id !== 'string' || checked.value.pack_id !== row.pack_id ||
    typeof row.request_id !== 'string' || !Number.isSafeInteger(Number(row.sequence)) ||
    !['test_release', 'test_withdrawal', 'test_rollback'].includes(String(row.action)) ||
    typeof row.release_hash !== 'string' || !HASH.test(row.release_hash) ||
    !(row.target_event_id === null || typeof row.target_event_id === 'string') ||
    typeof row.actor_id !== 'string' || typeof row.reason !== 'string') throw fail('INVALID_RULE_PACK_LEDGER_ROW');
  const pack = checked.value;
  if (pack.release?.channel !== 'test' || pack.release.content_hash !== row.release_hash ||
    rulePackContentHash(pack) !== row.release_hash ||
    (row.action === 'test_withdrawal' ? pack.status !== 'withdrawn' : pack.status !== 'published') ||
    ((row.action === 'test_rollback') !== (row.target_event_id !== null))) throw fail('INVALID_RULE_PACK_LEDGER_ROW');
  return {
    eventId: row.id,
    packId: row.pack_id,
    requestId: row.request_id,
    sequence: Number(row.sequence),
    action: row.action as StoredRulePackLedgerEvent['action'],
    releaseHash: row.release_hash,
    targetEventId: row.target_event_id,
    pack,
    actorId: row.actor_id,
    reason: row.reason,
    occurredAt: isoTimestamp(row.occurred_at),
    replayed,
  };
}

async function lockPack(client: RulePackLedgerClient, packId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rule-pack-test-ledger:${packId}`]);
}

async function currentRow(client: RulePackLedgerClient, packId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query(
    `SELECT ${EVENT_COLUMNS} FROM bb_rule_pack_release_events WHERE pack_id = $1 ORDER BY sequence DESC LIMIT 1`, [packId],
  );
  return result.rows[0] ?? null;
}

async function replayOrConflict(
  client: RulePackLedgerClient,
  packId: string,
  requestId: string,
  requestHash: string,
): Promise<StoredRulePackLedgerEvent | null> {
  const prior = await client.query(
    `SELECT ${EVENT_COLUMNS}, request_hash FROM bb_rule_pack_release_events WHERE pack_id = $1 AND request_id = $2`,
    [packId, requestId],
  );
  if (!prior.rows.length) return null;
  if (prior.rows[0]!.request_hash !== requestHash) throw fail('RULE_PACK_LEDGER_IDEMPOTENCY_MISMATCH');
  return mapEvent(prior.rows[0]!, true);
}

async function insertEvent(
  dependencies: RulePackLedgerDependencies,
  client: RulePackLedgerClient,
  input: { pack: RulePack; requestId: string; requestHash: string; action: StoredRulePackLedgerEvent['action'];
    actorId: string; occurredAt: string; reason: string; targetEventId: string | null; sequence: number },
): Promise<StoredRulePackLedgerEvent> {
  const releaseHash = input.pack.release?.content_hash;
  if (!releaseHash || input.pack.release?.channel !== 'test' || !HASH.test(releaseHash) || rulePackContentHash(input.pack) !== releaseHash) {
    throw fail('RULE_PACK_TEST_RELEASE_HASH_INVALID');
  }
  const eventId = dependencies.newId?.() ?? randomUUID();
  const stored = await client.query(
    `INSERT INTO bb_rule_pack_release_events
      (id, pack_id, request_id, request_hash, sequence, action, release_hash, target_event_id,
       pack_snapshot, actor_id, reason, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     RETURNING ${EVENT_COLUMNS}`,
    [eventId, input.pack.pack_id, input.requestId, input.requestHash, input.sequence, input.action, releaseHash,
      input.targetEventId, JSON.stringify(input.pack), input.actorId, input.reason, input.occurredAt],
  );
  if (stored.rows.length !== 1) throw fail('RULE_PACK_LEDGER_NOT_STORED');
  await client.query(
    `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1,'system','rule_pack',$2,$3,$4::jsonb)`,
    [dependencies.newId?.() ?? randomUUID(), input.pack.pack_id, `rule_pack.${input.action}`, JSON.stringify({
      pack_id: input.pack.pack_id, version: input.pack.version, release_hash: releaseHash,
      action: input.action, target_event_id: input.targetEventId,
    })],
  );
  return mapEvent(stored.rows[0]!);
}

async function withTransaction<T>(pool: RulePackLedgerPool, work: (client: RulePackLedgerClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const value = await work(client);
    await client.query('COMMIT');
    open = false;
    return value;
  } catch (error) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Persists a validated test-channel release only. Reviewer IDs and sample
 * classifications are stored as test evidence, never treated as authenticated
 * professional attestation or selectable production capability.
 */
export async function appendTestRulePackRelease(
  dependencies: RulePackLedgerDependencies,
  input: RulePackTestReleaseInput,
): Promise<StoredRulePackLedgerEvent> {
  validateActor(input);
  let published: RulePack;
  try {
    published = publishRulePackBundle(input.draft, input.template, input.coverage, {
      channel: 'test', reviews: input.reviews, released_by: input.actorId, released_at: input.occurredAt, reason: input.reason,
    });
  } catch (error) {
    throw error;
  }
  const requestHash = sha256(canonical({ action: 'test_release', pack: published, actor_id: input.actorId,
    request_id: input.requestId, occurred_at: input.occurredAt, reason: input.reason }));
  return withTransaction(dependencies.pool, async (client) => {
    await lockPack(client, published.pack_id);
    const replay = await replayOrConflict(client, published.pack_id, input.requestId, requestHash);
    if (replay) return replay;
    const previousRow = await currentRow(client, published.pack_id);
    let sequence = 1;
    if (previousRow) {
      const previous = mapEvent(previousRow);
      if (input.draft.supersedes_version !== previous.pack.version) throw fail('RULE_PACK_SUPERSEDES_VERSION_MISMATCH');
      sequence = previous.sequence + 1;
    } else if (input.draft.supersedes_version !== null) throw fail('RULE_PACK_SUPERSEDES_VERSION_MISMATCH');
    return insertEvent(dependencies, client, { pack: published, requestId: input.requestId, requestHash,
      action: 'test_release', actorId: input.actorId, occurredAt: input.occurredAt, reason: input.reason,
      targetEventId: null, sequence });
  });
}

export async function appendTestRulePackWithdrawal(
  dependencies: RulePackLedgerDependencies,
  packId: string,
  input: RulePackLedgerActor,
): Promise<StoredRulePackLedgerEvent> {
  validateActor(input);
  if (!PACK_OR_ACTOR_ID.test(packId)) throw fail('INVALID_RULE_PACK_ID');
  const requestHash = sha256(canonical({ action: 'test_withdrawal', pack_id: packId, ...input }));
  return withTransaction(dependencies.pool, async (client) => {
    await lockPack(client, packId);
    const replay = await replayOrConflict(client, packId, input.requestId, requestHash);
    if (replay) return replay;
    const priorRow = await currentRow(client, packId);
    if (!priorRow) throw fail('RULE_PACK_TEST_RELEASE_NOT_FOUND');
    const prior = mapEvent(priorRow);
    if (prior.pack.status !== 'published') throw fail('RULE_PACK_TEST_RELEASE_NOT_ACTIVE');
    const withdrawn = withdrawRulePack(prior.pack, {
      withdrawn_by: input.actorId, withdrawn_at: input.occurredAt, reason: input.reason,
    });
    return insertEvent(dependencies, client, { pack: withdrawn, requestId: input.requestId,
      requestHash, action: 'test_withdrawal', actorId: input.actorId, occurredAt: input.occurredAt,
      reason: input.reason, targetEventId: null, sequence: prior.sequence + 1 });
  });
}

function revalidateTestRollbackTarget(pack: RulePack, current: RulePack, occurredAt: string): void {
  if (pack.status !== 'published' || pack.release?.channel !== 'test' || !pack.release.content_hash ||
    rulePackContentHash(pack) !== pack.release.content_hash || pack.pack_id !== current.pack_id ||
    pack.version === current.version || pack.release.content_hash === current.release?.content_hash ||
    pack.release.released_at >= (current.release?.released_at ?? '')) throw fail('RULE_PACK_ROLLBACK_TARGET_INVALID');
  const asOf = occurredAt.slice(0, 10);
  if (asOf < pack.validity.effective_from || (pack.validity.effective_to && asOf > pack.validity.effective_to)) {
    throw fail('RULE_PACK_ROLLBACK_TARGET_NOT_EFFECTIVE');
  }
  const sources = new Map(pack.sources.map((source) => [source.source_id, source]));
  const inactive = pack.rules.some((rule) => rule.enabled && rule.source_ref_ids.some((id) => {
    const source = sources.get(id);
    return !source || (source.effective_from !== null && asOf < source.effective_from) ||
      (source.effective_to !== null && asOf > source.effective_to);
  }));
  if (inactive) throw fail('RULE_PACK_ROLLBACK_TARGET_SOURCE_NOT_EFFECTIVE');
}

/** Restores an immutable historical test release after rechecking pack and source dates. */
export async function appendTestRulePackRollback(
  dependencies: RulePackLedgerDependencies,
  packId: string,
  targetEventId: string,
  input: RulePackLedgerActor,
): Promise<StoredRulePackLedgerEvent> {
  validateActor(input);
  if (!PACK_OR_ACTOR_ID.test(packId) || !LEDGER_KEY.test(targetEventId)) throw fail('INVALID_RULE_PACK_ROLLBACK_TARGET');
  const requestHash = sha256(canonical({ action: 'test_rollback', pack_id: packId, target_event_id: targetEventId, ...input }));
  return withTransaction(dependencies.pool, async (client) => {
    await lockPack(client, packId);
    const replay = await replayOrConflict(client, packId, input.requestId, requestHash);
    if (replay) return replay;
    const currentRaw = await currentRow(client, packId);
    if (!currentRaw) throw fail('RULE_PACK_TEST_RELEASE_NOT_FOUND');
    const current = mapEvent(currentRaw);
    if (current.pack.status !== 'published') throw fail('RULE_PACK_TEST_RELEASE_NOT_ACTIVE');
    const targetRaw = await client.query(
      `SELECT ${EVENT_COLUMNS} FROM bb_rule_pack_release_events WHERE pack_id = $1 AND id = $2`, [packId, targetEventId],
    );
    if (!targetRaw.rows.length) throw fail('RULE_PACK_ROLLBACK_TARGET_NOT_FOUND');
    const target = mapEvent(targetRaw.rows[0]!);
    if (!['test_release', 'test_rollback'].includes(target.action)) throw fail('RULE_PACK_ROLLBACK_TARGET_INVALID');
    revalidateTestRollbackTarget(target.pack, current.pack, input.occurredAt);
    const requestId = input.requestId;
    return insertEvent(dependencies, client, { pack: target.pack, requestId, requestHash, action: 'test_rollback',
      actorId: input.actorId, occurredAt: input.occurredAt, reason: input.reason, targetEventId,
      sequence: current.sequence + 1 });
  });
}

export async function getCurrentTestRulePack(
  pool: RulePackLedgerPool,
  packId: string,
): Promise<CurrentTestRulePack | null> {
  if (!PACK_OR_ACTOR_ID.test(packId)) throw fail('INVALID_RULE_PACK_ID');
  const result = await pool.query(
    `SELECT ${EVENT_COLUMNS} FROM bb_rule_pack_release_events WHERE pack_id = $1 ORDER BY sequence DESC LIMIT 1`, [packId],
  );
  if (!result.rows.length) return null;
  const event = mapEvent(result.rows[0]!);
  return { eventId: event.eventId, action: event.action, pack: event.pack, active: event.pack.status === 'published' };
}
