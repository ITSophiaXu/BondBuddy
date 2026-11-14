import type { AssistantPageProject, AssistantPageState } from './assistant-page-context.js';
import { esc } from './ui.js';

export function assistantHandoffHtml(state: AssistantPageState, hash: string, conversation: AssistantPageProject | undefined, disabled: boolean) {
  if (state.hash !== hash || state.status === 'none') return '';
  if (state.status === 'loading') return '<p class="ba-page-context-note" role="status">正在核对页面项目；本对话不会自动切换。</p>';
  if (state.status === 'unavailable') return '<p class="ba-page-context-note" role="status">页面项目暂不可核实；本对话保持不变。<button data-a="read-page-project">重新读取页面项目</button></p>';
  const page = state.project!;
  if (page.project_id === conversation?.project_id || page.project_id === conversation?.source_project_id) return '';
  return `<div class="ba-page-handoff"><p>当前页面：<strong>${esc(page.name)}</strong></p><p>本对话仍关联：<strong>${esc(conversation?.name ?? '未关联项目')}</strong></p><button data-a="current-project" data-page-project="${esc(page.project_id)}" ${disabled ? 'disabled' : ''}>为“${esc(page.name)}”开新对话</button><small>原对话的草稿、附件与成果选择保留，可在“最近对话”找回。</small></div>`;
}

export function assistantSendContextHtml(projectName: string, resultLabel: string) {
  return `<span>发送至：<strong>${esc(projectName)}</strong></span><span>讨论依据：${esc(resultLabel)}</span>`;
}
