import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  OCR_V2_LIMITS, OcrAggregateV2Schema, OcrBatchRequestV2Schema, OcrBatchResponseV2Schema,
  OcrDocumentIdentityV2Schema, OcrExecutionContextV2Schema, OcrPageCheckpointV2Schema,
  OcrPageIdentityV2Schema, OcrPageResultV2Schema,
  type OcrCheckpointRefV2, type OcrDocumentIdentityV2, type OcrExecutionContextV2,
  type OcrPageCheckpointV2, type OcrPageIdentityV2, type OcrPageResultV2
} from './ocr.js';

function requireValid(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new Error(`Invalid OCR v2 contract: ${detail}`);
}

function checked<T extends TSchema>(schema: T, value: unknown): Static<T> {
  requireValid(Value.Check(schema, value), 'schema mismatch');
  return value;
}

// OCR v2 wire hashes: sorted JSON object keys, original array order, UTF-8, no whitespace.
// Kept browser-compatible; importing shared contracts must not pull in node:crypto.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function documentIdentity(value: unknown): OcrDocumentIdentityV2 {
  const document = checked(OcrDocumentIdentityV2Schema, value);
  requireValid(['application/pdf', 'image/png', 'image/jpeg'].includes(document.material.media_type), 'unsupported material');
  requireValid(document.material.media_type === 'application/pdf' || document.page_count === 1, 'image physical page count');
  requireValid(Number.isSafeInteger(document.material.material_version), 'material version');
  const languages = document.engine.language.split('+');
  requireValid(new Set(languages).size === languages.length &&
    languages.every(language => Object.hasOwn(document.engine.language_data_sha256, language)), 'missing or repeated language data');
  return document;
}

function pageIdentity(value: unknown): OcrPageIdentityV2 {
  const identity = checked(OcrPageIdentityV2Schema, value);
  documentIdentity(identity.document);
  requireValid(identity.page <= identity.document.page_count, 'physical page out of range');
  return identity;
}

function pageResult(value: unknown): OcrPageResultV2 {
  const result = checked(OcrPageResultV2Schema, value);
  const { page, records } = result;
  requireValid(page.width * page.height <= OCR_V2_LIMITS.page_pixels, 'page pixel limit');
  const ids = new Set<string>();
  for (const record of records) {
    const [left, top, right, bottom] = record.bbox;
    requireValid(record.page === page.page && !ids.has(record.record_id), 'record page or duplicate record ID');
    requireValid(right > left && bottom > top && right <= page.width && bottom <= page.height, 'record bounds');
    requireValid(record.uncertainty.length > 0 && record.uncertainty.every(item => item.trim().length > 0), 'record uncertainty required');
    requireValid(record.numeric.kind === 'number'
      ? record.numeric.decimal !== null && /^-?\d+(?:\.\d+)?$/.test(record.numeric.decimal)
      : record.numeric.decimal === null, 'numeric value');
    if (record.cell) {
      requireValid([record.cell.row, record.cell.column, record.cell.row_span, record.cell.column_span]
        .every(Number.isSafeInteger), 'table coordinates');
    }
    ids.add(record.record_id);
  }
  return result;
}

export async function ocrPageIdentitySha256V2(value: OcrPageIdentityV2): Promise<string> {
  return sha256(new TextEncoder().encode(canonical({
    schema_version: 'ocr-page-identity-v2', identity: pageIdentity(value)
  })));
}

const resultHashInputSchema = Type.Pick(OcrPageCheckpointV2Schema, ['identity_sha256', 'source_request_id', 'result']);
export async function ocrPageResultSha256V2(
  value: Pick<OcrPageCheckpointV2, 'identity_sha256' | 'source_request_id' | 'result'>
): Promise<string> {
  checked(resultHashInputSchema, value);
  pageResult(value.result);
  return sha256(new TextEncoder().encode(canonical({
    schema_version: 'ocr-page-result-v2', ...value
  })));
}

/** Validates read-back evidence, not authorization, storage durability or audited facts. */
export async function validateOcrPageCheckpointV2(
  value: unknown, expected: OcrPageIdentityV2, image: Uint8Array
): Promise<OcrPageCheckpointV2> {
  const checkpoint = checked(OcrPageCheckpointV2Schema, value);
  pageIdentity(expected);
  requireValid(Value.Equal(checkpoint.identity, expected), 'checkpoint identity mismatch');
  const result = pageResult(checkpoint.result);
  requireValid(result.page.page === expected.page &&
    result.page.width * result.page.height <= expected.document.rendering.max_page_pixels, 'checkpoint page or rendering limit');
  requireValid(checkpoint.identity_sha256 === await ocrPageIdentitySha256V2(expected), 'identity hash mismatch');
  requireValid(checkpoint.result_sha256 === await ocrPageResultSha256V2({
    identity_sha256: checkpoint.identity_sha256, source_request_id: checkpoint.source_request_id, result
  }), 'result hash mismatch');
  requireValid(image instanceof Uint8Array && image.length >= 24 && image.length <= 48 * 1024 * 1024, 'page image size');
  const header = new DataView(image.buffer, image.byteOffset, image.byteLength);
  requireValid([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => image[index] === byte) &&
    header.getUint32(16) === result.page.width && header.getUint32(20) === result.page.height, 'page PNG header or dimensions');
  requireValid(result.page.image_sha256 === await sha256(image), 'page image hash mismatch');
  return checkpoint;
}

function context(value: unknown): OcrExecutionContextV2 {
  const result = checked(OcrExecutionContextV2Schema, value);
  if (result.run) requireValid(Number.isSafeInteger(result.run.input_revision), 'input revision');
  return result;
}

function orderedPages(pages: number[], document: OcrDocumentIdentityV2, execution: OcrExecutionContextV2): void {
  requireValid(pages.every((page, index) => page >= 1 && page <= document.page_count &&
    (index === 0 || pages[index - 1] < page)), 'unordered, duplicate or out-of-range pages');
  if (execution.purpose === 'source_preflight') {
    requireValid(pages.length <= OCR_V2_LIMITS.preflight_pages &&
      pages.every(page => page <= OCR_V2_LIMITS.preflight_pages), 'source preflight page budget');
  }
}

export async function validateOcrBatchRequestV2(value: unknown) {
  const request = checked(OcrBatchRequestV2Schema, value);
  documentIdentity(request.document);
  context(request.context);
  orderedPages(request.pages, request.document, request.context);
  orderedPages(request.reuse.map(ref => ref.page), request.document, request.context);
  for (const ref of request.reuse) {
    requireValid(request.pages.includes(ref.page), 'reuse outside requested pages');
    requireValid(ref.identity_sha256 === await ocrPageIdentitySha256V2({ document: request.document, page: ref.page }), 'reuse identity hash mismatch');
    requireValid(ref.source_request_id !== request.request_id, 'reuse must reference an earlier request');
  }
  return request;
}

/** The future owner-scoped storage reader must return exact, bounded, read-back bytes. */
export type OcrCheckpointReaderV2 = (ref: OcrCheckpointRefV2) => Promise<{ checkpoint: unknown; image: Uint8Array }>;

async function readCheckpoint(ref: OcrCheckpointRefV2, document: OcrDocumentIdentityV2, read: OcrCheckpointReaderV2) {
  const evidence = await read(ref);
  const checkpoint = await validateOcrPageCheckpointV2(evidence.checkpoint, { document, page: ref.page }, evidence.image);
  requireValid(checkpoint.identity_sha256 === ref.identity_sha256 && checkpoint.result_sha256 === ref.result_sha256 &&
    checkpoint.source_request_id === ref.source_request_id, 'checkpoint reference mismatch');
  return checkpoint;
}

export async function validateOcrBatchResponseV2(value: unknown, expectedRequest: unknown, read: OcrCheckpointReaderV2) {
  const request = await validateOcrBatchRequestV2(expectedRequest);
  const response = checked(OcrBatchResponseV2Schema, value);
  requireValid(response.request_id === request.request_id && Value.Equal(response.document, request.document) &&
    Value.Equal(response.context, request.context), 'batch request mismatch');
  requireValid(Value.Equal(response.page_results.map(page => page.page), request.pages), 'batch must account for every requested page exactly once');
  let attempts = 0, unknownAttempts = false, successes = 0;
  for (const outcome of response.page_results) {
    if (outcome.status === 'failed') {
      requireValid(outcome.error.trim().length > 0, 'failure reason required');
      if (outcome.attempted === null) unknownAttempts = true;
      else if (outcome.attempted) attempts++;
      continue;
    }
    successes++;
    requireValid(outcome.checkpoint.page === outcome.page, 'outcome checkpoint page');
    if (outcome.reused) {
      requireValid(Value.Equal(request.reuse.find(ref => ref.page === outcome.page), outcome.checkpoint), 'unrequested reuse');
    } else {
      attempts++;
      requireValid(outcome.checkpoint.source_request_id === request.request_id, 'new checkpoint request mismatch');
    }
    await readCheckpoint(outcome.checkpoint, request.document, read);
  }
  requireValid(response.attempted_pages === (unknownAttempts ? null : attempts), 'attempt accounting mismatch');
  requireValid(response.coverage === (successes ? 'partial' : 'none'), 'batch coverage mismatch');
  return response;
}

export async function validateOcrAggregateV2(
  value: unknown, expected: { document: OcrDocumentIdentityV2; context: OcrExecutionContextV2 }, read: OcrCheckpointReaderV2
) {
  documentIdentity(expected.document);
  context(expected.context);
  const aggregate = checked(OcrAggregateV2Schema, value);
  requireValid(Value.Equal(aggregate.document, expected.document) && Value.Equal(aggregate.context, expected.context), 'aggregate identity or context mismatch');
  const pages = aggregate.successful_pages.map(ref => ref.page);
  orderedPages(pages, expected.document, expected.context);
  const coverage = pages.length === expected.document.page_count ? 'complete' : pages.length ? 'partial' : 'none';
  requireValid(aggregate.coverage === coverage, 'aggregate coverage mismatch');
  // Ordered, unique and bounded + N entries proves exact physical coverage 1..N.
  for (const ref of aggregate.successful_pages) await readCheckpoint(ref, expected.document, read);
  return aggregate;
}
