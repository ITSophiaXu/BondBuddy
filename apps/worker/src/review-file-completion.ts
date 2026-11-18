// Read-only, bounded Stop feedback. It neither generates a report nor decides
// delivery quality; the normal collector remains authoritative.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasReviewReportBody } from '@bondbuddy/contracts';
import { readDocxBodyText } from '@bondbuddy/api/docx-inspector';
import { trustedFileHookArgs } from './file-authoring-completion.js';

export const REVIEW_COMPLETION_COMMAND = '/usr/local/bin/node /app/apps/worker/dist/review-file-completion.js';
export function reviewFileCompletionArgs(): string[] {
  // Review has a different input contract: no authoring SessionStart/checkpoint.
  return trustedFileHookArgs([{ event: 'Stop', command: REVIEW_COMPLETION_COMMAND, timeout: 10 }]);
}

async function safeRead(root: string, name: string, max: number): Promise<Buffer | null> {
  const path = resolve(root, name);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max || await realpath(path) !== path) return null;
    return await readFile(path);
  } catch { return null; }
}

export async function reviewCompletionFeedback(root: string, continued: boolean): Promise<Record<string, unknown>> {
  if (continued) return {}; // One correction in this CLI, never an infinite loop.
  const bytes = await safeRead(root, 'input.json', 32 * 1024 * 1024);
  if (!bytes) return {};
  let input: { version?: string; scope?: {operation?:string;selected_targets?:{source_finding_id:string}[]} };
  try { input = JSON.parse(bytes.toString('utf8')); } catch { return {}; }
  if (input?.version !== 'review-file-input-v1') return {};
  const scopeFeedback=(body:string):Record<string,unknown>=>{
    if(input.scope?.operation!=='differential_review'||!Array.isArray(input.scope.selected_targets))return {};
    const expected=input.scope.selected_targets.map(i=>i.source_finding_id);
    const reported=[...body.matchAll(/^\s*(?:[-*+]\s+)?(?:\*\*)?原问题编号(?:\*\*)?\s*[：:](?:\*\*)?\s*([^\r\n]+)$/gm)].map(m=>m[1]!.trim());
    if(expected.length&&reported.length===expected.length&&new Set(reported).size===expected.length&&reported.every(id=>expected.includes(id)))return {};
    return {decision:'block',reason:'BB_REVIEW_DIFFERENTIAL_SCOPE_INVALID：这是差异复核，只能处理 input.json 中 scope.selected_targets 的原问题。请用已有核对记录修正报告：每个选定问题恰好一个条目，写明原问题编号，并逐字沿用该目标的原文披露与位置。删除范围外条目，补齐缺项，不复制其他问题的编号，不为了结束而虚构已解决。保存修正后的报告再结束。'};
  };
  const text = await safeRead(root, 'output/report.md', 4 * 1024 * 1024);
  if (text && hasReviewReportBody(text.toString('utf8'))) return scopeFeedback(text.toString('utf8'));
  const word = await safeRead(root, 'output/report.docx', 100 * 1024 * 1024);
  const body = word ? readDocxBodyText(word) : null;
  if (body && hasReviewReportBody(body)) return scopeFeedback(body);
  return { decision: 'block', reason: 'BB_REVIEW_OUTPUT_INCOMPLETE：尚未实际保存可读取的复核报告。请在当前工作目录继续已有复核，利用已核对的材料和 scratch/记录，将实际发现、核验结论、覆盖范围与未覆盖事项写入 output/report.md（或有效的 output/report.docx）。遵守 review.md 的问题格式和逐字原文要求；即使没有发现问题也须报告实际覆盖和限制。不要用进度通知、已保存声明或重复叙述代替报告，不要为了结束而虚构结论。保存文件后才结束；仍无法完成时如实说明。' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 1024 * 1024) process.exit(1); }
  try { console.log(JSON.stringify(await reviewCompletionFeedback(process.cwd(), JSON.parse(text).stop_hook_active === true))); }
  catch { console.log('{}'); } // Failures still reach the authoritative collector.
}
