import { createHash, randomUUID } from 'node:crypto';
import {
  M1_MATERIAL_PARTITIONS,
  canonicalTargetPeriodCandidateSnapshotContent,
  validTargetPeriodCandidateSnapshot,
  type TargetPeriodCandidateSnapshot,
} from '@bondbuddy/contracts';
import type { PrivateBlobs } from '@bondbuddy/api/data';
import { validateOcrResponse } from '@bondbuddy/api/ocr';

export interface TargetPeriodCandidateSnapshotClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface TargetPeriodCandidateSnapshotPool {
  connect(): Promise<TargetPeriodCandidateSnapshotClient>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TargetPeriodCandidateSnapshotDependencies {
  readonly pool: TargetPeriodCandidateSnapshotPool;
  readonly blobs: PrivateBlobs;
  readonly newId?: () => string;
}

export interface AppendTargetPeriodCandidateSnapshotRequest {
  /** Trusted worker context; HTTP handlers must never map browser identity into this value. */
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly requestId: string;
  /** Exact refs resolved by the server before calling this repository; never pass raw browser refs. The future input-lock consumer must pass its own resolved selected refs and compare them to this stored envelope in the lock transaction. */
  readonly selectedFinancialMaterials: readonly { readonly materialId: string; readonly materialVersion: number }[];
  /** Already built by the internal candidate snapshot builder. Evidence is reloaded from PostgreSQL below. */
  readonly snapshot: TargetPeriodCandidateSnapshot;
}

export interface StoredTargetPeriodCandidateSnapshot {
  readonly id: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly snapshot: TargetPeriodCandidateSnapshot;
  readonly createdAt: string;
  readonly replayed: boolean;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const FINANCIAL_ROLES: ReadonlySet<string> = new Set(M1_MATERIAL_PARTITIONS.find(partition => partition.label === '财务与审计')!.roles.map(role => role.code));

function fail(code: string): Error {
  const error = new Error(code);
  error.name = 'TargetPeriodCandidateSnapshotRepositoryError';
  return error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { throw fail('TARGET_PERIOD_CANDIDATE_ROW_INVALID'); }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_INVALID');
  return json;
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function same(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }

function requestHash(request: AppendTargetPeriodCandidateSnapshotRequest): string {
  const selectedFinancialMaterials = [...request.selectedFinancialMaterials]
    .sort((a, b) => a.materialId.localeCompare(b.materialId) || a.materialVersion - b.materialVersion);
  return sha256(canonical({ request_id: request.requestId, selected_financial_materials: selectedFinancialMaterials,
    snapshot: request.snapshot }));
}

function text(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== 'string') throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVALID');
  return row[key] as string;
}

function storedSnapshot(row: Record<string, unknown>, replayed: boolean): StoredTargetPeriodCandidateSnapshot {
  const content = parseJson(row.content);
  const snapshot: TargetPeriodCandidateSnapshot = {
    candidate_set_id: text(row, 'candidate_set_id'),
    candidate_set_version: Number(row.candidate_set_version),
    content_sha256: text(row, 'content_sha256').trim(),
    content: content as TargetPeriodCandidateSnapshot['content'],
  };
  if (!validTargetPeriodCandidateSnapshot(snapshot) ||
      sha256(canonicalTargetPeriodCandidateSnapshotContent(snapshot)) !== snapshot.content_sha256 ||
      !Number.isSafeInteger(snapshot.candidate_set_version)) throw fail('TARGET_PERIOD_CANDIDATE_ROW_INVALID');
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return { id: text(row, 'id'), requestId: text(row, 'request_id'), requestHash: text(row, 'request_hash').trim(),
    snapshot, createdAt, replayed };
}

async function lockProject(client: TargetPeriodCandidateSnapshotClient, request: AppendTargetPeriodCandidateSnapshotRequest): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT draft_revision, update_details
       FROM bb_projects
      WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL
      FOR UPDATE`,
    [request.ownerUserId, request.projectId],
  );
  if (result.rows.length !== 1) throw fail('TARGET_PERIOD_CANDIDATE_PROJECT_NOT_FOUND');
  return result.rows[0]!;
}

function verifyCurrentProject(row: Record<string, unknown>, request: AppendTargetPeriodCandidateSnapshotRequest): void {
  const details = parseJson(row.update_details);
  if (!isObject(details) || details.reporting_cutoff !== request.snapshot.content.reporting_cutoff ||
      Number(row.draft_revision) !== request.snapshot.content.project_draft_revision) {
    throw fail('TARGET_PERIOD_CANDIDATE_DRAFT_STALE');
  }
}

async function verifyCurrentMaterials(client: TargetPeriodCandidateSnapshotClient,
  request: AppendTargetPeriodCandidateSnapshotRequest): Promise<void> {
  const selected = [...request.selectedFinancialMaterials].sort((a, b) => a.materialId.localeCompare(b.materialId));
  if (selected.length === 0 || new Set(selected.map(item => item.materialId)).size !== selected.length ||
      selected.some(item => !identifier.test(item.materialId) || !Number.isSafeInteger(item.materialVersion) || item.materialVersion < 1)) {
    throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_SELECTION_INVALID');
  }
  const expected = request.snapshot.content.financial_materials;
  if (selected.length !== expected.length || selected.some((item, index) => item.materialId !== expected[index]!.material_id ||
      item.materialVersion !== expected[index]!.material_version)) throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_SELECTION_MISMATCH');
  const result = await client.query(
    `SELECT m.id AS material_id, m.version AS material_version, lower(btrim(m.sha256::text)) AS material_sha256, m.role
       FROM bb_material_versions m
      WHERE m.owner_user_id=$1 AND m.project_id=$2 AND m.deleted_at IS NULL
        AND (m.id,m.version) IN (SELECT selected.material_id,selected.material_version
          FROM jsonb_to_recordset($3::jsonb) AS selected(material_id text,material_version integer))
      ORDER BY m.id
      FOR SHARE OF m`,
    [request.ownerUserId, request.projectId, JSON.stringify(selected.map(item => ({ material_id: item.materialId, material_version: item.materialVersion })))],
  );
  const live = result.rows.map(row => ({ material_id: text(row, 'material_id'), material_version: Number(row.material_version),
    material_sha256: text(row, 'material_sha256'), role: text(row, 'role') }));
  if (!same(live, expected) || live.some(item => !FINANCIAL_ROLES.has(item.role))) throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_STALE');
  // The project FOR UPDATE lock serializes this new write with the API upload/
  // replacement path (and the material FK's KEY SHARE lock). Lock latest active
  // rows in material-ID order as well; an older version can be replayed for
  // audit, but cannot become a new candidate snapshot after replacement.
  for (const item of selected) {
    const latest = await client.query(
      `SELECT version, lower(btrim(sha256::text)) AS sha256 FROM bb_material_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL
        ORDER BY version DESC LIMIT 1 FOR SHARE`,
      [request.ownerUserId, request.projectId, item.materialId],
    );
    if (latest.rows.length !== 1 || Number(latest.rows[0]!.version) !== item.materialVersion ||
        text(latest.rows[0]!, 'sha256').trim() !== expected.find(pin => pin.material_id === item.materialId)?.material_sha256) {
      throw fail('TARGET_PERIOD_CANDIDATE_MATERIAL_STALE');
    }
  }
}

async function verifyNativeSource(client: TargetPeriodCandidateSnapshotClient,
  snapshot: TargetPeriodCandidateSnapshot, source: TargetPeriodCandidateSnapshot['content']['source_snapshots'][number]): Promise<void> {
  if (source.evidence_method !== 'native_text') throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_METHOD_INVALID');
  const sourceRow = await client.query(
    `SELECT s.id, s.owner_user_id, s.project_id, s.material_id, s.material_version, s.content_sha256,
            s.parser_version, s.response_status, s.response_sha256, s.record_count, m.role
       FROM bb_parse_snapshots s
       JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
        AND m.id=s.material_id AND m.version=s.material_version AND m.deleted_at IS NULL
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.id=$3 AND s.material_id=$4 AND s.material_version=$5
        AND lower(btrim(s.content_sha256::text))=lower(btrim(m.sha256::text))
      FOR SHARE OF s,m`,
    [snapshot.content.owner_user_id, snapshot.content.project_id, source.snapshot_id, source.material_id, source.material_version],
  );
  if (sourceRow.rows.length !== 1) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_NOT_FOUND');
  const liveSource = sourceRow.rows[0]!;
  if (text(liveSource, 'material_id') !== source.material_id || Number(liveSource.material_version) !== source.material_version ||
      text(liveSource, 'content_sha256').trim() !== source.material_sha256 || text(liveSource, 'role') !==
        snapshot.content.financial_materials.find(item => item.material_id === source.material_id)?.role ||
      text(liveSource, 'parser_version') !== source.parser_version || text(liveSource, 'response_sha256').trim() !== source.response_sha256) {
    throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STALE');
  }
  const status = text(liveSource, 'response_status');
  const expectedState = status === 'parsed' ? 'available' : status === 'needs_confirmation' ? 'needs_confirmation' : status === 'failed' ? 'failed' : null;
  if (expectedState === null || source.source_state !== expectedState) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STALE');

  const latest = await client.query(
    `SELECT id FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
    [snapshot.content.owner_user_id, snapshot.content.project_id, source.material_id, source.material_version],
  );
  if (latest.rows.length !== 1 || latest.rows[0]!.id !== source.snapshot_id) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STALE');

  const records = await client.query(
    `SELECT record_id, lower(btrim(record_sha256::text)) AS record_sha256, literal_quote, context, locator, uncertainty
       FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4 AND snapshot_id=$5
      ORDER BY record_id FOR SHARE`,
    [snapshot.content.owner_user_id, snapshot.content.project_id, source.material_id, source.material_version, source.snapshot_id],
  );
  if (Number(liveSource.record_count) !== records.rows.length || records.rows.length !== source.record_pins.length) {
    throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVENTORY_MISMATCH');
  }
  for (let index = 0; index < records.rows.length; index += 1) {
    const row = records.rows[index]!;
    const pin = source.record_pins[index]!;
    if (text(row, 'record_id') !== pin.record_id || text(row, 'record_sha256').trim() !== pin.record_sha256) {
      throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_INVENTORY_MISMATCH');
    }
  }
  for (const evidence of snapshot.content.evidence_records.filter(item => item.snapshot_id === source.snapshot_id)) {
    const row = records.rows.find(item => item.record_id === evidence.record_id);
    if (!row) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_MISMATCH');
    if (text(row, 'record_sha256').trim() !== evidence.record_sha256) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_HASH_MISMATCH');
    if (text(row, 'literal_quote') !== evidence.quote || text(row, 'context') !== evidence.context) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_TEXT_MISMATCH');
    if (!same(parseJson(row.locator), evidence.locator)) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_LOCATOR_MISMATCH');
    if (!same(parseJson(row.uncertainty), evidence.uncertainty)) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_UNCERTAINTY_MISMATCH');
  }
}

type StoredOcrResult = {
  response: import('@bondbuddy/contracts').OcrEngineResponse;
  page_objects: Record<string, { key: string; sha256: string }>;
};

async function verifyOcrSource(client: TargetPeriodCandidateSnapshotClient, blobs: PrivateBlobs,
  snapshot: TargetPeriodCandidateSnapshot, source: TargetPeriodCandidateSnapshot['content']['source_snapshots'][number]): Promise<void> {
  const materialPin = snapshot.content.financial_materials.find(item => item.material_id === source.material_id);
  const sourceRow = await client.query(
    `SELECT s.id, s.owner_user_id, s.project_id, s.material_id, s.material_version, s.request_id,
            s.result_hash, s.result_key, s.purpose, s.run_id, m.sha256 AS material_sha256, m.role,
            m.media_type, m.deleted_at
       FROM bb_ocr_snapshots s
       JOIN bb_material_versions m ON m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id
        AND m.id=s.material_id AND m.version=s.material_version
      WHERE s.owner_user_id=$1 AND s.project_id=$2 AND s.id=$3 AND s.material_id=$4 AND s.material_version=$5
        AND m.deleted_at IS NULL
      FOR SHARE OF s,m`,
    [snapshot.content.owner_user_id, snapshot.content.project_id, source.snapshot_id, source.material_id, source.material_version],
  );
  if (sourceRow.rows.length !== 1) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_NOT_FOUND');
  const row = sourceRow.rows[0]!;
  const resultHash = text(row, 'result_hash').trim();
  const resultKey = text(row, 'result_key');
  const materialHash = text(row, 'material_sha256').trim();
  const purpose = text(row, 'purpose');
  if (text(row, 'owner_user_id') !== snapshot.content.owner_user_id || text(row, 'project_id') !== snapshot.content.project_id ||
      text(row, 'material_id') !== source.material_id || Number(row.material_version) !== source.material_version ||
      materialHash !== source.material_sha256 || materialHash !== materialPin?.material_sha256 ||
      text(row, 'role') !== materialPin?.role || !digest.test(resultHash) || resultHash !== source.response_sha256 ||
      purpose !== 'source_preflight' || row.run_id !== null && row.run_id !== undefined ||
      source.parser_version.trim() === '' || !FINANCIAL_ROLES.has(text(row, 'role'))) {
    throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STALE');
  }
  const latest = await client.query(
    `SELECT id FROM bb_ocr_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
    [snapshot.content.owner_user_id, snapshot.content.project_id, source.material_id, source.material_version],
  );
  if (latest.rows.length !== 1 || latest.rows[0]!.id !== source.snapshot_id) throw fail('TARGET_PERIOD_CANDIDATE_SOURCE_STALE');

  const expectedKey = `users/${snapshot.content.owner_user_id}/projects/${snapshot.content.project_id}/ocr/results/${resultHash}.json`;
  if (resultKey !== expectedKey) throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_KEY_INVALID');
  const bytes = await blobs.getIfExistsBounded(resultKey, 32 * 1024 * 1024);
  if (!bytes || sha256Bytes(bytes) !== resultHash) throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INTEGRITY_FAILED');
  let stored: StoredOcrResult;
  try { stored = JSON.parse(bytes.toString('utf8')) as StoredOcrResult; }
  catch { throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID'); }
  let response: StoredOcrResult['response'];
  try {
    response = validateOcrResponse(stored?.response, { materialId: source.material_id, version: source.material_version,
      sha256: source.material_sha256, mediaType: text(row, 'media_type'), requestId: text(row, 'request_id'), purpose }, false);
  } catch {
    throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID');
  }
  if (!isObject(stored.page_objects) || response.processor_version !== source.parser_version ||
      response.status !== 'needs_confirmation' || response.error !== null || response.pages.some(page => page.image_base64 !== '')) {
    throw fail('TARGET_PERIOD_CANDIDATE_OCR_RESULT_INVALID');
  }
  const expectedPageKeys = response.pages.map(page => String(page.page)).sort();
  if (!same(Object.keys(stored.page_objects).sort(), expectedPageKeys)) throw fail('TARGET_PERIOD_CANDIDATE_OCR_PAGE_INVENTORY_MISMATCH');
  for (const page of response.pages) {
    const object = stored.page_objects[String(page.page)];
    const key = `users/${snapshot.content.owner_user_id}/projects/${snapshot.content.project_id}/ocr/${source.material_id}/${source.material_version}/${page.image_sha256}.png`;
    if (!object || object.key !== key || object.sha256 !== page.image_sha256) throw fail('TARGET_PERIOD_CANDIDATE_OCR_PAGE_PIN_MISMATCH');
    const image = await blobs.getIfExistsBounded(object.key, 32 * 1024 * 1024);
    if (!image || sha256Bytes(image) !== page.image_sha256 || image.length < 24 ||
        image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        image.readUInt32BE(16) !== page.width || image.readUInt32BE(20) !== page.height) {
      throw fail('TARGET_PERIOD_CANDIDATE_OCR_PAGE_INTEGRITY_FAILED');
    }
  }
  const responseRecords = response.records;
  const ids = responseRecords.map(record => record.record_id).sort();
  if (new Set(ids).size !== ids.length || responseRecords.some(record => !record.uncertainty.length ||
      !response.pages.some(page => page.page === record.page))) throw fail('TARGET_PERIOD_CANDIDATE_OCR_RECORD_INVENTORY_INVALID');
  const expectedRecordPins = responseRecords.map(record => ({ record_id: record.record_id, record_sha256: sha256(canonical(record)) }))
    .sort((a, b) => a.record_id.localeCompare(b.record_id));
  const expectedPagePins = response.pages.map(page => ({ page: page.page, image_sha256: page.image_sha256 }))
    .sort((a, b) => a.page - b.page);
  const expectedState = response.coverage === 'complete' ? 'needs_confirmation' : 'partial_coverage';
  if (source.source_state !== expectedState || !same(source.record_pins, expectedRecordPins) ||
      !same(source.page_image_pins, expectedPagePins)) throw fail('TARGET_PERIOD_CANDIDATE_OCR_PIN_MISMATCH');

  const recordsById = new Map(responseRecords.map(record => [record.record_id, record]));
  const pagesById = new Map(response.pages.map(page => [page.page, page]));
  for (const evidence of snapshot.content.evidence_records.filter(item => item.snapshot_id === source.snapshot_id)) {
    const record = recordsById.get(evidence.record_id);
    if (!record) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_MISMATCH');
    const page = pagesById.get(record.page);
    if (!page || evidence.record_sha256 !== sha256(canonical(record))) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_HASH_MISMATCH');
    const expected = { snapshot_id: source.snapshot_id, record_id: record.record_id, record_sha256: sha256(canonical(record)),
      quote: record.text, context: '', locator: { page: record.page, bbox: record.bbox }, uncertainty: record.uncertainty,
      page: record.page, page_image_sha256: page.image_sha256 };
    if (!same(evidence, expected)) throw fail('TARGET_PERIOD_CANDIDATE_EVIDENCE_TEXT_MISMATCH');
  }
}

function sha256Bytes(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

async function verifySources(client: TargetPeriodCandidateSnapshotClient, blobs: PrivateBlobs,
  snapshot: TargetPeriodCandidateSnapshot): Promise<void> {
  for (const source of snapshot.content.source_snapshots) {
    if (source.evidence_method === 'native_text') await verifyNativeSource(client, snapshot, source);
    else await verifyOcrSource(client, blobs, snapshot, source);
  }
}

/**
 * Persists a builder-produced envelope after validating its complete contract and re-reading
 * native/OCR source pins from owner/project-scoped immutable rows and private objects. No HTTP
 * route calls this. Non-empty requirements stay fail closed until #18 provides immutable
 * content/version hashes and a corresponding locked consumer.
 */
export async function appendTargetPeriodCandidateSnapshot(
  dependencies: TargetPeriodCandidateSnapshotDependencies,
  request: AppendTargetPeriodCandidateSnapshotRequest,
): Promise<StoredTargetPeriodCandidateSnapshot> {
  if (![request.ownerUserId, request.projectId, request.requestId].every(value => identifier.test(value)) ||
      !validTargetPeriodCandidateSnapshot(request.snapshot) ||
      request.snapshot.content.owner_user_id !== request.ownerUserId || request.snapshot.content.project_id !== request.projectId ||
      !digest.test(request.snapshot.content_sha256) ||
      sha256(canonicalTargetPeriodCandidateSnapshotContent(request.snapshot)) !== request.snapshot.content_sha256 ||
      Buffer.byteLength(canonical(request.snapshot.content), 'utf8') > 64 * 1024 * 1024) {
    throw fail('TARGET_PERIOD_CANDIDATE_SNAPSHOT_INVALID');
  }
  if (request.snapshot.content.supplemental_requirements.message_ids.length > 0) {
    throw fail('TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED');
  }

  const client = await dependencies.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN'); transactionOpen = true;
    // Project then source material/parse locks match the input-lock consumer's planned order.
    // The project row remains locked while exact request replay is checked; historical retries
    // remain readable after the draft advances, while new writes must match its current state.
    const project = await lockProject(client, request);
    const reqHash = requestHash(request);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`target-period-candidate-request:${request.ownerUserId}:${request.projectId}:${request.requestId}`]);
    const prior = await client.query(
      `SELECT id, owner_user_id, project_id, candidate_set_id, candidate_set_version, content_sha256, content, request_id, request_hash, created_at
         FROM bb_target_period_candidate_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND request_id=$3`,
      [request.ownerUserId, request.projectId, request.requestId],
    );
    if (prior.rows.length > 0) {
      if (prior.rows.length !== 1 || text(prior.rows[0]!, 'request_hash').trim() !== reqHash) {
        throw fail('TARGET_PERIOD_CANDIDATE_IDEMPOTENCY_CONFLICT');
      }
      const replay = storedSnapshot(prior.rows[0]!, true);
      await client.query('COMMIT'); transactionOpen = false;
      return replay;
    }

    verifyCurrentProject(project, request);

    // The project FOR UPDATE lock above conflicts with the KEY SHARE lock required by
    // project FKs on the submission registration's snapshot and submission rows. It therefore either
    // committed before this query (and is visible) or waits until after this snapshot.
    // Any later input-lock consumer must revalidate message metadata before use.
    // Do not take the submission advisory lock here: registration takes it before its FK
    // insert, which would invert the project/advisory lock order and allow a deadlock.
    const messages = await client.query(`SELECT 1 FROM bb_user_submission_versions
      WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message' LIMIT 1`,
    [request.ownerUserId, request.projectId]);
    if (messages.rows.length) throw fail('TARGET_PERIOD_CANDIDATE_REQUIREMENTS_STORE_REQUIRED');

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`target-period-candidate:${request.ownerUserId}:${request.projectId}:${request.snapshot.candidate_set_id}`]);
    await verifyCurrentMaterials(client, request);
    await verifySources(client, dependencies.blobs, request.snapshot);

    const latestVersion = await client.query(
      `SELECT COALESCE(max(candidate_set_version),0)::int AS version FROM bb_target_period_candidate_snapshots
        WHERE owner_user_id=$1 AND project_id=$2 AND candidate_set_id=$3`,
      [request.ownerUserId, request.projectId, request.snapshot.candidate_set_id],
    );
    if (request.snapshot.candidate_set_version !== Number(latestVersion.rows[0]?.version ?? 0) + 1) {
      throw fail('TARGET_PERIOD_CANDIDATE_VERSION_CONFLICT');
    }

    const id = (dependencies.newId ?? randomUUID)();
    const inserted = await client.query(
      `INSERT INTO bb_target_period_candidate_snapshots
         (id,owner_user_id,project_id,candidate_set_id,candidate_set_version,content_sha256,content,request_id,request_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       RETURNING id,owner_user_id,project_id,candidate_set_id,candidate_set_version,content_sha256,content,request_id,request_hash,created_at`,
      [id, request.ownerUserId, request.projectId, request.snapshot.candidate_set_id, request.snapshot.candidate_set_version,
        request.snapshot.content_sha256, JSON.stringify(request.snapshot.content), request.requestId, reqHash],
    );
    if (inserted.rows.length !== 1) throw fail('TARGET_PERIOD_CANDIDATE_PERSIST_FAILED');
    await client.query(
      `INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
       VALUES($1,$2,'target_period_candidate_snapshot',$3,'project.target_period_candidates_snapshotted',$4::jsonb)`,
      [(dependencies.newId ?? randomUUID)(), request.ownerUserId, id, JSON.stringify({
        project_id: request.projectId, candidate_set_id: request.snapshot.candidate_set_id,
        candidate_set_version: request.snapshot.candidate_set_version, content_sha256: request.snapshot.content_sha256,
        request_id: request.requestId,
      })],
    );
    await client.query('COMMIT'); transactionOpen = false;
    return storedSnapshot(inserted.rows[0]!, false);
  } catch (error) {
    if (transactionOpen) { try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error instanceof Error && error.name === 'TargetPeriodCandidateSnapshotRepositoryError'
      ? error : fail('TARGET_PERIOD_CANDIDATE_PERSIST_FAILED');
  } finally { client.release(); }
}
