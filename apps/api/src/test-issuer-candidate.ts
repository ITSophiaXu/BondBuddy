import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { listIssuerIdentitySourceRecords } from './issuer-identity-source.js';

export type TestIssuerCandidate = {
  status: 'pending_test_candidate';
  material_id: string; material_version: number; source_record_id: string; identity_version: number;
  content_sha256: string; snapshot_id: string; snapshot_sha256: string;
  source_content_sha256: string; candidate_key: string; issuer_display_name: string;
  /** Present for repeated anchors of one pending subject; every anchor is part of the immutable pin. */
  observations?: TestIssuerObservation[]; observations_sha256?: string;
};

type TestIssuerObservation = { source_record_id: string; identity_version: number; content_sha256: string;
  snapshot_id: string; snapshot_sha256: string; source_record_sha256: string;
  source_content_sha256: string; quote_sha256: string };
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const normalizedName=(name:string)=>name.normalize('NFKC').replace(/\s+/gu,' ').trim();
const observationHash=(items:TestIssuerObservation[])=>hash(JSON.stringify(items.map(item=>[
  item.source_record_id,item.identity_version,item.content_sha256,item.snapshot_id,item.snapshot_sha256,
  item.source_record_sha256,item.source_content_sha256,item.quote_sha256])));

/** Repeated source anchors may identify one pending subject; divergent observations never do. */
export async function loadTestIssuerCandidate(db: Pool | PoolClient, scope: {
  ownerUserId: string; projectId: string; materialId: string; materialVersion: number;
}): Promise<TestIssuerCandidate | null> {
  const evidence = await listIssuerIdentitySourceRecords(db as Pool, scope);
  if (evidence.status !== 'needs_review' || !evidence.items.length) return null;
  const items=[...evidence.items].sort((a,b)=>a.source_record_id.localeCompare(b.source_record_id));
  const item = items[0]!;
  const name=normalizedName(item.issuer_display_name);
  if (!item.candidate_key || !name || items.some(other=>other.status!=='needs_review' ||
      other.candidate_key!==item.candidate_key || normalizedName(other.issuer_display_name)!==name ||
      other.snapshot_id!==item.snapshot_id || other.snapshot_sha256!==item.snapshot_sha256 ||
      other.source_content_sha256!==item.source_content_sha256 ||
      hash(other.quote)!==hash(item.quote) ||
      !/^[a-f0-9]{64}$/.test(other.source_record_sha256) ||
      !/^[a-f0-9]{64}$/.test(other.content_sha256) ||
      !/^[a-f0-9]{64}$/.test(other.snapshot_sha256) ||
      !/^[a-f0-9]{64}$/.test(other.source_content_sha256))) return null;
  if(new Set(items.map(other=>other.source_record_id)).size!==items.length) return null;
  // A revoked reviewer grant must never make a rejected/conflicted observation
  // look like a fresh pending candidate for this separate test path.
  const decisions=await db.query(`SELECT 1 FROM bb_issuer_identity_source_reviews WHERE owner_user_id=$1
    AND project_id=$2 AND material_id=$3 AND material_version=$4 AND source_record_id=ANY($5::text[]) LIMIT 1`,
  [scope.ownerUserId,scope.projectId,scope.materialId,scope.materialVersion,items.map(other=>other.source_record_id)]);
  if(decisions.rowCount) return null;
  const observations:TestIssuerObservation[]=items.map(other=>({source_record_id:other.source_record_id,
    identity_version:other.identity_version,content_sha256:other.content_sha256,
    snapshot_id:other.snapshot_id,snapshot_sha256:other.snapshot_sha256,
    source_record_sha256:other.source_record_sha256,source_content_sha256:other.source_content_sha256,
    quote_sha256:hash(other.quote)}));
  return { status: 'pending_test_candidate', material_id: scope.materialId, material_version: scope.materialVersion,
    source_record_id: item.source_record_id, identity_version: item.identity_version, content_sha256: item.content_sha256,
    snapshot_id: item.snapshot_id, snapshot_sha256: item.snapshot_sha256,
    source_content_sha256: item.source_content_sha256, candidate_key: item.candidate_key,
    issuer_display_name: item.issuer_display_name,
    ...(items.length>1?{observations,observations_sha256:observationHash(observations)}:{}) };
}

export function isTestIssuerCandidate(value: unknown): value is TestIssuerCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.status === 'pending_test_candidate' && typeof v.material_id === 'string' &&
    Number.isSafeInteger(v.material_version) && Number(v.material_version) > 0 &&
    Number.isSafeInteger(v.identity_version) && Number(v.identity_version) > 0 &&
    ['source_record_id','snapshot_id','candidate_key','issuer_display_name'].every(k => typeof v[k] === 'string' && !!v[k]) &&
    ['content_sha256','snapshot_sha256','source_content_sha256'].every(k => typeof v[k] === 'string' && /^[a-f0-9]{64}$/.test(v[k] as string)) &&
    (v.observations===undefined && v.observations_sha256===undefined ||
      Array.isArray(v.observations) && v.observations.length>1 &&
      v.observations.every((observation:unknown)=>{
        if(!observation || typeof observation!=='object' || Array.isArray(observation))return false;
        const a=observation as Record<string,unknown>;
        return typeof a.source_record_id==='string' && !!a.source_record_id &&
          Number.isSafeInteger(a.identity_version) && Number(a.identity_version)>0 &&
          typeof a.snapshot_id==='string' && !!a.snapshot_id &&
          ['content_sha256','snapshot_sha256','source_record_sha256','source_content_sha256','quote_sha256']
            .every(key=>typeof a[key]==='string' && /^[a-f0-9]{64}$/.test(a[key] as string));
      }) && typeof v.observations_sha256==='string' &&
      v.observations_sha256===observationHash(v.observations));
}

export async function testIssuerCandidateMatches(db: Pool | PoolClient, scope: {
  ownerUserId: string; projectId: string;
}, candidate: TestIssuerCandidate): Promise<boolean> {
  const current = await loadTestIssuerCandidate(db, { ...scope,
    materialId: candidate.material_id, materialVersion: candidate.material_version });
  return current !== null && isDeepStrictEqual(candidate,current);
}
