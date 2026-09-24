import { createHash, randomUUID } from 'node:crypto';
import {
  DOCUMENT_PARSE_REQUEST_VERSION,
  validateDocumentParseResponse,
  type DocumentParseRecord,
  type DocumentParseRequest,
  type DocumentParseResponse,
} from './document-parser.js';
import {
  parseAuthorizedMaterial,
  type AuthorizedMaterialParseInput,
  type MaterialParserDependencies,
} from './material-parser.js';

export interface ParseEvidenceClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface ParseEvidencePool {
  connect(): Promise<ParseEvidenceClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ParseEvidenceDependencies {
  pool: ParseEvidencePool;
  newId?: () => string;
}

export interface TrustedParseEvidenceContext {
  ownerUserId: string;
  projectId: string;
  materialId: string;
  materialVersion: number;
  requestId: string;
  options?: { max_pages?: number };
}

export interface StoredParseSnapshot {
  snapshotId: string;
  ownerUserId: string;
  projectId: string;
  materialId: string;
  materialVersion: number;
  contentSha256: string;
  parserVersion: string;
  requestId: string;
  requestHash: string;
  requestOptions: { max_pages?: number };
  responseSha256: string;
  response: DocumentParseResponse;
  evidence: DocumentParseRecord[];
  createdAt: string;
  replayed: boolean;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'ParseEvidenceRepositoryError';
  return error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function responseResultHash(response: DocumentParseResponse): string {
  const { request_id: _retryRequestId, ...stableResult } = response;
  return sha256(canonical(stableResult));
}

function validateContext(context: TrustedParseEvidenceContext): void {
  if (![context.ownerUserId, context.projectId, context.materialId, context.requestId].every(value => identifier.test(value)) ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1 ||
      (context.options !== undefined && Object.keys(context.options).some(key => key !== 'max_pages')) ||
      (context.options?.max_pages !== undefined && (!Number.isSafeInteger(context.options.max_pages) ||
        context.options.max_pages < 1 || context.options.max_pages > 1500))) {
    throw fail('INVALID_PARSE_EVIDENCE_CONTEXT');
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('INVALID_PARSE_EVIDENCE_ROW'); }
}

function dateString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail('INVALID_PARSE_EVIDENCE_ROW');
  return date.toISOString();
}

function requestFor(context: TrustedParseEvidenceContext, mediaType: DocumentParseRequest['material']['media_type'], sha: string): DocumentParseRequest {
  return {
    schema_version: DOCUMENT_PARSE_REQUEST_VERSION,
    request_id: context.requestId,
    material: {
      material_id: context.materialId,
      material_version: context.materialVersion,
      media_type: mediaType,
      sha256: sha,
      // Never persisted; only a schema validator input for this trusted boundary.
      authorized_local_path: '/private/bondbuddy-parse-evidence-validation',
    },
    options: context.options ?? {},
  };
}

function snapshotRequestHash(request: DocumentParseRequest, parserVersion: string): string {
  return sha256(canonical({
    schema_version: request.schema_version,
    material: {
      material_id: request.material.material_id,
      material_version: request.material.material_version,
      media_type: request.material.media_type,
      sha256: request.material.sha256,
    },
    options: request.options,
    parser_version: parserVersion,
  }));
}

function parseSnapshotResponse(row: Record<string, unknown>, evidenceRows: Record<string, unknown>[], expected: TrustedParseEvidenceContext): StoredParseSnapshot {
  const meta = parseJson(row.response_meta);
  const options = parseJson(row.request_options);
  if (!isObject(meta) || typeof row.id !== 'string' || typeof row.owner_user_id !== 'string' ||
      typeof row.project_id !== 'string' || typeof row.material_id !== 'string' ||
      typeof row.parser_version !== 'string' || typeof row.content_sha256 !== 'string' || typeof row.request_hash !== 'string' ||
      typeof row.response_sha256 !== 'string' || !Number.isSafeInteger(Number(row.material_version)) ||
      !Number.isSafeInteger(Number(row.record_count)) || typeof meta.request_id !== 'string' || !isObject(options) ||
      Object.keys(options).some(key => key !== 'max_pages') ||
      (options.max_pages !== undefined && (!Number.isSafeInteger(options.max_pages) || Number(options.max_pages) < 1 || Number(options.max_pages) > 1500)) ||
      meta.parser_version !== row.parser_version || meta.status !== row.response_status ||
      evidenceRows.length !== Number(row.record_count) || row.owner_user_id !== expected.ownerUserId ||
      row.project_id !== expected.projectId || row.material_id !== expected.materialId ||
      Number(row.material_version) !== expected.materialVersion) {
    throw fail('INVALID_PARSE_EVIDENCE_ROW');
  }
  const records: DocumentParseRecord[] = evidenceRows.map((entry, index) => {
    const locator = parseJson(entry.locator);
    const uncertainty = parseJson(entry.uncertainty);
    const formatting = parseJson(entry.formatting);
    if (Number(entry.ordinal) !== index || typeof entry.record_id !== 'string' ||
        typeof entry.content_sha256 !== 'string' || typeof entry.locator_type !== 'string' || !isObject(locator) ||
        typeof entry.literal_quote !== 'string' || typeof entry.context !== 'string' ||
        entry.extraction_method !== 'native_text' || typeof entry.extractor_version !== 'string' ||
        !(entry.confidence === null || (typeof entry.confidence === 'number' || typeof entry.confidence === 'string')) ||
        !Array.isArray(uncertainty) || !isObject(formatting)) throw fail('INVALID_PARSE_EVIDENCE_ROW');
    const confidence = entry.confidence === null ? null : Number(entry.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw fail('INVALID_PARSE_EVIDENCE_ROW');
    return {
      record_id: entry.record_id,
      material_id: expected.materialId,
      material_version: expected.materialVersion,
      content_hash: String(entry.content_sha256).trim(),
      locator_type: entry.locator_type as DocumentParseRecord['locator_type'],
      locator,
      literal_quote: entry.literal_quote,
      context: entry.context,
      extraction_method: 'native_text',
      extractor_version: entry.extractor_version,
      confidence,
      uncertainty: uncertainty as string[],
      formatting,
    };
  });
  const response = { ...meta, records } as unknown as DocumentParseResponse;
  const material = response.material;
  if (!isObject(material) || typeof material.media_type !== 'string') throw fail('INVALID_PARSE_EVIDENCE_ROW');
  const validated = validateDocumentParseResponse(response, requestFor({ ...expected, requestId: String(meta.request_id), options: options as { max_pages?: number } },
    material.media_type as DocumentParseRequest['material']['media_type'], String(row.content_sha256).trim()));
  if (responseResultHash(validated) !== String(row.response_sha256).trim()) throw fail('PARSE_EVIDENCE_INTEGRITY_MISMATCH');
  return {
    snapshotId: row.id,
    ownerUserId: row.owner_user_id,
    projectId: row.project_id,
    materialId: row.material_id,
    materialVersion: Number(row.material_version),
    contentSha256: String(row.content_sha256).trim(),
    parserVersion: row.parser_version,
    requestId: String(meta.request_id),
    requestHash: String(row.request_hash).trim(),
    requestOptions: options as { max_pages?: number },
    responseSha256: String(row.response_sha256).trim(),
    response: validated,
    evidence: records,
    createdAt: dateString(row.created_at),
    replayed: false,
  };
}

const SNAPSHOT_COLUMNS = `s.id, s.owner_user_id, s.project_id, s.material_id, s.material_version, s.content_sha256,
 s.parser_version, s.request_hash, s.request_options, s.response_status, s.response_schema_version, s.response_sha256, s.record_count,
 s.response_meta, s.created_at`;
const SNAPSHOT_RETURNING_COLUMNS = `id, owner_user_id, project_id, material_id, material_version, content_sha256,
 parser_version, request_hash, request_options, response_status, response_schema_version, response_sha256, record_count,
 response_meta, created_at`;

async function findSnapshot(client: ParseEvidenceClient, context: TrustedParseEvidenceContext, snapshotId: string): Promise<StoredParseSnapshot | null> {
  const result = await client.query(
    `SELECT ${SNAPSHOT_COLUMNS} FROM bb_parse_snapshots s
      JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
       AND m.id=s.material_id AND m.version=s.material_version AND lower(btrim(m.sha256::text))=lower(btrim(s.content_sha256::text))
      WHERE s.owner_user_id = $1 AND s.project_id = $2 AND s.material_id = $3 AND s.material_version = $4 AND s.id = $5
        AND m.deleted_at IS NULL`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, snapshotId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw fail('INVALID_PARSE_EVIDENCE_ROW');
  const evidence = await client.query(
    `SELECT record_id, content_sha256, locator_type, locator, literal_quote, context, extraction_method,
            extractor_version, confidence, uncertainty, formatting, ordinal
       FROM bb_parse_evidence
      WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4 AND snapshot_id = $5
      ORDER BY ordinal`,
    [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, snapshotId],
  );
  return parseSnapshotResponse(result.rows[0]!, evidence.rows, context);
}

/** Saves a validated result once for a given owner/material/version/parser version, plus every source anchor. */
export async function persistParseSnapshot(
  dependencies: ParseEvidenceDependencies,
  context: TrustedParseEvidenceContext,
  material: { mediaType: DocumentParseRequest['material']['media_type']; sha256: string },
  responseInput: unknown,
): Promise<StoredParseSnapshot> {
  validateContext(context);
  if (!/^[a-f0-9]{64}$/.test(material.sha256)) throw fail('INVALID_PARSE_EVIDENCE_CONTEXT');
  const request = requestFor(context, material.mediaType, material.sha256);
  const response = validateDocumentParseResponse(responseInput, request);
  if (response.material?.material_id !== context.materialId || response.material.material_version !== context.materialVersion ||
      response.material.sha256 !== material.sha256) throw fail('PARSE_EVIDENCE_MATERIAL_MISMATCH');
  const responseText = canonical(response);
  if (Buffer.byteLength(responseText, 'utf8') > MAX_RESPONSE_BYTES) throw fail('PARSE_SNAPSHOT_TOO_LARGE');
  for (const record of response.records) {
    if (Buffer.byteLength(canonical(record), 'utf8') > MAX_RECORD_BYTES) throw fail('PARSE_EVIDENCE_RECORD_TOO_LARGE');
  }
  const requestHash = snapshotRequestHash(request, response.parser_version);
  const responseHash = responseResultHash(response);
  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN'); transactionOpen = true;
    const lockIdentity = `${context.ownerUserId}:${context.projectId}:${context.materialId}:${context.materialVersion}:${response.parser_version}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`parse-snapshot:${lockIdentity}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`parse-request:${lockIdentity}:${context.requestId}`]);
    const authorized = await client.query(
      `SELECT media_type, sha256 FROM bb_material_versions
        WHERE owner_user_id = $1 AND project_id = $2 AND id = $3 AND version = $4 AND deleted_at IS NULL
        FOR SHARE`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion],
    );
    if (authorized.rows.length !== 1 || authorized.rows[0]!.media_type !== material.mediaType ||
        String(authorized.rows[0]!.sha256).trim().toLowerCase() !== material.sha256) {
      throw fail('PARSE_EVIDENCE_MATERIAL_NOT_AUTHORIZED');
    }

    const priorRequest = await client.query(
      `SELECT request_hash, snapshot_id FROM bb_parse_snapshot_requests
        WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4 AND request_id = $5`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, context.requestId],
    );
    if (priorRequest.rows.length > 1) throw fail('INVALID_PARSE_EVIDENCE_ROW');
    if (priorRequest.rows.length === 1) {
      if (String(priorRequest.rows[0]!.request_hash).trim() !== requestHash) throw fail('PARSE_REQUEST_IDEMPOTENCY_MISMATCH');
      const priorResult = await client.query(
        `SELECT response_sha256 FROM bb_parse_snapshots
          WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND id=$5`,
        [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, priorRequest.rows[0]!.snapshot_id],
      );
      if (priorResult.rows.length !== 1 || String(priorResult.rows[0]!.response_sha256).trim() !== responseHash) {
        throw fail('PARSE_SNAPSHOT_RESULT_CONFLICT');
      }
      const stored = await findSnapshot(client, context, String(priorRequest.rows[0]!.snapshot_id));
      if (stored === null) throw fail('INVALID_PARSE_EVIDENCE_ROW');
      await client.query('COMMIT'); transactionOpen = false;
      return { ...stored, replayed: true };
    }

    const existing = await client.query(
      `SELECT id, request_hash, response_sha256 FROM bb_parse_snapshots
        WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4 AND parser_version = $5`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, response.parser_version],
    );
    if (existing.rows.length > 1) throw fail('INVALID_PARSE_EVIDENCE_ROW');
    if (existing.rows.length === 1) {
      if (String(existing.rows[0]!.request_hash).trim() !== requestHash) throw fail('PARSE_SNAPSHOT_INPUT_MISMATCH');
      if (String(existing.rows[0]!.response_sha256).trim() !== responseHash) throw fail('PARSE_SNAPSHOT_RESULT_CONFLICT');
      const snapshotId = String(existing.rows[0]!.id);
      await client.query(
        `INSERT INTO bb_parse_snapshot_requests(owner_user_id,project_id,material_id,material_version,request_id,request_hash,snapshot_id)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, context.requestId, requestHash, snapshotId],
      );
      const stored = await findSnapshot(client, context, snapshotId);
      if (stored === null) throw fail('INVALID_PARSE_EVIDENCE_ROW');
      await client.query('COMMIT'); transactionOpen = false;
      return { ...stored, replayed: true };
    }

    const snapshotId = dependencies.newId?.() ?? randomUUID();
    const { records: _records, ...responseMeta } = response;
    const inserted = await client.query(
      `INSERT INTO bb_parse_snapshots
         (id, owner_user_id, project_id, material_id, material_version, content_sha256, parser_version,
          request_hash, request_options, response_status, response_schema_version, response_sha256, record_count, response_meta)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb)
       RETURNING ${SNAPSHOT_RETURNING_COLUMNS}`,
      [snapshotId, context.ownerUserId, context.projectId, context.materialId, context.materialVersion,
        material.sha256, response.parser_version, requestHash, JSON.stringify(request.options), response.status, response.schema_version,
        responseHash, response.records.length, JSON.stringify(responseMeta)],
    );
    if (inserted.rows.length !== 1) throw fail('PARSE_SNAPSHOT_NOT_STORED');
    for (let ordinal = 0; ordinal < response.records.length; ordinal += 1) {
      const record = response.records[ordinal]!;
      if (Buffer.byteLength(record.literal_quote, 'utf8') > 65536 || Buffer.byteLength(record.context, 'utf8') > 65536 ||
          Buffer.byteLength(canonical(record.locator), 'utf8') > 65536 || Buffer.byteLength(canonical(record.formatting), 'utf8') > 65536 ||
          Buffer.byteLength(canonical(record.uncertainty), 'utf8') > 8192) throw fail('PARSE_EVIDENCE_RECORD_TOO_LARGE');
      await client.query(
        `INSERT INTO bb_parse_evidence
           (owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
            locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,
            uncertainty,formatting,record_sha256,ordinal)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18)`,
        [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, snapshotId,
          record.record_id, record.content_hash, record.locator_type, JSON.stringify(record.locator), record.literal_quote,
          record.context, record.extraction_method, record.extractor_version, record.confidence,
          JSON.stringify(record.uncertainty), JSON.stringify(record.formatting), sha256(canonical(record)), ordinal],
      );
    }
    await client.query(
      `INSERT INTO bb_parse_snapshot_requests(owner_user_id,project_id,material_id,material_version,request_id,request_hash,snapshot_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, context.requestId, requestHash, snapshotId],
    );
    await client.query(
      `INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
       VALUES($1,$2,'parse_snapshot',$3,'material.parse_completed',$4::jsonb)`,
      [dependencies.newId?.() ?? randomUUID(), context.ownerUserId, snapshotId, JSON.stringify({
        project_id: context.projectId, material_id: context.materialId, material_version: context.materialVersion,
        snapshot_id: snapshotId, parser_version: response.parser_version, status: response.status,
        evidence_count: response.records.length,
      })],
    );
    const saved = parseSnapshotResponse(inserted.rows[0]!, response.records.map((record, ordinal) => ({
      record_id: record.record_id, content_sha256: record.content_hash, locator_type: record.locator_type,
      locator: record.locator, literal_quote: record.literal_quote, context: record.context,
      extraction_method: record.extraction_method, extractor_version: record.extractor_version,
      confidence: record.confidence, uncertainty: record.uncertainty, formatting: record.formatting, ordinal,
    })), context);
    await client.query('COMMIT'); transactionOpen = false;
    return saved;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the operation failure */ }
    }
    throw error instanceof Error && error.name === 'ParseEvidenceRepositoryError' ? error : fail('PARSE_SNAPSHOT_PERSIST_FAILED');
  } finally {
    client.release();
  }
}

/** Exact owner/project/material/version/snapshot lookup. No latest or cross-scope fallback exists. */
export async function getParseSnapshot(
  dependencies: ParseEvidenceDependencies,
  context: Omit<TrustedParseEvidenceContext, 'requestId' | 'options'>,
  snapshotId: string,
): Promise<StoredParseSnapshot | null> {
  if (![context.ownerUserId, context.projectId, context.materialId, snapshotId].every(value => identifier.test(value)) ||
      !Number.isSafeInteger(context.materialVersion) || context.materialVersion < 1) throw fail('INVALID_PARSE_EVIDENCE_CONTEXT');
  const client = await dependencies.pool.connect();
  try {
    const row = await client.query(
      `SELECT ${SNAPSHOT_COLUMNS} FROM bb_parse_snapshots s
        JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
         AND m.id=s.material_id AND m.version=s.material_version AND lower(btrim(m.sha256::text))=lower(btrim(s.content_sha256::text))
        WHERE s.owner_user_id = $1 AND s.project_id = $2 AND s.material_id = $3 AND s.material_version = $4 AND s.id = $5
          AND m.deleted_at IS NULL`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, snapshotId],
    );
    if (row.rows.length === 0) return null;
    if (row.rows.length !== 1) throw fail('INVALID_PARSE_EVIDENCE_ROW');
    const evidence = await client.query(
      `SELECT record_id, content_sha256, locator_type, locator, literal_quote, context, extraction_method,
              extractor_version, confidence, uncertainty, formatting, ordinal
         FROM bb_parse_evidence
        WHERE owner_user_id = $1 AND project_id = $2 AND material_id = $3 AND material_version = $4 AND snapshot_id = $5
        ORDER BY ordinal`,
      [context.ownerUserId, context.projectId, context.materialId, context.materialVersion, snapshotId],
    );
    return parseSnapshotResponse(row.rows[0]!, evidence.rows, { ...context, requestId: String((parseJson(row.rows[0]!.response_meta) as Record<string, unknown>).request_id) });
  } catch (error) {
    throw error instanceof Error && error.name === 'ParseEvidenceRepositoryError' ? error : fail('PARSE_SNAPSHOT_READ_FAILED');
  } finally {
    client.release();
  }
}

/** Worker-only composition; does not create or claim a queue job. */
export async function parseAndPersistAuthorizedMaterial(
  materialDependencies: MaterialParserDependencies,
  evidenceDependencies: ParseEvidenceDependencies,
  input: AuthorizedMaterialParseInput,
): Promise<StoredParseSnapshot> {
  const response = await parseAuthorizedMaterial(materialDependencies, input);
  const materialResult = await materialDependencies.pool.query(
    `SELECT media_type, sha256 FROM bb_material_versions
      WHERE owner_user_id = $1 AND project_id = $2 AND id = $3 AND version = $4 AND deleted_at IS NULL`,
    [input.ownerUserId, input.projectId, input.materialId, input.version],
  );
  if (materialResult.rows.length !== 1 || typeof materialResult.rows[0]!.media_type !== 'string') throw fail('PARSE_EVIDENCE_MATERIAL_NOT_AUTHORIZED');
  return persistParseSnapshot(evidenceDependencies, {
    ownerUserId: input.ownerUserId, projectId: input.projectId, materialId: input.materialId,
    materialVersion: input.version, requestId: input.requestId, options: input.options,
  }, { mediaType: materialResult.rows[0]!.media_type as DocumentParseRequest['material']['media_type'],
    sha256: String(materialResult.rows[0]!.sha256).trim().toLowerCase() }, response);
}
