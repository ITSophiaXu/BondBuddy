import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const id = Type.String({ minLength: 1, maxLength: 128 });
const refs = Type.Array(id, { maxItems: 200, uniqueItems: true });
const common = {
  reason_code: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
  evidence_ref: Type.Union([id, Type.Null()]),
  source_ref_ids: refs,
};

/** A coverage item has its own identity. Its name is never an inferred rule reference. */
export const TestCoverageGapSchema = Type.Object({
  kind: Type.Literal('coverage_gap'),
  manifest_id: id,
  manifest_version: id,
  item_id: id,
  candidate_asset_sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  disposition: Type.Literal('uncovered'),
  area: Type.String({ minLength: 1, maxLength: 500 }),
  rationale: Type.String({ minLength: 1, maxLength: 8000 }),
  rule_ids: refs,
  ...common,
}, { additionalProperties: false });

export const TestRuleCheckGapSchema = Type.Object({
  kind: Type.Literal('rule_check'),
  rule_id: id,
  ...common,
}, { additionalProperties: false });

// Scope exclusions remain in the pinned coverage evaluation; they cannot be emitted as missing work.
export const TestUncoveredItemSchema = Type.Union([TestCoverageGapSchema, TestRuleCheckGapSchema]);
export const TestUncoveredItemsSchema = Type.Array(TestUncoveredItemSchema, { maxItems: 200 });
export type TestCoverageGap = Static<typeof TestCoverageGapSchema>;
export type TestUncoveredItem = Static<typeof TestUncoveredItemSchema>;
export function isTestUncoveredItems(value: unknown): value is TestUncoveredItem[] {
  return Value.Check(TestUncoveredItemsSchema, value);
}
