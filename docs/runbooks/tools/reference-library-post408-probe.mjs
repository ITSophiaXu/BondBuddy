// Run inside the current Node image on an internal Docker network. This script records
// only request status, byte counts and hashes; source responses and document text stay local.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { azureBlobs } from '/app/apps/api/dist/data.js';
import { enqueueLibrarySync, registerLibrarySource } from '/app/apps/api/dist/library.js';
import { runLibraryOnce } from '/app/apps/worker/dist/library-pipeline.js';
import { SSE_BOND_SOURCE, SseBondProjectAdapter } from '/app/apps/worker/dist/library-sources.js';
import { assertProbeDatabase, validateProbeConfiguration } from './reference-library-probe-safety.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const memoryPeak = () => Number(readFileSync('/sys/fs/cgroup/memory.peak', 'utf8').trim());
const mode = process.argv[2];
const { database } = validateProbeConfiguration(process.env, mode);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const realBlobs = azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING, 'bondbuddy-private');
const syntheticSource = {
  id: 'synthetic_uncommitted_blob_fault', kind: 'public_disclosure', market: 'sse',
  displayName: 'Synthetic fault fixture', authorizationBasis: 'synthetic local test',
  usageRights: 'evaluation_only',
};
const syntheticItem = {
  itemKey: 'fixture:1', externalKey: 'fixture', issuerKey: 'synthetic', issuerName: 'Synthetic issuer',
  title: 'Synthetic prospectus', sourceRevision: '1', sourceRevisionRank: 1,
  mediaType: 'application/pdf', sourceUrl: null, disclosedAt: null, market: 'sse', locator: 'synthetic',
};
const syntheticBytes = Buffer.from('%PDF-1.7 synthetic fault fixture\n');
const documentKey = sha(`${syntheticSource.id}\u0000${syntheticItem.externalKey}`).slice(0, 32);
const blobKey = `library/${syntheticSource.id}/${documentKey}/${sha(syntheticBytes)}`;
const fake = {
  sourceId: syntheticSource.id, mode: 'scheduled',
  async discover() { return { items: [syntheticItem], cursorAfter: { fixture: 1 } }; },
  async fetch() { return syntheticBytes; },
};
const parser = async request => ({
  schema_version: 'document-parse-response-v1', request_id: request.request_id,
  parser_version: 'synthetic-parser', status: 'parsed',
  material: request.material, records: [{ record_id: 'synthetic', material_id: request.material.material_id,
    material_version: request.material.material_version, content_hash: request.material.sha256,
    locator_type: 'text_line', locator: { line: 1 }, literal_quote: 'synthetic', context: 'synthetic',
    extraction_method: 'native_text', extractor_version: 'synthetic', confidence: 1,
    uncertainty: [], formatting: {} }], warnings: [], document: { page_count: 1 }, error: null,
});

try {
  await assertProbeDatabase(pool, database, mode);
  if (mode === 'live') {
    await registerLibrarySource(pool, SSE_BOND_SOURCE);
    const requests = [];
    let lastRequestStartAt = 0;
    const adapter = new SseBondProjectAdapter({ maxProjects: 1, maxPages: 1, pageSize: 10, delayMs: 800,
      fetch: async (url, init) => {
        const host = new URL(url).hostname;
        const requestStartAt = Date.now();
        const startGapMs = lastRequestStartAt ? requestStartAt - lastRequestStartAt : null;
        lastRequestStartAt = requestStartAt;
        const start = performance.now();
        const response = await fetch(url, init);
        requests.push({ host, status: response.status, header_ms: Math.round(performance.now() - start), start_gap_ms: startGapMs });
        return response;
      },
    });
    let itemCount = 0;
    let file = null;
    const limited = {
      sourceId: adapter.sourceId, mode: adapter.mode,
      async discover(cursor, checkpoint) {
        const found = await adapter.discover(cursor, checkpoint);
        itemCount = found.items.length;
        return { ...found, items: found.items.slice(0, 1) };
      },
      async fetch(item) {
        const start = performance.now();
        const bytes = await adapter.fetch(item);
        file = { bytes: bytes.length, sha256: sha(bytes), elapsed_ms: Math.round(performance.now() - start) };
        return bytes;
      },
    };
    await enqueueLibrarySync(pool, SSE_BOND_SOURCE.id);
    const outcome = await runLibraryOnce({ pool, blobs: realBlobs, adapters: { [limited.sourceId]: limited },
      fetchAttempts: 1, retryDelayMs: 0 });
    const state = await pool.query(`SELECT v.state, count(*)::int AS count FROM bb_library_document_versions v
      JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1 GROUP BY v.state`, [SSE_BOND_SOURCE.id]);
    const source = await pool.query('SELECT usage_rights FROM bb_library_sources WHERE id=$1', [SSE_BOND_SOURCE.id]);
    const published = await pool.query(`SELECT count(*)::int AS count FROM bb_library_index_entries e
      JOIN bb_library_document_versions v ON v.id=e.document_version_id
      JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1`, [SSE_BOND_SOURCE.id]);
    process.stdout.write(`${JSON.stringify({ mode, node: process.version, release: process.env.BB_RELEASE_SHA,
      candidate_files: itemCount, requests, file, outcome, source_rights: source.rows[0]?.usage_rights,
      versions: state.rows, active_index_entries: published.rows[0].count,
      cgroup_peak_bytes: memoryPeak(), cgroup_limit_bytes: Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()) })}\n`);
  } else if (mode === 'fault') {
    const prior = await pool.query('SELECT count(*)::int AS count FROM bb_library_sources WHERE id=$1', [syntheticSource.id]);
    if (prior.rows[0].count !== 0) throw new Error('PROBE_FAULT_SOURCE_NOT_EMPTY');
    await registerLibrarySource(pool, syntheticSource);
    await enqueueLibrarySync(pool, syntheticSource.id);
    const killingBlobs = { ...realBlobs, put: async (...args) => {
      await realBlobs.put(...args);
      if (args[0].startsWith(`library/${syntheticSource.id}/`)) {
        process.stderr.write('fault_injected_after_blob_put\n');
        process.kill(process.pid, 'SIGKILL');
      }
    } };
    await runLibraryOnce({ pool, blobs: killingBlobs, adapters: { [syntheticSource.id]: fake }, parser, fetchAttempts: 1 });
    throw new Error('fault was not injected');
  } else if (mode === 'recover') {
    const before = await pool.query(`SELECT count(*)::int AS count FROM bb_library_document_versions v
      JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1`, [syntheticSource.id]);
    const blobAfterCrash = await realBlobs.exists(blobKey);
    if (before.rows[0].count !== 0 || !blobAfterCrash) throw new Error('PROBE_FAULT_STATE_INVALID');
    const lease = await pool.query(`UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE job_type='library'
      AND id IN (SELECT job_id FROM bb_library_sync_runs WHERE source_id=$1) AND state='running' RETURNING id`, [syntheticSource.id]);
    if (lease.rowCount !== 1) throw new Error('PROBE_FAULT_LEASE_INVALID');
    const outcome = await runLibraryOnce({ pool, blobs: realBlobs, adapters: { [syntheticSource.id]: fake }, parser, fetchAttempts: 1 });
    const after = await pool.query(`SELECT v.state, v.version, v.sha256 FROM bb_library_document_versions v
      JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1`, [syntheticSource.id]);
    const published = await pool.query(`SELECT count(*)::int AS count FROM bb_library_index_entries e
      JOIN bb_library_document_versions v ON v.id=e.document_version_id
      JOIN bb_library_documents d ON d.id=v.document_id WHERE d.source_id=$1`, [syntheticSource.id]);
    const syncItems = await pool.query(`SELECT count(*)::int AS count FROM bb_library_sync_items i
      JOIN bb_library_sync_runs r ON r.id=i.sync_run_id WHERE r.source_id=$1`, [syntheticSource.id]);
    process.stdout.write(`${JSON.stringify({ mode, before_versions: before.rows[0].count, blob_after_crash: blobAfterCrash,
      outcome, after_versions: after.rows.map(r => ({ state: r.state, version: r.version, sha256: r.sha256.trim() })),
      sync_items: syncItems.rows[0].count, active_index_entries: published.rows[0].count,
      blob_after_recovery: await realBlobs.exists(blobKey) })}\n`);
  } else throw new Error('mode must be live, fault or recover');
} finally { await pool.end(); }
