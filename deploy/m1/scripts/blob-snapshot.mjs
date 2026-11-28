// Usage (inside the api image): node deploy/m1/scripts/blob-snapshot.mjs export|import <dir>
// Export the configured application containers; never export the off-host backup container.
import { backupContainers } from './backup-stream.mjs';
import { snapshotStore } from './snapshot-store.mjs';
import { exportApplicationSnapshot, importApplicationSnapshot } from './snapshot-workflow.mjs';

const [mode, root] = process.argv.slice(2);
if (!['export', 'import'].includes(mode) || !root) throw new Error('usage: blob-snapshot.mjs export|import <dir>');
const storeFor = snapshotStore();
const result = mode === 'export'
  ? await exportApplicationSnapshot(root, backupContainers(), storeFor)
  : await importApplicationSnapshot(root, process.env.BB_BACKUP_CONTAINER || 'bb-backups', storeFor);
console.log(JSON.stringify(result));
