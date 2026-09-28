import { Type, type Static } from '@sinclair/typebox';
import { VERIFIED_ISSUER_ENTITY_PATTERN } from './issuer-identity-review.js';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revision = Type.Integer({ minimum: 1 });
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
const nonEmpty = Type.String({ minLength: 1, maxLength: 2048 });
const issuerEntityId = Type.String({ pattern: VERIFIED_ISSUER_ENTITY_PATTERN });
const locator = Type.Object({ type: Type.String({ minLength: 1, maxLength: 64 }), value: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false });
const identityUncertainty = Type.Object({
  code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
  source_record_id: Type.Union([id, Type.Null()]),
  source_record_sha256: Type.Union([hash, Type.Null()]),
  locator: Type.Union([locator, Type.Null()]),
  reason: nonEmpty,
}, { additionalProperties: false, description: 'Unresolved issuer-identity uncertainty. Amount/formula warnings are preserved separately and do not block identity approval by themselves.' });

export const GENERATION_ISSUER_MATERIAL_ROLES = ['audit', 'financial', 'interimFinancial', 'notes'] as const;
export const GENERATION_ISSUER_BINDING_STATUSES = ['pending', 'approved', 'withdrawn'] as const;
export const GENERATION_ISSUER_BINDING_ACTIONS = ['request_more_evidence', 'approve', 'withdraw'] as const;
export const GENERATION_ISSUER_MATERIAL_DISPOSITIONS = ['classified', 'unrelated', 'pending'] as const;
export const GENERATION_ISSUER_SUBJECT_RELATIONS = ['issuer_compiler', 'component_subsidiary', 'unrelated', 'pending'] as const;
export const GENERATION_ISSUER_ACCOUNTING_SCOPES = ['consolidated', 'parent', 'not_applicable', 'pending'] as const;

const materialPin = Type.Object({
  material_id: id,
  material_version: revision,
  role: Type.Union(GENERATION_ISSUER_MATERIAL_ROLES.map(value => Type.Literal(value))),
  material_sha256: hash,
  parse_snapshot_id: id,
  parse_response_sha256: hash,
  parse_coverage: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]),
  parse_warning_codes: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 }),
  identity_coverage: Type.Union([Type.Literal('complete'), Type.Literal('incomplete')]),
  identity_uncertainties: Type.Array(identityUncertainty, { maxItems: 100 }),
}, { additionalProperties: false });

const observation = Type.Object({
  source_record_id: id,
  source_record_sha256: hash,
  material_id: id,
  material_version: revision,
  material_sha256: hash,
  parse_snapshot_id: id,
  parse_response_sha256: hash,
  locator: locator,
  quote: Type.String({ minLength: 1, maxLength: 4096 }),
  observed_subject_label: Type.String({ minLength: 1, maxLength: 512 }),
  evidence_context: Type.Union([Type.Literal('financial_statement'), Type.Literal('identity_relationship')]),
  subject_relation: Type.Union(GENERATION_ISSUER_SUBJECT_RELATIONS.map(value => Type.Literal(value))),
  accounting_scope: Type.Union(GENERATION_ISSUER_ACCOUNTING_SCOPES.map(value => Type.Literal(value))),
  relation_reason: nonEmpty,
  source_identity_review_id: Type.Union([id, Type.Null()]),
  source_identity_review_sha256: Type.Union([hash, Type.Null()]),
  source_identity_review_decision: Type.Union([Type.Literal('verified'), Type.Null()]),
  verified_entity_id: Type.Union([issuerEntityId, Type.Null()]),
}, { additionalProperties: false, description: 'One source-local subject observation. Only issuer_compiler participates in resolving the legal issuer; subsidiary and unrelated observations need the current combination review, not a verified-issuer source review.' });

const materialDecision = Type.Object({
  material_id: id,
  material_version: revision,
  disposition: Type.Union(GENERATION_ISSUER_MATERIAL_DISPOSITIONS.map(value => Type.Literal(value))),
  reason: nonEmpty,
  observations: Type.Array(observation, { maxItems: 1000 }),
}, { additionalProperties: false, description: 'Exactly one decision is required for every selected issuer-role material in selected_materials; a material may contain multiple localized observations.' });

const dispute = Type.Object({
  code: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
  status: Type.Union([Type.Literal('open'), Type.Literal('resolved')]),
  reason: nonEmpty,
  source_record_ids: Type.Array(id, { minItems: 1, maxItems: 100 }),
  resolution: Type.Union([nonEmpty, Type.Null()]),
}, { additionalProperties: false });

const reviewEvent = Type.Object({
  review_id: id,
  action: Type.Union(GENERATION_ISSUER_BINDING_ACTIONS.map(value => Type.Literal(value))),
  reason: nonEmpty,
  reviewer_user_id: id,
  reviewer_grant_id: id,
  authority: Type.Literal('issuer_identity_reviewer'),
  binding_version: revision,
  binding_content_sha256: hash,
  reviewed_at: utc,
}, { additionalProperties: false });

export const generationIssuerBindingSchemas = {
  GenerationIssuerBindingRef: Type.Object({ binding_id: id, version: revision, content_sha256: hash }, { additionalProperties: false }),
  GenerationIssuerBindingReviewRequest: Type.Object({
    request_id: id,
    action: Type.Union(GENERATION_ISSUER_BINDING_ACTIONS.map(value => Type.Literal(value))),
    expected_binding: Type.Object({ binding_id: id, version: revision, content_sha256: hash }, { additionalProperties: false }),
    reason: nonEmpty,
  }, { additionalProperties: false }),
  GenerationIssuerBindingResponse: Type.Object({
    schema_version: Type.Literal('generation-issuer-binding-v1'),
    binding_id: id,
    version: revision,
    content_sha256: hash,
    owner_user_id: id,
    project_id: id,
    input_revision: revision,
    input_hash: hash,
    selected_materials: Type.Array(materialPin, { minItems: 1, maxItems: 100 }),
    material_decisions: Type.Array(materialDecision, { minItems: 1, maxItems: 100 }),
    disputes: Type.Array(dispute, { maxItems: 500 }),
    status: Type.Union(GENERATION_ISSUER_BINDING_STATUSES.map(value => Type.Literal(value))),
    issuer_entity_id: Type.Union([issuerEntityId, Type.Null()]),
    review_events: Type.Array(reviewEvent, { maxItems: 100 }),
    created_at: utc,
  }, { additionalProperties: false, description: 'Versioned project-level identity decision. A response marked approved is usable only after the separate #17 transaction/input-lock seam validates this exact ref and all current source/grant pins.' }),
} as const;

export type GenerationIssuerBindingRef = Static<typeof generationIssuerBindingSchemas.GenerationIssuerBindingRef>;
export type GenerationIssuerBindingReviewRequest = Static<typeof generationIssuerBindingSchemas.GenerationIssuerBindingReviewRequest>;
export type GenerationIssuerBindingResponse = Static<typeof generationIssuerBindingSchemas.GenerationIssuerBindingResponse>;
export type GenerationIssuerBindingExpectedInput = Pick<GenerationIssuerBindingResponse, 'owner_user_id' | 'project_id' | 'input_revision' | 'input_hash'>;

/** Semantic gate for the pure contract slice. Persistence, authority, revocation, and
 * current source-review/grant state, and atomic input-lock checks remain server
 * responsibilities and are not implemented here. */
export function validGenerationIssuerBindingApproval(
  value: GenerationIssuerBindingResponse,
  expectedInput: GenerationIssuerBindingExpectedInput,
  expectedSelectedMaterials: readonly GenerationIssuerBindingResponse['selected_materials'][number][],
): boolean {
  if (value.schema_version !== 'generation-issuer-binding-v1' || value.status !== 'approved' || !value.issuer_entity_id ||
      value.owner_user_id !== expectedInput.owner_user_id || value.project_id !== expectedInput.project_id ||
      value.input_revision !== expectedInput.input_revision || value.input_hash !== expectedInput.input_hash) return false;
  if (value.review_events.length === 0 || value.review_events.some(event => event.authority !== 'issuer_identity_reviewer' ||
      event.binding_version !== value.version || event.binding_content_sha256 !== value.content_sha256)) return false;
  let reviewStatus: GenerationIssuerBindingResponse['status'] = 'pending';
  const reviewIds = new Set<string>();
  for (const event of value.review_events) {
    if (reviewIds.has(event.review_id) || !GENERATION_ISSUER_BINDING_ACTIONS.includes(event.action)) return false;
    reviewIds.add(event.review_id);
    const nextStatus = nextGenerationIssuerBindingStatus(reviewStatus, event.action);
    if (nextStatus === null) return false;
    reviewStatus = nextStatus;
  }
  if (reviewStatus !== value.status || value.review_events[value.review_events.length - 1]!.action !== 'approve') return false;
  if (value.disputes.some(item => item.status === 'open' || item.resolution === null) ||
      value.disputes.some(item => item.source_record_ids.some(sourceId => !value.material_decisions.some(decision => decision.observations.some(observation => observation.source_record_id === sourceId))))) return false;

  const pinKey = (pin: Pick<GenerationIssuerBindingResponse['selected_materials'][number], 'material_id' | 'material_version'>) => `${pin.material_id}\u0000${pin.material_version}`;
  const samePin = (left: GenerationIssuerBindingResponse['selected_materials'][number], right: GenerationIssuerBindingResponse['selected_materials'][number]) =>
    left.material_id === right.material_id && left.material_version === right.material_version && left.role === right.role &&
    left.material_sha256 === right.material_sha256 && left.parse_snapshot_id === right.parse_snapshot_id &&
    left.parse_response_sha256 === right.parse_response_sha256 && left.parse_coverage === right.parse_coverage &&
    left.identity_coverage === right.identity_coverage && JSON.stringify(left.parse_warning_codes) === JSON.stringify(right.parse_warning_codes) &&
    JSON.stringify(left.identity_uncertainties) === JSON.stringify(right.identity_uncertainties);
  if (expectedSelectedMaterials.length !== value.selected_materials.length) return false;
  const selected = new Map<string, GenerationIssuerBindingResponse['selected_materials'][number]>();
  const expected = new Map<string, GenerationIssuerBindingResponse['selected_materials'][number]>();
  for (const pin of expectedSelectedMaterials) {
    if (expected.has(pinKey(pin))) return false;
    expected.set(pinKey(pin), pin);
  }
  for (const pin of value.selected_materials) {
    const key = pinKey(pin);
    if (!GENERATION_ISSUER_MATERIAL_ROLES.includes(pin.role) || selected.has(key) || pin.identity_coverage !== 'complete' || pin.identity_uncertainties.length > 0 ||
        !expected.has(key) || !samePin(pin, expected.get(key)!)) return false;
    selected.set(pinKey(pin), pin);
  }
  if ([...expected.keys()].some(key => !selected.has(key))) return false;
  const decisions = new Map<string, GenerationIssuerBindingResponse['material_decisions'][number]>();
  for (const decision of value.material_decisions) {
    const key = pinKey(decision);
    if (decisions.has(key) || !selected.has(key) || decision.disposition === 'pending') return false;
    if ((decision.disposition === 'classified' && decision.observations.length === 0) ||
        (decision.disposition === 'classified' && decision.observations.every(item => item.subject_relation === 'unrelated')) ||
        (decision.disposition === 'unrelated' && (decision.observations.length === 0 || decision.observations.some(item => item.subject_relation !== 'unrelated')))) return false;
    const pin = selected.get(key)!;
    for (const item of decision.observations) {
      if (item.material_id !== pin.material_id || item.material_version !== pin.material_version || item.material_sha256 !== pin.material_sha256 ||
          item.parse_snapshot_id !== pin.parse_snapshot_id || item.parse_response_sha256 !== pin.parse_response_sha256 ||
          item.subject_relation === 'pending' || item.accounting_scope === 'pending' || !item.relation_reason.trim()) return false;
      if (item.evidence_context === 'financial_statement' && item.accounting_scope === 'not_applicable') return false;
      if (item.evidence_context === 'identity_relationship' && item.accounting_scope !== 'not_applicable') return false;
      if (item.subject_relation === 'issuer_compiler') {
        if (!item.verified_entity_id || item.verified_entity_id !== value.issuer_entity_id ||
            !item.source_identity_review_id || !item.source_identity_review_sha256 || item.source_identity_review_decision !== 'verified') return false;
        if (item.evidence_context === 'financial_statement' && !['consolidated', 'parent'].includes(item.accounting_scope)) return false;
      }
      if (item.subject_relation !== 'issuer_compiler') {
        const hasSourceReview = item.source_identity_review_id !== null || item.source_identity_review_sha256 !== null || item.source_identity_review_decision !== null;
        if ((item.source_identity_review_id === null) !== (item.source_identity_review_sha256 === null) ||
            (item.source_identity_review_id === null) !== (item.source_identity_review_decision === null) ||
            (hasSourceReview && item.source_identity_review_decision === 'verified' && item.verified_entity_id === null) ||
            (!hasSourceReview && item.verified_entity_id !== null)) return false;
      }
    }
    decisions.set(key, decision);
  }
  if (decisions.size !== selected.size || [...selected.keys()].some(key => !decisions.has(key))) return false;
  const compilers = [...decisions.values()].flatMap(item => item.observations.filter(observation => observation.subject_relation === 'issuer_compiler'));
  return compilers.length > 0 && compilers.every(item => item.verified_entity_id === value.issuer_entity_id);
}

/** Append-only review transition helper. A withdrawn binding is terminal; a new
 * approval requires a new binding version and its own immutable ref. */
export function nextGenerationIssuerBindingStatus(
  current: GenerationIssuerBindingResponse['status'],
  action: GenerationIssuerBindingReviewRequest['action'],
): GenerationIssuerBindingResponse['status'] | null {
  if (current === 'withdrawn') return null;
  if (current === 'approved') return action === 'withdraw' ? 'withdrawn' : null;
  if (action === 'request_more_evidence') return 'pending';
  return action === 'approve' ? 'approved' : 'withdrawn';
}
