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
        const app = createServer({ pool, allowedOrigin: origin, enableSyntheticQueue: true,
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
            const locked = await send(`/api/v1/projects/${project}/input-revisions`,
              { draft_revision: 1, material_versions: [], requirement_message_ids: [] });
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
