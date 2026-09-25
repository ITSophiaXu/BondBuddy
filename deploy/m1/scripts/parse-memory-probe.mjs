#!/usr/bin/env node
// #17 large-material parse probe on the production worker profile (synthetic data only, no model calls).
// Uploads one synthetic material through the real API routes (which enqueue the durable parse job), then
// runs one-shot `material-parse-job.js` passes inside the worker image under the prod limits
// (320M, 0.75 CPU, NODE_OPTIONS=--max-old-space-size=160) until the job is terminal. Each pass
// reports wall time, exit code, OOM kill and the container cgroup memory.peak.
//
// Usage: node parse-memory-probe.mjs <file> <media-type> [role=other]
// Env: optional BB_PROBE_STAGING_VOLUME; BB_PROBE_DATABASE_URL, BB_PROBE_BLOB (host-side, same stores the container sees),
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
const send = async (method, url, payload, contentType) => {
  const r = await app.inject({ method, url, headers: { origin, ...(contentType ? { 'content-type': contentType } : {}) }, payload });
  if (r.statusCode >= 300) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.statusCode === 204 ? null : r.json();
};
try {
  // Claims are global: retire parse jobs left by an earlier probe so this pass measures only this material.
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE job_type='parse' AND state NOT IN ('succeeded','failed','cancelled')");
  const project = await send('POST', '/api/v1/projects', { name: 'Synthetic parse probe', kind: 'update', issuer_name: null, market: null, offering: null });
  const start = await send('POST', `/api/v1/projects/${project.project_id}/materials/uploads`, { filename: basename(file), media_type: mediaType, byte_size: bytes.length, sha256: sha, role });
  await send('PUT', start.upload_url, bytes, 'application/octet-stream');
  const done = await send('POST', `/api/v1/projects/${project.project_id}/materials/uploads/${start.upload_id}/complete`, { byte_size: bytes.length, sha256: sha });
  const job = async () => (await pool.query("SELECT state,stage,attempts,max_attempts,error_code FROM bb_jobs WHERE job_type='parse' AND material_id=$1", [done.material_id])).rows[0];
    // BB_PROBE_STAGING_VOLUME=<docker volume>: stage materials on a disk-backed volume instead of the /tmp tmpfs.
  const staging = process.env.BB_PROBE_STAGING_VOLUME ? ['-v', `${process.env.BB_PROBE_STAGING_VOLUME}:/var/lib/bondbuddy/parse-staging`, '-e', 'BB_PARSE_STAGING_DIR=/var/lib/bondbuddy/parse-staging'] : [];
  const passes = [];
  for (let pass = 1; pass <= 12; pass++) {
    const before = await job();
    if (['succeeded', 'failed', 'cancelled'].includes(before.state)) break;
    const name = `bb-parse-probe-${process.pid}-${pass}`;
    const started = Date.now();
    const run = spawnSync('docker', ['run', '--name', name, '--network', need('BB_PROBE_NETWORK'), '--memory', '320m', '--memory-swap', '320m', '--cpus', '0.75',
      '--read-only', '--tmpfs', '/tmp', ...staging, '-e', 'NODE_OPTIONS=--max-old-space-size=160', '-e', 'BB_PARSE_JOB_BATCH=1',
      '-e', `DATABASE_URL=${need('BB_PROBE_WORKER_DATABASE_URL')}`, '-e', `AZURE_STORAGE_CONNECTION_STRING=${need('BB_PROBE_WORKER_BLOB')}`,
      '--entrypoint', 'sh', need('BB_PROBE_WORKER_IMAGE'), '-c', 'node apps/worker/dist/material-parse-job.js; echo "exit=$?" >&2; echo "peak=$(cat /sys/fs/cgroup/memory.peak)" >&2'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const wallMs = Date.now() - started;
    const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.OOMKilled}} {{.State.ExitCode}}', name], { encoding: 'utf8' }).stdout.trim();
    spawnSync('docker', ['rm', '-f', name]);
    const exit = /exit=(\d+)/.exec(run.stderr)?.[1];
    const peak = Number(/peak=(\d+)/.exec(run.stderr)?.[1] ?? NaN);
    const after = await job();
    const row = { pass, wall_ms: wallMs, node_exit: exit === undefined ? null : Number(exit), container: inspect, peak_mib: Number.isFinite(peak) ? +(peak / 1048576).toFixed(1) : null,
      outcome: /"outcome":"([a-z_]+)"/.exec(run.stdout)?.[1] ?? null, job: after };
    // Node's own fatal line (e.g. heap OOM) without any environment or path content.
    row.node_fatal = /FATAL ERROR: [^\n]{0,120}|JavaScript heap out of memory|Killed/.exec(run.stderr)?.[0] ?? null;
    passes.push(row);
    console.log(JSON.stringify(row));
    // A crashed pass leaves its lease; wait for PostgreSQL lease expiry instead of spinning idle passes.
    if (row.outcome === null || row.outcome === 'idle') await new Promise(r => setTimeout(r, 32_000));
  }
  const final = await job();
  console.log(JSON.stringify({ summary: { file: basename(file), media_type: mediaType, mib: +(bytes.length / 1048576).toFixed(1), passes: passes.length,
    total_wall_ms: passes.reduce((s, p) => s + p.wall_ms, 0), max_peak_mib: Math.max(...passes.map(p => p.peak_mib ?? 0)), final } }));
} finally { await app.close(); await pool.end(); }
