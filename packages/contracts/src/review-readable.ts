import { Type, type Static } from '@sinclair/typebox';

/** A read-only projection of an existing private report; never an execution/acceptance gate. */
export const ReviewReadableReportSchema = Type.Object({
  version: Type.Literal('review-readable-v1'), project_id: Type.String(), run_id: Type.String(),
  execution_version: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('invalid_content')]),
  markdown: Type.String({ maxLength: 4194304 }),
  content_sha256: Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]),
}, { additionalProperties: false });
export type ReviewReadableReport = Static<typeof ReviewReadableReportSchema>;

/** Internal progress markers and formatting alone are not a review report. */
export function hasReviewReportBody(text: string): boolean {
  return Boolean(text.replace(/^\s*(?:[#*>`~-]+\s*)?BB_REVIEW_PROGRESS:[a-z_]+:(?:started|completed|failed)\s*$/gm, '')
    .replace(/[\s\uFEFF#*`~>|-]/g, ''));
}
