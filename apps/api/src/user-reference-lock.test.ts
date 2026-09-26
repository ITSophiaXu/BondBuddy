import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { inputManifestHash } from './production-rule-pin.js';
import { resolveUserReferencePin } from './user-reference-lock.js';

const sha = 'a'.repeat(64);
const scope = { owner:'synthetic-owner',projectId:'synthetic-project',revision:1,market:'sse',offering:'private' };
const choice = { material_id:'synthetic-reference',material_version:1,material_sha256:sha,
  parse_snapshot_id:'synthetic-snapshot',target_product:'synthetic-bond',target_document_stage:'registration' };
const materials = [{ material_id:choice.material_id,material_version:1,role:'reference',sha256:sha }];
const outline = [{ order:1,heading:'发行概况' }];
const media_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const warning = (code:string) => ({ code,message:'synthetic warning' });

function fixture(options: { context?: boolean; status?: 'parsed'|'needs_confirmation'; warnings?: string[];
  coverage?: string; confirmed?: string[]; signedHash?: string | null; reviewResponseHash?: string;
  evidenceCount?: number; uncertainCount?: number } = {}): PoolClient {
  const codes = options.warnings ?? [];
  const target = { id:'synthetic-target',target_market:'sse',target_offering:'private',
    target_product:choice.target_product,target_document_stage:choice.target_document_stage,
    content_hash:inputManifestHash({ market:'sse',offering:'private',product:choice.target_product,
      document_stage:choice.target_document_stage }),status:'accepted',revoked_at:null };
  const snapshot = { id:choice.parse_snapshot_id,content_sha256:sha,response_sha256:sha,
    response_status:options.status ?? 'parsed',
    response_schema_version:'document-parse-response-v1',record_count:1,
    response_meta:{ document:{ coverage:options.coverage ?? 'complete' },warnings:codes.map(warning),
      material:{ media_type } } };
  const review = { id:'synthetic-review',revoked_at:null,material_sha256:sha,
    target_market:'sse',target_offering:'private',target_product:choice.target_product,
    target_document_stage:choice.target_document_stage,status:'accepted',authorization_status:'accepted',
    readability_status:'accepted',applicability_status:'accepted',fact_isolation_check_version:'synthetic-v1',
    parse_response_sha256:options.reviewResponseHash ?? sha,
    signed_outline_sha256:options.signedHash === undefined ? inputManifestHash(outline) : options.signedHash,
    confirmed_warning_codes:options.confirmed ?? [],outline,reviewer_user_id:'synthetic-reviewer',
    reviewer_grant_id:'synthetic-grant' };
  return { query:async (sql:string) => {
    if (sql.includes('FROM bb_user_reference_target_contexts')) return { rows:options.context ? [target] : [] };
    if (sql.includes('FROM bb_parse_snapshots')) return { rows:[snapshot] };
    if (sql.includes('FROM bb_parse_evidence')) return { rows:[{
      evidence_count:options.evidenceCount ?? 1,uncertain_count:options.uncertainCount ?? 0}] };
    if (sql.includes('FROM bb_user_reference_reviews')) return { rows:[review] };
    throw new Error(`Unexpected query: ${sql}`);
  } } as unknown as PoolClient;
}

test('trusted project target is required; client product and stage are assertions', async () => {
  const pending = await resolveUserReferencePin(fixture(),scope,choice,materials);
  assert.equal(pending.pin.status,'needs_review');
  assert.equal(pending.pin.target_product,null);
  assert.equal(pending.pin.target_document_stage,null);
  await assert.rejects(resolveUserReferencePin(fixture({context:true}),scope,
    {...choice,target_product:'other-bond'},materials),/reviewed project target/);
  await assert.rejects(resolveUserReferencePin(fixture({context:true}),scope,
    {...choice,target_document_stage:'issuance'},materials),/reviewed project target/);
});

test('only exact reviewed DOCX warnings and signed headings permit acceptance', async () => {
  const safe = { context:true,status:'needs_confirmation' as const,
    warnings:['DOCX_DRAWINGS','DOCX_AUXILIARY_PARTS'],
    confirmed:['DOCX_AUXILIARY_PARTS','DOCX_DRAWINGS'] };
  assert.equal((await resolveUserReferencePin(fixture(safe),scope,choice,materials)).pin.status,'accepted');
  for (const options of [
    { ...safe,confirmed:['DOCX_DRAWINGS'] },
    { ...safe,warnings:['DOCX_DRAWINGS','DOCX_TEXT_BOXES'],confirmed:['DOCX_DRAWINGS','DOCX_TEXT_BOXES'] },
    { ...safe,coverage:'incomplete' },
    { ...safe,signedHash:null },
    { ...safe,reviewResponseHash:'b'.repeat(64) },
    { ...safe,evidenceCount:0 },
    { ...safe,uncertainCount:1 },
  ]) assert.equal((await resolveUserReferencePin(fixture(options),scope,choice,materials)).pin.status,'needs_review');
});
