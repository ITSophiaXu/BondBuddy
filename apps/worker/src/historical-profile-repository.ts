import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { isMarketOffering, schemas, type Market, type Offering, type Recognition, type RecognitionPatchRequest } from '@bondbuddy/contracts';
import { parseHistoricalNativeExtractorVersion } from './historical-native-recognition.js';

export interface HistoricalProfileClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface HistoricalProfilePool {
  connect(): Promise<HistoricalProfileClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface HistoricalProfileDependencies {
  pool: HistoricalProfilePool;
  newId?: () => string;
}

export interface TrustedHistoricalProfileContext {
  ownerUserId: string;
  projectId: string;
  materialId: string;
  materialVersion: number;
  requestId: string;
}

export interface TrustedHistoricalCorrectionContext extends TrustedHistoricalProfileContext {
  actorId: string;
}

export interface StoredHistoricalProfile {
  ownerUserId: string;
  projectId: string;
  materialId: string;
  materialVersion: number;
  profileVersion: number;
  requestId: string;
  writeKind: 'recognition' | 'correction';
  recognition: Recognition;
  actorId: string | null;
  correctionReason: string | null;
  correctionEvidenceRefs: string[];
  createdAt: string;
  replayed: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateRecognition = ajv.compile(schemas.RecognitionResponse);
const validatePatch = ajv.compile(schemas.RecognitionPatchRequest);

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'HistoricalProfileRepositoryError';
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_HISTORICAL_PROFILE_ROW'); }
}

function fieldReady(field: Recognition['source_market' | 'source_offering' | 'latest_reporting_cutoff']): boolean {
  return field.value !== null && field.status === 'recognized' &&
    field.uncertainty.length === 0 && field.provenance.evidence_refs.length > 0;
}

function validDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isReadySupported(recognition: Recognition): boolean {
  const periodsSupported = recognition.reporting_periods.length > 0 && recognition.reporting_periods.every(period =>
      validDate(period.start) && validDate(period.end) && period.start <= period.end &&
      period.period_kind !== null && period.scope !== null &&
      period.status === 'recognized' &&
      period.uncertainty.length === 0 && period.provenance.evidence_refs.length > 0);
  const latestSupportedEnd = periodsSupported
    ? recognition.reporting_periods.reduce((latest, period) => period.end! > latest ? period.end! : latest, '')
    : null;
  return fieldReady(recognition.source_market) && fieldReady(recognition.source_offering) &&
    fieldReady(recognition.latest_reporting_cutoff) && periodsSupported &&
    recognition.latest_reporting_cutoff.value === latestSupportedEnd;
}

function validateProfile(value: unknown): asserts value is Recognition {
  if (!validateRecognition(value)) throw fail('INVALID_RECOGNITION_SCHEMA');
  const recognition = value as Recognition;
  const provenance = [recognition.source_market.provenance, recognition.source_offering.provenance,
    recognition.latest_reporting_cutoff.provenance, ...recognition.reporting_periods.map(period => period.provenance)];
  if (provenance.some(source => source.material_id !== recognition.material_id ||
      source.material_version !== recognition.material_version)) {
    throw fail('HISTORICAL_PROFILE_EVIDENCE_MATERIAL_MISMATCH');
  }
  if (recognition.source_market.value !== null && recognition.source_offering.value !== null &&
      !isMarketOffering(recognition.source_market.value as Market, recognition.source_offering.value as Offering)) {
    throw fail('INVALID_SOURCE_MARKET_OFFERING');
  }
  if (recognition.state === 'ready' && !isReadySupported(recognition)) throw fail('UNSUPPORTED_READY_PROFILE');
}

function validateContext(context: TrustedHistoricalProfileContext): void {
  if (![context.ownerUserId, context.projectId, context.materialId, context.requestId].every(safeIdentifier) ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1) {
    throw fail('INVALID_HISTORICAL_PROFILE_CONTEXT');
  }
}

function parserVersionFromRecognition(recognition: Recognition): string {
  const versions = [recognition.source_market, recognition.source_offering, recognition.latest_reporting_cutoff]
    .map(field => field.provenance.extractor_version);
  const parsed = versions.map(parseHistoricalNativeExtractorVersion);
  if (parsed.some(version => version === null) || parsed.some(version =>
    version!.algorithmVersion !== parsed[0]!.algorithmVersion || version!.parserVersion !== parsed[0]!.parserVersion)) {
    throw fail('HISTORICAL_PROFILE_PARSER_VERSION_UNRELIABLE');
  }
  for (const period of recognition.reporting_periods) {
    const version = parseHistoricalNativeExtractorVersion(period.provenance.extractor_version);
    if (version === null || version.algorithmVersion !== parsed[0]!.algorithmVersion ||
        version.parserVersion !== parsed[0]!.parserVersion) {
      throw fail('HISTORICAL_PROFILE_PARSER_VERSION_UNRELIABLE');
    }
  }
  return parsed[0]!.parserVersion;
}

async function validateParseEvidenceReferences(
  client: HistoricalProfileClient,
  context: TrustedHistoricalProfileContext,
  recognition: Recognition,
  parserVersion: string,
): Promise<void> {
  const algorithm = parseHistoricalNativeExtractorVersion(recognition.source_market.provenance.extractor_version);
  if (algorithm === null || algorithm.parserVersion !== parserVersion) throw fail('HISTORICAL_PROFILE_PARSER_VERSION_UNRELIABLE');
  const nativePrefix = `${algorithm.algorithmVersion}/${parserVersion}`;
  const references = new Map<string, string | null>();
  const addRefs = (refs: readonly string[], extractorVersion: string | null) => {
    for (const ref of refs) {
      const previous = references.get(ref);
      if (previous !== undefined && previous !== null && extractorVersion !== null && previous !== extractorVersion) {
        throw fail('HISTORICAL_PROFILE_EVIDENCE_VERSION_MISMATCH');
      }
      references.set(ref, previous === undefined || previous === null ? extractorVersion : previous);
    }
  };
  for (const field of [recognition.source_market, recognition.source_offering, recognition.latest_reporting_cutoff]) {
    if (field.provenance.extractor_version !== nativePrefix) throw fail('HISTORICAL_PROFILE_PARSER_VERSION_UNRELIABLE');
    addRefs(field.provenance.evidence_refs, null);
  }
  for (const period of recognition.reporting_periods) {
    addRefs(period.provenance.evidence_refs, parserVersion);
  }
  const result = await client.query(
    `SELECT s.parser_version, s.response_status, s.record_count, e.record_id, e.extractor_version, e.extraction_method
       FROM bb_parse_snapshots s
       LEFT JOIN bb_parse_evidence e ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id
        AND e.material_id=s.material_id AND e.material_version=s.material_version AND e.snapshot_id=s.id
        AND e.record_id=ANY($6::text[])
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.material_id=$3 AND s.material_version=$4
        AND s.parser_version=$5`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, parserVersion, [...references.keys()]],
  );
  if (result.rows.length === 0 || result.rows.some(row => row.parser_version !== parserVersion)) {
    throw fail('HISTORICAL_PROFILE_PARSE_SNAPSHOT_NOT_FOUND');
  }
  const snapshotStatus = result.rows[0]!.response_status;
  const recordCount = Number(result.rows[0]!.record_count);
  if (recognition.state === 'failed') {
    if (snapshotStatus !== 'failed' || recordCount !== 0 || references.size !== 0 || result.rows.length !== 1) {
      throw fail('HISTORICAL_PROFILE_PARSE_SNAPSHOT_MISMATCH');
    }
    return;
  }
  if (snapshotStatus === 'failed' || (recognition.state === 'ready' && snapshotStatus !== 'parsed')) {
    throw fail('HISTORICAL_PROFILE_PARSE_SNAPSHOT_MISMATCH');
  }
  const found = new Map<string, string>();
  for (const row of result.rows) {
    if (row.record_id === null) continue;
    if (row.extraction_method !== 'native_text' || typeof row.extractor_version !== 'string' || found.has(String(row.record_id))) {
      throw fail('HISTORICAL_PROFILE_EVIDENCE_NOT_FOUND');
    }
    found.set(String(row.record_id), row.extractor_version);
  }
  for (const [ref, extractorVersion] of references) {
    const actual = found.get(ref);
    if (actual === undefined) throw fail('HISTORICAL_PROFILE_EVIDENCE_NOT_FOUND');
    if (actual !== parserVersion || (extractorVersion !== null && actual !== extractorVersion)) {
      throw fail('HISTORICAL_PROFILE_EVIDENCE_VERSION_MISMATCH');
    }
  }
}

async function validateCorrectionEvidenceReferences(
  client: HistoricalProfileClient,
  context: TrustedHistoricalProfileContext,
  parserVersion: string,
  refs: readonly string[],
): Promise<void> {
  if (refs.length === 0) return;
  const result = await client.query(
    `SELECT DISTINCT e.record_id FROM bb_parse_evidence e
       JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
        AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
      WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=$4
        AND s.parser_version=$5 AND e.extractor_version=$5 AND e.record_id=ANY($6::text[])`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, parserVersion, [...new Set(refs)]],
  );
  if (new Set(result.rows.map(row => row.record_id)).size !== new Set(refs).size) {
    throw fail('HISTORICAL_PROFILE_CORRECTION_EVIDENCE_NOT_FOUND');
  }
}

function dateString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_HISTORICAL_PROFILE_ROW');
  return date.toISOString();
}

function mapProfile(row: Record<string, unknown>, replayed: boolean): StoredHistoricalProfile {
  const recognition = parseJson(row.recognition);
  const correctionEvidenceRefs = parseJson(row.correction_evidence_refs);
  if (typeof row.owner_user_id !== 'string' || typeof row.project_id !== 'string' ||
      typeof row.material_id !== 'string' || !Number.isSafeInteger(Number(row.material_version)) ||
      !Number.isSafeInteger(Number(row.profile_version)) || typeof row.request_id !== 'string' ||
      (row.write_kind !== 'recognition' && row.write_kind !== 'correction') ||
      !(row.actor_id === null || typeof row.actor_id === 'string') ||
      !(row.correction_reason === null || typeof row.correction_reason === 'string') ||
      !Array.isArray(correctionEvidenceRefs) || !correctionEvidenceRefs.every(ref => typeof ref === 'string') ||
      !(row.created_at instanceof Date || typeof row.created_at === 'string')) {
    throw fail('INVALID_HISTORICAL_PROFILE_ROW');
  }
  validateProfile(recognition);
  const createdAt = dateString(row.created_at);
  const mapped = {
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    materialId: row.material_id,
    materialVersion: Number(row.material_version),
    profileVersion: Number(row.profile_version),
    requestId: row.request_id,
    writeKind: row.write_kind,
    recognition,
    actorId: row.actor_id,
    correctionReason: row.correction_reason,
    correctionEvidenceRefs,
    createdAt,
    replayed,
  };
  return mapped as StoredHistoricalProfile;
}

const PROFILE_COLUMNS = `owner_user_id, project_id, material_id, material_version, profile_version,
 request_id, request_hash, write_kind, recognition, actor_id, correction_reason, correction_evidence_refs, created_at`;

async function lockHistoricalMaterial(client: HistoricalProfileClient, context: TrustedHistoricalProfileContext): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM bb_material_versions
      WHERE owner_user_id = $1 AND project_id = $2 AND id = $3 AND version = $4
        AND role = 'historical'
        AND media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
        AND deleted_at IS NULL
      FOR UPDATE`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
  );
  if (result.rows.length !== 1) throw fail('HISTORICAL_MATERIAL_NOT_FOUND');
}

async function priorRequest(
  client: HistoricalProfileClient,
  context: TrustedHistoricalProfileContext,
  requestHash: string,
): Promise<StoredHistoricalProfile | null> {
  const result = await client.query(
    `SELECT ${PROFILE_COLUMNS} FROM bb_historical_profiles
      WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4 AND request_id = $5`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, context.requestId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || String(result.rows[0]!.request_hash).trim() !== requestHash) throw fail('HISTORICAL_PROFILE_IDEMPOTENCY_MISMATCH');
  return mapProfile(result.rows[0]!, true);
}

async function appendSnapshot(
  dependencies: HistoricalProfileDependencies,
  client: HistoricalProfileClient,
  context: TrustedHistoricalProfileContext,
  requestHash: string,
  writeKind: 'recognition' | 'correction',
  recognition: Recognition,
  correction?: { actorId: string; reason: string; evidenceRefs: string[] },
): Promise<StoredHistoricalProfile> {
  const latestResult = await client.query(
    `SELECT COALESCE(max(profile_version), 0)::int AS profile_version FROM bb_historical_profiles
      WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
  );
  const profileVersion = Number(latestResult.rows[0]?.profile_version ?? 0) + 1;
  if (recognition.material_id !== context.materialId || recognition.material_version !== context.materialVersion ||
      recognition.profile_version !== profileVersion) throw fail('HISTORICAL_PROFILE_VERSION_MISMATCH');
  const inserted = await client.query(
    `INSERT INTO bb_historical_profiles
       (owner_user_id, project_id, material_id, material_version, profile_version, request_id, request_hash,
        write_kind, recognition, actor_id, correction_reason, correction_evidence_refs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb)
     RETURNING ${PROFILE_COLUMNS}`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, profileVersion,
      context.requestId, requestHash, writeKind, JSON.stringify(recognition), correction?.actorId ?? null,
      correction?.reason ?? null, JSON.stringify(correction?.evidenceRefs ?? [])],
  );
  if (inserted.rows.length !== 1) throw fail('HISTORICAL_PROFILE_NOT_STORED');
  const profile = mapProfile(inserted.rows[0]!, false);
  await client.query(
    `INSERT INTO bb_outbox (id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1,$2,'historical_profile',$3,'historical_profile.updated',$4::jsonb)`,
    [dependencies.newId?.() ?? randomUUID(), context.ownerUserId, context.materialId, JSON.stringify({
      project_id: context.projectId, material_id: context.materialId,
      material_version: context.materialVersion, profile_version: profileVersion,
      state: recognition.state,
    })],
  );
  return profile;
}

/** Persists one schema-validated recognition result for an authorized material version. */
export async function appendHistoricalRecognition(
  dependencies: HistoricalProfileDependencies,
  context: TrustedHistoricalProfileContext,
  recognitionInput: unknown,
): Promise<StoredHistoricalProfile> {
  validateContext(context);
  const recognition = structuredClone(recognitionInput) as Recognition;
  validateProfile(recognition);
  if (recognition.material_id !== context.materialId || recognition.material_version !== context.materialVersion) {
    throw fail('HISTORICAL_PROFILE_MATERIAL_MISMATCH');
  }
  const requestHash = hashRequest({ kind: 'recognition', owner: context.ownerUserId, project: context.projectId,
    material: context.materialId, materialVersion: context.materialVersion,
    recognition: { ...recognition, profile_version: 1 } });
  const parserVersion = parserVersionFromRecognition(recognition);
  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN'); transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `historical-profile:${context.ownerUserId}:${context.projectId}:${context.materialId}:${context.materialVersion}`,
    ]);
    await lockHistoricalMaterial(client, context);
    await validateParseEvidenceReferences(client, context, recognition, parserVersion);
    const existing = await priorRequest(client, context, requestHash);
    if (existing) {
      await client.query('COMMIT'); transactionOpen = false;
      return existing;
    }
    const latestResult = await client.query(
      `SELECT COALESCE(max(profile_version), 0)::int AS profile_version,
              COALESCE(bool_or(write_kind = 'correction'), false) AS has_correction
         FROM bb_historical_profiles
        WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
    );
    if (latestResult.rows[0]?.has_correction === true) throw fail('HISTORICAL_PROFILE_ALREADY_CORRECTED');
    const sameExtractor = await client.query(
      `SELECT ${PROFILE_COLUMNS} FROM bb_historical_profiles
        WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
          AND write_kind='recognition' AND recognition #>> '{source_market,provenance,extractor_version}'=$5
        ORDER BY profile_version ASC`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion,
        recognition.source_market.provenance.extractor_version],
    );
    if (sameExtractor.rows.length > 1) throw fail('HISTORICAL_PROFILE_EXTRACTOR_RESULT_CONFLICT');
    if (sameExtractor.rows.length === 1) {
      const existingProfile = mapProfile(sameExtractor.rows[0]!, true);
      const priorRecognition = { ...existingProfile.recognition, profile_version: 1 };
      const incomingRecognition = { ...recognition, profile_version: 1 };
      if (canonical(priorRecognition) !== canonical(incomingRecognition)) throw fail('HISTORICAL_PROFILE_EXTRACTOR_RESULT_CONFLICT');
      await client.query('COMMIT'); transactionOpen = false;
      return existingProfile;
    }
    recognition.profile_version = Number(latestResult.rows[0]?.profile_version ?? 0) + 1;
    validateProfile(recognition);
    const profile = await appendSnapshot(dependencies, client, context, requestHash, 'recognition', recognition);
    await client.query('COMMIT'); transactionOpen = false;
    return profile;
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error;
  } finally { client.release(); }
}

/** Appends source-market/offering and/or reporting-period corrections. Previous snapshots remain intact. */
export async function correctHistoricalRecognition(
  dependencies: HistoricalProfileDependencies,
  context: TrustedHistoricalCorrectionContext,
  patchInput: unknown,
): Promise<StoredHistoricalProfile> {
  validateContext(context);
  if (!safeIdentifier(context.actorId)) throw fail('INVALID_HISTORICAL_PROFILE_ACTOR');
  if (!validatePatch(patchInput)) throw fail('INVALID_RECOGNITION_PATCH_SCHEMA');
  const patch = patchInput as RecognitionPatchRequest;
  if (patch.reason.trim().length === 0) throw fail('INVALID_RECOGNITION_PATCH_REASON');
  const requestHash = hashRequest({ kind: 'correction', owner: context.ownerUserId, project: context.projectId,
    material: context.materialId, materialVersion: context.materialVersion, actorId: context.actorId, patch });
  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN'); transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `historical-profile:${context.ownerUserId}:${context.projectId}:${context.materialId}:${context.materialVersion}`,
    ]);
    await lockHistoricalMaterial(client, context);
    const existing = await priorRequest(client, context, requestHash);
    if (existing) {
      await client.query('COMMIT'); transactionOpen = false;
      return existing;
    }
    const latestResult = await client.query(
      `SELECT ${PROFILE_COLUMNS} FROM bb_historical_profiles
        WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4
        ORDER BY profile_version DESC LIMIT 1 FOR UPDATE`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
    );
    if (latestResult.rows.length !== 1) throw fail('HISTORICAL_PROFILE_NOT_FOUND');
    const latest = mapProfile(latestResult.rows[0]!, false);
    const periodEvidenceRefs = patch.reporting_periods?.flatMap(period => period.evidence_refs) ?? [];
    const citedEvidenceRefs = [...new Set([...patch.evidence_refs, ...periodEvidenceRefs])];
    await validateCorrectionEvidenceReferences(client, context,
      parserVersionFromRecognition(latest.recognition), citedEvidenceRefs);
    if (latest.profileVersion !== patch.profile_version) throw fail('HISTORICAL_PROFILE_VERSION_CONFLICT');
    const prior = latest.recognition;
    const resultingMarket = patch.source_market === undefined ? prior.source_market.value : patch.source_market;
    const resultingOffering = patch.source_offering === undefined ? prior.source_offering.value : patch.source_offering;
    if (resultingMarket !== null && resultingOffering !== null &&
        !isMarketOffering(resultingMarket as Market, resultingOffering as Offering)) {
      throw fail('INVALID_SOURCE_MARKET_OFFERING');
    }
    const corrected = structuredClone(prior) as Recognition;
    corrected.profile_version = latest.profileVersion + 1;
    const correctionField = <T extends Market | Offering>(
      current: Recognition['source_market'] | Recognition['source_offering'], value: T | null,
    ): Recognition['source_market'] | Recognition['source_offering'] => ({
      value,
      raw_value: current.raw_value,
      provenance: {
        material_id: context.materialId,
        material_version: context.materialVersion,
        method: 'user_correction',
        extractor_version: current.provenance.extractor_version,
        evidence_refs: [...new Set(patch.evidence_refs)],
      },
      uncertainty: patch.evidence_refs.length === 0
        ? ['用户校正缺少来源锚点']
        : ['锚点存在但不证明所校正值，需人工核对原文语义'],
      status: 'user_asserted',
    });
    if (patch.source_market !== undefined) {
      corrected.source_market = correctionField(prior.source_market, patch.source_market as Market | null) as Recognition['source_market'];
    }
    if (patch.source_offering !== undefined) {
      corrected.source_offering = correctionField(prior.source_offering, patch.source_offering as Offering | null) as Recognition['source_offering'];
    }
    if (patch.reporting_periods !== undefined) {
      corrected.reporting_periods = patch.reporting_periods.map((period, index) => {
        const current = prior.reporting_periods[index];
        return {
          start: period.start,
          end: period.end,
          period_kind: period.period_kind,
          scope: period.scope,
          raw_value: null,
          provenance: {
            material_id: context.materialId,
            material_version: context.materialVersion,
            method: 'user_correction',
            extractor_version: current?.provenance.extractor_version ?? prior.latest_reporting_cutoff.provenance.extractor_version,
            evidence_refs: [...new Set(period.evidence_refs)],
          },
          uncertainty: period.evidence_refs.length === 0
            ? ['用户校正的报告期间缺少来源锚点，需人工核对']
            : ['用户校正的报告期间尚未人工核验'],
          status: 'user_asserted',
        };
      });
      const allPeriodsValid = corrected.reporting_periods.length > 0 && corrected.reporting_periods.every(period =>
        validDate(period.start) && validDate(period.end) && period.start <= period.end);
      const validEnds = allPeriodsValid ? corrected.reporting_periods.map(period => period.end!) : [];
      const latestEnd = validEnds.length ? validEnds.reduce((latestEnd, end) => end > latestEnd ? end : latestEnd) : null;
      const cutoffRefs = [...new Set(corrected.reporting_periods.flatMap(period => period.provenance.evidence_refs))];
      corrected.latest_reporting_cutoff = {
        value: latestEnd,
        raw_value: null,
        provenance: {
          material_id: context.materialId,
          material_version: context.materialVersion,
          method: 'user_correction',
          extractor_version: prior.latest_reporting_cutoff.provenance.extractor_version,
          evidence_refs: cutoffRefs,
        },
        uncertainty: latestEnd === null
          ? ['用户校正期间没有有效截止日，需人工核对']
          : ['最新截止日由用户校正期间推导，尚未人工核验'],
        status: 'user_asserted',
      };
    }
    // A user assertion is never sufficient confirmation, even when it cites valid anchors.
    corrected.state = 'needs_confirmation';
    validateProfile(corrected);
    const profile = await appendSnapshot(dependencies, client, context, requestHash, 'correction', corrected, {
      actorId: context.actorId, reason: patch.reason, evidenceRefs: citedEvidenceRefs,
    });
    await client.query('COMMIT'); transactionOpen = false;
    return profile;
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error;
  } finally { client.release(); }
}

/** Owner-scoped latest read; deleted or non-historical materials are inaccessible. */
export async function getLatestHistoricalProfile(
  dependencies: HistoricalProfileDependencies,
  context: Omit<TrustedHistoricalProfileContext, 'requestId'>,
): Promise<StoredHistoricalProfile | null> {
  if (![context.ownerUserId, context.projectId, context.materialId].every(safeIdentifier) ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1) throw fail('INVALID_HISTORICAL_PROFILE_CONTEXT');
  const result = await dependencies.pool.query(
    `SELECT p.${PROFILE_COLUMNS.split(', ').join(', p.')}
       FROM bb_historical_profiles p
       JOIN bb_material_versions m ON m.owner_user_id = p.owner_user_id AND m.project_id = p.project_id
        AND m.id = p.material_id AND m.version = p.material_version
      WHERE p.owner_user_id = $1 AND p.project_id = $2 AND p.material_id = $3 AND p.material_version = $4
        AND m.role = 'historical' AND m.deleted_at IS NULL
        AND m.media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
      ORDER BY p.profile_version DESC LIMIT 1`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
  );
  if (result.rows.length > 1) throw fail('INVALID_HISTORICAL_PROFILE_ROW');
  return result.rows.length === 0 ? null : mapProfile(result.rows[0]!, false);
}

/** Owner-scoped immutable history read for one historical material version. */
export async function listHistoricalProfileHistory(
  dependencies: HistoricalProfileDependencies,
  context: Omit<TrustedHistoricalProfileContext, 'requestId'>,
): Promise<StoredHistoricalProfile[]> {
  if (![context.ownerUserId, context.projectId, context.materialId].every(safeIdentifier) ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1) throw fail('INVALID_HISTORICAL_PROFILE_CONTEXT');
  const result = await dependencies.pool.query(
    `SELECT p.${PROFILE_COLUMNS.split(', ').join(', p.')}
       FROM bb_historical_profiles p
       JOIN bb_material_versions m ON m.owner_user_id = p.owner_user_id AND m.project_id = p.project_id
        AND m.id = p.material_id AND m.version = p.material_version
      WHERE p.owner_user_id = $1 AND p.project_id = $2 AND p.material_id = $3 AND p.material_version = $4
        AND m.role = 'historical' AND m.deleted_at IS NULL
        AND m.media_type IN ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf')
      ORDER BY p.profile_version`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
  );
  return result.rows.map(row => mapProfile(row, false));
}
