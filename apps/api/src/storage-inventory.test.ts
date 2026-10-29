import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { azureBlobs } from './data.js';
import { inventoryPolicyFromEnv, parseInventoryKey, runStorageInventory } from './storage-inventory.js';
import { isolatedTestDatabase } from './test-database.js';

test('inventory keys accept only known private object layouts', () => {
  const owner = 'owner_1', project = 'project_1', sha = 'a'.repeat(64), u = '12345678-1234-1234-1234-123456789012';
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/snapshots/s1`), 'snapshot');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/uploads/u1`), 'upload');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/file-templates/assets/${sha}.docx`), 'file_template');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/provider-results/c1-${sha}.json`), 'provider_result');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/ocr/results/${sha}.json`), 'ocr_result');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/ocr-v2/material/1/${sha}/${sha}.json`), 'ocr_v2_checkpoint');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/ocr-v2/material/1/${sha}/${sha}.png`), 'ocr_v2_page');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/ocr/m1/1/${sha}.png`), 'ocr_page');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/ocr/m1/2147483648/${sha}.png`), 'unrecognized');
  assert.equal(parseInventoryKey(`users/${owner}/runs/r1/artifacts/a1/v1.docx`), 'artifact');
  assert.equal(parseInventoryKey(`parse-cache/${sha}/${u}`), 'parse_cache');
  assert.equal(parseInventoryKey(`log-archive/ndjson_file/${u}.ndjson`), 'log_archive');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/snapshots/x/extra`), 'unrecognized');
  assert.equal(parseInventoryKey(`users/${owner}/projects/${project}/unknown/x`), 'unrecognized');
  assert.equal(inventoryPolicyFromEnv({}).deleteEnabled, false);
  assert.equal(inventoryPolicyFromEnv({ BB_STORAGE_ORPHAN_GRACE_HOURS: '0' }).graceHours, 24);
});

const connection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const database = await isolatedTestDatabase();
test('PostgreSQL/Azurite inventory is read-only by default and deletes only old unreferenced snapshots', { skip: !connection || !database }, async () => {
  const pool = new Pool({ connectionString: database });
  const containerName = `bb-inventory-${randomUUID().replaceAll('-', '')}`;
  const service = BlobServiceClient.fromConnectionString(connection!);
  const container = service.getContainerClient(containerName);
  const blobs = azureBlobs(connection!, containerName);
  const owner = `o_${randomUUID().replaceAll('-', '')}`, project = `p_${randomUUID().replaceAll('-', '')}`;
  const key = (name: string) => `users/${owner}/projects/${project}/snapshots/${name}`;
  const names = ['a_ref','b_intent','c_orphan','d_young','e_race','f_cap'];
  const unknown = `users/${owner}/projects/${project}/unexpected/file`;
  const created = new Date();
  const now = new Date(created.getTime() + 48 * 3600000);
  const intentBoundary = new Date(created.getTime() + 3600000);
  const put = async (name: string) => blobs.put(key(name), Buffer.from(name), 'text/plain');
  const register = async (name: string, version: number) => pool.query(`INSERT INTO bb_snapshot_refs
    (id,owner_user_id,project_id,snapshot_kind,version,object_key,content_sha256,redaction_version)
    VALUES($1,$2,$3,'user_prompt',$4,$5,$6,'scrub_v1')`, [randomUUID(),owner,project,version,key(name),'a'.repeat(64)]);
  try {
    await container.create();
    // Model legacy objects as older than the actual application of 0042 in this cloned database.
    await pool.query("UPDATE bb_schema_migrations SET applied_at=$1 WHERE filename='0042_m1_orphan_prompt_blobs.sql'", [intentBoundary]);
    await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)', [project,owner,'Synthetic inventory project','update']);
    for (const name of names) await put(name);
    await blobs.put(unknown,Buffer.from('unknown'),'text/plain');
    await register('a_ref',1);
    await pool.query('INSERT INTO bb_prompt_blob_intents(id,owner_user_id,project_id,object_key) VALUES($1,$2,$3,$4)', [randomUUID(),owner,project,key('b_intent')]);
    const listed = blobs.listPage!.bind(blobs);
    const dated = { ...blobs, listPage: async (prefix: string, cursor: string | undefined, size: number) => {
      const page = await listed(prefix,cursor,size);
      return { ...page, items: page.items.map(item => ({ ...item, lastModified: item.key === key('d_young') ? now : item.lastModified })) };
    } };
    const opts = { now: () => now, pageSize: 100, maxPages: 1, sampleLimit: 2 };
    const dry = await runStorageInventory(pool, dated, opts);
    assert.equal(dry.byPrefix['users/'].referenced.count,1);
    assert.equal(dry.byPrefix['users/'].intent_pending.count,1);
    assert.equal(dry.byPrefix['users/'].orphan_candidate.count,3);
    assert.equal(dry.byPrefix['users/'].orphan_candidate.bytes, ['c_orphan','e_race','f_cap'].reduce((n, s) => n + Buffer.byteLength(s), 0));
    assert.equal(dry.byPrefix['users/'].post_0042_unregistered.count,1);
    assert.ok(dry.byPrefix['users/'].orphan_candidate.oldest);
    assert.equal(dry.byPrefix['users/'].unrecognized.count,1);
    assert.equal(dry.candidateKeyHashes.length,2);
    assert.equal(dry.deleted,0);
    assert.equal(await blobs.exists(key('c_orphan')),true);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_ops_alerts WHERE kind='storage_orphan_candidates'")).rows[0].n,1);

    const capped = await runStorageInventory(pool, dated, { ...opts, deleteEnabled: true, maxDeletes: 1 });
    assert.equal(capped.deleted,1,'one old orphan is removed per batch');
    const race = await runStorageInventory(pool, dated, { ...opts, deleteEnabled: true, maxDeletes: 3,
      beforeDelete: async candidate => { if (candidate === key('e_race')) await register('e_race',2); } });
    assert.equal(race.deleted,1,'late reference blocks deletion of the raced object');
    assert.equal(await blobs.exists(key('a_ref')),true);
    assert.equal(await blobs.exists(key('b_intent')),true);
    assert.equal(await blobs.exists(key('d_young')),true);
    assert.equal(await blobs.exists(key('e_race')),true,'a reference registered after listing survives deletion');
    assert.equal(await blobs.exists(unknown),true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_storage_inventory_deletions')).rows[0].n,2);
    assert.ok((await pool.query('SELECT count(*)::int n FROM bb_storage_inventory_delete_attempts')).rows[0].n >= 2);
    await put('g_changed');
    const changed = { ...dated, listPage: async (prefix: string, cursor: string | undefined, size: number) => {
      const page = await dated.listPage(prefix,cursor,size);
      return { ...page, items: page.items.map(item => ({ ...item, etag: item.key === key('g_changed') ? '"stale-etag"' : item.etag })) };
    } };
    const stale = await runStorageInventory(pool, changed, { ...opts, deleteEnabled: true });
    assert.equal(stale.deleted,0,'a changed ETag is never deleted');
    assert.equal(await blobs.exists(key('g_changed')),true);
    await put('h_boundary_race');
    const boundaryRaced = await runStorageInventory(pool, changed, { ...opts, deleteEnabled: true,
      beforeDelete: async candidate => {
        if (candidate === key('h_boundary_race')) await pool.query("UPDATE bb_schema_migrations SET applied_at=$1 WHERE filename='0042_m1_orphan_prompt_blobs.sql'", [new Date(created.getTime() - 3600000)]);
      } });
    assert.equal(boundaryRaced.deleted,0,'the 0042 boundary is rechecked in the deletion transaction');
    assert.equal(await blobs.exists(key('h_boundary_race')),true);
    await pool.query("UPDATE bb_schema_migrations SET applied_at=$1 WHERE filename='0042_m1_orphan_prompt_blobs.sql'", [intentBoundary]);
    await register('h_boundary_race',3);
    await register('g_changed',4);
    await put('h_post');
    await put('i_missing_time');
    const guardedBlobs = { ...changed, listPage: async (prefix: string, cursor: string | undefined, size: number) => {
      const page = await changed.listPage(prefix,cursor,size);
      return { ...page, items: page.items.map(item => ({ ...item, lastModified: item.key === key('h_post')
        ? new Date(intentBoundary.getTime() + 3600000) : item.key === key('i_missing_time') ? undefined : item.lastModified })) };
    } };
    const guarded = await runStorageInventory(pool, guardedBlobs, { ...opts, deleteEnabled: true });
    assert.equal(guarded.deleted,0,'a post-0042 object older than the grace period is never deleted');
    assert.equal(guarded.byPrefix['users/'].orphan_candidate.count,0);
    assert.equal(guarded.byPrefix['users/'].post_0042_unregistered.count,2);
    assert.equal(guarded.byPrefix['users/'].snapshot_provenance_unknown.count,1);
    assert.equal(await blobs.exists(key('h_post')),true);
    assert.equal(await blobs.exists(key('i_missing_time')),true);
    await put('j_missing_boundary');
    await pool.query("DELETE FROM bb_schema_migrations WHERE filename='0042_m1_orphan_prompt_blobs.sql'");
    const noBoundary = await runStorageInventory(pool, guardedBlobs, { ...opts, deleteEnabled: true });
    assert.equal(noBoundary.deleted,0,'missing 0042 application time fails closed');
    assert.ok(noBoundary.byPrefix['users/'].snapshot_provenance_unknown.count >= 1);
    assert.equal(await blobs.exists(key('j_missing_boundary')),true);
    await assert.rejects(pool.query('DELETE FROM bb_storage_inventory_deletions'), /immutable|append-only|reject/i);
  } finally { await pool.end(); await container.deleteIfExists(); }
});
