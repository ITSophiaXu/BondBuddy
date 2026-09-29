import type { Pool, PoolClient } from 'pg';
import { listIssuerIdentitySourceRecords } from './issuer-identity-source.js';

export type TestIssuerCandidate = {
  status: 'pending_test_candidate';
  material_id: string; material_version: number; source_record_id: string; identity_version: number;
  content_sha256: string; snapshot_id: string; snapshot_sha256: string;
  source_content_sha256: string; candidate_key: string; issuer_display_name: string;
};

/** Only one exact parsed issuer observation may be used as an unreviewed test subject. */
export async function loadTestIssuerCandidate(db: Pool | PoolClient, scope: {
  ownerUserId: string; projectId: string; materialId: string; materialVersion: number;
}): Promise<TestIssuerCandidate | null> {
  const evidence = await listIssuerIdentitySourceRecords(db as Pool, scope);
  if (evidence.status !== 'needs_review' || evidence.items.length !== 1) return null;
  const item = evidence.items[0]!;
  if (item.status !== 'needs_review' || !item.candidate_key || !item.issuer_display_name ||
      item.source_content_sha256.length !== 64 || item.content_sha256.length !== 64) return null;
  // A revoked reviewer grant must never make a rejected/conflicted observation
  // look like a fresh pending candidate for this separate test path.
  const decisions=await db.query(`SELECT 1 FROM bb_issuer_identity_source_reviews WHERE owner_user_id=$1
    AND project_id=$2 AND material_id=$3 AND material_version=$4 AND source_record_id=$5 LIMIT 1`,
  [scope.ownerUserId,scope.projectId,scope.materialId,scope.materialVersion,item.source_record_id]);
  if(decisions.rowCount) return null;
  return { status: 'pending_test_candidate', material_id: scope.materialId, material_version: scope.materialVersion,
    source_record_id: item.source_record_id, identity_version: item.identity_version, content_sha256: item.content_sha256,
    snapshot_id: item.snapshot_id, snapshot_sha256: item.snapshot_sha256,
    source_content_sha256: item.source_content_sha256, candidate_key: item.candidate_key,
    issuer_display_name: item.issuer_display_name };
}

export function isTestIssuerCandidate(value: unknown): value is TestIssuerCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.status === 'pending_test_candidate' && typeof v.material_id === 'string' &&
    Number.isSafeInteger(v.material_version) && Number(v.material_version) > 0 &&
    Number.isSafeInteger(v.identity_version) && Number(v.identity_version) > 0 &&
    ['source_record_id','snapshot_id','candidate_key','issuer_display_name'].every(k => typeof v[k] === 'string' && !!v[k]) &&
    ['content_sha256','snapshot_sha256','source_content_sha256'].every(k => typeof v[k] === 'string' && /^[a-f0-9]{64}$/.test(v[k] as string));
}

export async function testIssuerCandidateMatches(db: Pool | PoolClient, scope: {
  ownerUserId: string; projectId: string;
}, candidate: TestIssuerCandidate): Promise<boolean> {
  const current = await loadTestIssuerCandidate(db, { ...scope,
    materialId: candidate.material_id, materialVersion: candidate.material_version });
  return current !== null && Object.keys(candidate).every(key =>
    candidate[key as keyof TestIssuerCandidate] === current[key as keyof TestIssuerCandidate]);
}
