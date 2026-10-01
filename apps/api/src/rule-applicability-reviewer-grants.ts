import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reason = /^[a-z][a-z0-9_]{0,63}$/;

export interface RuleApplicabilityReviewerClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void | Promise<void>;
}

export interface RuleApplicabilityReviewerPool {
  connect(): Promise<RuleApplicabilityReviewerClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ChangeRuleApplicabilityReviewerGrantInput {
  readonly action: 'grant' | 'revoke';
  readonly reviewerUserId: string;
  readonly actorUserId: string;
  readonly reasonCode: string;
  readonly authorizationBasis: string;
  readonly scopeOwnerUserId: string;
  readonly scopeProjectId: string;
}

/** Direct database maintenance only. There is deliberately no grant/revoke HTTP route. */
export async function changeRuleApplicabilityReviewerGrant(
  pool: RuleApplicabilityReviewerPool,
  input: ChangeRuleApplicabilityReviewerGrantInput,
): Promise<string> {
  const basis = typeof input.authorizationBasis === 'string' ? input.authorizationBasis.trim() : '';
  if (!['grant', 'revoke'].includes(input.action) || !id.test(input.reviewerUserId) ||
      !id.test(input.actorUserId) || input.reviewerUserId === input.actorUserId ||
      !id.test(input.scopeOwnerUserId) || !id.test(input.scopeProjectId) ||
      input.reviewerUserId === input.scopeOwnerUserId || !reason.test(input.reasonCode) ||
      !basis || basis.length > 2048) throw new Error('Invalid rule-applicability grant audit arguments');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admin = await client.query(`SELECT 1 FROM pg_class c
      JOIN pg_roles table_owner ON table_owner.oid=c.relowner
      JOIN pg_roles actor ON actor.rolname=current_user
      WHERE c.oid='bb_rule_applicability_reviewer_grants'::regclass
        AND (actor.rolsuper OR table_owner.rolname=current_user)`);
    if (!admin.rows[0]) throw new Error('Database table owner or superuser required');

    const users = await client.query("SELECT id FROM bb_users WHERE id=ANY($1::text[]) AND status='active' ORDER BY id FOR SHARE",
      [[input.reviewerUserId, input.actorUserId]]);
    if (users.rows.length !== 2) throw new Error('Active reviewer and grant actor required');

    let grantId: string;
    let eventType: string;
    if (input.action === 'grant') {
      const project = await client.query(`SELECT 1 FROM bb_projects
        WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
      [input.scopeOwnerUserId, input.scopeProjectId]);
      if (project.rows.length !== 1) throw new Error('Active exact owner/project scope required');
      grantId = randomUUID();
      await client.query(`INSERT INTO bb_rule_applicability_reviewer_grants
        (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'rule_applicability_reviewer',$3,$4,$5,$6,$7)`,
      [grantId, input.reviewerUserId, input.actorUserId, input.reasonCode, basis,
        input.scopeOwnerUserId, input.scopeProjectId]);
      eventType = 'rule_applicability_reviewer.granted';
    } else {
      const updated = await client.query(`UPDATE bb_rule_applicability_reviewer_grants
        SET revoked_at=now(),revoked_by=$2,revocation_reason_code=$3,revocation_basis=$4
        WHERE user_id=$1 AND role='rule_applicability_reviewer' AND revoked_at IS NULL
          AND scope_owner_user_id=$5 AND scope_project_id=$6 RETURNING id`,
      [input.reviewerUserId, input.actorUserId, input.reasonCode, basis,
        input.scopeOwnerUserId, input.scopeProjectId]);
      if (updated.rows.length !== 1) throw new Error('Active exact rule-applicability reviewer grant not found');
      grantId = String(updated.rows[0]!.id);
      eventType = 'rule_applicability_reviewer.revoked';
    }

    await client.query(`INSERT INTO bb_outbox
      (id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES($1,$2,'rule_applicability_reviewer_grant',$3,$4,$5::jsonb)`,
    [randomUUID(), input.scopeOwnerUserId, grantId, eventType, JSON.stringify({
      grant_id: grantId,
      reviewer_user_id: input.reviewerUserId,
      actor_user_id: input.actorUserId,
      scope_owner_user_id: input.scopeOwnerUserId,
      scope_project_id: input.scopeProjectId,
      reason_code: input.reasonCode,
      authorization_basis: basis,
    })]);
    await client.query('COMMIT');
    return grantId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { await client.release(); }
}

const trustedRuleApplicabilityReviewerBrand: unique symbol = Symbol('TrustedRuleApplicabilityReviewer');
const trustedRuleApplicabilityReviewers = new WeakSet<object>();

/** This value must originate from the API's authenticated server session, never request JSON. */
export interface RuleApplicabilityReviewerPrincipal {
  readonly userId: string;
}

/** Exact scope is mandatory. A reviewer grant does not imply issuer-identity review authority. */
export interface RuleApplicabilityReviewerScope {
  readonly ownerUserId: string;
  readonly projectId: string;
}

export interface TrustedRuleApplicabilityReviewer {
  readonly userId: string;
  readonly grantId: string;
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly [trustedRuleApplicabilityReviewerBrand]: true;
}

export async function authorizeRuleApplicabilityReviewer(
  pool: Pick<RuleApplicabilityReviewerPool, 'query'>,
  principal: RuleApplicabilityReviewerPrincipal,
  scope: RuleApplicabilityReviewerScope,
): Promise<TrustedRuleApplicabilityReviewer | null> {
  if (!principal || !id.test(principal.userId) || !scope || !id.test(scope.ownerUserId) ||
      !id.test(scope.projectId) || principal.userId === scope.ownerUserId) return null;
  const result = await pool.query(`SELECT g.id FROM bb_rule_applicability_reviewer_grants g
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
    WHERE g.user_id=$1 AND g.role='rule_applicability_reviewer' AND g.revoked_at IS NULL
      AND g.scope_owner_user_id=$2 AND g.scope_project_id=$3
    FOR SHARE OF g,p,u`,
  [principal.userId, scope.ownerUserId, scope.projectId]);
  if (result.rows.length !== 1 || !id.test(String(result.rows[0]?.id))) return null;
  const context = Object.freeze({ userId: principal.userId, grantId: String(result.rows[0]!.id),
    ownerUserId: scope.ownerUserId, projectId: scope.projectId,
    [trustedRuleApplicabilityReviewerBrand]: true as const });
  trustedRuleApplicabilityReviewers.add(context);
  return context;
}

export function isTrustedRuleApplicabilityReviewer(value: unknown): value is TrustedRuleApplicabilityReviewer {
  return typeof value === 'object' && value !== null && trustedRuleApplicabilityReviewers.has(value);
}

/** Recheck a branded context at the point of every new review/selection; the brand is not durable authority. */
export async function isCurrentRuleApplicabilityReviewer(
  pool: Pick<RuleApplicabilityReviewerPool, 'query'>,
  reviewer: TrustedRuleApplicabilityReviewer,
  scope: RuleApplicabilityReviewerScope,
): Promise<boolean> {
  if (!isTrustedRuleApplicabilityReviewer(reviewer) || !scope ||
      reviewer.ownerUserId !== scope.ownerUserId || reviewer.projectId !== scope.projectId ||
      reviewer.userId === scope.ownerUserId) return false;
  const current = await pool.query(`SELECT 1 FROM bb_rule_applicability_reviewer_grants g
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
    WHERE g.id=$1 AND g.user_id=$2 AND g.role='rule_applicability_reviewer' AND g.revoked_at IS NULL
      AND g.scope_owner_user_id=$3 AND g.scope_project_id=$4 FOR SHARE OF g,p,u`,
  [reviewer.grantId, reviewer.userId, scope.ownerUserId, scope.projectId]);
  return current.rows.length === 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action, reviewerUserId, actorUserId, reasonCode, authorizationBasis, scopeOwnerUserId, scopeProjectId] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !['grant', 'revoke'].includes(action ?? '') || !reviewerUserId ||
      !actorUserId || !reasonCode || !authorizationBasis || !scopeOwnerUserId || !scopeProjectId)
    throw new Error('Usage: rule-applicability-reviewer-grants grant|revoke REVIEWER_USER_ID ACTOR_USER_ID REASON_CODE BASIS OWNER_USER_ID PROJECT_ID (DATABASE_URL required)');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    process.stdout.write(`${await changeRuleApplicabilityReviewerGrant(pool, { action: action as 'grant' | 'revoke',
      reviewerUserId, actorUserId, reasonCode, authorizationBasis, scopeOwnerUserId, scopeProjectId })}\n`);
  } finally { await pool.end(); }
}
