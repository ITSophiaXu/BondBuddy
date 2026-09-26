import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { schemas, type Recognition, type RecognitionPatchRequest } from '@bondbuddy/contracts';
import { applyHistoricalProfileCorrection, validateHistoricalRecognitionProfile } from '@bondbuddy/domain/historical-profile-correction';
import type { Pool, PoolClient } from 'pg';
import { readOcr, readOcrPage } from './ocr.js';
import { Problem, project, uid, type PrivateBlobs } from './data.js';

type Context = { owner: string; projectId: string; materialId: string; materialVersion: number; actorId: string; requestId: string };
export type HistoricalProfileCorrectionResult = {
  ownerUserId: string; projectId: string; materialId: string; materialVersion: number; profileVersion: number;
  requestId: string; writeKind: 'correction'; recognition: Recognition; actorId: string; correctionReason: string;
  correctionEvidenceRefs: string[]; createdAt: string; replayed: boolean;
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePatch = ajv.compile(schemas.RecognitionPatchRequest);
const validateRecognition = ajv.compile(schemas.RecognitionResponse);
const profileColumns = `owner_user_id, project_id, material_id, material_version, profile_version,
 request_id, request_hash, write_kind, recognition, actor_id, correction_reason, correction_evidence_refs, created_at`;

function fail(code: string): never {
  const error = new Error(code);
  error.name = 'HistoricalProfileCorrectionError';
  throw error;
}

export function historicalProfileCorrectionProblem(error: unknown): Problem | null {
  if (!(error instanceof Error) || error.name !== 'HistoricalProfileCorrectionError') return null;
  const code = error.message;
  if (['HISTORICAL_PROFILE_NOT_FOUND', 'HISTORICAL_MATERIAL_NOT_FOUND'].includes(code)) {
    return new Problem(404, 'NOT_FOUND', 'Source profile or material does not exist');
  }
  if (['HISTORICAL_PROFILE_VERSION_CONFLICT', 'HISTORICAL_OCR_PROFILE_SNAPSHOT_STALE', 'HISTORICAL_OCR_PROFILE_SNAPSHOT_MISMATCH',
    'HISTORICAL_PROFILE_IDEMPOTENCY_MISMATCH'].includes(code)) {
    return new Problem(409, code === 'HISTORICAL_PROFILE_IDEMPOTENCY_MISMATCH' ? 'IDEMPOTENCY_CONFLICT' : 'INPUT_REVISION_CONFLICT', 'Source profile changed');
  }
  if (code === 'HISTORICAL_OCR_PROFILE_PAGE_INTEGRITY_FAILED' || code === 'HISTORICAL_OCR_PROFILE_READER_REQUIRED') {
    return new Problem(503, 'DATA_UNAVAILABLE', 'Source profile evidence could not be verified');
  }
  if (['INVALID_RECOGNITION_PATCH_SCHEMA', 'INVALID_HISTORICAL_PROFILE_CORRECTION_REASON', 'INVALID_SOURCE_MARKET_OFFERING',
    'HISTORICAL_PROFILE_CORRECTION_EVIDENCE_NOT_FOUND', 'HISTORICAL_OCR_PROFILE_EVIDENCE_NOT_FOUND'].includes(code)) {
    return new Problem(422, 'VALIDATION_FAILED', 'Source profile correction or evidence is invalid');
  }
  return new Problem(503, 'DATA_UNAVAILABLE', 'Stored source profile or parser evidence is invalid');
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseNativeIdentity(value: unknown): { algorithmVersion: string; parserVersion: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(historical-native-recognition-v[12])\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(value);
  return match && match[2] !== 'unknown-parser' ? { algorithmVersion: match[1]!, parserVersion: match[2]! } : null;
}

function parseOcrIdentity(value: unknown): { snapshotId: string; resultSha256: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^historical-ocr-recognition-v[12]:([A-Za-z0-9][A-Za-z0-9._:-]{0,127}):([a-f0-9]{64})$/.exec(value);
  return match ? { snapshotId: match[1]!, resultSha256: match[2]! } : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { fail('INVALID_HISTORICAL_PROFILE_ROW'); }
}

function mapRecognition(row: Record<string, unknown>): Recognition {
  const value = parseJson(row.recognition);
  if (!validateRecognition(value)) fail('INVALID_HISTORICAL_PROFILE_ROW');
  try { validateHistoricalRecognitionProfile(value); }
  catch (error) { fail(error instanceof Error ? error.message : 'INVALID_HISTORICAL_PROFILE_ROW'); }
  return value as Recognition;
}

function mapStoredProfile(row: Record<string, unknown>, replayed: boolean): HistoricalProfileCorrectionResult {
  // Reuse the public response schema rather than trusting JSON read from the database.
  const refs = parseJson(row.correction_evidence_refs);
  if (typeof row.owner_user_id !== 'string' || typeof row.project_id !== 'string' ||
      typeof row.material_id !== 'string' || !Number.isSafeInteger(Number(row.material_version)) ||
      !Number.isSafeInteger(Number(row.profile_version)) || typeof row.request_id !== 'string' ||
      row.write_kind !== 'correction' || typeof row.actor_id !== 'string' || typeof row.correction_reason !== 'string' ||
      !Array.isArray(refs) || !refs.every(ref => typeof ref === 'string') ||
      !(row.created_at instanceof Date || typeof row.created_at === 'string')) fail('INVALID_HISTORICAL_PROFILE_ROW');
  const createdAt = (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString();
  return { ownerUserId: row.owner_user_id, projectId: row.project_id, materialId: row.material_id,
    materialVersion: Number(row.material_version), profileVersion: Number(row.profile_version), requestId: row.request_id,
    writeKind: 'correction', recognition: mapRecognition(row), actorId: row.actor_id, correctionReason: row.correction_reason,
    correctionEvidenceRefs: refs as string[], createdAt, replayed };
}

function requestHash(context: Context, patch: RecognitionPatchRequest): string {
  return createHash('sha256').update(canonical({ kind: 'correction', owner: context.owner,
    project: context.projectId, material: context.materialId, materialVersion: context.materialVersion,
    actorId: context.actorId, patch }), 'utf8').digest('hex');
}

async function verifyNativeEvidence(client: PoolClient, context: Context, parserVersion: string, refs: string[]): Promise<void> {
  if (!refs.length) return;
  const result = await client.query(
    `SELECT DISTINCT e.record_id FROM bb_parse_evidence e
       JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
        AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
      WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
        AND s.parser_version=$5 AND e.extractor_version=$5 AND e.record_id=ANY($6::text[])`,
    [context.owner, context.projectId, context.materialId, context.materialVersion, parserVersion, [...new Set(refs)]],
  );
  if (new Set(result.rows.map(row => row.record_id)).size !== new Set(refs).size) {
    fail('HISTORICAL_PROFILE_CORRECTION_EVIDENCE_NOT_FOUND');
  }
}

async function verifyOcrEvidence(client: PoolClient, blobs: PrivateBlobs, context: Context,
  identity: { snapshotId: string; resultSha256: string }, refs: string[]): Promise<void> {
  let review;
  try { review = await readOcr(client as unknown as Pool, blobs, context.owner, context.projectId, context.materialId); }
  catch (error) {
    if (error instanceof Problem && error.status === 404) fail('HISTORICAL_OCR_PROFILE_SNAPSHOT_STALE');
    throw error;
  }
  if (review.snapshot_id !== identity.snapshotId || review.result_sha256 !== identity.resultSha256 ||
      review.material_version !== context.materialVersion || review.eligible_for_manuscript !== false) {
    fail('HISTORICAL_OCR_PROFILE_SNAPSHOT_STALE');
  }
  if (!refs.length) return;
  const selected = review.records.filter(record => refs.includes(record.record_id));
  if (selected.length !== new Set(refs).size) fail('HISTORICAL_OCR_PROFILE_EVIDENCE_NOT_FOUND');
  try {
    for (const page of [...new Set(selected.map(record => record.page))]) {
      await readOcrPage(client as unknown as Pool, blobs, context.owner, context.projectId,
        context.materialId, review.snapshot_id, String(page));
    }
  } catch { fail('HISTORICAL_OCR_PROFILE_PAGE_INTEGRITY_FAILED'); }
}

/** Appends an immutable, owner-scoped user assertion inside the caller's transaction. */
export async function correctHistoricalProfile(
  client: PoolClient,
  blobs: PrivateBlobs | null,
  context: Context,
  patchInput: unknown,
): Promise<HistoricalProfileCorrectionResult> {
  if (![context.owner, context.projectId, context.materialId, context.actorId, context.requestId].every(safeIdentifier)) {
    fail('INVALID_HISTORICAL_PROFILE_CONTEXT');
  }
  if (!validatePatch(patchInput)) fail('INVALID_RECOGNITION_PATCH_SCHEMA');
  const patch = patchInput as RecognitionPatchRequest;
  const hash = requestHash(context, patch);

  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `historical-profile:${context.owner}:${context.projectId}:${context.materialId}:${context.materialVersion}`,
  ]);
  try { await project(client, context.owner, context.projectId, true); }
  catch (error) {
    if (error instanceof Problem && error.status === 404) fail('HISTORICAL_PROFILE_NOT_FOUND');
    throw error;
  }
  const material = await client.query(
    `SELECT id FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4
      AND role='historical' AND media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
      AND deleted_at IS NULL FOR UPDATE`,
    [context.owner, context.projectId, context.materialId, context.materialVersion],
  );
  if (!material.rows[0]) fail('HISTORICAL_MATERIAL_NOT_FOUND');

  const priorRequest = await client.query(
    `SELECT ${profileColumns} FROM bb_historical_profiles WHERE owner_user_id=$1 AND project_id=$2
      AND material_id=$3 AND material_version=$4 AND request_id=$5`,
    [context.owner, context.projectId, context.materialId, context.materialVersion, context.requestId],
  );
  if (priorRequest.rows[0]) {
    if (String(priorRequest.rows[0].request_hash).trim() !== hash) fail('HISTORICAL_PROFILE_IDEMPOTENCY_MISMATCH');
    return mapStoredProfile(priorRequest.rows[0], true);
  }

  const latestResult = await client.query(
    `SELECT ${profileColumns} FROM bb_historical_profiles WHERE owner_user_id=$1 AND project_id=$2
      AND material_id=$3 AND material_version=$4 ORDER BY profile_version DESC LIMIT 1 FOR UPDATE`,
    [context.owner, context.projectId, context.materialId, context.materialVersion],
  );
  if (!latestResult.rows[0]) fail('HISTORICAL_PROFILE_NOT_FOUND');
  const latest = latestResult.rows[0] as Record<string, unknown>;
  const latestVersion = Number(latest.profile_version);
  if (!Number.isSafeInteger(latestVersion) || latestVersion < 1) fail('INVALID_HISTORICAL_PROFILE_ROW');
  const prior = mapRecognition(latest);
  const periodRefs = patch.reporting_periods?.flatMap(period => period.evidence_refs) ?? [];
  const refs = [...new Set([...patch.evidence_refs, ...periodRefs])];
  const versions = [prior.source_market, prior.source_offering, prior.latest_reporting_cutoff, ...prior.reporting_periods]
    .map(field => field.provenance.extractor_version);
  const ocrIdentity = parseOcrIdentity(versions[0]!);
  if (ocrIdentity) {
    if (versions.some(value => {
      const parsed = parseOcrIdentity(value);
      return parsed?.snapshotId !== ocrIdentity.snapshotId || parsed.resultSha256 !== ocrIdentity.resultSha256;
    })) fail('HISTORICAL_OCR_PROFILE_SNAPSHOT_MISMATCH');
    if (!blobs) fail('HISTORICAL_OCR_PROFILE_READER_REQUIRED');
    await verifyOcrEvidence(client, blobs, context, ocrIdentity, refs);
  } else {
    const identity = parseNativeIdentity(versions[0]!);
    if (!identity || versions.some(value => {
      const parsed = parseNativeIdentity(value);
      return parsed?.algorithmVersion !== identity.algorithmVersion || parsed.parserVersion !== identity.parserVersion;
    })) fail('HISTORICAL_PROFILE_PARSER_VERSION_UNRELIABLE');
    await verifyNativeEvidence(client, context, identity.parserVersion, refs);
  }
  if (patch.profile_version !== latestVersion) fail('HISTORICAL_PROFILE_VERSION_CONFLICT');

  let recognition: Recognition;
  try {
    recognition = applyHistoricalProfileCorrection(prior, patch, {
      materialId: context.materialId, materialVersion: context.materialVersion, profileVersion: latestVersion + 1,
    });
  } catch (error) { fail(error instanceof Error ? error.message : 'INVALID_RECOGNITION_PATCH_SCHEMA'); }
  const inserted = await client.query(
    `INSERT INTO bb_historical_profiles (owner_user_id,project_id,material_id,material_version,profile_version,
       request_id,request_hash,write_kind,recognition,actor_id,correction_reason,correction_evidence_refs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'correction',$8::jsonb,$9,$10,$11::jsonb) RETURNING ${profileColumns}`,
    [context.owner, context.projectId, context.materialId, context.materialVersion, latestVersion + 1,
      context.requestId, hash, JSON.stringify(recognition), context.actorId, patch.reason, JSON.stringify(refs)],
  );
  if (!inserted.rows[0]) fail('HISTORICAL_PROFILE_NOT_STORED');
  await client.query(
    `INSERT INTO bb_outbox (id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
     VALUES ($1,$2,'historical_profile',$3,'historical_profile.updated',$4::jsonb)`,
    [uid(), context.owner, context.materialId, JSON.stringify({ project_id: context.projectId,
      material_id: context.materialId, material_version: context.materialVersion,
      profile_version: latestVersion + 1, state: recognition.state })],
  );
  return mapStoredProfile(inserted.rows[0], false);
}
