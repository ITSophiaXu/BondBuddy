/** Synthetic CLI turn using the real run-local tools. Never a real provider/business acceptance. */
import { callReviewTool, createReviewToolTrace, type ReviewToolData, type ReviewToolTrace } from './review-tools.js';
import type { CliReview } from './review-model-stage.js';
import type { ModelReviewAnalysis } from './review-analysis-protocol.js';

export function syntheticCliReview(data: ReviewToolData, selection: {
  financial?: Pick<ModelReviewAnalysis, 'observations' | 'calculations'> & { audit_rule_ids?: string[]; native_formula_record_ids?: string[] };
  compliance?: { assessments: ModelReviewAnalysis['compliance_assessments']; rule_keys: string[]; formatting_check_ids?: string[]; formatting_record_ids?: string[] };
  concerns?: CliReview['concerns']; checks?: CliReview['checks'];
} = {}): { output: CliReview; tool_trace: ReviewToolTrace } {
  const trace = createReviewToolTrace(data);
  const materials = (callReviewTool(data, 'list_materials', {}, trace) as { materials: { id: string; records: number }[] }).materials;
  for (const material of materials) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = callReviewTool(data, 'read_records', { material_id: material.id, offset, limit: 300 }, trace) as { next_offset: number | null };
      offset = page.next_offset;
    }
  }
  let offset: number | null = 0;
  while (offset !== null) offset = (callReviewTool(data, 'read_knowledge', { offset, limit: 30000 }, trace) as { next_offset: number | null }).next_offset;
  if (selection.financial) callReviewTool(data, 'check_financial', selection.financial, trace);
  if (selection.compliance) callReviewTool(data, 'check_compliance', selection.compliance, trace);
  return { output: { summary: 'Synthetic CLI review using explicit tool selections.', reviewed_record_count: trace.read_record_ids.length,
    receipt_ids: trace.receipts.map(r => r.receipt_id), concerns: selection.concerns ?? [], checks: selection.checks ?? [], limitations: [] }, tool_trace: trace };
}
