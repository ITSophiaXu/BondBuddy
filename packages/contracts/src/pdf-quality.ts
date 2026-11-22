import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const PDF_QUALITY_VERSION = 'pdf-raster-quality-4' as const;
/** Earlier DPI-only receipts cannot decide readiness under the detail-aware policy. */
export const PDF_QUALITY_JOB_VERSIONS = [PDF_QUALITY_VERSION] as const;
export const PDF_QUALITY_SAMPLE_LIMIT = 8;
/** One-based representative pages, front body first, then distributed across the report. */
export function pdfQualitySamplePages(count: number): number[] {
  if (!Number.isSafeInteger(count) || count < 1) return [];
  if (count <= PDF_QUALITY_SAMPLE_LIMIT) return Array.from({length: count}, (_, i) => i + 1);
  return [...new Set([5, 8, Math.min(12, count), 1, Math.ceil(count / 4), Math.ceil(count / 2), Math.ceil(count * 3 / 4), count])];
}
/** Measured raster resolution, not an OCR/readability verdict. v1 remains readable for old jobs. */
export const PdfQualitySchema = Type.Object({
  version: Type.Union([Type.Literal('pdf-raster-quality-1'), Type.Literal('pdf-raster-quality-2'), Type.Literal('pdf-raster-quality-3'), Type.Literal(PDF_QUALITY_VERSION)]),
  status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unavailable')]),
  page_count: Type.Union([Type.Integer({minimum: 1}), Type.Null()]),
  checked_pages: Type.Integer({minimum: 0, maximum: 1500}),
  sampled_pages: Type.Optional(Type.Array(Type.Integer({minimum: 1}), {maxItems: PDF_QUALITY_SAMPLE_LIMIT, uniqueItems: true})),
  blocking_pages: Type.Optional(Type.Array(Type.Integer({minimum: 1}), {maxItems: 1, uniqueItems: true})),
  low_resolution_pages: Type.Array(Type.Object({
    page: Type.Integer({minimum: 1}),
    dpi: Type.Integer({minimum: 1, maximum: 199}),
  }, {additionalProperties: false}), {maxItems: 1500}),
}, {additionalProperties: false});
export type PdfQuality = Static<typeof PdfQualitySchema>;
export const PDF_QUALITY_STAGE = 'pdf_quality' as const;
export function readPdfQuality(value: unknown): PdfQuality | undefined {
  if (!Value.Check(PdfQualitySchema, value)) return undefined;
  if (value.page_count === null && (value.checked_pages || value.low_resolution_pages.length || value.status !== 'unavailable')) return undefined;
  if (value.page_count !== null && value.checked_pages > value.page_count) return undefined;
  const sampledVersion = value.version === PDF_QUALITY_VERSION || value.version === 'pdf-raster-quality-3';
  if (sampledVersion) {
    const sampled = value.sampled_pages, plan = pdfQualitySamplePages(value.page_count ?? 0);
    if (!sampled || sampled.length !== value.checked_pages || sampled.some((page, i) => page !== plan[i])) return undefined;
    if (value.version === PDF_QUALITY_VERSION) {
      if (!value.blocking_pages || value.blocking_pages.some(page => page !== sampled.at(-1) || !value.low_resolution_pages.some(p => p.page === page))) return undefined;
      if (value.low_resolution_pages.length > PDF_QUALITY_SAMPLE_LIMIT) return undefined;
      if (value.status === 'complete' && (!sampled.length || !value.blocking_pages.length && sampled.length !== plan.length)) return undefined;
    } else {
      if (value.blocking_pages !== undefined || value.low_resolution_pages.length > 1 || value.low_resolution_pages.some(p => p.page !== sampled.at(-1))) return undefined;
      if (value.status === 'complete' && (!sampled.length || !value.low_resolution_pages.length && sampled.length !== plan.length)) return undefined;
    }
  } else if (value.sampled_pages !== undefined || value.blocking_pages !== undefined || value.status === 'complete' && value.checked_pages !== value.page_count) return undefined;
  if (value.status === 'unavailable' && (value.checked_pages || value.low_resolution_pages.length)) return undefined;
  let previous = -1;
  for (const page of value.low_resolution_pages) {
    const position = sampledVersion ? value.sampled_pages!.indexOf(page.page) : page.page - 1;
    if (position <= previous || position < 0 || !sampledVersion && page.page > value.checked_pages) return undefined;
    previous = position;
  }
  return value;
}


export const AuditPdfQualityCheckRequestSchema = Type.Object({
  retry: Type.Optional(Type.Boolean()),
}, {additionalProperties: false});
export const isAuditPdf = (material: {role: string; media_type?: string}) =>
  material.role === 'audit' && material.media_type === 'application/pdf';
export const AUDIT_PDF_QUALITY_REQUIRED = 'AUDIT_PDF_QUALITY_REQUIRED' as const;
export const AUDIT_PDF_LOW_MESSAGE = '上传的审计报告 PDF 清晰度太低，可能影响财务数字识别。请移除此文件并重新上传清晰的电子版审计报告，才能继续下一步。';
export const AUDIT_PDF_PENDING_MESSAGE = '正在检查审计报告 PDF 的清晰度，请等待检查完成后继续。';
export const AUDIT_PDF_INCOMPLETE_MESSAGE = '审计报告 PDF 的清晰度检查未完成，暂不能继续。请重试检查；仍无法完成时，请重新上传电子版材料。';
export function auditPdfQualityState(value: unknown): 'pending' | 'low' | 'incomplete' | 'ready' {
  const quality = readPdfQuality(value);
  if (!quality || !PDF_QUALITY_JOB_VERSIONS.some(version => version === quality.version)) return 'pending';
  if (quality.blocking_pages?.length) return 'low';
  return quality.status === 'complete' ? 'ready' : 'incomplete';
}
export function auditPdfQualityMessage(value: unknown): string {
  const state = auditPdfQualityState(value);
  return state === 'low' ? AUDIT_PDF_LOW_MESSAGE : state === 'ready' ? ''
    : state === 'incomplete' ? AUDIT_PDF_INCOMPLETE_MESSAGE : AUDIT_PDF_PENDING_MESSAGE;
}

// Old queued quality jobs must remain lightweight; they must never fall into full parsing/OCR.
export const isPdfQualityJobVersion = (version: string) => [PDF_QUALITY_VERSION, 'pdf-raster-quality-3', 'pdf-raster-quality-2'].some(current => version === current || version.startsWith(current + ':retry:'));
