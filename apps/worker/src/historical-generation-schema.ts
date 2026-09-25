import { Ajv } from 'ajv';
import type { BlockDisposition, TableColumnRequest, UpdateBinding, UpdateOccurrence, ValueDisplay } from '@bondbuddy/domain/historical-update';
import type { StoredFactCandidate } from './fact-repository.js';
import type { DocumentParseRecord } from './document-parser.js';

export const HISTORICAL_GENERATION_VERSION = 'historical-generation-v1';
const str = { type: 'string', minLength: 1, maxLength: 12000 };
const id = { type: 'string', minLength: 1, maxLength: 256 };
const explanation = { type: 'string', minLength: 1, maxLength: 1200, pattern: '\\S' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const expression = object({ operation: { enum: ['fact', 'sum', 'ratio', 'difference', 'growth_percent'] }, candidate_ids: { type: 'array', minItems: 1, maxItems: 32, items: id } });
const display = { anyOf: [
  object({ kind: { const: 'number' }, unit: id, decimalPlaces: { type: 'integer', minimum: 0, maximum: 12 }, groupThousands: { type: 'boolean' } }),
  object({ kind: { const: 'period' }, style: { enum: ['year', 'annual', 'date', 'range'] } }),
  object({ kind: { const: 'source_text' } }),
] };
const binding = { expression, reason: { enum: ['new_period', 'restatement', 'correction'] }, replaces_candidate_id: { anyOf: [id, { type: 'null' }] } };
const change = object({ start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, before: str, ...binding, display });
export const historicalGenerationSchema = object({
  schema_version: { const: HISTORICAL_GENERATION_VERSION },
  blocks: { type: 'array', minItems: 1, maxItems: 80, items: object({ record_id: id,
    disposition: { enum: ['retain', 'update', 'needs_evidence'] }, reason: explanation,
    changes: { type: 'array', maxItems: 100, items: change } }) },
  columns: { type: 'array', maxItems: 20, items: object({ cells: { type: 'array', minItems: 1, maxItems: 80,
    items: object({ after_record_id: id, expression, display }) } }) },
});
type Expression = { operation: 'fact' | 'sum' | 'ratio' | 'difference' | 'growth_percent'; candidate_ids: string[] };
type ModelBinding = { expression: Expression; reason: UpdateBinding['reason']; replaces_candidate_id: string | null };
export type HistoricalModelAnswer = { schema_version: typeof HISTORICAL_GENERATION_VERSION;
  blocks: { record_id: string; disposition: BlockDisposition['disposition']; reason: string;
    changes: (ModelBinding & { start: number; end: number; before: string; display: ValueDisplay })[] }[];
  columns: { cells: { after_record_id: string; expression: Expression; display: ValueDisplay }[] }[];
};
const checkShape = new Ajv({ strict: false }).compile(historicalGenerationSchema);
export type SemanticInventory = { bindings: UpdateBinding[]; occurrences: UpdateOccurrence[]; columns: TableColumnRequest[]; coverage: BlockDisposition[] };

/** The model proposes references only: values, identities, evidence and status come from the frozen server inventory. */
export function semanticInventory(value: unknown, records: readonly DocumentParseRecord[], facts: readonly StoredFactCandidate[], batch: number): SemanticInventory {
  if (!checkShape(value)) throw new Error('UPDATE_INVALID_MODEL_INVENTORY');
  const answer = value as HistoricalModelAnswer;
  const recordMap = new Map(records.map(r => [r.record_id, r]));
  const factMap = new Map(facts.map(f => [f.candidate.candidateId, f.candidate.identity]));
  const seen = new Set<string>();
  const result: SemanticInventory = { bindings: [], occurrences: [], columns: [], coverage: [] };
  const resolve = (id: string) => { const identity = factMap.get(id); if (!identity) throw new Error('UPDATE_MODEL_UNKNOWN_FACT'); return identity; };
  const addBinding = (source: ModelBinding): string => {
    const operands = source.expression.candidate_ids.map(resolve);
    if (new Set(source.expression.candidate_ids).size !== operands.length ||
      (source.expression.operation === 'fact' ? operands.length !== 1 : source.expression.operation !== 'sum' && operands.length !== 2)) throw new Error('UPDATE_INVALID_MODEL_EXPRESSION');
    if ((source.reason === 'restatement') !== (source.replaces_candidate_id !== null)) throw new Error('UPDATE_INVALID_MODEL_RESTATEMENT');
    const expr: UpdateBinding['expression'] = source.expression.operation === 'fact' ? { kind: 'fact', identity: operands[0]! }
      : source.expression.operation === 'sum' ? { kind: 'sum', terms: operands }
      : { kind: source.expression.operation, left: operands[0]!, right: operands[1]! };
    // The same financial expression shares a binding across every occurrence and batch.
    const key = JSON.stringify([expr, source.reason, source.replaces_candidate_id ? resolve(source.replaces_candidate_id) : null]);
    let existing = result.bindings.find(b => JSON.stringify([b.expression, b.reason, b.replaces ?? null]) === key);
    if (!existing) {
      existing = { bindingId: `b${batch}-${result.bindings.length}`, expression: expr, reason: source.reason,
        ...(source.replaces_candidate_id ? { replaces: resolve(source.replaces_candidate_id) } : {}) };
      result.bindings.push(existing);
    }
    return existing.bindingId;
  };
  for (const block of answer.blocks) {
    const record = recordMap.get(block.record_id);
    if (!record || seen.has(block.record_id)) throw new Error('UPDATE_MODEL_COVERAGE_MISMATCH');
    seen.add(block.record_id);
    if (block.disposition !== 'update' && block.changes.length) throw new Error('UPDATE_MODEL_COVERAGE_CONFLICT');
    result.coverage.push({ recordId: block.record_id, disposition: block.disposition, reason: block.reason });
    const ranges = [...block.changes].sort((a, b) => a.start - b.start);
    for (let i = 0; i < ranges.length; i++) {
      const c = ranges[i]!;
      if (c.end <= c.start || record.literal_quote.slice(c.start, c.end) !== c.before || c.end > record.literal_quote.length ||
        (i > 0 && c.start < ranges[i - 1]!.end)) throw new Error('UPDATE_MODEL_STALE_ANCHOR');
      result.occurrences.push({ occurrenceId: `m${batch}-${result.occurrences.length}`, bindingId: addBinding(c), recordId: block.record_id,
        start: c.start, end: c.end, before: c.before, display: c.display });
    }
  }
  if (seen.size !== records.length) throw new Error('UPDATE_MODEL_COVERAGE_INCOMPLETE');
  for (const column of answer.columns) {
    const cells = column.cells.map(cell => {
      if (!recordMap.has(cell.after_record_id) || !answer.blocks.some(b => b.record_id === cell.after_record_id && b.disposition === 'update')) throw new Error('UPDATE_MODEL_COLUMN_ANCHOR');
      return { afterRecordId: cell.after_record_id, bindingId: addBinding({ expression: cell.expression, reason: 'new_period', replaces_candidate_id: null }), display: cell.display };
    });
    result.columns.push({ changeId: `col${batch}-${result.columns.length}`, cells });
  }
  return result;
}

/** Merge expression-equivalent bindings so a bad citation cannot update only one occurrence of an amount. */
export function mergeInventories(parts: SemanticInventory[]): SemanticInventory {
  const out: SemanticInventory = { bindings: [], occurrences: [], columns: [], coverage: [] };
  const keys = new Map<string, string>();
  for (const part of parts) {
    const ids = new Map<string, string>();
    for (const binding of part.bindings) {
      const key = JSON.stringify([binding.expression, binding.reason, binding.replaces ?? null]);
      let id = keys.get(key);
      if (!id) { id = `binding-${out.bindings.length}`; keys.set(key, id); out.bindings.push({ ...binding, bindingId: id }); }
      ids.set(binding.bindingId, id);
    }
    out.occurrences.push(...part.occurrences.map(c => ({ ...c, bindingId: ids.get(c.bindingId)! })));
    out.columns.push(...part.columns.map(c => ({ ...c, cells: c.cells.map(cell => ({ ...cell, bindingId: ids.get(cell.bindingId)! })) })));
    out.coverage.push(...part.coverage);
  }
  return out;
}
