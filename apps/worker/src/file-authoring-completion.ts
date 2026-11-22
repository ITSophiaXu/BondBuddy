// Fixed read-only authoring hooks for pinned Codex 0.169.0. Stop checks
// required file availability, not content quality or layout. Never writes a
// journal, invents no_changes, executes model text, or starts another CLI.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_START_COMMAND, SESSION_START_TIMEOUT } from './file-authoring-session-start.js';

export const COMPLETION_COMMAND =
  '/usr/local/bin/node /app/apps/worker/dist/file-authoring-completion.js';
export function fileCompletionArgs(): string[] {
  return trustedFileHookArgs([
    { event: 'Stop', command: COMPLETION_COMMAND, timeout: 10 },
    { event: 'SessionStart', command: SESSION_START_COMMAND, timeout: SESSION_START_TIMEOUT },
  ]);
}

/** Fixed application-owned handlers only; never populate this from model input. */
export function trustedFileHookArgs(
  handlers: { event: 'Stop' | 'SessionStart'; command: string; timeout: number }[],
): string[] {
  // Codex normalizes each event handler independently before hashing sorted JSON.
  // Both application-owned handlers must be trusted; never bypass hook trust.
  const trusted = (event: string, command: string, timeout: number) => {
    const identity = {
      event_name: event,
      hooks: [{ async: false, command, timeout, type: 'command' }],
    };
    const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const source =
      (process.platform === 'win32'
        ? 'C:\\<session-flags>\\config.toml:'
        : '/<session-flags>/config.toml:') +
      event +
      ':0:0';
    return JSON.stringify(source) + '={trusted_hash=' + JSON.stringify(hash) + '}';
  };
  const handler = (command: string, timeout: number) =>
    '{hooks=[{type="command",command=' + JSON.stringify(command) + ',timeout=' + timeout + '}]}';
  return [
    '--enable',
    'hooks',
    '-c',
    'hooks={' +
      handlers.map((h) => h.event + '=[' + handler(h.command, h.timeout) + ']').join(',') +
      ',state={' +
      handlers
        .map((h) => trusted(h.event === 'Stop' ? 'stop' : 'session_start', h.command, h.timeout))
        .join(',') +
      '}}',
  ];
}

async function available(root: string, name: string, max: number) {
  const path = resolve(root, name);
  try {
    const s = await lstat(path);
    return (
      s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1 &&
      s.size > 0 &&
      s.size <= max &&
      (await realpath(path)) === path
    );
  } catch {
    return false;
  }
}

export async function completionFeedback(
  root: string,
  continued: boolean,
): Promise<Record<string, unknown>> {
  // One in-process correction only. A persistent failure stays a failure; do not
  // force an infinite completion loop or change the existing authoring deadline.
  if (continued) return {};
  if (!(await available(root, 'input.json', 32 * 1024 * 1024))) return {};
  const input = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
  if (input.version !== 'codex-file-input-v1') return {};
  const controlled = input.format_tools?.version === 'controlled-docx-v1';
  const missing = [];
  for (const name of controlled ? ['operations.json'] : ['tracked.docx', 'clean.docx']) {
    if (!(await available(root, `output/${name}`, (controlled ? 32 : 100) * 1024 * 1024)))
      missing.push(name);
  }
  if (!missing.length) return {};
  return {
    decision: 'block',
    reason: `BB_AUTHORING_OUTPUT_INCOMPLETE：必需交付文件 ${missing.join('、')} 尚未实际保存。本次执行尚未完成，请在当前工作目录继续已有工作，排查工具错误并保存实际成果。${controlled ? '阅读 fixed-edit.md，使用固定编辑工具分批 apply 将有依据的修改写入 output/operations.json；不要以任意 Word 文件替代操作日志，不得用空日志或 no_changes 跳过应完成的更新。' : '实际写出 output/tracked.docx 和 output/clean.docx；不得以旧原稿或空模板冒充更新结果。'}保留 scratch/工作记录.md，准确记录仍无法完成的事项。不能完成时如实说明，不要声称交付成功。`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024) process.exit(1);
  }
  try {
    console.log(
      JSON.stringify(
        await completionFeedback(process.cwd(), JSON.parse(text).stop_hook_active === true),
      ),
    );
  } catch {
    console.log('{}');
  } // Collector remains authoritative even if the hook cannot inspect.
}
