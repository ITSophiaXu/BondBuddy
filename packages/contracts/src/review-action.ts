import { Type, type Static } from '@sinclair/typebox';

/** Host-observed work only. No model prose, arguments, results or private paths. */
export const REVIEW_ACTION_CODES = ['read_materials', 'read_knowledge', 'check_financial', 'check_compliance',
  'search_public', 'compare_sources', 'revise_document', 'prepare_report'] as const;
export const REVIEW_ACTION_STATES = ['started', 'completed', 'failed'] as const;
export const ReviewActionSchema = Type.Object({
  version: Type.Literal('review-action-v1'),
  action_id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  code: Type.Union(REVIEW_ACTION_CODES.map(code => Type.Literal(code))),
  state: Type.Union(REVIEW_ACTION_STATES.map(state => Type.Literal(state))),
}, { additionalProperties: false });
export type ReviewAction = Static<typeof ReviewActionSchema>;
export type ReviewActionCode = ReviewAction['code'];
export type ReviewActionState = ReviewAction['state'];
