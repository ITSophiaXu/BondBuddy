import { lstat, open, opendir, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderCallIntent } from '@bondbuddy/api/provider-results';

const activeAttempts = new Set<string>();
const MAX_ENTRIES = 1024;

/** One Node worker process must own this root. Never share it between roles or
 * processes: an unknown attempt is deliberately treated as retained work. */
export function fileAuthoringWorkRoot(configRoot?: string): string {
  return process.env.BB_FILE_AUTHORING_WORK_ROOT ?? join(process.env.BB_PARSE_STAGING_DIR ?? configRoot
    ?? process.env.BB_CODEX_WORK_ROOT ?? join(tmpdir(), 'bb-codex'), 'file-authoring');
}

export function markFileWorkspaceActive(attemptDir: string): () => void {
  const path = resolve(attemptDir);
  activeAttempts.add(path);
  return () => { activeAttempts.delete(path); };
}

/** The inventory reads the directories themselves, not just success markers.
 * Thus SIGKILL, a failed marker write and a process restart all stay visible. */
export function createFileWorkspaceRetention(workRoot = fileAuthoringWorkRoot()): { pendingCount(): Promise<number> } {
  const root = resolve(workRoot);
  return { pendingCount: async () => {
    let stat;
    try { stat = await lstat(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) throw Error('AUTHORING_RETENTION_INVENTORY_UNSAFE');
    let entries = 0, pending = 0;
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (++entries > MAX_ENTRIES) throw Error('AUTHORING_RETENTION_INVENTORY_LIMIT');
      const path = join(root, entry.name);
      let candidate;
      try { candidate = await lstat(path); }
      catch (error) {
        // A live attempt may finish cleanup while the bounded inventory runs.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!/^attempt-[A-Za-z0-9_-]+$/.test(entry.name) || !candidate.isDirectory() || candidate.isSymbolicLink()
        || await realpath(path) !== path) throw Error('AUTHORING_RETENTION_INVENTORY_UNSAFE');
      if (!activeAttempts.has(path)) pending++;
    }
    return pending;
  } };
}

/** This marker is private diagnostic metadata, never a recovery authorization.
 * Failure to write it must not authorize deletion of the surviving directory. */
export async function recordFileWorkspaceRetention(attemptDir: string, intent: ProviderCallIntent, reason: string, captureFailure: string): Promise<void> {
  const path = resolve(attemptDir);
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw Error('AUTHORING_RETENTION_INVENTORY_UNSAFE');
  const file = join(path, 'retention.json.tmp');
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 'file-workspace-retention-v1', state: 'operator_action_required',
      run_id: intent.run_id, call_id: intent.call_id, logical_call_id: intent.logical_call_id,
      reason, capture_failure: captureFailure, retained_at: new Date().toISOString() }));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(file, join(path, 'retention.json'));
  // POSIX requires syncing the directory to make the rename durable. Windows
  // cannot open directories this way; the candidate remains visible regardless.
  if (process.platform !== 'win32') {
    const directory = await open(path, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
