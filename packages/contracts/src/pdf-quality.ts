import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const PDF_QUALITY_VERSION = 'pdf-raster-quality-2' as const;
/** Measured raster resolution, not an OCR/readability verdict. v1 remains readable for old jobs. */
export const PdfQualitySchema = Type.Object({
  version: Type.Union([Type.Literal('pdf-raster-quality-1'), Type.Literal(PDF_QUALITY_VERSION)]),
  status: Type.Union([Type.Literal('complete'), Type.Literal('partial'), Type.Literal('unavailable')]),
  page_count: Type.Union([Type.Integer({minimum: 1}), Type.Null()]),
  checked_pages: Type.Integer({minimum: 0, maximum: 1500}),
  low_resolution_pages: Type.Array(Type.Object({
    page: Type.Integer({minimum: 1, maximum: 1500}),
    dpi: Type.Integer({minimum: 1, maximum: 199}),
  }, {additionalProperties: false}), {maxItems: 1500}),
}, {additionalProperties: false});
export type PdfQuality = Static<typeof PdfQualitySchema>;
export const PDF_QUALITY_STAGE = 'pdf_quality' as const;
export function readPdfQuality(value: unknown): PdfQuality | undefined {
  if (!Value.Check(PdfQualitySchema, value)) return undefined;
  if (value.page_count === null && (value.checked_pages || value.low_resolution_pages.length || value.status !== 'unavailable')) return undefined;
  if (value.page_count !== null && value.checked_pages > value.page_count) return undefined;
  if (value.status === 'complete' && value.checked_pages !== value.page_count) return undefined;
  if (value.status === 'unavailable' && (value.checked_pages || value.low_resolution_pages.length)) return undefined;
  let previous = 0;
  for (const page of value.low_resolution_pages) {
    if (page.page <= previous || page.page > value.checked_pages) return undefined;
    previous = page.page;
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
  if (!quality || quality.version !== PDF_QUALITY_VERSION) return 'pending';
  if (quality.low_resolution_pages.length) return 'low';
  return quality.status === 'complete' ? 'ready' : 'incomplete';
}
export function auditPdfQualityMessage(value: unknown): string {
  const state = auditPdfQualityState(value);
  return state === 'low' ? AUDIT_PDF_LOW_MESSAGE : state === 'ready' ? ''
    : state === 'incomplete' ? AUDIT_PDF_INCOMPLETE_MESSAGE : AUDIT_PDF_PENDING_MESSAGE;
}

export const isPdfQualityJobVersion = (version: string) => version === PDF_QUALITY_VERSION || version.startsWith(PDF_QUALITY_VERSION + ':retry:');
