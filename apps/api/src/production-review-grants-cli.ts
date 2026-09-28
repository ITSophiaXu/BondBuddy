import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { productionSnapshotHash } from '@bondbuddy/rule-pack-registry';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const markets = ['sse', 'szse', 'nafmii'] as const;
const offeringsByMarket = {
  sse: ['private', 'public', 'public_all'],
  szse: ['private', 'public', 'public_all'],
  nafmii: ['ppn', 'mtn', 'cp', 'scp', 'dfi'],
} as const;
const roles = ['rule_pack_operator', 'rule_pack_industry_reviewer', 'rule_pack_technical_reviewer'] as const;
const grantableStages = ['issuance', 'registration'] as const;
const usage = 'usage: production-review:grants grant <user_id> <grantor_user_id> <role> <market> <offering> <reason> <scope.json> | revoke <grant_id> <revoker_user_id> <reason>';

export type ProductionReviewDimension =
  | { readonly mode: 'reviewed_unrestricted'; readonly evidence_id: string; readonly evidence_version: number; readonly evidence_sha256: string }
  | { readonly mode: 'explicit_codes'; readonly codes: readonly string[]; readonly dictionary_version: string }
  | { readonly mode: 'needs_review'; readonly reason_code: string; readonly reason: string };

export type ProductionReviewGrantScope = {
  readonly instruments: readonly string[];
  readonly document_stages: readonly (typeof grantableStages[number])[];
  readonly issuer_scopes: ProductionReviewDimension;
  readonly investor_scopes: ProductionReviewDimension;
  readonly industry_codes: ProductionReviewDimension;
  readonly special_feature_scope: ProductionReviewDimension;
};

export type ProductionReviewGrantScopeFile = ProductionReviewGrantScope;

export type ProductionReviewGrantClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void | Promise<void>;
};
export type ProductionReviewGrantPool = {
  connect(): Promise<ProductionReviewGrantClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSortedUniqueCodes(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128 && item.trim() === item)
    && value.every((item, index) => index === 0 || value[index - 1]! < item)
    && !value.some((item) => ['all', '*'].includes(item.toLowerCase()));
}

function validDimension(value: unknown, maxItems: number): value is ProductionReviewDimension {
  if (!isRecord(value) || typeof value.mode !== 'string') return false;
  if (value.mode === 'reviewed_unrestricted') {
    return exactKeys(value, ['mode', 'evidence_id', 'evidence_version', 'evidence_sha256'])
      && typeof value.evidence_id === 'string' && idPattern.test(value.evidence_id)
      && Number.isSafeInteger(value.evidence_version) && Number(value.evidence_version) > 0
      && Number(value.evidence_version) <= 2147483647
      && typeof value.evidence_sha256 === 'string' && hashPattern.test(value.evidence_sha256);
  }
  if (value.mode === 'explicit_codes') {
    return exactKeys(value, ['mode', 'codes', 'dictionary_version'])
      && isSortedUniqueCodes(value.codes, maxItems)
      && typeof value.dictionary_version === 'string' && value.dictionary_version.length > 0
      && value.dictionary_version.length <= 128;
  }
  if (value.mode === 'needs_review') {
    return exactKeys(value, ['mode', 'reason_code', 'reason'])
      && typeof value.reason_code === 'string' && value.reason_code.length > 0 && value.reason_code.length <= 128
      && typeof value.reason === 'string' && value.reason.length > 0 && value.reason.length <= 2048;
  }
  return false;
}

/** Parse the additive grant-scope contract and require canonical set ordering. */
export function parseProductionReviewGrantScope(value: unknown): ProductionReviewGrantScope {
  const stages = isRecord(value) && Array.isArray(value.document_stages) ? value.document_stages : null;
  if (!isRecord(value) || !exactKeys(value, [
    'instruments', 'document_stages', 'issuer_scopes', 'investor_scopes', 'industry_codes', 'special_feature_scope',
  ]) || !isSortedUniqueCodes(value.instruments, 100)
    || !stages || stages.length === 0 || stages.length > 2
    || !stages.every((stage) => typeof stage === 'string' && grantableStages.includes(stage as typeof grantableStages[number]))
    || !stages.every((stage, index) => index === 0 || String(stages[index - 1]) < String(stage))
    || !validDimension(value.issuer_scopes, 100) || !validDimension(value.investor_scopes, 100)
    || !validDimension(value.industry_codes, 1000) || !validDimension(value.special_feature_scope, 100)) {
    throw new Error('INVALID_PRODUCTION_REVIEW_GRANT_SCOPE');
  }
  return value as unknown as ProductionReviewGrantScope;
}

/** Creates a grant and its immutable exact scope at one transaction timestamp. */
export async function issueProductionReviewGrant(
  pool: ProductionReviewGrantPool,
  input: {
    readonly userId: string;
    readonly grantorUserId: string;
    readonly role: string;
    readonly market: string;
    readonly offering: string;
    readonly reason: string;
    readonly scope: ProductionReviewGrantScope;
  },
): Promise<{ readonly grant_id: string; readonly scope_hash: string }> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!idPattern.test(input.userId) || !idPattern.test(input.grantorUserId) || input.userId === input.grantorUserId
    || !roles.includes(input.role as typeof roles[number]) || !markets.includes(input.market as typeof markets[number])
    || !(offeringsByMarket[input.market as keyof typeof offeringsByMarket] as readonly string[] | undefined)?.includes(input.offering)
    || !reason || reason.length > 2048) throw new Error('INVALID_PRODUCTION_REVIEW_GRANT_ARGUMENTS');
  const scope = parseProductionReviewGrantScope(input.scope);
  // Market/offering are pinned by the 0036 grant row. The 0071 scope hash
  // covers only the six immutable fields in bb_rule_pack_production_grant_scopes.
  const scopeHash = productionSnapshotHash(scope);
  const client = await pool.connect();
  const grantId = randomUUID();
  try {
    await client.query('BEGIN');
    await requireGrantTableOwner(client);
    const users = await client.query(`SELECT id FROM bb_users
      WHERE id=ANY($1::text[]) AND status='active' ORDER BY id FOR SHARE`,
    [[input.grantorUserId, input.userId]]);
    if (users.rows.length !== 2) throw new Error('ACTIVE_GRANTOR_AND_GRANTEE_REQUIRED');
    // Keep PostgreSQL's microsecond precision. node-postgres maps timestamptz
    // to JS Date (millisecond precision), which would fail 0071's exact-time guard.
    const timing = await client.query('SELECT now()::text AS granted_at');
    const grantedAt = timing.rows[0]?.granted_at;
    if (typeof grantedAt !== 'string' || !grantedAt) throw new Error('DATABASE_TIME_UNAVAILABLE');
    await client.query(`INSERT INTO bb_rule_pack_production_reviewer_grants
      (id,user_id,role,market,offering,granted_by,reason_code,granted_at)
      VALUES($1,$2,$3,$4,$5,$6,'controlled_ops_cli',$7)`,
    [grantId, input.userId, input.role, input.market, input.offering, input.grantorUserId, grantedAt]);
    await client.query(`INSERT INTO bb_rule_pack_production_grant_scopes
      (grant_id,instruments,document_stages,issuer_scopes,investor_scopes,industry_codes,special_feature_scope,scope_hash,created_at)
      VALUES($1,$2::text[],$3::text[],$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
    [grantId, scope.instruments, scope.document_stages, JSON.stringify(scope.issuer_scopes),
      JSON.stringify(scope.investor_scopes), JSON.stringify(scope.industry_codes),
      JSON.stringify(scope.special_feature_scope), scopeHash, grantedAt]);
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'rule_pack_production_grant',$3,'rule_pack_grant_granted',$4::jsonb)`,
    [randomUUID(), input.grantorUserId, grantId, JSON.stringify({
      grant_id: grantId, user_id: input.userId, role: input.role, market: input.market,
      offering: input.offering, scope_hash: scopeHash, reason,
    })]);
    await client.query('COMMIT');
    return { grant_id: grantId, scope_hash: scopeHash };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.release(); }
}

/** Revoke atomically and retain affected manifest/release references for human follow-up. */
export async function revokeProductionReviewGrant(
  pool: ProductionReviewGrantPool,
  input: { readonly grantId: string; readonly actorUserId: string; readonly reason: string },
): Promise<{ readonly grant_id: string; readonly revoked: true; readonly manifest_refs: readonly object[]; readonly release_refs: readonly object[] }> {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!idPattern.test(input.grantId) || !idPattern.test(input.actorUserId) || !reason || reason.length > 2048) {
    throw new Error('INVALID_PRODUCTION_REVIEW_GRANT_ARGUMENTS');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireGrantTableOwner(client);
    const actor = await client.query("SELECT id FROM bb_users WHERE id=$1 AND status='active' FOR SHARE", [input.actorUserId]);
    if (actor.rows.length !== 1) throw new Error('ACTIVE_GRANT_REVOCATION_ACTOR_REQUIRED');
    const grantResult = await client.query(`SELECT g.id,g.user_id,g.role,g.market,g.offering,g.granted_by,
        s.scope_hash,g.revoked_at
      FROM bb_rule_pack_production_reviewer_grants g
      LEFT JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
      WHERE g.id=$1 FOR UPDATE OF g`, [input.grantId]);
    const grant = grantResult.rows[0];
    if (!grant || grant.revoked_at) throw new Error('ACTIVE_PRODUCTION_REVIEW_GRANT_NOT_FOUND');
    if (!grant.scope_hash) throw new Error('PRODUCTION_REVIEW_GRANT_SCOPE_REQUIRED');
    const manifestResult = await client.query(`SELECT DISTINCT m.manifest_id,m.manifest_version,m.content_sha256
      FROM bb_production_review_attestation_events a
      JOIN bb_production_review_manifests m
        ON m.manifest_id=a.manifest_id AND m.manifest_version=a.manifest_version AND m.content_sha256=a.content_sha256
      WHERE a.grant_id=$1 ORDER BY m.manifest_id,m.manifest_version`, [input.grantId]);
    const releaseResult = await client.query(`SELECT DISTINCT id AS event_id,pack_id,sequence,action
      FROM bb_rule_pack_production_release_events
      WHERE operator_grant_id=$1 OR industry_reviewer_grant_id=$1 OR technical_reviewer_grant_id=$1
      ORDER BY pack_id,sequence`, [input.grantId]);
    const manifestRefs = manifestResult.rows;
    const releaseRefs = releaseResult.rows;
    const revoked = await client.query(`UPDATE bb_rule_pack_production_reviewer_grants
      SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [input.grantId]);
    if (revoked.rows.length !== 1) throw new Error('ACTIVE_PRODUCTION_REVIEW_GRANT_NOT_FOUND');
    const payload = {
      grant_id: input.grantId,
      revoked_user_id: grant.user_id,
      role: grant.role,
      market: grant.market,
      offering: grant.offering,
      scope_hash: grant.scope_hash,
      reason,
      affected_manifests: manifestRefs,
      affected_releases: releaseRefs,
      automatic_release_withdrawal: false,
    };
    await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'rule_pack_production_grant',$3,'rule_pack_grant_revoked',$4::jsonb)`,
    [randomUUID(), input.actorUserId, input.grantId, JSON.stringify(payload)]);
    await client.query('COMMIT');
    return { grant_id: input.grantId, revoked: true, manifest_refs: manifestRefs, release_refs: releaseRefs };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.release(); }
}

async function requireGrantTableOwner(client: ProductionReviewGrantClient): Promise<void> {
  const result = await client.query(`SELECT 1 FROM pg_class c
    JOIN pg_roles table_owner ON table_owner.oid=c.relowner
    JOIN pg_roles actor ON actor.rolname=current_user
    WHERE c.oid='bb_rule_pack_production_reviewer_grants'::regclass
      AND (actor.rolsuper OR table_owner.rolname=current_user)`);
  if (!result.rows[0]) throw new Error('DATABASE_TABLE_OWNER_OR_SUPERUSER_REQUIRED');
}

async function parseScopeFile(path: string): Promise<ProductionReviewGrantScope> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { throw new Error('INVALID_PRODUCTION_REVIEW_GRANT_SCOPE_JSON'); }
  return parseProductionReviewGrantScope(value);
}

export async function runProductionReviewGrantCommand(
  pool: ProductionReviewGrantPool,
  args: string[],
  readScope: (path: string) => Promise<ProductionReviewGrantScope> = parseScopeFile,
): Promise<object> {
  const [command, ...rest] = args;
  if (command === 'grant' && rest.length === 7) {
    const [userId, grantorUserId, role, market, offering, reason, scopePath] = rest;
    const scope = await readScope(scopePath!);
    return issueProductionReviewGrant(pool, { userId: userId!, grantorUserId: grantorUserId!, role: role!,
      market: market!, offering: offering!, reason: reason!, scope });
  }
  if (command === 'revoke' && rest.length === 3) {
    const [grantId, actorUserId, reason] = rest;
    return revokeProductionReviewGrant(pool, { grantId: grantId!, actorUserId: actorUserId!, reason: reason! });
  }
  throw new Error(usage);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  runProductionReviewGrantCommand(pool, process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    const safeCodes = new Set([
      usage, 'INVALID_PRODUCTION_REVIEW_GRANT_SCOPE', 'INVALID_PRODUCTION_REVIEW_GRANT_SCOPE_JSON',
      'INVALID_PRODUCTION_REVIEW_GRANT_ARGUMENTS', 'ACTIVE_GRANTOR_AND_GRANTEE_REQUIRED',
      'ACTIVE_GRANT_REVOCATION_ACTOR_REQUIRED', 'ACTIVE_PRODUCTION_REVIEW_GRANT_NOT_FOUND',
      'PRODUCTION_REVIEW_GRANT_SCOPE_REQUIRED', 'DATABASE_TABLE_OWNER_OR_SUPERUSER_REQUIRED',
      'DATABASE_TIME_UNAVAILABLE',
    ]);
    const code = error instanceof Error && safeCodes.has(error.message) ? error.message : 'PRODUCTION_REVIEW_GRANT_OPERATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }).finally(() => pool.end());
}
