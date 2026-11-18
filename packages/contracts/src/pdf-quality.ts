import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** Advisory raster resolution only; never a readability verdict or execution prerequisite. */
export const PdfQualitySchema = Type.Object({
  version: Type.Literal('pdf-raster-quality-1'),
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
