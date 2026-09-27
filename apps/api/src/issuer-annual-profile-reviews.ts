import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { Problem, missing, conflict, transaction, uid } from './data.js';
import { schemas } from '@bondbuddy/contracts';
import { loadVerifiedIssuerIdentitySourceRecord } from './issuer-identity-source.js';

type Db = Pool | PoolClient;
type ReviewAction = 'approve' | 'request_more_evidence' | 'withdraw';
type ReviewInput = { request_id: string; action: ReviewAction; reason: string; reviewer_attestation: 'manual_source_evidence_review'; profile_version: number; profile_sha256: string;
  input_revision: number; input_hash: string; source_material_sha256: string; parse_snapshot_sha256: string };
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` :
  value !== null && typeof value === 'object' ? `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);

export function installIssuerAnnualProfileReviewRoutes(app: FastifyInstance, dependencies: {
  db: () => Pool; owner: (request: FastifyRequest) => Promise<string>;
}) {
  app.get('/api/v1/reviewer/projects/:project_id/issuer-business-profiles',
    { schema: { response: { 200: schemas.IssuerAnnualProfileReviewListResponse } } }, async request => {
      const reviewerUserId = await dependencies.owner(request), projectId = (request.params as Record<string,string>).project_id;
      return transaction(dependencies.db(), async client => {
        const grant = await client.query(`SELECT p.owner_user_id,g.id AS grant_id FROM bb_projects p
          JOIN bb_issuer_annual_profile_reviewer_grants g ON g.scope_owner_user_id=p.owner_user_id AND g.scope_project_id=p.id
          JOIN bb_users u ON u.id=g.user_id AND u.status='active'
          WHERE p.id=$1 AND p.deleted_at IS NULL AND g.user_id=$2 AND g.revoked_at IS NULL
          FOR SHARE OF p,g,u`, [projectId, reviewerUserId]);
        if (grant.rows.length !== 1) throw missing();
        const ownerUserId = String(grant.rows[0]!.owner_user_id);
        const result = await client.query(`SELECT p.id AS profile_id,p.profile_version,p.profile_sha256,p.input_revision,p.input_hash,
            p.source_material_id,p.source_material_version,p.source_material_sha256,p.parse_snapshot_id,p.parse_snapshot_sha256,
            p.annual_revenue_basis,p.annual_revenue_total,p.annual_revenue_total_evidence,p.third_place_tie_proof,p.profile,p.created_at,
            (SELECT jsonb_agg(jsonb_build_object('record_id',e.record_id,'record_sha256',btrim(e.record_sha256::text),
              'locator_type',e.locator_type,'locator',e.locator,'quote',e.literal_quote,'context',e.context) ORDER BY e.ordinal)
              FROM bb_parse_evidence e WHERE e.owner_user_id=p.owner_user_id AND e.project_id=p.project_id
                AND e.material_id=p.source_material_id AND e.material_version=p.source_material_version
                AND e.snapshot_id=p.parse_snapshot_id AND e.record_id IN (SELECT jsonb_array_elements_text(p.evidence_refs))
                AND btrim(e.record_sha256::text)=p.evidence_record_hashes->>e.record_id) AS source_evidence,
            COALESCE((SELECT rv.action FROM bb_issuer_annual_profile_reviews rv WHERE rv.owner_user_id=p.owner_user_id
              AND rv.project_id=p.project_id AND rv.profile_id=p.id ORDER BY rv.sequence_id DESC LIMIT 1),'pending_review') AS latest_decision,
            i.manifest->'issuer_identity' AS identity_binding
          FROM bb_issuer_business_profiles p JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.project_id
            AND i.revision=p.input_revision AND i.input_hash=p.input_hash
          JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.project_id AND r.id=p.run_id
            AND r.input_revision=p.input_revision AND r.input_hash=p.input_hash
          JOIN bb_material_versions m ON m.owner_user_id=p.owner_user_id AND m.project_id=p.project_id
            AND m.id=p.source_material_id AND m.version=p.source_material_version AND m.sha256=p.source_material_sha256 AND m.deleted_at IS NULL
          JOIN bb_parse_snapshots s ON s.owner_user_id=p.owner_user_id AND s.project_id=p.project_id AND s.material_id=p.source_material_id
            AND s.material_version=p.source_material_version AND s.id=p.parse_snapshot_id AND s.response_sha256=p.parse_snapshot_sha256
            AND s.response_status='parsed'
          JOIN LATERAL (SELECT x.id,x.response_sha256 FROM bb_parse_snapshots x WHERE x.owner_user_id=p.owner_user_id
            AND x.project_id=p.project_id AND x.material_id=p.source_material_id AND x.material_version=p.source_material_version
            ORDER BY x.created_at DESC,x.id DESC LIMIT 1) latest_parse ON latest_parse.id=p.parse_snapshot_id
              AND latest_parse.response_sha256=p.parse_snapshot_sha256
          WHERE p.owner_user_id=$1 AND p.project_id=$2
            AND (SELECT count(*) FROM jsonb_each_text(p.evidence_record_hashes) h JOIN bb_parse_evidence e
              ON e.owner_user_id=p.owner_user_id AND e.project_id=p.project_id AND e.material_id=p.source_material_id
                AND e.material_version=p.source_material_version AND e.snapshot_id=p.parse_snapshot_id
                AND e.record_id=h.key AND btrim(e.record_sha256::text)=h.value)=(SELECT count(*) FROM jsonb_object_keys(p.evidence_record_hashes))
          ORDER BY p.created_at DESC LIMIT 50`, [ownerUserId, projectId]);
        await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
          VALUES($1,$2,'project',$3,'issuer.annual_profile.reviewer_read',$4::jsonb)`,
        [uid(), ownerUserId, projectId, JSON.stringify({ reviewer_user_id: reviewerUserId, reviewer_grant_id: grant.rows[0]!.grant_id,
          profiles: result.rows.map(row => ({ profile_id: row.profile_id, profile_version: row.profile_version,
            profile_sha256: String(row.profile_sha256).trim() })) })]);
        return { project_id: projectId, items: result.rows.map(row => {
          const binding = row.identity_binding as Record<string, unknown> | null;
          if (!binding || binding.status !== 'verified') throw missing();
          return { profile_id: String(row.profile_id), profile_version: Number(row.profile_version), profile_sha256: String(row.profile_sha256).trim(),
            input_revision: Number(row.input_revision), input_hash: String(row.input_hash).trim(), source_material_id: String(row.source_material_id),
            source_material_version: Number(row.source_material_version), source_material_sha256: String(row.source_material_sha256).trim(),
            parse_snapshot_id: String(row.parse_snapshot_id), parse_snapshot_sha256: String(row.parse_snapshot_sha256).trim(),
            issuer_identity_record_id: String(binding.record_id), issuer_identity_version: Number(binding.version),
            issuer_identity_hash: String(binding.content_hash).trim(), verified_entity_id: String(binding.entity_id),
            annual_revenue_basis: row.annual_revenue_basis, annual_revenue_total: String(row.annual_revenue_total), annual_revenue_total_evidence: row.annual_revenue_total_evidence,
            third_place_tie_proof: row.third_place_tie_proof, profile: row.profile, source_evidence: row.source_evidence ?? [],
            latest_decision: row.latest_decision, created_at: new Date(String(row.created_at)).toISOString() };
        }) };
      });
    });

  app.post('/api/v1/projects/:project_id/issuer-business-profiles/:profile_id/review',
    { schema: { body: schemas.IssuerAnnualProfileReviewRequest, response: { 201: schemas.IssuerAnnualProfileReviewResponse } } }, async (request, reply) => {
      const reviewerUserId = await dependencies.owner(request), params = request.params as Record<string,string>, input = request.body as ReviewInput;
      const result = await transaction(dependencies.db(), async client => {
        const allowed = await client.query(`SELECT p.owner_user_id,g.id AS grant_id FROM bb_projects p
          JOIN bb_issuer_annual_profile_reviewer_grants g ON g.scope_owner_user_id=p.owner_user_id AND g.scope_project_id=p.id
          JOIN bb_users u ON u.id=g.user_id AND u.status='active'
          WHERE p.id=$1 AND p.deleted_at IS NULL AND g.user_id=$2 AND g.revoked_at IS NULL
          FOR UPDATE OF p,g,u`, [params.project_id, reviewerUserId]);
        if (allowed.rows.length !== 1) throw missing();
        const ownerUserId = String(allowed.rows[0]!.owner_user_id), grantId = String(allowed.rows[0]!.grant_id);
        const found = await client.query(`SELECT p.*,i.manifest,i.material_versions,m.sha256 AS live_material_sha,m.role,m.deleted_at AS material_deleted,
            s.response_sha256 AS live_parse_sha,s.response_status AS parse_status,
            newest.id AS latest_parse_id,newest.response_sha256 AS latest_parse_sha,
            (SELECT jsonb_object_agg(e.record_id,e.record_sha256) FROM bb_parse_evidence e WHERE e.owner_user_id=p.owner_user_id
              AND e.project_id=p.project_id AND e.material_id=p.source_material_id AND e.material_version=p.source_material_version
              AND e.snapshot_id=p.parse_snapshot_id AND e.record_id IN (SELECT jsonb_array_elements_text(p.evidence_refs))) AS live_evidence_hashes
          FROM bb_issuer_business_profiles p JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.project_id
            AND i.revision=p.input_revision AND i.input_hash=p.input_hash
          JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.project_id AND r.id=p.run_id
            AND r.input_revision=p.input_revision AND r.input_hash=p.input_hash
          JOIN bb_material_versions m ON m.owner_user_id=p.owner_user_id AND m.project_id=p.project_id
            AND m.id=p.source_material_id AND m.version=p.source_material_version
          JOIN bb_parse_snapshots s ON s.owner_user_id=p.owner_user_id AND s.project_id=p.project_id AND s.material_id=p.source_material_id
            AND s.material_version=p.source_material_version AND s.id=p.parse_snapshot_id
          JOIN LATERAL (SELECT x.id,x.response_sha256 FROM bb_parse_snapshots x WHERE x.owner_user_id=p.owner_user_id
            AND x.project_id=p.project_id AND x.material_id=p.source_material_id AND x.material_version=p.source_material_version
            ORDER BY x.created_at DESC,x.id DESC LIMIT 1) newest ON true
          WHERE p.owner_user_id=$1 AND p.project_id=$2 AND p.id=$3 FOR SHARE OF p,i,r,m,s`, [ownerUserId,params.project_id,params.profile_id]);
        const profile = found.rows[0];
        if (!profile || profile.material_deleted || profile.role === 'reference' || input.profile_version !== Number(profile.profile_version) ||
            input.profile_sha256 !== String(profile.profile_sha256).trim() || input.input_revision !== Number(profile.input_revision) ||
            input.input_hash !== String(profile.input_hash).trim() || input.source_material_sha256 !== String(profile.source_material_sha256).trim() ||
            input.parse_snapshot_sha256 !== String(profile.parse_snapshot_sha256).trim() ||
            String(profile.live_material_sha).trim() !== String(profile.source_material_sha256).trim() ||
            String(profile.live_parse_sha).trim() !== String(profile.parse_snapshot_sha256).trim() || profile.parse_status !== 'parsed' ||
            String(profile.latest_parse_id) !== String(profile.parse_snapshot_id) ||
            String(profile.latest_parse_sha).trim() !== String(profile.parse_snapshot_sha256).trim())
          throw conflict('INPUT_REVISION_CONFLICT','Annual profile source or version changed');
        const binding = (profile.manifest as Record<string,unknown> | null)?.issuer_identity as Record<string,unknown> | undefined;
        if (!binding || binding.status !== 'verified' || binding.entity_id !== (profile.profile as Record<string,unknown>).issuerId)
          throw conflict('INPUT_REVISION_CONFLICT','Verified issuer identity binding changed');
        const inputMaterials = profile.material_versions as Array<Record<string,unknown>>;
        const manifestMaterials = (profile.manifest as Record<string,unknown>).materials as Array<Record<string,unknown>>;
        if (!Array.isArray(inputMaterials) || !inputMaterials.some(item => item.material_id === profile.source_material_id &&
            Number(item.material_version) === Number(profile.source_material_version)) || !Array.isArray(manifestMaterials) ||
            !manifestMaterials.some(item => item.material_id === profile.source_material_id && Number(item.material_version) === Number(profile.source_material_version) &&
              String(item.sha256).trim().toLowerCase() === String(profile.source_material_sha256).trim().toLowerCase()))
          throw conflict('INPUT_REVISION_CONFLICT','Annual profile source is outside the immutable input material set');
        const hashMap = profile.evidence_record_hashes as Record<string,string>;
        const liveHashes = profile.live_evidence_hashes as Record<string,string> | null;
        if (!liveHashes || Object.entries(hashMap).some(([id, hash]) => String(liveHashes[id] ?? '').trim() !== String(hash).trim()))
          throw conflict('INPUT_REVISION_CONFLICT','Annual profile evidence changed');
        const requestHash = createHash('sha256').update(canonical({ ownerUserId, projectId: params.project_id, profileId: params.profile_id,
          reviewerUserId, grantId, input })).digest('hex');
        const prior = await client.query(`SELECT id,action,request_hash,created_at FROM bb_issuer_annual_profile_reviews
          WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`, [ownerUserId,params.project_id,input.request_id]);
        if (prior.rows[0]) {
          if (String(prior.rows[0].request_hash).trim() !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT','Review request ID is already bound');
          return { review_id: String(prior.rows[0].id), profile_id: params.profile_id, action: prior.rows[0].action,
            created_at: new Date(String(prior.rows[0].created_at)).toISOString(), replayed: true };
        }
        const latestDecision = await client.query(`SELECT action FROM bb_issuer_annual_profile_reviews
          WHERE owner_user_id=$1 AND project_id=$2 AND profile_id=$3 ORDER BY sequence_id DESC LIMIT 1 FOR SHARE`,
          [ownerUserId, params.project_id, params.profile_id]);
        if (latestDecision.rows[0]?.action === 'withdraw')
          throw conflict('INPUT_REVISION_CONFLICT','Withdrawn annual profile cannot be reviewed again');
        let identity;
        try {
          identity = await loadVerifiedIssuerIdentitySourceRecord(client, { ownerUserId, projectId: params.project_id,
            materialId: String(binding.material_id), materialVersion: Number(binding.material_version) });
        } catch { throw conflict('INPUT_REVISION_CONFLICT','Verified issuer identity review is no longer current'); }
        if (!identity || identity.recordId !== binding.record_id || identity.version !== Number(binding.version) ||
            identity.contentHash !== String(binding.content_hash).trim() || identity.entityId !== binding.entity_id ||
            identity.sourceSnapshotId !== binding.source_snapshot_id || identity.sourceRecordId !== binding.source_record_id ||
            identity.sourceRecordSha256 !== String(binding.source_record_sha256).trim())
          throw conflict('INPUT_REVISION_CONFLICT','Verified issuer identity review is no longer current');
        const reviewId = randomUUID();
        await client.query(`INSERT INTO bb_issuer_annual_profile_reviews(id,request_id,request_hash,owner_user_id,project_id,run_id,
          profile_id,profile_version,profile_sha256,input_revision,input_hash,source_material_id,source_material_version,source_material_sha256,
          parse_snapshot_id,parse_snapshot_sha256,issuer_identity_record_id,issuer_identity_version,issuer_identity_hash,verified_entity_id,
          action,reason,reviewer_attestation,reviewer_user_id,reviewer_grant_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [reviewId,input.request_id,requestHash,ownerUserId,params.project_id,profile.run_id,params.profile_id,profile.profile_version,
          profile.profile_sha256,profile.input_revision,profile.input_hash,profile.source_material_id,profile.source_material_version,
          profile.source_material_sha256,profile.parse_snapshot_id,profile.parse_snapshot_sha256,binding.record_id,binding.version,
          binding.content_hash,binding.entity_id,input.action,input.reason.trim(),input.reviewer_attestation,reviewerUserId,grantId]);
        await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
          VALUES($1,$2,'project',$3,'issuer.annual_profile.reviewed',$4::jsonb)`,
        [uid(),ownerUserId,params.project_id,JSON.stringify({profile_id:params.profile_id,profile_version:profile.profile_version,
          profile_sha256:String(profile.profile_sha256).trim(),action:input.action,reviewer_user_id:reviewerUserId,reviewer_grant_id:grantId})]);
        return { review_id: reviewId, profile_id: params.profile_id, action: input.action, created_at: new Date().toISOString(), replayed: false };
      });
      reply.code(201); return result;
    });
}
