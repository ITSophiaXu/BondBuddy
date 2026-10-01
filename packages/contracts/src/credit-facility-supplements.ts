import { Type, type Static } from '@sinclair/typebox';

const id = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$', description: 'Opaque identifier; not an authorization grant or verified source.' });
const assertedText = Type.String({ maxLength: 256, description: 'User-asserted context; an empty string is preserved as missing and stays needs_confirmation.' });
const amountText = Type.Union([Type.String({ maxLength: 128, description: 'Decimal string; never a floating-point JSON number.' }), Type.Null()]);
const statementDate = Type.String({ maxLength: 32, description: 'User-stated date; empty or invalid values are retained and become needs_confirmation.' });

const CreditFacilitySupplementAmountSchema = Type.Object({
  bank: assertedText,
  as_of: statementDate,
  currency: assertedText,
  unit: assertedText,
  basis: assertedText,
  scope: assertedText,
  amount: amountText,
  source_id: Type.String({ maxLength: 128, description: 'User-supplied source label; not a message or material authorization.' }),
  statement_date: statementDate,
}, { additionalProperties: false });

const CreditFacilityAmountsSchema = Type.Object({
  total: CreditFacilitySupplementAmountSchema,
  used: CreditFacilitySupplementAmountSchema,
  unused: CreditFacilitySupplementAmountSchema,
}, { additionalProperties: false });

const CreditFacilitySupersedesSchema = Type.Object({
  supplement_id: id,
  version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

const CreditFacilitySupplementVersionRefSchema = Type.Object({
  supplement_id: id,
  version: Type.Integer({ minimum: 1 }),
  request_hash: Type.String({ pattern: '^[a-f0-9]{64}$', description: 'Exact immutable content hash returned by the owner-scoped supplement endpoint.' }),
}, { additionalProperties: false });

const CreditFacilitySupplementReasonSchema = Type.Union([
  Type.Literal('missing_source'), Type.Literal('invalid_statement_date'), Type.Literal('invalid_as_of'),
  Type.Literal('missing_context'), Type.Literal('missing_amount'), Type.Literal('invalid_amount'), Type.Literal('context_mismatch'),
]);

export const creditFacilitySupplementSchemas = {
  CreditFacilitySupplementAmount: CreditFacilitySupplementAmountSchema,
  CreditFacilityAmounts: CreditFacilityAmountsSchema,
  CreditFacilitySupplementVersionRef: CreditFacilitySupplementVersionRefSchema,
  CreditFacilitySupplementRequest: Type.Object({
    request_id: id,
    amounts: CreditFacilityAmountsSchema,
    /** null for the first assertion; revisions bind to one exact immutable predecessor. */
    supersedes: Type.Union([CreditFacilitySupersedesSchema, Type.Null()]),
  }, { additionalProperties: false }),
  CreditFacilitySupplementResponse: Type.Object({
    supplement_id: id,
    project_id: id,
    request_id: id,
    request_hash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    version: Type.Integer({ minimum: 1 }),
    supersedes: Type.Union([CreditFacilitySupersedesSchema, Type.Null()]),
    status: Type.Union([Type.Literal('user_asserted'), Type.Literal('needs_confirmation'), Type.Literal('conflicted')]),
    eligible_for_manuscript: Type.Literal(false),
    amounts: CreditFacilityAmountsSchema,
    reason: Type.Union([CreditFacilitySupplementReasonSchema, Type.Null()]),
    stated_total: Type.Union([Type.String(), Type.Null()]),
    calculated_total: Type.Union([Type.String(), Type.Null()]),
    created_at: Type.String({ format: 'date-time' }),
    replayed: Type.Boolean(),
  }, { additionalProperties: false }),
} as const;

export type CreditFacilitySupplementRequest = Static<typeof creditFacilitySupplementSchemas.CreditFacilitySupplementRequest>;
export type CreditFacilitySupplementResponse = Static<typeof creditFacilitySupplementSchemas.CreditFacilitySupplementResponse>;
export type CreditFacilitySupplementVersionRef = Static<typeof creditFacilitySupplementSchemas.CreditFacilitySupplementVersionRef>;
