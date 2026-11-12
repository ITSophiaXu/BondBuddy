import { lockSyntheticAuthoringInput, quoteSyntheticAuthoringRun, syntheticAuthoringBlobs, uploadSyntheticReference } from './test-authoring-source.js';
import type { PrivateBlobs } from './data.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'authoring-task-kind');
test('authoring snapshots cannot bypass project mutex by claiming to be QA when billing is disabled or enabled',
  { skip: !connection }, async () => {
    const pool = new Pool({ connectionString: connection! });
    const owner = `synthetic-kind-${randomUUID()}`;
    const origin = 'http://bondbuddy.test';
    try {
      for (const paid of [false, true]) {
        const files=new Map<string,Buffer>();
        const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>files.get(k)!,
          getIfExists:async k=>files.get(k)??null,getIfExistsBounded:async k=>files.get(k)??null,exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
        // This original contract deliberately exercises both historical billing modes.
        const app = createServer({ pool, blobs, historicalBillingFixture: true, allowedOrigin: origin, enableSyntheticQueue: true,
          enablePaidAuthoring: paid, principal: async () => ({ userId: owner, csrfVerified: true }) });
        const send = (url: string, payload: unknown) => app.inject({ method: 'POST', url,
          headers: { origin }, payload: payload as any });
        try {
          for (const kind of ['update', 'generation'] as const) {
            const created = await send('/api/v1/projects', { name: 'Synthetic authoring kind guard',
              kind, issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private',
              update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2026-09-30' } });
            assert.equal(created.statusCode, 201, created.body);
            const project = created.json().project_id;
            const materials=await uploadSyntheticReference(app,project);
            const locked = await send(`/api/v1/projects/${project}/input-revisions`, materials);
            assert.equal(locked.statusCode, 201, locked.body);
            const input = locked.json();
            const request = { execution_request_id: randomUUID(), project_id: project,
              input_revision: input.input_revision, input_hash: input.input_hash, task_kind: 'qa',
              input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic' };
            const rejected = await send('/api/v1/runs/execute', request);
            assert.equal(rejected.statusCode, 409, rejected.body);
            assert.equal(rejected.json().code, 'INPUT_REVISION_CONFLICT');
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [project])).rows[0].n, 0);
            if (!paid) {
              const valid = await send('/api/v1/runs/execute', { ...request,
                execution_request_id: randomUUID(), task_kind: kind });
              assert.equal(valid.statusCode, 202, valid.body);
            }
          }
        } finally { await app.close(); }
      }
    } finally { await pool.end(); }
  });

test('current authoring requires a quote and rejects a spoofed task kind with either paid flag',
  { skip: !connection }, async () => {
    const pool = new Pool({ connectionString: connection! });
    const origin = 'http://bondbuddy.test';
    try {
      for (const paid of [false, true]) {
        const owner = `synthetic-current-kind-${randomUUID()}`;
        const app = createServer({ pool, blobs: syntheticAuthoringBlobs(), allowedOrigin: origin,
          enableSyntheticQueue: true, enablePaidAuthoring: paid, paymentProviders: [],
          principal: async () => ({ userId: owner, csrfVerified: true }) });
        const send = (url: string, payload: unknown) => app.inject({ method: 'POST', url,
          headers: { origin }, payload: payload as any });
        try {
          for (const kind of ['update', 'generation'] as const) {
            const created = await send('/api/v1/projects', { name: 'Synthetic current task kind guard',
              kind, issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private' });
            assert.equal(created.statusCode, 201, created.body);
            const project = created.json().project_id;
            const input = (await lockSyntheticAuthoringInput(app, project)).json();
            const request = { execution_request_id: randomUUID(), project_id: project,
              input_revision: input.input_revision, input_hash: input.input_hash, task_kind: kind,
              input_manifest_ref: 'synthetic', storage_origin: 'cloud', workspace_id: 'synthetic' };
            const unquoted = await send('/api/v1/runs/execute', request);
            assert.equal(unquoted.statusCode, 409, unquoted.body);
            assert.equal(unquoted.json().code, 'QUOTE_REQUIRED');
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [project])).rows[0].n, 0);
            const quote_id = await quoteSyntheticAuthoringRun(app, pool, owner, project, input);
            const spoofed = await send('/api/v1/runs/execute', { ...request,
              execution_request_id: randomUUID(), task_kind: 'qa', quote_id });
            assert.equal(spoofed.statusCode, 409, spoofed.body);
            assert.equal(spoofed.json().code, 'INPUT_REVISION_CONFLICT');
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [project])).rows[0].n, 0);
            const accepted = await send('/api/v1/runs/execute', { ...request,
              execution_request_id: randomUUID(), quote_id });
            assert.equal(accepted.statusCode, 202, accepted.body);
            assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [project])).rows[0].n, 1);
          }
        } finally { await app.close(); }
      }
    } finally { await pool.end(); }
  });
