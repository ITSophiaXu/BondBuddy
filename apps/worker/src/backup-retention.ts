import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { OFFHOST_BACKUP_CONTAINER } from '@bondbuddy/contracts';

// #35 off-host backup retention. scripts/backup.sh uploads each backup as `<backup-id>/...` into the
// private bb-backups container, where the id is `<YYYYMMDDTHHMMSSZ>-<label>`. This deletes every backup
// older than the retention window. The newest backup is always kept, so a stalled backup job never
// leaves the host with no off-host copy. Deleting is idempotent: a re-run after a partial failure
// continues where it stopped.

export const backupIdPattern = /^(\d{8}T\d{6}Z)-[A-Za-z0-9._-]{1,64}$/;
export type RetentionResult = {
  backups: number;
  deleted: number;
  deletedBlobs: number;
  kept: number;
  failed: number;
};

/** UTC time encoded in a backup id, or null for names that are not backups (left untouched). */
export function backupTime(id: string): Date | null {
  const m = backupIdPattern.exec(id);
  if (!m) return null;
  const t = m[1];
  const at = new Date(
    `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`,
  );
  return Number.isNaN(at.getTime()) ? null : at;
}

export function backupContainer(
  connectionString: string,
  name = OFFHOST_BACKUP_CONTAINER,
): ContainerClient {
  return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(name);
}

export async function pruneOffhostBackups(
  container: ContainerClient,
  retentionDays: number,
  now = new Date(),
): Promise<RetentionResult> {
  if (!(await container.exists()))
    return { backups: 0, deleted: 0, deletedBlobs: 0, kept: 0, failed: 0 };
  const groups = new Map<string, { at: Date; blobs: string[] }>();
  for await (const blob of container.listBlobsFlat()) {
    const id = blob.name.split('/')[0];
    const at = backupTime(id);
    if (!at || !blob.name.includes('/')) continue;
    const group = groups.get(id) ?? { at, blobs: [] };
    group.blobs.push(blob.name);
    groups.set(id, group);
  }
  const newest = [...groups.entries()].sort(
    (a, b) => b[1].at.getTime() - a[1].at.getTime(),
  )[0]?.[0];
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let deleted = 0,
    deletedBlobs = 0,
    failed = 0;
  for (const [id, group] of groups) {
    if (id === newest || group.at.getTime() >= cutoff) continue;
    let ok = true;
    // The completion manifest goes last, so an interrupted delete never leaves a backup that looks whole.
    const order = [
      ...group.blobs.filter((n) => !n.endsWith('/offhost-manifest.json')),
      ...group.blobs.filter((n) => n.endsWith('/offhost-manifest.json')),
    ];
    for (const name of order) {
      try {
        await container.deleteBlob(name, { deleteSnapshots: 'include' });
        deletedBlobs++;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) {
          ok = false;
          failed++;
          break;
        }
      }
    }
    if (ok) deleted++;
  }
  return { backups: groups.size, deleted, deletedBlobs, kept: groups.size - deleted, failed };
}
