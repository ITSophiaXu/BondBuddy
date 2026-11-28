// Read-only Azure Blob inventory. Emits counts and byte totals, never object keys.
// Set AZURE_STORAGE_CONNECTION_STRING. Optionally set BB_AZURE_INVENTORY_CONTAINERS
// to a comma-separated explicit subset when account-level container listing is unavailable.
import { pathToFileURL } from 'node:url';
import { BlobServiceClient } from '@azure/storage-blob';

const options = { includeVersions: true, includeSnapshots: true, includeDeleted: true,
  includeDeletedWithVersions: true };

function category(item) {
  if (item.snapshot) return 'snapshots';
  if (item.deleted) return 'softDeleted';
  if (item.hasVersionsOnly) return 'versionsOnlyMarkers';
  if (item.versionId && item.isCurrentVersion === false) return 'historicalVersions';
  return 'current';
}

function add(summary, item) {
  if (typeof item.name !== 'string' || typeof item.deleted !== 'boolean')
    throw new Error('Azure inventory returned an invalid blob item');
  const kind = category(item);
  const length = item.properties?.contentLength;
  if (length !== undefined && length !== null && (!Number.isSafeInteger(length) || length < 0))
    throw new Error('Azure inventory returned an invalid object length');
  if (kind === 'current' && !Number.isSafeInteger(length))
    throw new Error('Azure current object length missing');
  const bytes = length ?? 0;
  const tier = item.properties?.accessTier || 'unknown';
  const target = summary[kind];
  target.objects++;
  target.bytes += bytes;
  if (!Number.isSafeInteger(target.bytes)) throw new Error('Azure inventory byte total overflow');
  if (kind === 'current') {
    const tierTotal = summary.currentByAccessTier[tier] ?? { objects: 0, bytes: 0 };
    tierTotal.objects++;
    tierTotal.bytes += bytes;
    if (!Number.isSafeInteger(tierTotal.bytes)) throw new Error('Azure tier byte total overflow');
    summary.currentByAccessTier[tier] = tierTotal;
    summary.largestCurrentObjectBytes = Math.max(summary.largestCurrentObjectBytes, bytes);
  }
}

export async function inventoryAzureBlobs(service, selectedContainers = null) {
  const names = [];
  if (selectedContainers) {
    if (!Array.isArray(selectedContainers) || !selectedContainers.length ||
        selectedContainers.some(name => typeof name !== 'string' || !/^[a-z0-9-]{3,63}$/.test(name)) ||
        new Set(selectedContainers).size !== selectedContainers.length)
      throw new Error('Invalid explicit Azure inventory containers');
    names.push(...selectedContainers);
  } else {
    for await (const container of service.listContainers()) names.push(container.name);
  }
  const containers = [];
  for (const name of names.sort()) {
    const summary = { container: name,
      current: { objects: 0, bytes: 0 }, historicalVersions: { objects: 0, bytes: 0 },
      snapshots: { objects: 0, bytes: 0 }, softDeleted: { objects: 0, bytes: 0 },
      versionsOnlyMarkers: { objects: 0, bytes: 0 }, currentByAccessTier: {}, largestCurrentObjectBytes: 0 };
    const client = service.getContainerClient(name);
    for await (const item of client.listBlobsFlat(options)) add(summary, item);
    containers.push(summary);
  }
  return { scope: selectedContainers ? 'explicit_containers_only' : 'account_containers',
    containerCount: containers.length, containers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error('Azure connection string required');
  const selected = env.BB_AZURE_INVENTORY_CONTAINERS
    ? env.BB_AZURE_INVENTORY_CONTAINERS.split(',').map(name => name.trim()) : null;
  const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING);
  process.stdout.write(`${JSON.stringify(await inventoryAzureBlobs(service, selected))}\n`);
}
