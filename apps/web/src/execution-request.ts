import type { Dto } from './api.js';

export type ExecutionTaskKind = 'update' | 'generation';

/**
 * Stable across tabs/reloads; a new input revision is required for an intentional new run.
 * The task kind matches the project's creation-time kind, so a no-history project submits the
 * controlled generation path instead of the update-only working-draft admission.
 */
export async function executionRequest(input: { project_id: string; input_revision: number; input_hash: string },
  taskKind: ExecutionTaskKind): Promise<Dto<'ExecuteRequest'>> {
  const bytes = new TextEncoder().encode(JSON.stringify([input.project_id, input.input_revision, input.input_hash]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { execution_request_id: `web-${taskKind}-${key}`, project_id: input.project_id, input_revision: input.input_revision,
    input_hash: input.input_hash, task_kind: taskKind, storage_origin: 'cloud',
    input_manifest_ref: input.input_hash, workspace_id: input.project_id };
}

/** Maps an already-persisted project to the only two execution task kinds the browser submits. */
export function executionTaskKind(kind: string): ExecutionTaskKind {
  return kind === 'generation' ? 'generation' : 'update';
}
