// Synthetic API test for the audited per-attempt execution log. No provider is called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { installAdminRoutes } from './admin-routes.js';
import { digest, type PrivateBlobs } from './data.js';

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };

function fakePool(row: Row | null, roles: string[]) {
  const calls: Call[] = [];
  const answer = (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return [];
    if (sql.includes('FROM bb_operator_grants')) return roles.map(role => ({ role }));
    if (sql.includes('FROM bb_codex_exec_logs l')) return row ? [row] : [];
    return [];
  };
  const client = { query: async (sql: string, params: unknown[] = []) => ({ rows: answer(sql, params), rowCount: 1 }), release() {} };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => ({ rows: answer(sql, params), rowCount: 1 }),
    connect: async () => client as unknown as PoolClient
  } as unknown as Pool;
  return { pool, calls };
}

function blobsOf(bytes: Buffer | null, key: string) {
  let readMax = -1;
  const blobs = {
    async getIfExistsBounded(_key: string, max: number) { readMax = max; return bytes; }
  } as unknown as PrivateBlobs;
  return { blobs, readMax: () => readMax, key };
}

const attemptId = 'att_syn_exec_1';
const objectKey = `users/user_syn_1/projects/proj_syn_1/runs/run_syn_1/attempts/${attemptId}/exec.log`;
const bytes = Buffer.from('[stdout]\n{"type":"thread.started"}\n[stderr]\nsynthetic warning\n', 'utf8');
const logRow = {
  attempt_id: attemptId, owner_user_id: 'user_syn_1', project_id: 'proj_syn_1', run_id: 'run_syn_1', object_key: objectKey,
  sha256: digest(bytes), byte_size: bytes.length, truncated: false, channel: 'production', created_at: new Date('2026-11-01T00:00:00Z')
};

function appFor(pool: Pool, blobs: PrivateBlobs) {
  const app = Fastify();
  app.setErrorHandler((error: any, _request, reply) => {
    const status = typeof error?.status === 'number' ? error.status : 500;
    reply.code(status).send({ code: typeof error?.code === 'string' ? error.code : 'DATA_UNAVAILABLE', message: 'synthetic' });
  });
  installAdminRoutes(app, { db: () => pool, blobs: () => blobs, owner: async request => String(request.headers['x-operator'] ?? '') });
  return app;
}

test('exec-log route denies non-readers with the owner-safe 404 before any Blob read or audit', async () => {
  const { pool, calls } = fakePool(logRow, []);
  const store = blobsOf(bytes, objectKey);
  const app = appFor(pool, store.blobs);
  try {
    const denied = await app.inject({ method: 'GET', url: `/api/v1/admin/exec-logs/${attemptId}`, headers: { 'x-operator': 'stranger' } });
    assert.equal(denied.statusCode, 404);
    assert.equal(store.readMax(), -1, 'unauthorized access never reaches Blob storage');
    assert.equal(calls.some(call => call.sql.includes('INSERT INTO bb_log_access_audit')), false);
  } finally { await app.close(); }
});

test('exec-log route returns bounded text for log_reader, audits the read and disables caching', async () => {
  const { pool, calls } = fakePool(logRow, ['log_reader']);
  const store = blobsOf(bytes, objectKey);
  const app = appFor(pool, store.blobs);
  try {
    const allowed = await app.inject({ method: 'GET', url: `/api/v1/admin/exec-logs/${attemptId}`, headers: { 'x-operator': 'operator_1' } });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.headers['cache-control'], 'no-store');
    const body = allowed.json();
    assert.equal(body.attempt_id, attemptId);
    assert.equal(body.run_id, 'run_syn_1');
    assert.equal(body.sha256, digest(bytes));
    assert.equal(body.byte_size, bytes.length);
    assert.equal(body.truncated, false);
    assert.equal(body.content_type, 'text/plain; charset=utf-8');
    assert.equal(body.body, bytes.toString('utf8'));
    const audit = calls.find(call => call.sql.includes('INSERT INTO bb_log_access_audit'));
    assert.ok(audit, 'read is audited');
    assert.equal(audit!.params[0]?.toString().startsWith('audit_') || typeof audit!.params[0] === 'string', true);
    assert.equal(audit!.params[3], 'admin_exec_log');
    assert.ok(store.readMax() >= bytes.length);
  } finally { await app.close(); }
});

test('unknown attempts and tampered Blob bytes fail owner-safely after auditing the lookup', async () => {
  const missingPool = fakePool(null, ['log_reader']);
  const missingStore = blobsOf(null, objectKey);
  const missingApp = appFor(missingPool.pool, missingStore.blobs);
  try {
    const response = await missingApp.inject({ method: 'GET', url: `/api/v1/admin/exec-logs/${attemptId}`, headers: { 'x-operator': 'operator_1' } });
    assert.equal(response.statusCode, 404);
    assert.ok(missingPool.calls.some(call => call.sql.includes('INSERT INTO bb_log_access_audit')), 'unknown lookups are still audited');
    assert.equal(missingStore.readMax(), -1);
  } finally { await missingApp.close(); }

  const tamperedPool = fakePool(logRow, ['log_reader']);
  const tampered = blobsOf(Buffer.from('different bytes'), objectKey);
  const tamperedApp = appFor(tamperedPool.pool, tampered.blobs);
  try {
    const response = await tamperedApp.inject({ method: 'GET', url: `/api/v1/admin/exec-logs/${attemptId}`, headers: { 'x-operator': 'operator_1' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'DATA_UNAVAILABLE');
  } finally { await tamperedApp.close(); }
});
