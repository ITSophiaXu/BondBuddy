import { Pool } from 'pg';
import { azureBlobs } from '@bondbuddy/api/data';
import {
  enqueueLibrarySync,
  libraryAlerts,
  libraryOverview,
  registerLibrarySource,
  syncRunSummary,
} from '@bondbuddy/api/library';
import { runLibraryOnce } from './library-pipeline.js';
import {
  OPERATOR_IMPORT_SOURCE,
  SSE_BOND_SOURCE,
  OperatorImportAdapter,
  SseBondProjectAdapter,
} from './library-sources.js';

// Operator/scheduler entry point: `node dist/library-sync-cli.js [source_id]`. One invocation = one sync
// (enqueue if none is live, then drain library jobs). Schedule it (cron/systemd timer) at the source's cadence.
// Prints a redacted JSON summary: counts and codes only, no document bytes or text.
const connection = process.env.DATABASE_URL,
  blobConnection = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!connection || !blobConnection)
  throw new Error('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING required');
const sourceId = process.argv[2] ?? SSE_BOND_SOURCE.id;
const pool = new Pool({ connectionString: connection });
const blobs = azureBlobs(blobConnection, process.env.BB_LIBRARY_CONTAINER ?? 'bondbuddy-private');
try {
  await registerLibrarySource(pool, SSE_BOND_SOURCE);
  await registerLibrarySource(pool, OPERATOR_IMPORT_SOURCE);
  const adapters = {
    [SSE_BOND_SOURCE.id]: new SseBondProjectAdapter({
      maxProjects: Number(process.env.BB_LIBRARY_MAX_PROJECTS ?? 3),
      delayMs: 800,
    }),
    [OPERATOR_IMPORT_SOURCE.id]: new OperatorImportAdapter(blobs),
  };
  if (sourceId !== OPERATOR_IMPORT_SOURCE.id) await enqueueLibrarySync(pool, sourceId);
  const runs = [];
  for (let i = 0; i < 20; i++) {
    const out = await runLibraryOnce({
      pool,
      blobs,
      adapters,
      retryDelayMs: 5000,
      log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
    });
    if (out.outcome === 'idle') break;
    runs.push({
      outcome: out.outcome,
      partial: out.partial ?? false,
      sync: out.syncRunId ? await syncRunSummary(pool, out.syncRunId) : null,
    });
  }
  const overview = await libraryOverview(pool);
  process.stdout.write(
    `${JSON.stringify({ source_id: sourceId, runs, counts: overview.counts, sources: overview.sources, alerts: await libraryAlerts(pool) }, null, 2)}\n`,
  );
} finally {
  await pool.end();
}
