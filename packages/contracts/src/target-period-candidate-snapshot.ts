import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TargetReportingPeriodSchema } from './update-project.js';
import { M1_MATERIAL_PARTITIONS } from './material-partitions.js';
import { TARGET_PERIOD_EVIDENCE_ANCHOR_KINDS, TARGET_PERIOD_EVIDENCE_METHODS } from './target-period-evidence.js';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revision = Type.Integer({ minimum: 1, maximum: 2147483647 });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const code = Type.String({ minLength: 1, maxLength: 128 });
const evidenceMethod = Type.Union(TARGET_PERIOD_EVIDENCE_METHODS.map(value => Type.Literal(value)));
const locator = Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]);
const financialMaterialRoles = Type.Union(M1_MATERIAL_PARTITIONS.find(partition => partition.label === '财务与审计')!.roles
  .map(role => Type.Literal(role.code)));

export const TARGET_PERIOD_CANDIDATE_SNAPSHOT_VERSION = 'target-period-candidate-snapshot-v1' as const;
export const TARGET_PERIOD_CANDIDATE_SNAPSHOT_HASH_DOMAIN = 'bondbuddy:target-period-candidate-snapshot:v1' as const;
export const TARGET_PERIOD_CANDIDATE_SNAPSHOT_CANONICALIZATION = 'utf8-json-sorted-object-keys-preserve-declared-array-order-v1' as const;

const materialPin = Type.Object({
  material_id: id,
  material_version: revision,
  material_sha256: hash,
  /** Restricted to canonical financial roles; the owner/project role is rechecked by the lock transaction. */
  role: financialMaterialRoles,
}, { additionalProperties: false });

const recordPin = Type.Object({ record_id: id, record_sha256: hash }, { additionalProperties: false });
const pagePin = Type.Object({ page: revision, image_sha256: hash }, { additionalProperties: false });
const sourceSnapshotPin = Type.Object({
  evidence_method: evidenceMethod,
  snapshot_id: id,
  material_id: id,
  material_version: revision,
  material_sha256: hash,
  parser_version: Type.String({ minLength: 1, maxLength: 128 }),
  response_sha256: hash,
  /** Derived source state, not candidate approval or a claim that its facts are verified. */
  source_state: Type.Union([Type.Literal('available'), Type.Literal('needs_confirmation'), Type.Literal('failed'), Type.Literal('partial_coverage')]),
  record_pins: Type.Array(recordPin, { maxItems: 20000 }),
  page_image_pins: Type.Array(pagePin, { maxItems: 2000 }),
}, { additionalProperties: false });

const evidenceRecord = Type.Object({
  snapshot_id: id,
  record_id: id,
  record_sha256: hash,
  quote: Type.String({ maxLength: 16384 }),
  context: Type.String({ maxLength: 16384 }),
  locator,
  uncertainty: Type.Array(code, { maxItems: 100 }),
  page: Type.Optional(revision),
  page_image_sha256: Type.Optional(hash),
}, { additionalProperties: false });

const evidenceRef = Type.Object({ snapshot_id: id, record_id: id }, { additionalProperties: false });
const nonPeriodEndAnchorKind = Type.Union(TARGET_PERIOD_EVIDENCE_ANCHOR_KINDS
  .filter(kind => kind !== 'period_end').map(value => Type.Literal(value)));
const anchor = Type.Union([
  Type.Object({ kind: nonPeriodEndAnchorKind, snapshot_id: id, record_id: id }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('period_end'),
    snapshot_id: id,
    record_id: id,
    /** Exact raw token from this specific evidence record, never borrowed from a merged candidate value. Producer must validate that its parsed end equals the candidate end. */
    raw_period_token: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false }),
]);
const candidate = Type.Object({
  start: TargetReportingPeriodSchema.properties.start,
  end: TargetReportingPeriodSchema.properties.end,
  period_kind: TargetReportingPeriodSchema.properties.period_kind,
  scope: TargetReportingPeriodSchema.properties.scope,
  raw_value: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  status: Type.Literal('needs_confirmation'),
  cutoff_relation: Type.Union([Type.Literal('on_or_before'), Type.Literal('after'), Type.Literal('unknown')]),
  evidence_refs: Type.Array(evidenceRef, { maxItems: 2000 }),
  anchors: Type.Array(anchor, { maxItems: 2000 }),
  pending_reasons: Type.Array(code, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false, description: 'A source-derived proposal, never recognized, confirmed, approved, or treated as user target intent.' });

const requirementsPin = Type.Object({
  version: revision,
  content_sha256: hash,
  message_ids: Type.Array(id, { maxItems: 500 }),
}, { additionalProperties: false, description: 'Exact selected supplementary-requirement set; an empty set still has an explicit version and hash.' });

const snapshotContent = Type.Object({
  schema_version: Type.Literal(TARGET_PERIOD_CANDIDATE_SNAPSHOT_VERSION),
  hash_domain: Type.Literal(TARGET_PERIOD_CANDIDATE_SNAPSHOT_HASH_DOMAIN),
  canonicalization: Type.Literal(TARGET_PERIOD_CANDIDATE_SNAPSHOT_CANONICALIZATION),
  owner_user_id: id,
  project_id: id,
  project_draft_revision: revision,
  /** Target intent only; candidate periods below are not a replacement target set. */
  reporting_cutoff: date,
  supplemental_requirements: requirementsPin,
  financial_materials: Type.Array(materialPin, { maxItems: 60 }),
  source_snapshots: Type.Array(sourceSnapshotPin, { maxItems: 200 }),
  evidence_records: Type.Array(evidenceRecord, { maxItems: 20000 }),
  status: Type.Literal('needs_confirmation'),
  completeness: Type.Literal('not_determined'),
  candidates: Type.Array(candidate, { maxItems: 100 }),
  source_warnings: Type.Array(code, { maxItems: 1000 }),
  pending_reasons: Type.Array(code, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false, description: 'Immutable pre-lock candidate snapshot; user target confirmation and later period evidence decisions remain separate records.' });

/** Content hash is over `content` with the declared domain/canonicalization; envelope identity is excluded. */
export const TargetPeriodCandidateSnapshotSchema = Type.Object({
  candidate_set_id: id,
  candidate_set_version: revision,
  content_sha256: hash,
  content: snapshotContent,
}, { additionalProperties: false });

export const TargetPeriodCandidateSnapshotRefSchema = Type.Object({
  candidate_set_id: id,
  candidate_set_version: revision,
  content_sha256: hash,
}, { additionalProperties: false });

export const targetPeriodCandidateSchemas = {
  TargetPeriodCandidateSnapshot: TargetPeriodCandidateSnapshotSchema,
  TargetPeriodCandidateSnapshotRef: TargetPeriodCandidateSnapshotRefSchema,
} as const;

export type TargetPeriodCandidateSnapshot = Static<typeof TargetPeriodCandidateSnapshotSchema>;
export type TargetPeriodCandidateSnapshotRef = Static<typeof TargetPeriodCandidateSnapshotRefSchema>;

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function strictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}
function evidenceKey(value: { snapshot_id: string; record_id: string }): string { return `${value.snapshot_id}\0${value.record_id}`; }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(',')}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('TARGET_PERIOD_CANDIDATE_SNAPSHOT_INVALID');
  return json;
}

/** Canonical bytes input for trusted producers/lock consumers to SHA-256. */
export function canonicalTargetPeriodCandidateSnapshotContent(value: unknown): string {
  if (!validTargetPeriodCandidateSnapshot(value)) throw new Error('TARGET_PERIOD_CANDIDATE_SNAPSHOT_INVALID');
  return canonicalJson(value.content);
}

/** Structural invariants for immutable candidate content. Hash recomputation is a trusted lock-time check. */
export function validTargetPeriodCandidateSnapshot(value: unknown): value is TargetPeriodCandidateSnapshot {
  if (!Value.Check(TargetPeriodCandidateSnapshotSchema, value)) return false;
  const snapshot = value as TargetPeriodCandidateSnapshot;
  const content = snapshot.content;
  if (!validCalendarDate(content.reporting_cutoff)) return false;
  if (!strictlySorted(content.supplemental_requirements.message_ids) ||
      !strictlySorted(content.source_warnings) || !strictlySorted(content.pending_reasons)) return false;
  if (!content.financial_materials.every((item, index) => index === 0 ||
      content.financial_materials[index - 1]!.material_id < item.material_id)) return false;
  if (!content.source_snapshots.every((item, index) => index === 0 ||
      content.source_snapshots[index - 1]!.snapshot_id < item.snapshot_id)) return false;
  const materials = new Map(content.financial_materials.map(item => [item.material_id, item]));
  const recordPins = new Map<string, { record_sha256: string; source: typeof content.source_snapshots[number] }>();
  for (const source of content.source_snapshots) {
    const material = materials.get(source.material_id);
    if (!material || material.material_version !== source.material_version || material.material_sha256 !== source.material_sha256 ||
        !strictlySorted(source.record_pins.map(item => item.record_id)) ||
        !source.page_image_pins.every((item, index) => index === 0 || source.page_image_pins[index - 1]!.page < item.page)) return false;
    if (source.evidence_method === 'native_text' && source.page_image_pins.length > 0) return false;
    for (const pin of source.record_pins) {
      const key = `${source.snapshot_id}\0${pin.record_id}`;
      if (recordPins.has(key)) return false;
      recordPins.set(key, { record_sha256: pin.record_sha256, source });
    }
  }
  const evidence = new Map<string, typeof content.evidence_records[number]>();
  if (!content.evidence_records.every((item, index) => index === 0 ||
      evidenceKey(content.evidence_records[index - 1]!) < evidenceKey(item))) return false;
  for (const item of content.evidence_records) {
    const key = evidenceKey(item);
    const pin = recordPins.get(key);
    if (!pin || pin.record_sha256 !== item.record_sha256 || evidence.has(key)) return false;
    if (pin.source.evidence_method === 'ocr') {
      const pagePin = item.page === undefined ? undefined : pin.source.page_image_pins.find(page => page.page === item.page);
      if (item.page === undefined || !item.page_image_sha256 || pagePin?.image_sha256 !== item.page_image_sha256) return false;
    } else if (item.page !== undefined || item.page_image_sha256 !== undefined) return false;
    evidence.set(key, item);
  }
  const candidateKeys = content.candidates.map(item => JSON.stringify([item.end ?? '', item.start ?? '', item.scope ?? '', item.period_kind ?? '']));
  if (!strictlySorted(candidateKeys)) return false;
  for (const item of content.candidates) {
    if (item.start !== null && !validCalendarDate(item.start) || item.end !== null && !validCalendarDate(item.end)) return false;
    if (item.start && item.end && item.start > item.end) return false;
    const expectedCutoffRelation = item.end === null ? 'unknown' : item.end <= content.reporting_cutoff ? 'on_or_before' : 'after';
    if (item.cutoff_relation !== expectedCutoffRelation) return false;
    const refs = item.evidence_refs.map(evidenceKey);
    if (!strictlySorted(refs) || refs.some(key => !evidence.has(key))) return false;
    const anchors = item.anchors.map(anchor => `${anchor.kind}\0${evidenceKey(anchor)}`);
    if (!strictlySorted(anchors) || item.anchors.some(anchor => !refs.includes(evidenceKey(anchor)))) return false;
    for (const anchor of item.anchors) {
      const sourceEvidence = evidence.get(evidenceKey(anchor))!;
      if (anchor.kind === 'period_end') {
        const candidateTokens = item.raw_value?.split('；') ?? [];
        if (item.end === null || !(candidateTokens.includes(anchor.raw_period_token) || anchor.raw_period_token === item.end) ||
            !sourceEvidence.quote.includes(anchor.raw_period_token)) return false;
      } else if ('raw_period_token' in anchor) return false;
    }
  }
  return true;
}
