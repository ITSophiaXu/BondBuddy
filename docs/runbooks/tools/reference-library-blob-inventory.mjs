// Read-only exact-key inventory for one source's original bytes in a dedicated test store.
import { createHash } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { assertProbeDatabase, validateProbeConfiguration } from './reference-library-probe-safety.mjs';

const { database } = validateProbeConfiguration(process.env, 'inventory');
const sourceId = process.argv[2];
if (!['sse_bond_project_platform', 'synthetic_uncommitted_blob_fault'].includes(sourceId)) throw new Error('PROBE_SOURCE_REJECTED');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await assertProbeDatabase(pool, database);
  const rows = await pool.query(`SELECT v.blob_key FROM bb_library_document_versions v
    JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1`, [sourceId]);
  const referenced = new Set(rows.rows.map(row => row.blob_key));
  const container = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private');
  const entries = [];
  let truncated = false;
  for await (const blob of container.listBlobsFlat({ prefix: `library/${sourceId}/` })) {
    if (entries.length >= 1000) { truncated = true; break; }
    entries.push({ key_sha256: createHash('sha256').update(blob.name).digest('hex'),
      byte_size: blob.properties.contentLength ?? null, referenced_by_version: referenced.has(blob.name) });
  }
  process.stdout.write(`${JSON.stringify({ source_id: sourceId, scanned: entries.length, truncated,
    referenced: entries.filter(e => e.referenced_by_version).length,
    unreferenced: entries.filter(e => !e.referenced_by_version).length, entries })}\n`);
} finally { await pool.end(); }
