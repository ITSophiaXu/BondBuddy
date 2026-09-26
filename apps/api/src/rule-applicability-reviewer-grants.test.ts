import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  authorizeRuleApplicabilityReviewer,
  changeRuleApplicabilityReviewerGrant,
  isCurrentRuleApplicabilityReviewer,
  isTrustedRuleApplicabilityReviewer,
} from './rule-applicability-reviewer-grants.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase('RULE_APPLICABILITY_REVIEWER_GRANT_TEST_DATABASE_URL');
const schemaReady = async () => {
  if (!databaseUrl) return false;
  const pool = new Pool({ connectionString: databaseUrl });
  try { return (await pool.query("SELECT to_regclass('public.bb_rule_applicability_reviewer_grants') AS name")).rows[0]?.name != null; }
  finally { await pool.end(); }
};
const ready = await schemaReady();

test('rule applicability reviewer grants are exact-scope, independent, privileged, revocable and audited',
  { skip: !ready && 'set RULE_APPLICABILITY_REVIEWER_GRANT_TEST_DATABASE_URL to a disposable PostgreSQL 16 template migrated through 0051' }, async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
    const owner = `rulegrant-owner-${suffix}`;
    const foreignOwner = `rulegrant-foreign-${suffix}`;
    const reviewer = `rulegrant-reviewer-${suffix}`;
    const legacyReviewer = `rulegrant-legacy-${suffix}`;
    const actor = `rulegrant-actor-${suffix}`;
    const atomicReviewer = `rulegrant-atomic-${suffix}`;
    const deniedReviewer = `rulegrant-denied-${suffix}`;
    const projectA = `rulegrant-project-a-${suffix}`;
    const projectB = `rulegrant-project-b-${suffix}`;
    const foreignProject = `rulegrant-project-f-${suffix}`;
    const grantArgs = (who: string, project = projectA, scopeOwner = owner) => ({
      action: 'grant' as const, reviewerUserId: who, actorUserId: actor, reasonCode: 'authorized_scope',
      authorizationBasis: 'Synthetic authorization basis for PostgreSQL integration test.',
      scopeOwnerUserId: scopeOwner, scopeProjectId: project,
    });
    const createRoleName = `rulegrant_nonowner_${suffix}`;
    try {
      for (const [userId, tag] of [[owner, 'owner'], [foreignOwner, 'foreign'], [reviewer, 'reviewer'],
        [legacyReviewer, 'legacy'], [actor, 'actor'], [atomicReviewer, 'atomic'], [deniedReviewer, 'denied']] as const) {
        await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',
          [userId, `rulegrant${tag}${suffix}`]);
      }
      for (const [projectId, projectOwner] of [[projectA, owner], [projectB, owner], [foreignProject, foreignOwner]] as const) {
        await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering)
          VALUES($1,$2,'Synthetic grant scope','update','Synthetic issuer','sse','private')`, [projectId, projectOwner]);
      }

      await assert.rejects(changeRuleApplicabilityReviewerGrant(pool, grantArgs(owner)), /Invalid rule-applicability grant audit arguments/,
        'the project owner cannot be granted authority over their own project');
      await assert.rejects(pool.query(`INSERT INTO bb_rule_applicability_reviewer_grants
        (id,user_id,role,granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id)
        VALUES($1,$2,'rule_applicability_reviewer',$3,'self_grant','synthetic',$2,$4)`,
      [`rulegrant-self-${suffix}`, owner, actor, projectA]), /check constraint/i,
      'database constraints also reject owner-as-reviewer rows');

      // A legacy issuer-identity grant has a different role and table. It must not authorize this capability.
      await pool.query(`INSERT INTO bb_issuer_identity_reviewer_grants
        (id,user_id,role,granted_by,reason_code) VALUES($1,$2,'issuer_identity_reviewer',$3,'legacy_scope')`,
      [`rulegrant-old-issuer-${suffix}`, legacyReviewer, actor]);
      assert.equal(await authorizeRuleApplicabilityReviewer(pool, { userId: legacyReviewer },
        { ownerUserId: owner, projectId: projectA }), null);

      const grantId = await changeRuleApplicabilityReviewerGrant(pool, grantArgs(reviewer));
      const grantAudit = await pool.query(`SELECT granted_by,reason_code,authorization_basis,scope_owner_user_id,scope_project_id
        FROM bb_rule_applicability_reviewer_grants WHERE id=$1`, [grantId]);
      assert.deepEqual(grantAudit.rows[0], { granted_by: actor, reason_code: 'authorized_scope',
        authorization_basis: 'Synthetic authorization basis for PostgreSQL integration test.',
        scope_owner_user_id: owner, scope_project_id: projectA });
      const exact = await authorizeRuleApplicabilityReviewer(pool, { userId: reviewer }, { ownerUserId: owner, projectId: projectA });
      assert.ok(exact);
      assert.equal(isTrustedRuleApplicabilityReviewer(exact), true);
      assert.equal(exact.grantId, grantId);
      assert.equal(exact.ownerUserId, owner);
      assert.equal(exact.projectId, projectA);
      assert.equal(await isCurrentRuleApplicabilityReviewer(pool, exact, { ownerUserId: owner, projectId: projectA }), true);
      assert.equal(await isCurrentRuleApplicabilityReviewer(pool, exact, { ownerUserId: owner, projectId: projectB }), false,
        'a branded grant context remains bound to its exact project');
      assert.equal(await authorizeRuleApplicabilityReviewer(pool, { userId: reviewer },
        { ownerUserId: owner, projectId: projectB }), null, 'same owner but another project is outside the exact grant');
      assert.equal(await authorizeRuleApplicabilityReviewer(pool, { userId: reviewer },
        { ownerUserId: foreignOwner, projectId: foreignProject }), null, 'another owner/project is outside the grant');
      assert.equal(await authorizeRuleApplicabilityReviewer(pool, { userId: owner },
        { ownerUserId: owner, projectId: projectA }), null, 'the owner is never a reviewer for their own project');

      const scopedGrantId = await changeRuleApplicabilityReviewerGrant(pool, grantArgs(reviewer, projectB));
      const projectBReview = await authorizeRuleApplicabilityReviewer(pool, { userId: reviewer },
        { ownerUserId: owner, projectId: projectB });
      assert.equal(projectBReview?.grantId, scopedGrantId, 'an independently granted second project works without widening project A');
      assert.equal((await authorizeRuleApplicabilityReviewer(pool, { userId: reviewer },
        { ownerUserId: foreignOwner, projectId: foreignProject })), null);

      await changeRuleApplicabilityReviewerGrant(pool, { ...grantArgs(reviewer), action: 'revoke',
        reasonCode: 'scope_ended', authorizationBasis: 'Synthetic revocation authority.' });
      assert.equal(await authorizeRuleApplicabilityReviewer(pool, { userId: reviewer },
        { ownerUserId: owner, projectId: projectA }), null, 'revocation immediately removes current authorization');
      assert.equal(await isCurrentRuleApplicabilityReviewer(pool, exact, { ownerUserId: owner, projectId: projectA }), false,
        'a previously returned reviewer context is invalid after revocation');
      const retained = await pool.query(`SELECT revoked_at,revoked_by,revocation_reason_code,revocation_basis
        FROM bb_rule_applicability_reviewer_grants WHERE id=$1`, [grantId]);
      assert.equal(retained.rows.length, 1, 'revoked history is retained');
      assert.ok(retained.rows[0]!.revoked_at);
      assert.equal(retained.rows[0]!.revoked_by, actor);
      assert.equal(retained.rows[0]!.revocation_reason_code, 'scope_ended');
      await assert.rejects(pool.query('DELETE FROM bb_rule_applicability_reviewer_grants WHERE id=$1', [grantId]), /retained/i);
      await assert.rejects(pool.query(`UPDATE bb_rule_applicability_reviewer_grants
        SET revocation_basis='rewritten' WHERE id=$1`, [grantId]), /immutable/i);
      await assert.rejects(changeRuleApplicabilityReviewerGrant(pool, { ...grantArgs(reviewer), action: 'revoke',
        reasonCode: 'second_revoke', authorizationBasis: 'Second revocation attempt.' }), /not found/i);

      const events = await pool.query(`SELECT event_type,payload FROM bb_outbox WHERE aggregate_id=$1 ORDER BY event_type`, [grantId]);
      assert.deepEqual(events.rows.map(row => row.event_type).sort(), [
        'rule_applicability_reviewer.granted', 'rule_applicability_reviewer.revoked',
      ]);
      assert.ok(events.rows.every(row => row.payload.actor_user_id === actor && row.payload.scope_project_id === projectA));

      // The production compose currently uses the same bondbuddy DB login for migration and runtime;
      // simulate an actual non-owner role to assert that the database gate rejects an unauthorized actor.
      await pool.query(`CREATE ROLE "${createRoleName}" NOLOGIN`);
      await pool.query(`GRANT "${createRoleName}" TO CURRENT_USER`);
      const nonOwnerPool = {
        query: (sql: string, values?: unknown[]) => pool.query(sql, values).then(result => ({ rows: result.rows as Record<string, unknown>[] })),
        connect: async () => {
          const client = await pool.connect();
          await client.query(`SET ROLE "${createRoleName}"`);
          return {
            query: (sql: string, values?: unknown[]) => client.query(sql, values).then(result => ({ rows: result.rows as Record<string, unknown>[] })),
            release: async () => { try { await client.query('RESET ROLE'); } finally { client.release(); } },
          };
        },
      };
      await assert.rejects(changeRuleApplicabilityReviewerGrant(nonOwnerPool, grantArgs(deniedReviewer)),
        /Database table owner or superuser required/);
      assert.equal((await pool.query('SELECT 1 FROM bb_rule_applicability_reviewer_grants WHERE user_id=$1', [deniedReviewer])).rows.length, 0);
      await pool.query(`REVOKE "${createRoleName}" FROM CURRENT_USER`);
      await pool.query(`DROP ROLE "${createRoleName}"`);

      // If the matching outbox insert fails, the grant insert must roll back with it.
      await pool.query(`CREATE FUNCTION bb_test_reject_rule_app_grant_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event_type='rule_applicability_reviewer.granted' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$`);
      await pool.query(`CREATE TRIGGER bb_test_reject_rule_app_grant_outbox BEFORE INSERT ON bb_outbox
        FOR EACH ROW EXECUTE FUNCTION bb_test_reject_rule_app_grant_outbox()`);
      await assert.rejects(changeRuleApplicabilityReviewerGrant(pool, grantArgs(atomicReviewer)), /synthetic outbox failure/);
      assert.equal((await pool.query('SELECT 1 FROM bb_rule_applicability_reviewer_grants WHERE user_id=$1', [atomicReviewer])).rows.length, 0,
        'grant insert rolls back when audit outbox cannot be written');
      assert.equal((await pool.query("SELECT 1 FROM bb_outbox WHERE event_type='rule_applicability_reviewer.granted' AND payload->>'reviewer_user_id'=$1", [atomicReviewer])).rows.length, 0);
      await pool.query('DROP TRIGGER bb_test_reject_rule_app_grant_outbox ON bb_outbox');
      await pool.query('DROP FUNCTION bb_test_reject_rule_app_grant_outbox()');
    } finally { await pool.end(); }
  });
