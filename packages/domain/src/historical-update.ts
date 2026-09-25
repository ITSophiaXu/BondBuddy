import { createHash } from 'node:crypto';
import { isMarketOffering, type Market, type Offering, type Recognition } from '@bondbuddy/contracts';
import { factCandidateStatus, factIdentityKey, type FactCandidate, type FactIdentity, type FactPeriod, type FactStatus } from './facts.js';
import * as arithmetic from './update-arithmetic.js';

/** Internal #31 → #34 handoff, not a public API or permission to publish a Word artifact. */
export const HISTORICAL_UPDATE_VERSION = 'historical-update-plan-v1' as const;

export interface UpdateAnchor {
  materialId: string; materialVersion: number; contentHash: string; recordId: string;
  locatorType: string; locator: Record<string, unknown>; literalQuote: string;
  extractionVersion: string; uncertainty: readonly string[];
}
export interface UpdateFact {
  candidate: FactCandidate; status: FactStatus; evidence: readonly UpdateAnchor[];
}
export interface BaselineBlock {
  recordId: string; text: string; locatorType: 'docx_block' | 'pdf_bbox';
  locator: Record<string, unknown>; formatting: Record<string, unknown>; uncertainty: readonly string[];
}
export interface HistoricalBaseline {
  ownerUserId: string; projectId: string; materialId: string; materialVersion: number;
  contentHash: string; snapshotId: string; parserVersion: string; parseResultHash: string;
  format: 'docx_effective' | 'pdf_requires_reconstruction';
  parseStatus: 'parsed' | 'needs_confirmation' | 'failed';
  warnings: readonly string[];
  priorRevisions: { insertions: number; deletions: number };
  blocks: readonly BaselineBlock[];
  profile: Recognition;
}
export interface UpdateContext {
  ownerUserId: string; projectId: string; issuerEntityId: string;
  inputRevision: number; inputHash: string;
  targetMarket: Market; targetOffering: Offering;
  /** A versioned reference, not an assertion that a rule pack has passed production review. */
  ruleSnapshot: { packId: string; version: string; contentHash: string };
}
export type ValueExpression =
  | { kind: 'fact'; identity: FactIdentity }
  | { kind: 'ratio' | 'difference' | 'growth_percent'; left: FactIdentity; right: FactIdentity }
  | { kind: 'sum'; terms: readonly FactIdentity[] };
export interface UpdateBinding {
  bindingId: string; expression: ValueExpression;
  reason: 'new_period' | 'restatement' | 'correction';
  /** Required for a restatement; otherwise old versions must remain untouched. */
  replaces?: FactIdentity;
}
export type ValueDisplay =
  | { kind: 'number'; unit: string; decimalPlaces: number; groupThousands: boolean }
  | { kind: 'period'; style: 'year' | 'annual' | 'date' | 'range' }
  | { kind: 'source_text' };
export interface UpdateOccurrence {
  occurrenceId: string; bindingId: string; recordId: string;
  /** UTF-16 offsets in the effective parser quote, never in deleted Word text. */
  start: number; end: number; before: string; display: ValueDisplay;
}
export interface TableColumnRequest {
  changeId: string;
  /** One existing anchor in every row, all in the same table and same insertion column. */
  cells: readonly { afterRecordId: string; bindingId: string; display: ValueDisplay }[];
}
export interface BlockDisposition {
  recordId: string; disposition: 'retain' | 'update' | 'needs_evidence'; reason: string;
}
export interface HistoricalUpdateInput {
  context: UpdateContext; baseline: HistoricalBaseline; facts: readonly UpdateFact[];
  bindings: readonly UpdateBinding[]; occurrences: readonly UpdateOccurrence[];
  columns: readonly TableColumnRequest[];
  /** Output of the upstream semantic traversal. Missing records remain an explicit coverage gap. */
  coverage: readonly BlockDisposition[];
}
export interface PlannedReplacement {
  kind: 'replace_text'; changeId: string; bindingId: string; recordId: string;
  locator: Record<string, unknown>; start: number; end: number; before: string; after: string;
  reason: UpdateBinding['reason']; evidence: readonly UpdateAnchor[]; candidateIds: readonly string[];
  expression: ValueExpression; replaces: FactIdentity | null; sourceStatuses: readonly FactStatus[];
}
export interface PlannedColumn {
  kind: 'insert_table_column'; changeId: string; table: number; afterColumn: number;
  cells: readonly { row: number; anchorRecordId: string; bindingId: string; before: ''; after: string;
    evidence: readonly UpdateAnchor[]; candidateIds: readonly string[]; expression: ValueExpression;
    reason: 'new_period'; sourceStatuses: readonly FactStatus[] }[];
  /** The exporter must additionally verify the physical grid/merges against the original DOCX. */
  requiresPhysicalGridValidation: true;
}
export interface UpdateFinding { code: string; recordIds: string[]; bindingIds: string[] }
export interface HistoricalUpdatePlan {
  schemaVersion: typeof HISTORICAL_UPDATE_VERSION; planHash: string; baselineHash: string;
  planningInputHash: string; context: UpdateContext;
  source: Pick<HistoricalBaseline, 'materialId' | 'materialVersion' | 'contentHash' | 'snapshotId' | 'parserVersion' | 'parseResultHash' | 'priorRevisions' | 'format'>;
  sourceProfile: Recognition;
  status: 'planned' | 'needs_confirmation'; deliverable: false;
  replacements: PlannedReplacement[]; columns: PlannedColumn[];
  /** Full ordered effective text, including unchanged risk paragraphs and old-year columns. */
  textPreview: { recordId: string; before: string; after: string; locator: Record<string, unknown>; formatting: Record<string, unknown> }[];
  findings: UpdateFinding[];
  coverage: { total: number; retained: number; updated: number; pending: number };
}

export function updateContentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('UPDATE_INVALID_JSON');
  return JSON.stringify(value);
}
function required(value: string): boolean { return typeof value === 'string' && value.trim().length > 0 && value.length <= 256; }
function hash(value: string): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function date(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function splitsSurrogate(text: string, offset: number): boolean {
  return /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(offset));
}
function periodKey(period: FactPeriod): string {
  if (period.asOf !== undefined) {
    if (!date(period.asOf) || period.start !== undefined || period.end !== undefined) throw new Error('UPDATE_INVALID_PERIOD');
  } else if (!period.start || !period.end || !date(period.start) || !date(period.end) || period.start > period.end) throw new Error('UPDATE_INVALID_PERIOD');
  return canonical(period);
}
function identities(expression: ValueExpression): readonly FactIdentity[] {
  return expression.kind === 'fact' ? [expression.identity] : expression.kind === 'sum' ? expression.terms : [expression.left, expression.right];
}
function validateIdentity(identity: FactIdentity, context: UpdateContext): void {
  if (identity.accountId !== context.ownerUserId || identity.entityId !== context.issuerEntityId) throw new Error('UPDATE_FACT_OWNER_OR_ISSUER_MISMATCH');
  if (![identity.scope, identity.metric, identity.unit, identity.basis, identity.dataVersion].every(required) ||
    !(identity.currency === null || required(identity.currency))) throw new Error('UPDATE_INVALID_FACT_IDENTITY');
  periodKey(identity.period);
}
function sameContext(left: FactIdentity, right: FactIdentity, samePeriod: boolean): void {
  if (left.accountId !== right.accountId || left.entityId !== right.entityId || left.scope !== right.scope ||
    left.currency !== right.currency || left.basis !== right.basis || (samePeriod && periodKey(left.period) !== periodKey(right.period))) {
    throw new Error('UPDATE_FORMULA_CONTEXT_MISMATCH');
  }
}
function validateBinding(binding: UpdateBinding, context: UpdateContext): void {
  if (!required(binding.bindingId) || !['new_period', 'restatement', 'correction'].includes(binding.reason)) throw new Error('UPDATE_INVALID_BINDING');
  if (!['fact', 'ratio', 'difference', 'growth_percent', 'sum'].includes(binding.expression.kind)) throw new Error('UPDATE_INVALID_FORMULA');
  const operands = identities(binding.expression);
  if (operands.length === 0 || operands.length > 32) throw new Error('UPDATE_INVALID_FORMULA');
  operands.forEach(identity => validateIdentity(identity, context));
  if (binding.expression.kind === 'sum' && new Set(operands.map(factIdentityKey)).size !== operands.length) throw new Error('UPDATE_DUPLICATE_FORMULA_TERM');
  for (const operand of operands.slice(1)) sameContext(operands[0]!, operand, binding.expression.kind === 'sum' || binding.expression.kind === 'ratio');
  if (binding.expression.kind === 'difference' || binding.expression.kind === 'growth_percent') {
    const { left, right } = binding.expression;
    if (left.metric !== right.metric || periodKey(left.period) === periodKey(right.period)) throw new Error('UPDATE_COMPARISON_PERIOD_MISMATCH');
    if (Boolean(left.period.asOf) !== Boolean(right.period.asOf)) throw new Error('UPDATE_COMPARISON_PERIOD_MISMATCH');
    if ((left.period.asOf ?? left.period.end!) <= (right.period.asOf ?? right.period.end!)) throw new Error('UPDATE_COMPARISON_PERIOD_ORDER');
    if (left.period.asOf && right.period.asOf && left.period.asOf.slice(5) !== right.period.asOf.slice(5)) throw new Error('UPDATE_COMPARISON_PERIOD_MISMATCH');
    if (left.period.start && right.period.start &&
      (left.period.start.slice(5) !== right.period.start.slice(5) || left.period.end!.slice(5) !== right.period.end!.slice(5))) {
      throw new Error('UPDATE_COMPARISON_PERIOD_MISMATCH');
    }
  }
  if (binding.reason === 'restatement') {
    if (!binding.replaces || binding.expression.kind !== 'fact') throw new Error('UPDATE_RESTATEMENT_MAPPING_REQUIRED');
    validateIdentity(binding.replaces, context);
    sameContext(binding.replaces, operands[0]!, true);
    if (binding.replaces.metric !== operands[0]!.metric || binding.replaces.dataVersion === operands[0]!.dataVersion) throw new Error('UPDATE_RESTATEMENT_MAPPING_REQUIRED');
  } else if (binding.replaces) throw new Error('UPDATE_UNEXPECTED_RESTATEMENT_MAPPING');
}

interface ResolvedValue { text?: string; number?: arithmetic.Rational; unit: string; period: FactPeriod; sources: readonly UpdateFact[]; previous?: ResolvedValue }
function resolveFact(identity: FactIdentity, facts: readonly UpdateFact[]): UpdateFact[] {
  const matches = facts.filter(fact => factIdentityKey(fact.candidate.identity) === factIdentityKey(identity));
  if (!matches.length) throw new Error('UPDATE_FACT_MISSING');
  for (const fact of matches) {
    const { candidate } = fact;
    if (candidate.source.kind !== 'audited' || !['extracted', 'verified'].includes(fact.status) ||
      fact.status !== factCandidateStatus(candidate) || candidate.value.kind !== 'known' ||
      !fact.evidence.length || fact.evidence.some(anchor => anchor.uncertainty.length > 0 ||
        !hash(anchor.contentHash) || !required(anchor.recordId) || !required(anchor.materialId) ||
        !Number.isSafeInteger(anchor.materialVersion) || anchor.materialVersion < 1 || !required(anchor.extractionVersion) || !anchor.literalQuote.trim())) {
      throw new Error('UPDATE_FACT_UNRESOLVED');
    }
  }
  // Compare exact values below too: display rounding must never hide a source disagreement.
  const first = matches[0]!.candidate.value;
  if (first.kind !== 'known') throw new Error('UPDATE_FACT_UNRESOLVED');
  for (const fact of matches.slice(1)) {
    const value = fact.candidate.value;
    if (value.kind !== 'known') throw new Error('UPDATE_FACT_UNRESOLVED');
    let same: boolean;
    try { same = arithmetic.equal(arithmetic.decimal(first.decimalOrText), arithmetic.decimal(value.decimalOrText)); }
    catch { same = first.decimalOrText === value.decimalOrText; }
    if (!same) throw new Error('UPDATE_FACT_CONFLICT');
  }
  return matches;
}
function evaluate(binding: UpdateBinding, facts: readonly UpdateFact[]): ResolvedValue {
  const operands = identities(binding.expression);
  const resolved = operands.map(identity => resolveFact(identity, facts));
  const sources = resolved.flat();
  const raw = resolved.map(group => {
    const value = group[0]!.candidate.value;
    if (value.kind !== 'known') throw new Error('UPDATE_FACT_UNRESOLVED');
    return value.decimalOrText;
  });
  const first = operands[0]!;
  if (binding.expression.kind === 'fact') {
    let number: arithmetic.Rational | undefined;
    try { number = arithmetic.decimal(raw[0]!); } catch { /* Text is emitted only by explicit source_text formatting. */ }
    const previous = binding.replaces ? evaluate({ bindingId: binding.bindingId, reason: 'correction', expression: { kind: 'fact', identity: binding.replaces } }, facts) : undefined;
    return { text: raw[0], number, unit: first.unit, period: first.period, sources: [...sources, ...(previous?.sources ?? [])], previous };
  }
  const numbers = raw.map((value, index) => arithmetic.convert(arithmetic.decimal(value), operands[index]!.unit, first.unit));
  let number: arithmetic.Rational; let unit = first.unit;
  switch (binding.expression.kind) {
    case 'sum': number = numbers.reduce(arithmetic.add); break;
    case 'difference': number = arithmetic.subtract(numbers[0]!, numbers[1]!); break;
    case 'growth_percent':
      if (numbers[1]!.numerator <= 0n) throw new Error('UPDATE_GROWTH_BASE_NOT_POSITIVE');
      number = arithmetic.scale(arithmetic.divide(arithmetic.subtract(numbers[0]!, numbers[1]!), numbers[1]!), 100n); unit = '%'; break;
    case 'ratio': number = arithmetic.divide(numbers[0]!, numbers[1]!); unit = 'ratio'; break;
  }
  return { number, unit, period: first.period, sources };
}
function format(value: ResolvedValue, specification: ValueDisplay): string {
  if (specification.kind === 'source_text') {
    if (value.text === undefined || !value.sources.some(source => source.evidence.some(anchor => anchor.literalQuote.includes(value.text!)))) throw new Error('UPDATE_TEXT_REQUIRES_SOURCE');
    return value.text;
  }
  if (specification.kind === 'period') {
    const end = value.period.asOf ?? value.period.end!;
    if (specification.style === 'date') return end;
    if (specification.style === 'year') return end.slice(0, 4);
    if (specification.style === 'annual') {
      if (value.period.start !== `${end.slice(0, 4)}-01-01` || !end.endsWith('-12-31')) throw new Error('UPDATE_NOT_ANNUAL_PERIOD');
      return `${end.slice(0, 4)}年度`;
    }
    if (specification.style === 'range' && value.period.start) return `${value.period.start}至${value.period.end}`;
    throw new Error('UPDATE_INVALID_PERIOD_DISPLAY');
  }
  if (specification.kind !== 'number' || !value.number) throw new Error('UPDATE_NOT_NUMERIC');
  const number = value.unit === 'ratio' && specification.unit === '%' ? arithmetic.scale(value.number, 100n)
    : arithmetic.convert(value.number, value.unit, specification.unit);
  return arithmetic.display(number, specification.decimalPlaces, specification.groupThousands);
}

function simpleCell(block: BaselineBlock): { table: number; row: number; column: number } | null {
  const path = block.locator.path;
  if (block.locatorType !== 'docx_block' || !Array.isArray(path) || path.length !== 2 || path[1]?.paragraph !== 1) return null;
  const { table, row, column } = path[0] ?? {};
  return [table, row, column].every(n => Number.isInteger(n) && n > 0) ? { table, row, column } : null;
}

/** Makes no model calls, writes no database state, and never upgrades facts or a run to success. */
export function planHistoricalUpdate(input: HistoricalUpdateInput): HistoricalUpdatePlan {
  // Clone so inputs, old artifacts, and a returned plan never share mutable objects.
  const { context, baseline, facts, bindings, occurrences, columns, coverage } = structuredClone(input);
  if (baseline.ownerUserId !== context.ownerUserId || baseline.projectId !== context.projectId ||
    ![context.ownerUserId, context.projectId, context.issuerEntityId, baseline.materialId, baseline.snapshotId, baseline.parserVersion].every(required) ||
    ![context.inputHash, baseline.contentHash, baseline.parseResultHash, context.ruleSnapshot.contentHash].every(hash) ||
    ![context.ruleSnapshot.packId, context.ruleSnapshot.version].every(required) ||
    !Number.isSafeInteger(context.inputRevision) || context.inputRevision < 1 ||
    !Number.isSafeInteger(baseline.materialVersion) || baseline.materialVersion < 1 ||
    !isMarketOffering(context.targetMarket, context.targetOffering)) throw new Error('UPDATE_INVALID_CONTEXT');
  if (baseline.blocks.length === 0 || baseline.blocks.length > 100_000 ||
    new Set(baseline.blocks.map(block => block.recordId)).size !== baseline.blocks.length ||
    !Object.values(baseline.priorRevisions).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('UPDATE_INVALID_BASELINE');
  if (facts.length > 100_000 || new Set(facts.map(fact => fact.candidate.candidateId)).size !== facts.length) throw new Error('UPDATE_DUPLICATE_FACT');
  for (const fact of facts) validateIdentity(fact.candidate.identity, context);
  for (const block of baseline.blocks) if (!required(block.recordId) || typeof block.text !== 'string' || block.text.length > 256_000) throw new Error('UPDATE_INVALID_BASELINE');
  const findings: UpdateFinding[] = [];
  const flag = (code: string, recordIds: string[] = [], bindingIds: string[] = []) => findings.push({ code, recordIds, bindingIds });
  const profile = baseline.profile;
  if (profile.material_id !== baseline.materialId || profile.material_version !== baseline.materialVersion) throw new Error('UPDATE_PROFILE_BASELINE_MISMATCH');
  if (baseline.format !== 'docx_effective') flag('UPDATE_PDF_RECONSTRUCTION_REQUIRED');
  const uncertainBlocks = baseline.blocks.filter(block => block.uncertainty.length > 0);
  // The parser contract permits needs_confirmation with no document warnings when
  // uncertainty is attached to individual records. Keep every document warning,
  // failed parse, or inconsistent status/record combination as a global gate.
  const localizedUncertainty = baseline.parseStatus === 'needs_confirmation' && baseline.warnings.length === 0 && uncertainBlocks.length > 0;
  if (baseline.parseStatus === 'failed' || baseline.warnings.length > 0 ||
    (baseline.parseStatus === 'parsed' && uncertainBlocks.length > 0) ||
    (baseline.parseStatus === 'needs_confirmation' && uncertainBlocks.length === 0)) flag('UPDATE_BASELINE_UNCERTAIN');
  const localizedUncertainRecordIds = new Set<string>();
  const sourceFields = [profile.source_market, profile.source_offering, profile.latest_reporting_cutoff, ...profile.reporting_periods];
  const recordIds = new Set(baseline.blocks.map(block => block.recordId));
  const uncertainBlockIds = new Set(uncertainBlocks.map(block => block.recordId));
  if (profile.state !== 'ready' || !profile.reporting_periods.length ||
    !profile.source_market.value || !profile.source_offering.value || !isMarketOffering(profile.source_market.value, profile.source_offering.value) ||
    !profile.latest_reporting_cutoff.value || !date(profile.latest_reporting_cutoff.value) ||
    profile.latest_reporting_cutoff.value !== profile.reporting_periods.map(period => period.end).filter((end): end is string => end !== null).sort().at(-1) ||
    profile.reporting_periods.some(period => !period.start || !period.end || !date(period.start) || !date(period.end) ||
      period.start > period.end || !period.period_kind || !period.scope) ||
    sourceFields.some(field => field.status !== 'recognized' || field.uncertainty.length ||
      field.provenance.material_id !== baseline.materialId || field.provenance.material_version !== baseline.materialVersion ||
      !field.provenance.evidence_refs.length || field.provenance.evidence_refs.some(id => !recordIds.has(id) || uncertainBlockIds.has(id)))) flag('UPDATE_PROFILE_UNCONFIRMED');
  if (profile.source_market.value !== context.targetMarket || profile.source_offering.value !== context.targetOffering) flag('UPDATE_STRUCTURE_MAPPING_REQUIRED');
  const globalBlocked = findings.length > 0;
  if (localizedUncertainty) for (const block of uncertainBlocks) {
    localizedUncertainRecordIds.add(block.recordId);
    flag('UPDATE_BASELINE_BLOCK_UNCERTAIN', [block.recordId]);
  }
  const blockById = new Map(baseline.blocks.map(block => [block.recordId, block]));
  const bindingById = new Map(bindings.map(binding => [binding.bindingId, binding]));
  if (bindingById.size !== bindings.length) throw new Error('UPDATE_DUPLICATE_BINDING');
  const occurrenceIds = occurrences.map(occurrence => occurrence.occurrenceId).concat(columns.map(column => column.changeId));
  if (occurrenceIds.some(id => !required(id)) || new Set(occurrenceIds).size !== occurrenceIds.length) throw new Error('UPDATE_DUPLICATE_CHANGE');
  const values = new Map<string, ResolvedValue>();
  const failedBindings = new Set<string>();
  for (const binding of bindings) {
    try { validateBinding(binding, context); values.set(binding.bindingId, evaluate(binding, facts)); }
    catch (error) { failedBindings.add(binding.bindingId); flag(error instanceof Error ? error.message : 'UPDATE_INVALID_BINDING', [], [binding.bindingId]); }
  }
  const reviews = new Map(coverage.map(item => [item.recordId, item]));
  if (reviews.size !== coverage.length || coverage.some(item => !blockById.has(item.recordId) || !item.reason.trim() || !['retain', 'update', 'needs_evidence'].includes(item.disposition))) throw new Error('UPDATE_INVALID_COVERAGE');
  const pendingRecords = new Set<string>();
  for (const recordId of localizedUncertainRecordIds) pendingRecords.add(recordId);
  for (const block of baseline.blocks) {
    const review = reviews.get(block.recordId);
    if (!review || review.disposition === 'needs_evidence') { pendingRecords.add(block.recordId); flag('UPDATE_COVERAGE_INCOMPLETE', [block.recordId]); }
  }
  const replacements: PlannedReplacement[] = [];
  for (const occurrence of occurrences) {
    const block = blockById.get(occurrence.recordId);
    const binding = bindingById.get(occurrence.bindingId);
    if (!block || !binding) throw new Error('UPDATE_UNKNOWN_BINDING_OR_ANCHOR');
    if (localizedUncertainRecordIds.has(block.recordId)) continue;
    if (!Number.isInteger(occurrence.start) || !Number.isInteger(occurrence.end) || occurrence.start < 0 ||
      occurrence.end <= occurrence.start || occurrence.end > block.text.length || splitsSurrogate(block.text, occurrence.start) || splitsSurrogate(block.text, occurrence.end) ||
      block.text.slice(occurrence.start, occurrence.end) !== occurrence.before) {
      failedBindings.add(binding.bindingId); flag('UPDATE_STALE_ANCHOR', [block.recordId], [binding.bindingId]); continue;
    }
    if (reviews.get(block.recordId)?.disposition !== 'update') { failedBindings.add(binding.bindingId); flag('UPDATE_COVERAGE_CONFLICT', [block.recordId], [binding.bindingId]); continue; }
    const resolved = values.get(binding.bindingId);
    if (!resolved) continue;
    try {
      if (resolved.previous && format(resolved.previous, occurrence.display) !== occurrence.before) throw new Error('UPDATE_RESTATEMENT_BASELINE_MISMATCH');
      const after = format(resolved, occurrence.display);
      if (after === occurrence.before) continue;
      replacements.push({ kind: 'replace_text', changeId: occurrence.occurrenceId, bindingId: binding.bindingId,
        recordId: block.recordId, locator: block.locator, start: occurrence.start, end: occurrence.end,
        before: occurrence.before, after, reason: binding.reason, evidence: resolved.sources.flatMap(source => source.evidence),
        candidateIds: resolved.sources.map(source => source.candidate.candidateId), expression: binding.expression, replaces: binding.replaces ?? null,
        sourceStatuses: resolved.sources.map(source => source.status) });
    } catch (error) { failedBindings.add(binding.bindingId); flag(error instanceof Error ? error.message : 'UPDATE_INVALID_DISPLAY', [block.recordId], [binding.bindingId]); }
  }
  // Check all requested intervals, including unchanged values, before applying any member of a binding group.
  for (const block of baseline.blocks) {
    const ranges = occurrences.filter(item => item.recordId === block.recordId).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) {
      const ids = [ranges[i]!.bindingId, ranges[i - 1]!.bindingId];
      ids.forEach(id => failedBindings.add(id)); flag('UPDATE_OVERLAPPING_CHANGES', [block.recordId], ids);
    }
  }
  const plannedColumns: PlannedColumn[] = [];
  const columnPositions = new Set<string>();
  for (const request of columns) {
    const uncertainAnchors = request.cells.filter(cell => localizedUncertainRecordIds.has(cell.afterRecordId));
    if (uncertainAnchors.length) {
      for (const cell of uncertainAnchors) flag('UPDATE_BASELINE_BLOCK_UNCERTAIN', [cell.afterRecordId], [cell.bindingId]);
      continue;
    }
    try {
      if (!request.cells.length) throw new Error('UPDATE_EMPTY_COLUMN');
      const anchors = request.cells.map(cell => blockById.get(cell.afterRecordId));
      const positions = anchors.map(anchor => anchor && simpleCell(anchor));
      if (positions.some(position => !position)) throw new Error('UPDATE_COMPLEX_TABLE_REQUIRES_MAPPING');
      const first = positions[0]!;
      const columnPosition = `${first.table}:${first.column}`;
      if (columnPositions.has(columnPosition)) throw new Error('UPDATE_DUPLICATE_COLUMN_POSITION');
      columnPositions.add(columnPosition);
      if (positions.some(position => position!.table !== first.table || position!.column !== first.column)) throw new Error('UPDATE_COLUMN_ANCHOR_MISMATCH');
      const tableBlocks = baseline.blocks.filter(block => Array.isArray(block.locator.path) && block.locator.path[0]?.table === first.table);
      const grid = tableBlocks.map(simpleCell);
      if (grid.some(cell => !cell)) throw new Error('UPDATE_COMPLEX_TABLE_REQUIRES_MAPPING');
      const rows = [...new Set(grid.map(cell => cell!.row))].sort((a, b) => a - b);
      const widths = rows.map(row => [...new Set(grid.filter(cell => cell!.row === row).map(cell => cell!.column))].sort((a, b) => a - b).join(','));
      const columnNumbers = [...new Set(grid.map(cell => cell!.column))].sort((a, b) => a - b);
      if (rows.some((row, index) => row !== index + 1) || new Set(widths).size !== 1 ||
        columnNumbers.some((column, index) => column !== index + 1) || new Set(grid.map(cell => `${cell!.row}:${cell!.column}`)).size !== grid.length ||
        request.cells.length !== rows.length || new Set(positions.map(position => position!.row)).size !== rows.length) throw new Error('UPDATE_TABLE_COVERAGE_INCOMPLETE');
      const columnContexts: string[] = [];
      const cells = request.cells.map((cell, index) => {
        const value = values.get(cell.bindingId); const binding = bindingById.get(cell.bindingId);
        if (!value || !binding || failedBindings.has(cell.bindingId)) throw new Error('UPDATE_COLUMN_FACT_UNRESOLVED');
        if (reviews.get(cell.afterRecordId)?.disposition !== 'update') throw new Error('UPDATE_COVERAGE_CONFLICT');
        const identity = identities(binding.expression)[0]!;
        if (binding.reason !== 'new_period') throw new Error('UPDATE_COLUMN_REQUIRES_NEW_PERIOD');
        if ((value.period.asOf ?? value.period.end!) <= (profile.latest_reporting_cutoff.value ?? '')) throw new Error('UPDATE_COLUMN_PERIOD_NOT_NEW');
        columnContexts.push(canonical([value.period, identity.scope, identity.currency, identity.basis]));
        return { row: positions[index]!.row, anchorRecordId: cell.afterRecordId, bindingId: cell.bindingId, before: '' as const,
          after: format(value, cell.display), evidence: value.sources.flatMap(source => source.evidence),
          candidateIds: value.sources.map(source => source.candidate.candidateId), expression: binding.expression,
          reason: 'new_period' as const, sourceStatuses: value.sources.map(source => source.status) };
      }).sort((a, b) => a.row - b.row);
      if (new Set(columnContexts).size !== 1) throw new Error('UPDATE_COLUMN_CONTEXT_MISMATCH');
      plannedColumns.push({ kind: 'insert_table_column', changeId: request.changeId, table: first.table, afterColumn: first.column,
        cells, requiresPhysicalGridValidation: true });
    } catch (error) {
      request.cells.forEach(cell => failedBindings.add(cell.bindingId));
      flag(error instanceof Error ? error.message : 'UPDATE_INVALID_COLUMN', request.cells.map(cell => cell.afterRecordId), request.cells.map(cell => cell.bindingId));
    }
  }
  const usedBindings = new Set(occurrences.map(item => item.bindingId).concat(columns.flatMap(column => column.cells.map(cell => cell.bindingId))));
  for (const binding of bindings) if (!usedBindings.has(binding.bindingId)) flag('UPDATE_BINDING_HAS_NO_OCCURRENCE', [], [binding.bindingId]);
  const validReplacements = globalBlocked ? [] : replacements.filter(change => !failedBindings.has(change.bindingId));
  const validColumns = globalBlocked ? [] : plannedColumns.filter(column => column.cells.every(cell => !failedBindings.has(cell.bindingId)));
  const failedRecordIds = new Set(occurrences.filter(item => failedBindings.has(item.bindingId)).map(item => item.recordId)
    .concat(columns.filter(column => column.cells.some(cell => failedBindings.has(cell.bindingId))).flatMap(column => column.cells.map(cell => cell.afterRecordId)),
      [...localizedUncertainRecordIds]));
  const addressedRecords = new Set(occurrences.filter(item => !failedBindings.has(item.bindingId) && !localizedUncertainRecordIds.has(item.recordId)).map(item => item.recordId)
    .concat(validColumns.flatMap(column => column.cells.map(cell => cell.anchorRecordId))));
  for (const block of baseline.blocks) if (reviews.get(block.recordId)?.disposition === 'update' && (!addressedRecords.has(block.recordId) || failedRecordIds.has(block.recordId) || globalBlocked)) {
    pendingRecords.add(block.recordId); flag('UPDATE_RECORD_NOT_RESOLVED', [block.recordId]);
  }
  const textPreview = baseline.blocks.map(block => {
    let after = block.text;
    for (const change of validReplacements.filter(change => change.recordId === block.recordId).sort((a, b) => b.start - a.start)) {
      after = after.slice(0, change.start) + change.after + after.slice(change.end);
    }
    return { recordId: block.recordId, before: block.text, after, locator: block.locator, formatting: block.formatting };
  });
  const result: Omit<HistoricalUpdatePlan, 'planHash'> = {
    schemaVersion: HISTORICAL_UPDATE_VERSION, baselineHash: updateContentHash(baseline), planningInputHash: updateContentHash(input), context,
    source: { materialId: baseline.materialId, materialVersion: baseline.materialVersion, contentHash: baseline.contentHash,
      snapshotId: baseline.snapshotId, parserVersion: baseline.parserVersion, parseResultHash: baseline.parseResultHash,
      priorRevisions: baseline.priorRevisions, format: baseline.format }, sourceProfile: profile,
    status: findings.length ? 'needs_confirmation' : 'planned', deliverable: false,
    replacements: validReplacements, columns: validColumns, textPreview, findings,
    coverage: { total: baseline.blocks.length, retained: coverage.filter(item => item.disposition === 'retain' && !pendingRecords.has(item.recordId)).length,
      updated: [...addressedRecords].filter(id => !pendingRecords.has(id)).length, pending: pendingRecords.size },
  };
  return { ...result, planHash: updateContentHash(result) };
}
