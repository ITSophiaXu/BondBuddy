import type { Pool } from 'pg';
import {
  PDF_QUALITY_STAGE,
  PDF_QUALITY_VERSION,
  isPdfQualityJobVersion,
  readPdfQuality,
} from '@bondbuddy/contracts';
import { inspectPdfQuality } from './pdf-quality.js';
import { ERROR_CODES, type ErrorCode } from '@bondbuddy/contracts';
import { Problem } from '@bondbuddy/api/data';
import {
  claimMaterialParse,
  completeMaterialParseStage,
  deferMaterialParseForCapacity,
  failMaterialParse,
  pauseMaterialParse,
  renewMaterialParse,
  succeedMaterialParse,
  type MaterialParseLease,
  type MaterialParseResult,
} from '@bondbuddy/api/material-jobs';
import { DOCUMENT_PARSER_MEDIA_TYPES } from './document-parser.js';
import { inspectAuthorizedPdf, type MaterialParserDependencies } from './material-parser.js';
import {
  getParseSnapshotForMaterialJob,
  parseAndPersistAuthorizedMaterial,
  type ParseEvidenceDependencies,
  type StoredParseSnapshot,
} from './parse-evidence-repository.js';
import {
  appendHistoricalOcrRecognition,
  appendHistoricalRecognition,
  getLatestHistoricalProfile,
  type HistoricalOcrProfileDependencies,
  type HistoricalProfileDependencies,
} from './historical-profile-repository.js';
import { recognizeHistoricalOcr } from './historical-ocr-recognition.js';
import { readOcr } from '@bondbuddy/api/ocr';
import { recognizeHistoricalNativeText } from './historical-native-recognition.js';
import { performance } from 'node:perf_hooks';
import { OcrProcessingError, type OcrProcessingMetrics } from './ocr.js';
import { recordMaterialParseProcessingCost } from '@bondbuddy/api/material-jobs';
import { createHash } from 'node:crypto';
import { appendIssuerIdentitySourceRecord } from '@bondbuddy/api/issuer-identity-source';

export interface IssuerIdentityObservationContext {
  ownerUserId: string;
  projectId: string;
  materialId: string;
  materialVersion: number;
  snapshotId: string;
  materialSha256: string;
  evidence: readonly { recordId: string; recordSha256: string; locatorType: string }[];
}
export interface IssuerIdentityObservationCandidate {
  sourceRecordId: string;
  issuerDisplayName: string;
  entityId: string;
  observationId?: string;
  requestId?: string;
}

export interface MaterialParseJobDependencies {
  pool: Pool;
  pdfQualityInspector?: typeof inspectPdfQuality;
  /** Existing #13 parser bridge dependencies: private Blob reader, parser bridge and optional parse cache. */
  material: MaterialParserDependencies;
  evidence?: ParseEvidenceDependencies;
  profiles?: HistoricalProfileDependencies;
  /** #15 supplies a reviewed selection algorithm. Absence yields no observations. */
  issuerIdentityProducer?: (
    context: IssuerIdentityObservationContext,
  ) => Promise<readonly IssuerIdentityObservationCandidate[]>;
  leaseSeconds?: number;
  /** Test seam only: runs after each durable stage checkpoint, e.g. to simulate a process crash. */
  afterStage?: (stage: string, lease: MaterialParseLease) => Promise<void>;
  /**
   * #17 OCR hook: server-side OCR processor (production: `processOcrMaterial` from ./ocr.js with
   * purpose `source_preflight`). Absent => OCR-dependent jobs pause at `awaiting_ocr` as before.
   */
  ocr?: (input: {
    owner: string;
    projectId: string;
    materialId: string;
    version: number;
    requestId: string;
  }) => Promise<{
    snapshot_id: string;
    ocr_pages?: number;
    pages?: number;
    ocr_engine?: string;
    ocr_engine_version?: string;
    processing_ms?: number;
  }>;
  /** Private Blob access for turning a historical PDF's OCR snapshot into a recognition profile. */
  ocrProfiles?: HistoricalOcrProfileDependencies;
  /** Runtime hook: registers the active lease so graceful shutdown can release it. */
  onLease?: (lease: MaterialParseLease | null) => void;
}

export type MaterialParseRunOutcome =
  'idle' | 'succeeded' | 'paused' | 'retry_scheduled' | 'waiting_capacity' | 'failed' | 'lost';

const HISTORICAL_MEDIA = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
];
const OCR_WARNINGS = new Set(['PDF_PAGES_WITHOUT_TEXT', 'PDF_IMAGES_NOT_OCRD']);
const TERMINAL: Record<string, ErrorCode> = {
  NOT_FOUND: 'NOT_FOUND',
  PARSE_EVIDENCE_MATERIAL_NOT_AUTHORIZED: 'NOT_FOUND',
  MATERIAL_ROLE_MISMATCH: 'NOT_FOUND',
  MATERIAL_INTEGRITY_MISMATCH: 'MATERIAL_CONTENT_MISMATCH',
  PARSE_EVIDENCE_MATERIAL_MISMATCH: 'MATERIAL_CONTENT_MISMATCH',
  UNSUPPORTED_MEDIA_TYPE: 'MATERIAL_FORMAT_UNSUPPORTED',
  PARSER_VERSION_MISMATCH: 'VALIDATION_FAILED',
  PARSER_RESULT_CONTAINS_PRIVATE_REFERENCE: 'VALIDATION_FAILED',
  // #17 capacity: deterministic for the same bytes, so never retried (a retry only repeats the failure).
  MATERIAL_PARSE_SIZE_LIMIT: 'MATERIAL_TOO_LARGE',
  MATERIAL_PARSE_OUTPUT_LIMIT: 'MATERIAL_TOO_LARGE',
  MATERIAL_PARSE_MEMORY_LIMIT: 'MATERIAL_TOO_LARGE',
  PARSE_EVIDENCE_RECORD_TOO_LARGE: 'MATERIAL_TOO_LARGE',
};
// Structured Python parser failures that are not public codes themselves.
const PARSER_FAILURE: Record<string, ErrorCode> = { MATERIAL_LIMIT_EXCEEDED: 'MATERIAL_TOO_LARGE' };
// #17 OCR processor failures (apps/worker/src/ocr.ts). OCR_PROCESS_UNAVAILABLE pauses instead (engine not installed).
const OCR_TERMINAL: Record<string, ErrorCode> = {
  OCR_UNSUPPORTED_FORMAT: 'MATERIAL_FORMAT_UNSUPPORTED',
  OCR_INPUT_LIMIT: 'VALIDATION_FAILED',
  OCR_SOURCE_INTEGRITY_FAILED: 'MATERIAL_CONTENT_MISMATCH',
  OCR_PRIVATE_PATH_IN_RESULT: 'VALIDATION_FAILED',
  INVALID_OCR_BUDGET: 'VALIDATION_FAILED',
};
const OCR_RETRYABLE: Record<string, ErrorCode> = {
  OCR_PROCESS_TIMEOUT: 'MATERIAL_UNREADABLE',
  OCR_PROCESS_FAILED: 'MATERIAL_UNREADABLE',
  OCR_INVALID_RESPONSE: 'MATERIAL_UNREADABLE',
  OCR_OUTPUT_LIMIT: 'MATERIAL_UNREADABLE',
  OCR_FAILED: 'MATERIAL_UNREADABLE',
};
const OCR_MEDIA = ['application/pdf', 'image/png', 'image/jpeg'];
const RETRYABLE: Record<string, ErrorCode> = {
  MATERIAL_BYTES_UNAVAILABLE: 'DATA_UNAVAILABLE',
  MATERIAL_LOOKUP_FAILED: 'DATA_UNAVAILABLE',
  MATERIAL_PARSE_CACHE_FAILED: 'DATA_UNAVAILABLE',
  MATERIAL_TEMP_CLEANUP_FAILED: 'DATA_UNAVAILABLE',
  MATERIAL_PARSE_FAILED: 'MATERIAL_UNREADABLE',
  CHECKPOINT_SNAPSHOT_MISSING: 'DATA_UNAVAILABLE',
  MATERIAL_PARSE_TIMEOUT: 'MATERIAL_PARSE_TIMEOUT',
};

class StageFailure extends Error {
  constructor(
    public code: ErrorCode,
    public retryable: boolean,
  ) {
    super(code);
  }
}

/** Maps repository error codes to the public error enum; unknown failures are retryable infrastructure errors. */
export function classifyMaterialParseError(error: unknown): {
  code: ErrorCode;
  retryable: boolean;
  category: 'material_parse' | 'ocr' | 'internal';
} {
  if (error instanceof StageFailure)
    return { code: error.code, retryable: error.retryable, category: 'material_parse' };
  const message = error instanceof Error ? error.message : '';
  if (TERMINAL[message])
    return { code: TERMINAL[message], retryable: false, category: 'material_parse' };
  if (RETRYABLE[message])
    return { code: RETRYABLE[message], retryable: true, category: 'material_parse' };
  if (OCR_TERMINAL[message])
    return { code: OCR_TERMINAL[message], retryable: false, category: 'ocr' };
  if (OCR_RETRYABLE[message])
    return { code: OCR_RETRYABLE[message], retryable: true, category: 'ocr' };
  if (/^(INVALID_|HISTORICAL_PROFILE_)/.test(message))
    return { code: 'VALIDATION_FAILED', retryable: false, category: 'material_parse' };
  return { code: 'DATA_UNAVAILABLE', retryable: true, category: 'internal' };
}

const lostLease = (error: unknown) => error instanceof Problem && error.code === 'ALREADY_TERMINAL';
const elapsedMs = (started: number) => Math.max(1, Math.ceil(performance.now() - started));

async function activeMaterial(pool: Pool, lease: MaterialParseLease) {
  const q = await pool.query(
    `SELECT role, media_type, lower(btrim(sha256::text)) AS sha256 FROM bb_material_versions
    WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL`,
    [lease.owner, lease.projectId, lease.materialId, lease.materialVersion],
  );
  const row = q.rows[0];
  if (!row) throw new StageFailure('NOT_FOUND', false);
  if (row.sha256 !== lease.materialSha256)
    throw new StageFailure('MATERIAL_CONTENT_MISMATCH', false);
  return row as { role: string; media_type: string; sha256: string };
}

/**
 * Claims one material parse job and runs its remaining stages with the existing worker
 * repositories. Completed stages come from the durable checkpoint and are never redone.
 */
export async function runMaterialParseOnce(
  dependencies: MaterialParseJobDependencies,
): Promise<MaterialParseRunOutcome> {
  const { pool } = dependencies;
  const leaseSeconds = dependencies.leaseSeconds ?? 30;
  const evidence = dependencies.evidence ?? { pool };
  const profiles = dependencies.profiles ?? { pool };
  const lease = await claimMaterialParse(pool, leaseSeconds);
  dependencies.onLease?.(lease);
  if (!lease) return 'idle';
  const heartbeat = setInterval(
    () => {
      void renewMaterialParse(pool, lease, leaseSeconds).catch(() => clearInterval(heartbeat));
    },
    Math.max(1000, leaseSeconds * 400),
  );
  const context = {
    ownerUserId: lease.owner,
    projectId: lease.projectId,
    materialId: lease.materialId,
    materialVersion: lease.materialVersion,
  };
  const stage = async (
    name: 'parse_evidence' | 'historical_profile' | 'ocr_evidence' | typeof PDF_QUALITY_STAGE,
    value: Record<string, unknown>,
  ) => {
    await completeMaterialParseStage(pool, lease, name, value);
    await dependencies.afterStage?.(name, lease);
  };
  try {
    const material = await activeMaterial(pool, lease);
    const stages = lease.checkpoint.stages ?? {};
    if (isPdfQualityJobVersion(lease.parserVersion)) {
      if (material.role !== 'audit' || material.media_type !== 'application/pdf')
        throw new StageFailure('NOT_FOUND', false);
      if (!isPdfQualityJobVersion(readPdfQuality(stages[PDF_QUALITY_STAGE])?.version ?? '')) {
        const quality = await inspectAuthorizedPdf(
          dependencies.material,
          {
            ...context,
            version: lease.materialVersion,
            requestId: lease.jobId + '-quality',
            requiredRole: 'audit',
          },
          dependencies.pdfQualityInspector ?? inspectPdfQuality,
        );
        if (!readPdfQuality(quality) || quality.version !== PDF_QUALITY_VERSION)
          throw new StageFailure('DATA_UNAVAILABLE', true);
        await stage(PDF_QUALITY_STAGE, { ...quality });
      }
      // Completion means the measurement finished, not that the source was parsed or readable.
      await succeedMaterialParse(pool, lease, {
        pdf_quality: readPdfQuality(lease.checkpoint.stages?.[PDF_QUALITY_STAGE])!,
      });
      return 'succeeded';
    }
    const parseable = (DOCUMENT_PARSER_MEDIA_TYPES as readonly string[]).includes(
      material.media_type,
    );
    const needsNativeRecognition =
      material.role === 'historical' && HISTORICAL_MEDIA.includes(material.media_type);
    let snapshot: StoredParseSnapshot | null = null;
    if (parseable) {
      const saved = stages.parse_evidence as { snapshot_id?: string } | undefined;
      if (saved?.snapshot_id) {
        // Rebuild all anchor/text rows only when the historical recognition stage consumes them.
        // Other jobs need status/warnings only; the immutable full evidence remains in PostgreSQL.
        snapshot = await getParseSnapshotForMaterialJob(
          evidence,
          context,
          saved.snapshot_id,
          needsNativeRecognition,
        );
        if (!snapshot) throw new Error('CHECKPOINT_SNAPSHOT_MISSING');
      } else {
        const started = performance.now();
        try {
          const inspect = dependencies.pdfQualityInspector ?? inspectPdfQuality;
          const materialDependencies: MaterialParserDependencies = { ...dependencies.material };
          // Custom parser fixtures opt into the real inspection explicitly. Production
          // always runs the bounded probe once, and retains it even if parsing times out.
          if (
            (!dependencies.material.parser || dependencies.pdfQualityInspector) &&
            !readPdfQuality(stages[PDF_QUALITY_STAGE])
          ) {
            materialDependencies.onStagedPdf = async (path) => {
              const quality = await inspect(path);
              await stage(PDF_QUALITY_STAGE, { ...quality });
            };
          }
          snapshot = await parseAndPersistAuthorizedMaterial(materialDependencies, evidence, {
            ownerUserId: lease.owner,
            projectId: lease.projectId,
            materialId: lease.materialId,
            version: lease.materialVersion,
            requestId: `${lease.jobId}-parse`,
          });
          const failed =
            snapshot.response.status === 'failed' ||
            snapshot.parserVersion !== lease.parserVersion ||
            snapshot.contentSha256 !== lease.materialSha256;
          await recordMaterialParseProcessingCost(pool, lease, 'parse', {
            unit: 'document',
            quantity: 1,
            processing_ms: elapsedMs(started),
            outcome: failed ? 'failed' : 'succeeded',
          });
          if (snapshot.parserVersion !== lease.parserVersion)
            throw new Error('PARSER_VERSION_MISMATCH');
          if (snapshot.contentSha256 !== lease.materialSha256)
            throw new Error('PARSE_EVIDENCE_MATERIAL_MISMATCH');
        } catch (error) {
          if (error instanceof Error && error.message === 'MATERIAL_PARSE_CAPACITY_WAIT')
            throw error;
          // Preserve a failed parser attempt (including a failed structured response) before
          // the job retry/failure transition is committed.
          await recordMaterialParseProcessingCost(pool, lease, 'parse', {
            unit: 'document',
            quantity: 1,
            processing_ms: elapsedMs(started),
            outcome: 'failed',
          });
          throw error;
        }
        await stage('parse_evidence', {
          snapshot_id: snapshot.snapshotId,
          parse_status: snapshot.response.status,
          parser_version: snapshot.parserVersion,
        });
      }
      if (snapshot.response.status === 'failed') {
        // The failed snapshot stays as evidence; the job ends with the parser's structured code.
        const code = snapshot.response.error?.code;
        throw new StageFailure(
          code && PARSER_FAILURE[code]
            ? PARSER_FAILURE[code]
            : code && (ERROR_CODES as readonly string[]).includes(code)
              ? (code as ErrorCode)
              : 'MATERIAL_UNREADABLE',
          false,
        );
      }
    }
    const produceIssuerObservations = async () => {
      if (dependencies.issuerIdentityProducer && material.role === 'historical' && snapshot) {
        const anchors = await pool.query(
          `SELECT record_id, lower(btrim(record_sha256::text)) AS record_sha256, locator_type
          FROM bb_parse_evidence WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=$4
            AND snapshot_id=$5 AND uncertainty='[]'::jsonb ORDER BY record_id`,
          [
            lease.owner,
            lease.projectId,
            lease.materialId,
            lease.materialVersion,
            snapshot.snapshotId,
          ],
        );
        const observationContext: IssuerIdentityObservationContext = {
          ...context,
          snapshotId: snapshot.snapshotId,
          materialSha256: lease.materialSha256,
          evidence: anchors.rows.map((row) => ({
            recordId: String(row.record_id),
            recordSha256: String(row.record_sha256),
            locatorType: String(row.locator_type),
          })),
        };
        const candidates = await dependencies.issuerIdentityProducer(observationContext);
        const allowed = new Set(observationContext.evidence.map((anchor) => anchor.recordId));
        for (const candidate of candidates) {
          if (!allowed.has(candidate.sourceRecordId))
            throw new Error('INVALID_ISSUER_IDENTITY_SOURCE_ANCHOR');
          await appendIssuerIdentitySourceRecord(
            { pool },
            {
              ...context,
              requestId:
                candidate.requestId ??
                `issuer-${createHash('sha256').update(`${lease.jobId}:${snapshot.snapshotId}:${candidate.sourceRecordId}`).digest('hex')}`,
              observationId: candidate.observationId,
              sourceRecordId: candidate.sourceRecordId,
              issuerDisplayName: candidate.issuerDisplayName,
              entityId: candidate.entityId,
            },
          );
        }
      }
    };
    let profile: { profile_version: number; state: string } | null = null;
    if (snapshot && needsNativeRecognition) {
      if (!snapshot.evidenceComplete) throw new Error('PARSE_SNAPSHOT_EVIDENCE_INCOMPLETE');
      const saved = stages.historical_profile as
        { profile_version?: number; state?: string } | undefined;
      if (saved?.profile_version)
        profile = { profile_version: saved.profile_version, state: String(saved.state) };
      else {
        const latest = await getLatestHistoricalProfile(profiles, context);
        // A user correction is authoritative for this material version; never append recognition over it.
        const stored =
          latest?.writeKind === 'correction'
            ? latest
            : await appendHistoricalRecognition(
                profiles,
                { ...context, requestId: `${lease.jobId}-profile` },
                recognizeHistoricalNativeText(snapshot.response, { profileVersion: 1 }),
              );
        profile = { profile_version: stored.profileVersion, state: stored.recognition.state };
        await stage('historical_profile', {
          profile_version: profile.profile_version,
          state: profile.state,
        });
      }
    }
    const needsOcr =
      !parseable || snapshot!.response.warnings.some((warning) => OCR_WARNINGS.has(warning.code));
    const parseStatus = snapshot?.response.status ?? null;
    if (needsOcr) {
      const pendingOcr: MaterialParseResult = {
        outcome: 'pending_ocr',
        parse_status: parseStatus,
        profile_version: profile?.profile_version ?? null,
        pending_capabilities: ['ocr'],
      };
      if (!dependencies.ocr || !OCR_MEDIA.includes(material.media_type)) {
        await pauseMaterialParse(pool, lease, 'awaiting_ocr', pendingOcr);
        return 'paused';
      }
      // #17 OCR hook: the OCR snapshot is a checkpointed stage; a resumed job never re-runs it.
      let snapshotId = (stages.ocr_evidence as { snapshot_id?: string } | undefined)?.snapshot_id;
      if (!snapshotId) {
        const started = performance.now();
        try {
          const result = await dependencies.ocr({
            owner: lease.owner,
            projectId: lease.projectId,
            materialId: lease.materialId,
            version: lease.materialVersion,
            requestId: `${lease.jobId}-ocr`,
          });
          const pages = result.ocr_pages ?? result.pages ?? null;
          await recordMaterialParseProcessingCost(pool, lease, 'ocr', {
            unit: 'ocr_page',
            quantity: pages,
            ocr_pages: pages,
            ocr_engine: result.ocr_engine ?? null,
            ocr_engine_version: result.ocr_engine_version ?? null,
            processing_ms: result.processing_ms ?? elapsedMs(started),
            outcome: 'succeeded',
          });
          snapshotId = result.snapshot_id;
        } catch (error) {
          if (error instanceof Error && error.message === 'OCR_PROCESS_UNAVAILABLE') {
            await pauseMaterialParse(pool, lease, 'awaiting_ocr', pendingOcr, 'ocr_unavailable');
            return 'paused';
          }
          const metrics: OcrProcessingMetrics =
            error instanceof OcrProcessingError
              ? error.processingMetrics
              : {
                  ocr_pages: null,
                  ocr_engine: null,
                  ocr_engine_version: null,
                  processing_ms: elapsedMs(started),
                };
          await recordMaterialParseProcessingCost(pool, lease, 'ocr', {
            unit: 'ocr_page',
            quantity: metrics.ocr_pages,
            ocr_pages: metrics.ocr_pages,
            ocr_engine: metrics.ocr_engine,
            ocr_engine_version: metrics.ocr_engine_version,
            processing_ms: metrics.processing_ms,
            outcome: 'failed',
          });
          throw error;
        }
        await stage('ocr_evidence', { snapshot_id: snapshotId });
      }
      if (
        dependencies.ocrProfiles &&
        material.role === 'historical' &&
        material.media_type === 'application/pdf'
      ) {
        const review = await readOcr(
          pool,
          dependencies.ocrProfiles.blobs,
          lease.owner,
          lease.projectId,
          lease.materialId,
        );
        if (review.snapshot_id === snapshotId) {
          try {
            const stored = await appendHistoricalOcrRecognition(
              dependencies.ocrProfiles,
              { ...context, requestId: `${lease.jobId}-ocr-profile` },
              recognizeHistoricalOcr(review, { profileVersion: 1 }),
            );
            profile = { profile_version: stored.profileVersion, state: stored.recognition.state };
          } catch (error) {
            // A user correction stays authoritative; the OCR evidence is still recorded.
            if (!(
              error instanceof Error && error.message === 'HISTORICAL_PROFILE_ALREADY_CORRECTED'
            ))
              throw error;
          }
        }
      }
      // OCR text is evidence to review, never a confirmed fact.
      await produceIssuerObservations();
      await succeedMaterialParse(pool, lease, {
        outcome: 'needs_confirmation',
        parse_status: parseStatus,
        profile_version: profile?.profile_version ?? null,
        pending_capabilities: [],
      });
      return 'succeeded';
    }
    const confirmed = parseStatus === 'parsed' && (profile === null || profile.state === 'ready');
    await produceIssuerObservations();
    await succeedMaterialParse(pool, lease, {
      outcome: confirmed ? 'parsed' : 'needs_confirmation',
      parse_status: parseStatus,
      profile_version: profile?.profile_version ?? null,
      pending_capabilities: [],
    });
    return 'succeeded';
  } catch (error) {
    if (error instanceof Error && error.message === 'SYNTHETIC_CRASH') throw error;
    if (lostLease(error)) return 'lost';
    try {
      if (error instanceof Error && error.message === 'MATERIAL_PARSE_CAPACITY_WAIT')
        return await deferMaterialParseForCapacity(pool, lease);
      return await failMaterialParse(pool, lease, classifyMaterialParseError(error));
    } catch (finishError) {
      if (lostLease(finishError)) return 'lost';
      throw finishError;
    }
  } finally {
    clearInterval(heartbeat);
    dependencies.onLease?.(null);
  }
}

// Operational one-shot drain: processes at most BB_PARSE_JOB_BATCH jobs with the versioned Python parser, then exits.
// Compose runs parse claims through WorkerRuntime; this CLI remains available for an operator-triggered drain.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { Pool: PgPool } = await import('pg');
  const { azureBlobs } = await import('@bondbuddy/api/data');
  if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING)
    throw new Error('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING are required');
  const batch = Number(process.env.BB_PARSE_JOB_BATCH ?? '10');
  if (!Number.isInteger(batch) || batch < 1 || batch > 100)
    throw new Error('Invalid BB_PARSE_JOB_BATCH');
  const pool = new PgPool({ connectionString: process.env.DATABASE_URL });
  const blobs = azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const { createIssuerIdentityProducer } = await import('./issuer-identity-producer.js');
  try {
    for (let i = 0; i < batch; i++) {
      const outcome = await runMaterialParseOnce({
        pool,
        issuerIdentityProducer: createIssuerIdentityProducer(pool),
        material: {
          pool,
          blobs: {
            getPrivate: (key) => blobs.getIfExists(key),
            readToFile: (key, path, max) => blobs.readToFile!(key, path, max),
          },
        },
      });
      process.stdout.write(`${JSON.stringify({ outcome })}\n`);
      if (outcome === 'idle') break;
    }
  } finally {
    await pool.end();
  }
}
