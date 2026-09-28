import { createHash } from 'node:crypto';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** Registry canonical JSON SHA-256, shared by manifests and immutable snapshots. */
export function productionSnapshotHash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
