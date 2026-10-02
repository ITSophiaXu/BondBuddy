import { Value } from '@sinclair/typebox/value';
import { ReviewContextSchema, type ReviewContext, type ReviewMessageDraft, type ReviewExecutionRequest, type Run } from '@bondbuddy/contracts';

export function contextKey(context: ReviewContext): string {
  return JSON.stringify({ project: context.project_id, report: context.report_id,
    findings: [...context.finding_ids].sort(), materials: context.material_refs.map(ref => `${ref.material_id}:${ref.material_version}:${ref.sha256}`).sort() });
}

/** Browser recovery is scoped to the authenticated owner and project; the API is authoritative. */
export function readDraftCache(storage: Pick<Storage, 'getItem'>, owner: string, projectId: string): ReviewMessageDraft[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(`bb-review-drafts:${owner}:${projectId}`) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ReviewMessageDraft => item && typeof item === 'object' &&
      Value.Check(ReviewContextSchema, item.context) && item.context.project_id === projectId &&
      typeof item.content === 'string' && item.content.length <= 12000 && Number.isInteger(item.version) && item.version >= 0 && typeof item.updated_at === 'string');
  } catch { return []; }
}

export function saveDraftCache(storage: Pick<Storage, 'setItem'>, owner: string, projectId: string, drafts: Iterable<ReviewMessageDraft>): boolean {
  try {
    storage.setItem(`bb-review-drafts:${owner}:${projectId}`, JSON.stringify([...drafts].filter(d => d.context.project_id === projectId)));
    return true;
  } catch { return false; }
}

export const isActiveRun = (run: Run | null | undefined): boolean => Boolean(run && !['succeeded', 'test_completed', 'failed', 'cancelled', 'rejected'].includes(run.state));

export function executionIdentity(input: Omit<ReviewExecutionRequest, 'execution_request_id'>): string {
  return JSON.stringify({ operation: input.operation, input: input.expected_input_version, source: input.source_report_id,
    plan: input.expected_plan_version, findings: [...input.finding_ids].sort() });
}

export const runStateLabel: Record<Run['state'], string> = {
  preparing:'准备中', rejected:'未启动', queued:'排队中', running:'处理中', awaiting_input:'待补充材料', paused:'等待恢复',
  validating:'检查成果', delivering:'生成文档', settlement_pending:'确认结果中', succeeded:'已完成', test_completed:'内部测试稿', failed:'处理失败', cancelled:'已停止',
};
