import type { Run } from '@bondbuddy/contracts';

export type RecoveryKind = 'refresh' | 'materials' | 'resume' | 'support' | 'prepare';
export type ExecutionRecovery = { kind: RecoveryKind; title: string; instruction: string };
export type RecoveryContext = { reason?: string; stale?: boolean; repeatedPause?: boolean; needsRecharge?: boolean };

/** Presentation only. This never authorizes a transition or changes a run's input. */
export function executionRecovery(run: Pick<Run, 'state' | 'stage'>, context: RecoveryContext = {}): ExecutionRecovery | undefined {
  if (context.stale) return {
    kind: 'refresh', title: '先核对原任务状态',
    instruction: '当前显示最近已知记录，不能确认后台的最新进展。刷新只读取原任务，不重新提交；持续无法同步时可复制定位摘要联系支持。'
  };
  if (['succeeded', 'test_completed'].includes(run.state) || context.needsRecharge) return;
  if (run.state === 'paused' && run.stage === 'user_paused') return {
    kind: 'resume', title: '继续原任务',
    instruction: '继续会沿用本任务的材料、已保存进度和原计费规则，不创建新一轮。需要更换材料时，请先停止本次任务。'
  };
  if (context.repeatedPause || context.reason === 'word_size_repair_exhausted') return {
    kind: 'support', title: '请支持人员核对恢复条件',
    instruction: '重复继续不会解决当前条件。请复制定位摘要交给支持人员；已有材料和成果保留，无需重新上传。'
  };
  if (run.state === 'paused' && ['provider_reconcile', 'billing_reconcile', 'awaiting_materials', 'trial_limit'].includes(run.stage ?? '')) return {
    kind: 'refresh', title: '核对原任务的恢复状态',
    instruction: '请刷新原任务状态，查看处理条件是否恢复。无需重复提交或重新上传；是否能够继续以服务端返回为准。'
  };
  const reason = context.reason ?? '';
  const materialProblem = ['MATERIAL_UNREADABLE', 'authoring_material_unreadable', 'authoring_ocr_incomplete',
    'authoring_target_information_required', 'authoring_issuer_materials_required', 'material_versions', 'authoring_no_verified_changes'].includes(reason)
    || reason.startsWith('material_parse_failed:') || reason.startsWith('material_parse_cancelled:');
  if (materialProblem && ['failed', 'rejected', 'paused', 'awaiting_input'].includes(run.state)) return {
    kind: 'materials', title: '核对本轮材料与要求',
    instruction: ['failed', 'rejected'].includes(run.state)
      ? '先查看需处理材料；需要替换或补充时，选择“准备新一轮”。准备只打开草稿，明确开始后才提交新任务。'
      : '本轮材料已锁定，先查看需处理材料。如需替换或补充，请先停止本次任务，再准备新一轮；不会改写原任务输入。'
  };
  if (run.state === 'cancelled') return {
    kind: 'prepare', title: '需要继续工作时，准备新一轮',
    instruction: '本次任务已停止，不能用“准备新一轮”恢复它。原材料和成果保留；准备本身不执行，新任务开始后按其适用规则计费。'
  };
  if (['failed', 'rejected', 'paused', 'awaiting_input'].includes(run.state)) return {
    kind: 'support', title: '请支持人员核对本轮任务',
    instruction: '请复制定位摘要交给支持人员，核对原因和可用恢复方式。无需仅因系统提示重传材料；不要把准备新一轮当成原任务恢复。'
  };
}

/** Only use a material reference when the reason explicitly names it. Do not guess from the latest upload. */
export function recoveryMaterialId(reason?: string): string | undefined {
  return reason?.match(/^material_parse_(?:failed|cancelled):([^:]+)(?::\d+)?$/)?.[1];
}

/** Allowlisted diagnostic text; no raw errors, filenames, project names, URLs, prompts or hashes. */
export function recoverySupportSummary(run: Pick<Run, 'run_id' | 'state' | 'updated_at'>, stateLabel: string, stale: boolean): string {
  const id = /^[a-zA-Z0-9_-]{1,128}$/.test(run.run_id) ? run.run_id : '暂不可提供，请在原任务页联系支持';
  const timestamp = Number.isFinite(Date.parse(run.updated_at)) ? new Date(run.updated_at).toISOString() : '未知';
  return ['BondBuddy 任务定位摘要', `任务编号：${id}`, `最近已知状态：${stateLabel}`,
    `任务记录更新时间：${timestamp}`, `最新状态同步：${stale ? '暂不可获取' : '已读取'}`,
    '此摘要不含材料正文；请核对原任务，不创建新的执行请求。'].join('\n');
}
