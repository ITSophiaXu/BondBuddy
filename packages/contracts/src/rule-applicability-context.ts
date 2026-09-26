import { Type } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128 });
const revision = Type.Integer({ minimum: 1, maximum: 2147483647 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });

/** Owner-visible reference to an immutable applicability draft. This DTO can never represent production eligibility. */
export const ruleApplicabilityContextSchemas = {
  RuleApplicabilityContextDraftCreateRequest: Type.Object({
    request_id: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' }),
  }, { additionalProperties: false }),
  RuleApplicabilityContextDraftResponse: Type.Object({
    status: Type.Literal('needs_review'),
    production_eligible: Type.Literal(false),
    context_ref: Type.Object({
      context_id: id,
      version: revision,
      content_hash: hash,
      source_input_revision: revision,
      source_input_hash: hash,
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
};
