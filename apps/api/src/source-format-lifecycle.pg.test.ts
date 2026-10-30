// Synthetic private objects; real PostgreSQL retention, ownership and immutable purge receipts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { digest, type PrivateBlobs } from './data.js';
import { runDeletedContentPurge } from './deletion-lifecycle.js';
import { runStorageInventory } from './storage-inventory.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'source-format-lifecycle');
const DAY = 86400000;

function privateObjects() {
  const stored = new Map<string, Buffer>(), deleted: string[] = [], listed: string[] = [];
  const blobs: PrivateBlobs = {
    put: async (key, bytes) => { stored.set(key, Buffer.from(bytes)); },
    get: async key => { const bytes = stored.get(key); if (!bytes) throw Error('MISSING'); return bytes; },
    getIfExists: async key => stored.get(key) ?? null,
    getIfExistsBounded: async (key, max) => { const bytes = stored.get(key); if (bytes && bytes.length > max) throw Error('TOO_LARGE'); return bytes ?? null; },
    exists: async key => stored.has(key),
    delete: async key => { deleted.push(key); stored.delete(key); },
    deleteIfMatch: async key => { deleted.push(key); return stored.delete(key); },
    listPage: async (prefix, cursor, size) => {
      listed.push(prefix);
      const keys = [...stored.keys()].filter(key => key.startsWith(prefix) && (!cursor || key > cursor)).sort();
      const page = keys.slice(0, size);
      return { items: page.map(key => ({ key, bytes: stored.get(key)!.length, etag: 'synthetic-etag', lastModified: new Date('2020-01-01') })),
        ...(keys.length > page.length ? { continuation: page.at(-1) } : {}) };
    },
  };
  return { blobs, stored, deleted, listed };
}

async function runFixture(pool: Pool, owner: string, deleted = false) {
  const project = randomUUID(), run = randomUUID(), hash = digest(run);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic private format storage','update')", [project, owner]);
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,'{}','[]','[]')`, [project, owner, hash]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,1,$4,$1,'update',$4,'cancelled')`, [run, owner, project, hash]);
  if (deleted) await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [project]);
  return { owner, project, run, prefix: `owners/${owner}/projects/${project}/runs/${run}/` };
}

test('deleted project purges owned format inputs, operations, manifests, outputs and reports with retryable receipts', { skip: !connection, timeout: 30000 }, async () => {
  const pool = new Pool({ connectionString: connection }), owner = randomUUID();
  const store = privateObjects();
  try {
    const doomed = await runFixture(pool, owner, true), live = await runFixture(pool, owner), foreign = await runFixture(pool, randomUUID(), true);
    const original = ['baseline.docx', 'tracked.docx', 'clean.docx', 'delivery.md', 'input.json', 'operations.json', 'template-manifest.json'];
    const keys = original.map(file => `${doomed.prefix}file-authoring/call-1/${digest(file)}/${file}`);
    for (const file of ['baseline.docx', 'tracked.docx', 'clean.docx', 'operations.json'])
      keys.push(`${doomed.prefix}file-authoring/finalized/${digest(`final:${file}`)}/${file}`);
    keys.push(`${doomed.prefix}format-diagnostics/${digest('report')}/format-report.json`);
    // Cross a listing page while deleting, so a marker must not skip remaining objects.
    for (let n = 0; n < 103; n++) keys.push(`${doomed.prefix}file-authoring/call-${n + 2}/${digest(String(n))}/operations.json`);
    const protectedKeys = [
      `${live.prefix}file-authoring/call-1/${digest('live')}/input.json`,
      `${foreign.prefix}format-diagnostics/${digest('foreign')}/format-report.json`,
      `${doomed.prefix}file-authoring/call-1/${digest('unknown')}/unrelated.json`,
      `${doomed.prefix}another-producer/${digest('unrelated')}/input.json`,
    ];
    for (const key of [...keys, ...protectedKeys]) await store.blobs.put(key, Buffer.from('synthetic private bytes'), 'application/json');
    const early = await runDeletedContentPurge(pool, store.blobs, { ownerScope: owner, deletedContentPurgeDays: 7 });
    assert.equal(early.projectsPurged, 0); assert.equal(store.deleted.length, 0);
    const opts = { ownerScope: owner, deletedContentPurgeDays: 7, now: () => new Date(Date.now() + 8 * DAY) };
    const crashed = await runDeletedContentPurge(pool, store.blobs, { ...opts, afterBlobDeletes: async () => { throw Error('SYNTHETIC_RECEIPT_CRASH'); } });
    assert.equal(crashed.failed, 1); assert.equal(crashed.projectsPurged, 0);
    for (const key of keys) assert.equal(store.stored.has(key), false, key);
    for (const key of protectedKeys) assert.equal(store.stored.has(key), true, key);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_deleted_content_purges WHERE project_id=$1 AND subject_kind='project'", [doomed.project])).rows[0].n, 0);
    const recovered = await runDeletedContentPurge(pool, store.blobs, opts);
    assert.equal(recovered.failed, 0); assert.equal(recovered.projectsPurged, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_deleted_content_purges WHERE project_id=$1 AND subject_kind='project'", [doomed.project])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE id=$1', [doomed.run])).rows[0].n, 1, 'audit metadata is retained');
    const repeated = await runDeletedContentPurge(pool, store.blobs, opts);
    assert.deepEqual(repeated, { materialsPurged: 0, projectsPurged: 0, objectsDeleted: 0, failed: 0 });
    assert.ok(store.listed.every(prefix => prefix === `${doomed.prefix}file-authoring/` || prefix === `${doomed.prefix}format-diagnostics/`));
  } finally { await pool.end(); }
});

test('format inventory pins only the matching owned run and never auto-deletes authoring objects', { skip: !connection, timeout: 30000 }, async () => {
  const pool = new Pool({ connectionString: connection }), store = privateObjects();
  try {
    const fixture = await runFixture(pool, randomUUID());
    const input = `${fixture.prefix}file-authoring/call-1/${digest('input')}/input.json`;
    const report = `${fixture.prefix}format-diagnostics/${digest('report')}/format-report.json`;
    const foreign = report.replace(`owners/${fixture.owner}/`, 'owners/synthetic-foreign-owner/');
    const unregistered = `${fixture.prefix.replace(`/runs/${fixture.run}/`, '/runs/synthetic-unregistered-run/')}file-authoring/call-1/${digest('operations')}/operations.json`;
    const unknown = `${fixture.prefix}file-authoring/call-1/${digest('unknown')}/unknown.json`;
    for (const key of [input, report, foreign, unregistered, unknown]) await store.blobs.put(key, Buffer.from('synthetic private bytes'), 'application/json');
    const scanned = await runStorageInventory(pool, store.blobs, { deleteEnabled: true });
    assert.equal(scanned.byKind.file_authoring.referenced.count, 1);
    assert.equal(scanned.byKind.format_report.referenced.count, 1);
    assert.equal(scanned.byKind.file_authoring.orphan_candidate.count, 1);
    assert.equal(scanned.byKind.format_report.orphan_candidate.count, 1);
    assert.equal(scanned.byPrefix['owners/'].unrecognized.count, 1);
    assert.equal(scanned.deleted, 0); assert.equal(store.deleted.length, 0); assert.equal(store.stored.size, 5);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_storage_inventory_cursors WHERE prefix='owners/'")).rows[0].n, 1);
    await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [fixture.project]);
    assert.equal((await runDeletedContentPurge(pool, store.blobs, { deletedContentPurgeDays: 0, ownerScope: fixture.owner })).projectsPurged, 1);
    // An unexpected late write cannot be hidden by a retained run row after purge.
    await store.blobs.put(report, Buffer.from('synthetic late report'), 'application/json');
    const after = await runStorageInventory(pool, store.blobs);
    assert.equal(after.byKind.format_report.referenced.count, 0);
    assert.equal(after.byKind.format_report.orphan_candidate.count, 2);
  } finally { await pool.end(); }
});
