import { Type, type Static } from '@sinclair/typebox';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revision = Type.Integer({ minimum: 1 });
const nullableDate = Type.Union([Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }), Type.Null()]);
const evidenceRef = Type.Object({
  evidence_method: Type.Union([Type.Literal('native_text'),Type.Literal('ocr')]),
  material_id: id, material_version: revision, material_sha256: hash,
  parse_snapshot_id: id, parser_version: Type.String({ minLength: 1, maxLength: 128 }), response_sha256: hash,
  record_id: id, record_sha256: hash,
  page: Type.Optional(revision), page_image_sha256: Type.Optional(hash),
  ocr_uncertainty: Type.Optional(Type.Array(Type.String({minLength:1,maxLength:512}),{maxItems:20})),
  anchor_kind: Type.Union([Type.Literal('table_header'), Type.Literal('entity'), Type.Literal('scope'), Type.Literal('period_end')]),
}, { additionalProperties: false });
const periodDecision = Type.Object({
  start: nullableDate, end: nullableDate,
  period_kind: Type.Union([Type.Literal('annual'), Type.Literal('interim'), Type.Null()]),
  scope: Type.Union([Type.Literal('consolidated'), Type.Literal('parent'), Type.Null()]),
  outcome: Type.Union([Type.Literal('confirmed'), Type.Literal('needs_confirmation'), Type.Literal('conflict')]),
  evidence: Type.Array(evidenceRef, { maxItems: 40 }),
  reason: Type.String({ minLength: 1, maxLength: 2048 }),
}, { additionalProperties: false });

export const targetPeriodEvidenceSchemas = {
  TargetPeriodEvidenceDecisionRequest: Type.Object({
    request_id: id, input_revision: revision, input_hash: hash, source_profile_version: revision,
    periods: Type.Array(periodDecision, { minItems: 1, maxItems: 30 }),
  }, { additionalProperties: false, description: 'A reviewer decision about the identity, scope, and dates of every target reporting period. It does not confirm amounts or formulas and cannot change the user asserted target intent.' }),
  TargetPeriodEvidenceDecisionWithdrawalRequest: Type.Object({ request_id: id, decision_id: id, reason: Type.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
  TargetPeriodEvidenceDecisionWithdrawalResponse: Type.Object({ withdrawal_id:id,decision_id:id,reviewer_user_id:id,reviewer_grant_id:id,
    authority:Type.Literal('target_financial_period_reviewer'),reason:Type.String({minLength:1,maxLength:2048}),withdrawn_at:Type.String({pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'}),replayed:Type.Boolean() }, {additionalProperties:false}),
  TargetPeriodEvidenceDecisionResponse: Type.Object({
    decision_id: id, owner_user_id: id, project_id: id, input_revision: revision, input_hash: hash,
    locked_materials: Type.Array(Type.Object({ material_id: id, material_version: revision, material_sha256: hash }, { additionalProperties: false })),
    source_profile_material_id: id, source_profile_material_version: revision, source_profile_version: revision,
    source_profile_sha256: hash, periods: Type.Array(periodDecision),
    reviewer_user_id: id, reviewer_grant_id: id,
    authority: Type.Literal('target_financial_period_reviewer'), reviewed_at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' }),
    replayed: Type.Boolean(),
  }, { additionalProperties: false }),
} as const;

export type TargetPeriodEvidenceRef = Static<typeof evidenceRef>;
export type TargetPeriodEvidencePeriodDecision = Static<typeof periodDecision>;
export type TargetPeriodEvidenceDecisionRequest = Static<typeof targetPeriodEvidenceSchemas.TargetPeriodEvidenceDecisionRequest>;
export type TargetPeriodEvidenceDecisionResponse = Static<typeof targetPeriodEvidenceSchemas.TargetPeriodEvidenceDecisionResponse>;
export type TargetPeriodEvidenceDecisionWithdrawalRequest = Static<typeof targetPeriodEvidenceSchemas.TargetPeriodEvidenceDecisionWithdrawalRequest>;
export type TargetPeriodEvidenceDecisionWithdrawalResponse = Static<typeof targetPeriodEvidenceSchemas.TargetPeriodEvidenceDecisionWithdrawalResponse>;

/** Semantic requirements that JSON Schema cannot express: a confirmed period needs
 * all four distinct kinds of anchor from one immutable parse response. */
export function validTargetPeriodEvidenceDecision(value: TargetPeriodEvidenceDecisionRequest): boolean {
  if (!Array.isArray(value.periods) || value.periods.length === 0) return false;
  const keys=new Set<string>();
  for(const period of value.periods){
    const key=JSON.stringify([period.start,period.end,period.period_kind,period.scope]);
    if(keys.has(key))return false;keys.add(key);
    if(period.outcome!=='confirmed')continue;
    const needed=['table_header','entity','scope','period_end'];
    if(!Array.isArray(period.evidence)||needed.some(kind=>!period.evidence.some(ref=>ref.anchor_kind===kind)))return false;
    const identities=new Set(period.evidence.map(ref=>[ref.evidence_method,ref.material_id,ref.material_version,ref.parse_snapshot_id,ref.parser_version,ref.response_sha256].join('\0')));
    if(identities.size!==1)return false;
    if(period.evidence.some(ref=>ref.evidence_method==='ocr'&&(!Number.isSafeInteger(ref.page)||!ref.page_image_sha256))||
       period.evidence.some(ref=>ref.evidence_method==='ocr'&&!Array.isArray(ref.ocr_uncertainty))||
       period.evidence.some(ref=>ref.evidence_method==='native_text'&&(ref.page!==undefined||ref.page_image_sha256!==undefined||ref.ocr_uncertainty!==undefined)))return false;
  }
  return true;
}
