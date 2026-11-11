/** View state only. Server drafts, input pins, tasks and grants remain authoritative. */
export type WorkspaceTab =
  | { key: string; kind: 'input'; documentType: string | null; title: string }
  | { key: string; kind: 'making'; runId: string; title: string }
  | { key: string; kind: 'artifact'; artifactId: string; version: number; title: string; runId?: string };
export type WorkspaceReading = { tabs: WorkspaceTab[]; selected: string; scroll: Record<string, number> };
export type DiscussionQuote = { artifactId: string; version: number; anchor: string; text: string };
export type DiscussionComposer = { text: string; quote: DiscussionQuote | null; taskContext: string | null };

export function m4ProgressLabel(stage:string|null,reason?:string):string{
  const reasons:Record<string,string>={m4_reading_materials:'正在读取本轮材料',m4_document_working:'正在制作材料正文',m4_qa_working:'正在处理问题与引用材料',m4_writing_files:'正在制作可编辑文件',m4_registering_artifacts:'正在保存成果与制作说明'};
  const stages:Record<string,string>={input_lock:'正在固定本轮输入',materials_ready:'正在准备材料',model_generation:'正在生成材料正文',m4_document_prompt:'正在制作材料',m4_document_v1_prompt:'正在生成材料正文',m4_qa_v1_prompt:'正在处理讨论',m4_qa_prompt:'正在处理讨论',word_delivery:'正在准备成果下载',artifact_registration:'正在登记成果',settlement_pending:'正在完成交付',provider_reconcile:'正在核对执行状态',billing_reconcile:'正在核对积分账务，已保存进度并暂停',queued:'等待开始',awaiting_materials:'等待材料处理',capability_not_ready:'执行条件尚未就绪'};
  return reason&&reasons[reason]||stage&&stages[stage]||'正在处理本次材料，完成后将自动更新';
}

export const initialReading = (): WorkspaceReading => ({
  tabs: [{ key: 'input', kind: 'input', documentType: null, title: '任务输入' }], selected: 'input', scroll: {},
});
export function selectWorkspaceTab(state: WorkspaceReading, key: string): WorkspaceReading {
  return state.tabs.some(tab => tab.key === key) ? { ...state, selected: key } : state;
}
export function openWorkspaceTab(state: WorkspaceReading, tab: WorkspaceTab, focus = true): WorkspaceReading {
  const existing = state.tabs.find(item => tab.kind === 'artifact' && item.kind === 'artifact'
    ? item.artifactId === tab.artifactId && item.version === tab.version
    : item.key === tab.key);
  return { ...state, tabs: existing ? state.tabs : [...state.tabs, tab], selected: focus ? existing?.key ?? tab.key : state.selected };
}
export function closeWorkspaceTab(state: WorkspaceReading, key: string): WorkspaceReading {
  if (key === 'input') return state;
  const index = state.tabs.findIndex(tab => tab.key === key), tabs = state.tabs.filter(tab => tab.key !== key);
  return { ...state, tabs, selected: state.selected === key ? tabs[Math.max(0, index - 1)]?.key ?? 'input' : state.selected };
}
/** Only submitting from the input view focuses making. Reading an old file never moves. */
export function taskSubmitted(state: WorkspaceReading, runId: string, title: string): WorkspaceReading {
  return openWorkspaceTab(state, { key: `run:${runId}`, kind: 'making', runId, title }, state.selected === 'input');
}
/** Replace the making view in place; do not reopen a view the user has closed. */
export function taskArtifactAvailable(state: WorkspaceReading, runId: string, artifactId: string, version: number, title: string): WorkspaceReading {
  const key = `run:${runId}`;
  if (!state.tabs.some(tab => tab.key === key)) return state;
  return { ...state, tabs: state.tabs.map(tab => tab.key === key
    ? { key, kind: 'artifact', runId, artifactId, version, title }
    : tab) };
}
export function prepareInput(state: WorkspaceReading, documentType: string | null): WorkspaceReading {
  return { ...state, selected: 'input', tabs: state.tabs.map(tab => tab.key === 'input'
    ? { key: 'input', kind: 'input', documentType, title: '任务输入' } : tab) };
}
/** Discussion carries task context separately. It never sends or changes existing text/quote. */
export function discussTask(composer: DiscussionComposer, context: string): DiscussionComposer {
  return { ...composer, taskContext: context };
}
export function readWorkspaceReading(value: unknown): WorkspaceReading | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as WorkspaceReading;
  if (!Array.isArray(state.tabs) || state.tabs.length > 100 || typeof state.selected !== 'string' || !state.scroll || typeof state.scroll !== 'object') return null;
  const keys = new Set<string>();
  for (const tab of state.tabs) {
    if (!tab || typeof tab.key !== 'string' || keys.has(tab.key) || typeof tab.title !== 'string') return null;
    if (tab.kind === 'input') { if (tab.key !== 'input' || tab.documentType !== null && typeof tab.documentType !== 'string') return null; }
    else if (tab.kind === 'making') { if (typeof tab.runId !== 'string' || !tab.runId) return null; }
    else if (tab.kind === 'artifact') { if (typeof tab.artifactId !== 'string' || !tab.artifactId || !Number.isInteger(tab.version) || tab.version < 1) return null; }
    else return null;
    keys.add(tab.key);
  }
  if (!keys.has('input') || !keys.has(state.selected) || Object.values(state.scroll).some(position => !Number.isFinite(position) || position < 0)) return null;
  return structuredClone(state);
}
