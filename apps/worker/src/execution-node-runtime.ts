import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Pool } from 'pg';
import { Value } from '@sinclair/typebox/value';
import {
  ExecutionRuntimeEnrollmentSchema,
  type ExecutionRuntimeEnrollment,
  type ExecutionNode,
} from '@bondbuddy/contracts';
import { registerExecutionRuntime } from '@bondbuddy/api/execution-capacity';
import { assertManagedDatabasePrivileges } from './managed-database-preflight.js';

async function stat(pid: number) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8'),
      parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { parent: Number(parts[1]), start: parts[19]!, state: parts[0]! };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
export function assertManagedRuntimeOptions(options: {
  kinds?: readonly string[];
  parseSlots?: number;
  uploadConfirmationEnabled?: boolean;
  uploadConfirmationSmallSlot?: boolean;
  runKinds?: readonly string[];
  reviewAssistant?: unknown;
  platformProbe?: unknown;
}) {
  if (
    options.kinds?.length !== 1 ||
    options.kinds[0] !== 'run' ||
    options.parseSlots !== 0 ||
    options.uploadConfirmationEnabled ||
    options.uploadConfirmationSmallSlot
  )
    throw Error('MANAGED_NODE_UNGUARDED_ENTRYPOINT');
}
/** Secret file is per-node role material, not part of source/image/UserData. */
export async function enrollExecutionNodeFromEnv(
  pool: Pool,
  options: Parameters<typeof assertManagedRuntimeOptions>[0],
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = env.BB_EXECUTION_ENROLLMENT_FILE;
  if (!path) return;
  assertManagedRuntimeOptions(options);
  if (!isAbsolute(path)) throw Error('EXECUTION_ENROLLMENT_FILE_INVALID');
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.uid !== process.getuid?.() ||
    before.size > 16384
  )
    throw Error('EXECUTION_ENROLLMENT_FILE_INVALID');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeMs !== after.mtimeMs ||
    before.size !== after.size
  )
    throw Error('EXECUTION_ENROLLMENT_FILE_CHANGED');
  let material: ExecutionRuntimeEnrollment;
  try {
    material = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('EXECUTION_ENROLLMENT_INVALID');
  }
  if (!Value.Check(ExecutionRuntimeEnrollmentSchema, material))
    throw Error('EXECUTION_ENROLLMENT_INVALID');
  const own = await stat(process.pid),
    init = await stat(1);
  if (!own || !init) throw Error('EXECUTION_BOOT_IDENTITY_UNAVAILABLE');
  const capabilities: ExecutionNode['capabilities'] = [];
  if (options.runKinds?.includes('review')) capabilities.push('review');
  if (options.runKinds?.some((k) => ['generation', 'update', 'qa'].includes(k)))
    capabilities.push('authoring');
  if (options.reviewAssistant) capabilities.push('assistant');
  if (options.platformProbe) capabilities.push('probe');
  await assertManagedDatabasePrivileges(pool);
  await registerExecutionRuntime(pool, material.context, {
    capabilities,
    service_id: material.service_id,
    source_sha256: material.source_sha256,
    image_sha256: material.image_sha256,
    launch_manifest_sha256: material.launch_manifest_sha256,
    registration_token: material.registration_token,
    process_identity: {
      pid: String(process.pid),
      process_start: own.start,
      host_boot_id: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      pid_namespace: await readlink('/proc/self/ns/pid'),
      namespace_init_start: init.start,
    },
  });
  return { context: material.context, service_id: material.service_id };
}
/** Heartbeats and final drain use the same live-process proof as retry release.
 * Retain this export for existing runtime consumers; exited children are not work. */
export async function nativeExecutionChildren() {
  return nativeExecutionProcesses();
}

/** The standalone consumer owns its PID namespace. Count orphaned children too:
 * a browser reparented to tini must not disappear from a retry's release proof.
 * Ancestors and zombies cannot execute this task; unrelated live processes make
 * this conservative check wait. Missing/unreadable inventory fails closed. */
export async function nativeExecutionProcesses() {
  const records = new Map<number, NonNullable<Awaited<ReturnType<typeof stat>>>>();
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const row = await stat(Number(name));
    if (row) records.set(Number(name), row);
  }
  const ancestors = new Set<number>();
  let pid = process.pid;
  while (pid > 0) {
    const row = records.get(pid);
    if (!row || ancestors.has(pid)) throw Error('EXECUTION_PROCESS_INVENTORY_INCOMPLETE');
    ancestors.add(pid);
    pid = row.parent;
  }
  return [...records].filter(([id, row]) => !ancestors.has(id) && !['Z', 'X'].includes(row.state))
    .length;
}
