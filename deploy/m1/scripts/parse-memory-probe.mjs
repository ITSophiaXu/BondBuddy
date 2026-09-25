#!/usr/bin/env node
// #17 large-material parse probe on the production worker profile (no model calls).
// Uploads one synthetic or explicitly authorized material through the real API routes (which enqueue the durable parse job), then
// runs one-shot `material-parse-job.js` passes inside the worker image under the prod limits
// (BB_PROBE_WORKER_MEMORY, 0.75 CPU, NODE_OPTIONS=--max-old-space-size=160) until the job is terminal. Each pass
// reports wall time, exit code, OOM kill and cgroup memory, anon and file high-water samples.
//
// Usage: node parse-memory-probe.mjs <file> <media-type> [role=other]
// Env: optional BB_PROBE_STAGING_VOLUME, BB_PROBE_WORKER_MEMORY (default 384m), BB_PROBE_PG_CONTAINER;
//      BB_PROBE_DATABASE_URL, BB_PROBE_BLOB (host-side, same stores the container sees),
//      BB_PROBE_WORKER_IMAGE, BB_PROBE_NETWORK, BB_PROBE_WORKER_DATABASE_URL, BB_PROBE_WORKER_BLOB.
// Output: one JSON line per pass and a final summary line. No connection strings are printed.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs } from '@bondbuddy/api/data';

const [file, mediaType, role = 'other'] = process.argv.slice(2);
const need = (name) => { const v = process.env[name]; if (!v) throw new Error(`${name} is required`); return v; };
if (!file || !mediaType) { console.error('usage: parse-memory-probe.mjs <file> <media-type> [role]'); process.exit(2); }
const bytes = readFileSync(file);
const sha = createHash('sha256').update(bytes).digest('hex');
const pool = new Pool({ connectionString: need('BB_PROBE_DATABASE_URL') });
const blobs = azureBlobs(need('BB_PROBE_BLOB'));
const owner = `probe-${randomUUID()}`;
const origin = 'http://bondbuddy.probe';
const app = createServer({ pool, blobs, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const send = async (method, url, payload, contentType) => {
  const r = await fetch(new URL(url, address), {
    method, headers: { origin, 'content-type': contentType ?? 'application/json' },
    body: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`${method} ${new URL(url, address).pathname} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
};
try {
  // Claims are global: retire parse jobs left by an earlier probe so this pass measures only this material.
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE job_type='parse' AND state NOT IN ('succeeded','failed','cancelled')");
  const project = await send('POST', '/api/v1/projects', { name: 'Synthetic parse probe', kind: 'update', issuer_name: null, market: null, offering: null });
  const start = await send('POST', `/api/v1/projects/${project.project_id}/materials/uploads`, { filename: basename(file), media_type: mediaType, byte_size: bytes.length, sha256: sha, role });
  await send('PUT', start.upload_url, bytes, 'application/octet-stream');
  const done = await send('POST', `/api/v1/projects/${project.project_id}/materials/uploads/${start.upload_id}/complete`, { byte_size: bytes.length, sha256: sha });
  const job = async () => (await pool.query("SELECT state,stage,attempts,max_attempts,error_code FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [done.material_id])).rows[0];
  const evidence = async () => {
    const snapshot=(await pool.query(`SELECT id,record_count,response_status,response_meta->'document'->>'page_count' AS page_count
      FROM bb_parse_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND material_id=$3 AND material_version=1
      ORDER BY created_at DESC LIMIT 1`,[owner,project.project_id,done.material_id])).rows[0];
    if(!snapshot)return null;
    const counts=(await pool.query(`SELECT count(e.record_id)::int AS record_count,
      count(*) FILTER (WHERE e.locator_type='pdf_bbox')::int AS pdf_anchor_count,
      count(*) FILTER (WHERE e.locator_type='text_line')::int AS text_line_anchor_count,
      count(*) FILTER (WHERE e.locator ? 'stable_ref')::int AS stable_anchor_count,
      count(*) FILTER (WHERE jsonb_typeof(e.formatting->'word_boxes')='array')::int AS word_box_record_count,
      coalesce(sum(jsonb_array_length(CASE WHEN jsonb_typeof(e.formatting->'word_boxes')='array' THEN e.formatting->'word_boxes' ELSE '[]'::jsonb END)),0)::int AS word_box_count,
      min(e.ordinal)::int AS first_ordinal,max(e.ordinal)::int AS last_ordinal
      FROM bb_parse_evidence e WHERE e.owner_user_id=$1 AND e.project_id=$2 AND e.material_id=$3 AND e.material_version=1 AND e.snapshot_id=$4`,
    [owner,project.project_id,done.material_id,snapshot.id])).rows[0];
    return { ...counts, snapshot_record_count:snapshot.record_count, status:snapshot.response_status, page_count:snapshot.page_count };
  };
    // BB_PROBE_STAGING_VOLUME=<docker volume>: stage materials on a disk-backed volume instead of the /tmp tmpfs.
  const staging = process.env.BB_PROBE_STAGING_VOLUME ? ['-v', `${process.env.BB_PROBE_STAGING_VOLUME}:/var/lib/bondbuddy/parse-staging`, '-e', 'BB_PARSE_STAGING_DIR=/var/lib/bondbuddy/parse-staging'] : [];
  const passes = [];
  const workerMemory = process.env.BB_PROBE_WORKER_MEMORY ?? '384m';
  if (!/^\d+m$/.test(workerMemory)) throw new Error('BB_PROBE_WORKER_MEMORY must be a Docker MiB limit');
  const pgPeak = () => {
    if (!process.env.BB_PROBE_PG_CONTAINER) return null;
    const result = spawnSync('docker', ['exec', process.env.BB_PROBE_PG_CONTAINER, 'cat', '/sys/fs/cgroup/memory.peak'], { encoding: 'utf8' });
    const value = Number(result.stdout.trim());
    return result.status === 0 && Number.isFinite(value) ? +(value / 1048576).toFixed(1) : null;
  };
  for (let pass = 1; pass <= 12; pass++) {
    const before = await job();
    if (['succeeded', 'failed', 'cancelled', 'paused', 'awaiting_ocr'].includes(before.state)) break;
    const name = `bb-parse-probe-${process.pid}-${pass}`;
    const started = Date.now();
    const run = spawnSync('docker', ['run', '--name', name, '--network', need('BB_PROBE_NETWORK'), '--memory', workerMemory, '--memory-swap', workerMemory, '--cpus', '0.75',
      '--read-only', '--tmpfs', '/tmp', ...staging, '-e', 'NODE_OPTIONS=--max-old-space-size=160', '-e', 'BB_PARSE_JOB_BATCH=1',
      '-e', `DATABASE_URL=${need('BB_PROBE_WORKER_DATABASE_URL')}`, '-e', `AZURE_STORAGE_CONNECTION_STRING=${need('BB_PROBE_WORKER_BLOB')}`,
      '--entrypoint', 'sh', need('BB_PROBE_WORKER_IMAGE'), '-c', `(
        while true; do
          awk '/^(anon|file) / {print $1, $2}' /sys/fs/cgroup/memory.stat
          sleep 0.2
        done
      ) > /tmp/bb-memory-samples & monitor=$!
      node apps/worker/dist/material-parse-job.js; result=$?
      kill "$monitor" 2>/dev/null || true
      echo "exit=$result" >&2
      echo "peak=$(cat /sys/fs/cgroup/memory.peak)" >&2
      awk '{ if ($1 == "anon" && $2 > anon) anon=$2; if ($1 == "file" && $2 > file) file=$2 } END {print "anon_peak=" anon+0; print "file_peak=" file+0}' /tmp/bb-memory-samples >&2`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const wallMs = Date.now() - started;
    const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.OOMKilled}} {{.State.ExitCode}}', name], { encoding: 'utf8' }).stdout.trim();
    spawnSync('docker', ['rm', '-f', name]);
    const exit = /exit=(\d+)/.exec(run.stderr)?.[1];
    const peak = Number(/peak=(\d+)/.exec(run.stderr)?.[1] ?? NaN);
    const after = await job();
    const anon = Number(/anon_peak=(\d+)/.exec(run.stderr)?.[1] ?? NaN);
    const cachedFile = Number(/file_peak=(\d+)/.exec(run.stderr)?.[1] ?? NaN);
    const row = { pass, wall_ms: wallMs, node_exit: exit === undefined ? null : Number(exit), container: inspect, peak_mib: Number.isFinite(peak) ? +(peak / 1048576).toFixed(1) : null,
      anon_peak_sample_mib: Number.isFinite(anon) ? +(anon / 1048576).toFixed(1) : null,
      file_peak_sample_mib: Number.isFinite(cachedFile) ? +(cachedFile / 1048576).toFixed(1) : null, pg_peak_mib: pgPeak(),
      outcome: /"outcome":"([a-z_]+)"/.exec(run.stdout)?.[1] ?? null, job: after };
    // Node's own fatal line (e.g. heap OOM) without any environment or path content.
    row.node_fatal = /FATAL ERROR: [^\n]{0,120}|JavaScript heap out of memory|Killed/.exec(run.stderr)?.[0] ?? null;
    passes.push(row);
    console.log(JSON.stringify(row));
    // A crashed pass leaves its lease; wait for PostgreSQL lease expiry instead of spinning idle passes.
    if (row.outcome === null || row.outcome === 'idle') await new Promise(r => setTimeout(r, 32_000));
  }
  const final = await job();
  const savedEvidence=await evidence();
  console.log(JSON.stringify({ summary: { file: basename(file), media_type: mediaType, mib: +(bytes.length / 1048576).toFixed(1), passes: passes.length,
    total_wall_ms: passes.reduce((s, p) => s + p.wall_ms, 0), max_peak_mib: Math.max(...passes.map(p => p.peak_mib ?? 0)), final, evidence:savedEvidence } }));
} finally { await app.close(); await pool.end(); }
