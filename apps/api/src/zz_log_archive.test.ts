import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobServiceClient } from '@azure/storage-blob';
import { Pool } from 'pg';
import { ndjsonFileSink, forwardLogs, type LogRecord } from './log-ops.js';
import { transaction } from './data.js';
import { emitInternal, internalEvent } from './observability.js';
import { gateState, resetProcessGateForTests } from './evidence-gate.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const available = !!databaseUrl && !!blobConnection;
const record = (n: number, sink: string): LogRecord => {
  const outboxId = `archive-${randomUUID()}`;
  return { delivery_key: createHash('sha256').update(`${sink}:${outboxId}`).digest('hex'),
    outbox_id: outboxId, event: { kind: 'synthetic.event', seq: n, padding: 'x'.repeat(530) } };
};

test('#79 PG16/Azurite archive survives two rotations, delayed replay and crash boundaries', { skip: !available }, async t => {
  const pool = new Pool({ connectionString: databaseUrl });
  const containerName = `bb79archive${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const runPrefix = `bb${randomUUID().replaceAll('-', '').slice(0, 8)}_`;
  const container = BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(containerName);
  const dir = await mkdtemp(join(tmpdir(), 'bb79-archive-'));
  const saved = { DATABASE_URL: process.env.DATABASE_URL, AZURE_STORAGE_CONNECTION_STRING: process.env.AZURE_STORAGE_CONNECTION_STRING,
    BB_LOG_ARCHIVE_CONTAINER: process.env.BB_LOG_ARCHIVE_CONTAINER, NODE_ENV: process.env.NODE_ENV,
    BB_LOG_ARCHIVE_TEST_FAULT: process.env.BB_LOG_ARCHIVE_TEST_FAULT };
  process.env.DATABASE_URL = databaseUrl;
  process.env.AZURE_STORAGE_CONNECTION_STRING = blobConnection;
  process.env.BB_LOG_ARCHIVE_CONTAINER = containerName;
  process.env.NODE_ENV = 'test';
  await container.createIfNotExists();
  // This file owns a private clone, but earlier suites may have written pending rows into
  // the migrated template before the clone was made. Start with an empty delivery queue:
  // forwardLogs claims globally, so batchSize=1 must never select another suite's event.
  await pool.query('DELETE FROM bb_outbox WHERE delivered_at IS NULL');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE delivered_at IS NULL')).rows[0].n, 0);
  const sink = (file: string) => ndjsonFileSink(file, runPrefix + file.split('/').at(-1)!.replace('.ndjson', ''), 1024, { localBudget: 3072 });
  const receipt = async (r: LogRecord, sinkName: string) => {
    await pool.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload,delivered_at)
      VALUES($1,'synthetic-owner','observability',$1,'synthetic.event','{}',now())`, [r.outbox_id]);
    await pool.query('INSERT INTO bb_log_deliveries(outbox_id,sink,delivery_key,attempts) VALUES($1,$2,$3,1)',
      [r.outbox_id, sinkName, r.delivery_key]);
  };
  const localKeys = async (file: string) => {
    const names = (await readdir(dir)).filter(n => n === file.split('/').at(-1) || n.startsWith(`${file.split('/').at(-1)}.seg.`));
    const keys: string[] = [];
    for (const name of names) {
      const body = await readFile(join(dir, name), 'utf8');
      keys.push(...body.split('\n').filter(Boolean).map(line => JSON.parse(line).delivery_key as string));
    }
    return keys;
  };
  try {
    await t.test('two rotations retire only independently archived segments', async () => {
      const file = join(dir, 'normal.ndjson'), writer = sink(file);
      const [a, b, c] = [record(1, writer.name), record(2, writer.name), record(3, writer.name)];
      await writer.deliver([a]); await receipt(a, writer.name);
      await writer.deliver([b]); await receipt(b, writer.name);
      await writer.deliver([c]); await receipt(c, writer.name);
      await writer.deliver([]);
      const archives = (await pool.query('SELECT count(*)::int n FROM bb_log_archive_receipts WHERE object_key LIKE $1', [`log-archive/${writer.name}/%`])).rows[0].n;
      assert.ok(archives >= 2);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM bb_log_archive_lifecycle l
        JOIN bb_log_segments s ON s.id=l.segment_id WHERE s.sink=$1`, [writer.name])).rows[0].n, archives,
        'only retired local segments enter the cleanup lifecycle');
      const before = await localKeys(file);
      await writer.deliver([a]); // lease-expired process resumes after two local segments are gone
      assert.deepEqual(await localKeys(file), before);
      assert.deepEqual(before, [c.delivery_key]);
    });
    await t.test('expired process A resumes after process B rotates twice', async () => {
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE delivered_at IS NULL')).rows[0].n, 0);
      const file = join(dir, 'stale.ndjson'), marker = join(dir, 'stale.ready'), release = join(dir, 'stale.release');
      const writer = ndjsonFileSink(file, `${runPrefix}stale`, 2048, { localBudget: 6144 });
      const owner = `archive-${randomUUID()}`;
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `u${randomUUID().slice(0, 8)}`]);
      const makeEvent = () => internalEvent({ kind: 'operation.submitted', owner,
        traceId: 't'.repeat(100), operationId: 'o'.repeat(100), requestId: 'r'.repeat(100), stage: 's'.repeat(60) });
      const a = makeEvent(), b = makeEvent(), c = makeEvent();
      const lineBytes = Buffer.byteLength(JSON.stringify({ delivery_key: 'a'.repeat(64), ...a }) + '\n');
      assert.ok(lineBytes > 1024 && lineBytes < 2048);
      await transaction(pool, client => emitInternal(client, a));
      await pool.query("UPDATE bb_outbox SET created_at='1997-01-01' WHERE aggregate_id=$1", [a.event_id]);
      const source = `import { Pool } from 'pg';
        import { writeFile, access } from 'node:fs/promises';
        import { setTimeout as pause } from 'node:timers/promises';
        const { forwardLogs, ndjsonFileSink } = await import(process.env.BB_TEST_LOG_MODULE);
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const real = ndjsonFileSink(process.env.BB_TEST_LOG_FILE, process.env.BB_TEST_LOG_SINK, 2048, { localBudget: 6144 });
        const waiting = { name: real.name, archiveEnabled: true, async deliver(rows) {
          await writeFile(process.env.BB_TEST_READY, 'ready');
          for (;;) { try { await access(process.env.BB_TEST_RELEASE); break; } catch { await pause(30); } }
          await real.deliver(rows);
        } };
        try { await forwardLogs(pool, waiting, { batchSize: 1, leaseSeconds: 1 }); }
        finally { await pool.end(); }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env,
        BB_TEST_LOG_MODULE: new URL('./log-ops.js', import.meta.url).href,
        BB_TEST_LOG_FILE: file, BB_TEST_LOG_SINK: writer.name, BB_TEST_READY: marker, BB_TEST_RELEASE: release } });
      let stderr = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', part => { stderr += String(part).slice(0, 1000); });
      const childExit = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      try {
        let ready = false;
        for (let i = 0; i < 200; i++) {
          try { await readFile(marker); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        assert.ok(ready, `process A did not claim before timeout: ${stderr}`);
        await pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE aggregate_id=$1", [a.event_id]);
        assert.equal((await forwardLogs(pool, writer, { batchSize: 1 })).delivered, 1);
        for (const event of [b, c]) {
          await transaction(pool, client => emitInternal(client, event));
          assert.equal((await forwardLogs(pool, writer, { batchSize: 1 })).delivered, 1);
        }
        await writer.deliver([]);
        await writeFile(release, 'go');
        assert.equal(await childExit, 0, stderr);
        assert.deepEqual(await localKeys(file), [createHash('sha256').update(`${writer.name}:${(await pool.query('SELECT id FROM bb_outbox WHERE aggregate_id=$1', [c.event_id])).rows[0].id}`).digest('hex')]);
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_archive_receipts r JOIN bb_log_segments s ON s.id=r.segment_id WHERE s.sink=$1', [writer.name])).rows[0].n, 2);
      } finally { child.kill(); await writeFile(release, 'go'); }
    });
    for (const [i, point] of ['after_seal_filesync', 'after_seal_rename', 'after_seal_dirsync', 'after_active_id', 'after_blob_upload',
      'after_blob_readback', 'before_receipt', 'after_receipt', 'before_unlink', 'after_unlink',
      'before_file_sync', 'after_file_sync'].entries()) {
      await t.test(`cross-process ${point} recovery`, async () => {
        const file = join(dir, `fault${i}.ndjson`), writer = sink(file);
        const a = record(i * 2 + 100, writer.name), b = record(i * 2 + 101, writer.name);
        await writer.deliver([a]); await receipt(a, writer.name);
        process.env.BB_LOG_ARCHIVE_TEST_FAULT = point;
        await assert.rejects(writer.deliver([b]));
        delete process.env.BB_LOG_ARCHIVE_TEST_FAULT;
        await writer.deliver([b]); await receipt(b, writer.name);
        await writer.deliver([]);
        const keys = await localKeys(file);
        assert.equal(new Set(keys).size, keys.length);
        assert.ok(keys.includes(b.delivery_key));
      });
    }
    await t.test('missing key receipt preserves sealed file; PG/Blob faults reject and recover', async () => {
      const file = join(dir, 'pending.ndjson'), writer = sink(file);
      const a = record(900, writer.name), b = record(901, writer.name);
      await writer.deliver([a]);
      await writer.deliver([b]);
      assert.ok((await localKeys(file)).includes(a.delivery_key));
      await receipt(a, writer.name); await receipt(b, writer.name);
      const original = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://postgres@127.0.0.1:1/postgres';
      await assert.rejects(writer.deliver([]));
      process.env.DATABASE_URL = original;
      const blob = process.env.AZURE_STORAGE_CONNECTION_STRING;
      process.env.AZURE_STORAGE_CONNECTION_STRING = 'invalid';
      await assert.rejects(writer.deliver([]));
      process.env.AZURE_STORAGE_CONNECTION_STRING = blob;
      await writer.deliver([]);
      assert.deepEqual(await localKeys(file), [b.delivery_key]);
    });
    await t.test('legacy .1 is imported by unique name without overwrite', async () => {
      const file = join(dir, 'legacy.ndjson'), writer = sink(file), a = record(950, writer.name);
      await writeFile(`${file}.1`, JSON.stringify({ delivery_key: a.delivery_key, ...a.event }) + '\n', { mode: 0o600 });
      await receipt(a, writer.name);
      await writer.deliver([a]);
      assert.ok(!(await readdir(dir)).includes('legacy.ndjson.1'));
      assert.deepEqual(await localKeys(file), []);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_archive_receipts WHERE object_key LIKE $1', [`log-archive/${writer.name}/%`])).rows[0].n, 1);
    });
    await t.test('lost active identity requires operator recovery without inventing a UUID', async () => {
      const file = join(dir, 'lostid.ndjson'), writer = sink(file);
      const first = record(955, writer.name), next = record(956, writer.name);
      await writer.deliver([first]);
      const before = await readFile(file);
      await unlink(`${file}.active-id`);
      await assert.rejects(writer.deliver([next]), /operator recovery required/);
      assert.deepEqual(await readFile(file), before);
      assert.ok(!(await readdir(dir)).includes('lostid.ndjson.active-id'));
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_log_segments WHERE sink=$1 AND state='active'", [writer.name])).rows[0].n, 1);
    });
    await t.test('Blob hash mismatch and receipt SQL failure retain local segment', async () => {
      const file = join(dir, 'sqlfail.ndjson'), writer = sink(file), a = record(960, writer.name), b = record(961, writer.name);
      await writer.deliver([a]); await receipt(a, writer.name);
      process.env.BB_LOG_ARCHIVE_TEST_FAULT = 'hash_mismatch';
      await assert.rejects(writer.deliver([b]));
      delete process.env.BB_LOG_ARCHIVE_TEST_FAULT;
      assert.ok((await localKeys(file)).includes(a.delivery_key));
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_archive_receipts r JOIN bb_log_segments s ON s.id=r.segment_id WHERE s.sink=$1', [writer.name])).rows[0].n, 0);
      const sealedId = (await pool.query("SELECT id FROM bb_log_segments WHERE sink=$1 AND state='sealed'", [writer.name])).rows[0].id;
      await container.getBlockBlobClient(`log-archive/${writer.name}/${sealedId}.ndjson`).deleteIfExists();
      await pool.query(`CREATE FUNCTION bb_test_archive_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.object_key LIKE 'log-archive/%sqlfail/%' THEN RAISE EXCEPTION 'synthetic receipt transaction failure'; END IF;
        RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER bb_test_archive_receipt_fail BEFORE INSERT ON bb_log_archive_receipts FOR EACH ROW EXECUTE FUNCTION bb_test_archive_receipt_fail()');
      try {
        await assert.rejects(writer.deliver([b]));
        assert.ok((await localKeys(file)).includes(a.delivery_key));
      } finally {
        await pool.query('DROP TRIGGER bb_test_archive_receipt_fail ON bb_log_archive_receipts');
        await pool.query('DROP FUNCTION bb_test_archive_receipt_fail()');
      }
      await writer.deliver([b]); await receipt(b, writer.name);
      assert.deepEqual(await localKeys(file), [b.delivery_key]);
    });
    await t.test('bad line, permission and disk-full injection fail closed', async () => {
      const file = join(dir, 'bad.ndjson'), writer = sink(file), a = record(999, writer.name);
      await writeFile(file, '{"delivery_key":"broken"', { mode: 0o600 });
      await assert.rejects(writer.deliver([a]));
      await writeFile(file, '', { mode: 0o600 }); await chmod(file, 0o644);
      await assert.rejects(writer.deliver([a]));
      await chmod(file, 0o600);
      process.env.BB_LOG_ARCHIVE_TEST_FAULT = 'disk_full';
      await assert.rejects(writer.deliver([a]));
      delete process.env.BB_LOG_ARCHIVE_TEST_FAULT;
      assert.deepEqual(await localKeys(file), []);
    });
    await t.test('local budget exhaustion retains every unarchived key', async () => {
      const file = join(dir, 'budget.ndjson'), writer = sink(file);
      const accepted: LogRecord[] = [];
      let full = false;
      for (let n = 0; n < 8; n++) {
        const row = record(1100 + n, writer.name);
        try { await writer.deliver([row]); accepted.push(row); }
        catch (error) { assert.match(String(error), /budget reached/); full = true; break; }
      }
      assert.ok(full);
      assert.deepEqual(new Set(await localKeys(file)), new Set(accepted.map(row => row.delivery_key)));
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_archive_receipts WHERE object_key LIKE $1', [`log-archive/${writer.name}/%`])).rows[0].n, 0);
    });
    await t.test('mixed wrong schema version blocks the whole PG batch, then crash replay has one line per key', async () => {
      const file = join(dir, 'forward.ndjson');
      const writer = ndjsonFileSink(file, `${runPrefix}forward`, 4096, { localBudget: 8192 });
      const owner = `archive-${randomUUID()}`;
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `u${randomUUID().slice(0, 8)}`]);
      const first = internalEvent({ kind: 'operation.submitted', owner, traceId: randomUUID() });
      const wrong = internalEvent({ kind: 'operation.submitted', owner, traceId: randomUUID() });
      await transaction(pool, async client => { await emitInternal(client, first); await emitInternal(client, wrong); });
      const outbox = (await pool.query('SELECT id,aggregate_id FROM bb_outbox WHERE aggregate_id=ANY($1)', [[first.event_id, wrong.event_id]])).rows;
      await pool.query("UPDATE bb_outbox SET created_at='2000-01-01' WHERE id=ANY($1)", [outbox.map(r => r.id)]);
      await pool.query("UPDATE bb_outbox SET payload=jsonb_set(payload,'{schema_version}','2'::jsonb) WHERE aggregate_id=$1", [wrong.event_id]);
      const blocked = await forwardLogs(pool, writer, { batchSize: 2, retrySeconds: 0 });
      assert.equal(blocked.delivered, 0);
      assert.equal((await gateState(pool)).state, 'paused');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE id=ANY($1) AND delivered_at IS NULL', [outbox.map(r => r.id)])).rows[0].n, 2);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE outbox_id=ANY($1)', [outbox.map(r => r.id)])).rows[0].n, 0);
      await pool.query("UPDATE bb_outbox SET payload=jsonb_set(payload,'{schema_version}','1'::jsonb) WHERE aggregate_id=$1", [wrong.event_id]);
      await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [randomUUID()]);
      resetProcessGateForTests();
      await assert.rejects(forwardLogs(pool, writer, { batchSize: 2, retrySeconds: 0, afterSinkAccept: async () => { throw new Error('synthetic PG ACK boundary crash'); } }));
      await pool.query('UPDATE bb_outbox SET lease_until=now()-interval \'1 second\' WHERE id=ANY($1)', [outbox.map(r => r.id)]);
      const replay = await forwardLogs(pool, writer, { batchSize: 2, retrySeconds: 0 });
      assert.equal(replay.delivered, 2);
      const keys = await localKeys(file);
      assert.equal(keys.length, 2);
      assert.equal(new Set(keys).size, 2);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_deliveries WHERE outbox_id=ANY($1)', [outbox.map(r => r.id)])).rows[0].n, 2);
    });
    await t.test('archive ENOSPC keeps outbox pending, alerts and pauses external calls', async () => {
      const file = join(dir, 'full.ndjson');
      const writer = ndjsonFileSink(file, `${runPrefix}full`, 4096, { localBudget: 8192 });
      const owner = `archive-${randomUUID()}`;
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `u${randomUUID().slice(0, 8)}`]);
      const event = internalEvent({ kind: 'operation.submitted', owner, traceId: randomUUID() });
      await transaction(pool, client => emitInternal(client, event));
      const outboxId = (await pool.query('SELECT id FROM bb_outbox WHERE aggregate_id=$1', [event.event_id])).rows[0].id;
      await pool.query("UPDATE bb_outbox SET created_at='1999-01-01' WHERE id=$1", [outboxId]);
      process.env.BB_LOG_ARCHIVE_TEST_FAULT = 'disk_full';
      try {
        const result = await forwardLogs(pool, writer, { batchSize: 1, retrySeconds: 0 });
        assert.equal(result.failed, 1);
        assert.equal((await pool.query('SELECT delivered_at FROM bb_outbox WHERE id=$1', [outboxId])).rows[0].delivered_at, null);
        assert.equal((await gateState(pool)).state, 'paused');
        assert.equal((await pool.query("SELECT count(*)::int n FROM bb_ops_alerts WHERE kind='log_sink_unavailable' AND detail->>'sink'=$1", [writer.name])).rows[0].n, 1);
      } finally {
        delete process.env.BB_LOG_ARCHIVE_TEST_FAULT;
        await pool.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'open','synthetic_test_reset','system')", [randomUUID()]);
        resetProcessGateForTests();
      }
      const replay = await forwardLogs(pool, writer, { batchSize: 1, retrySeconds: 0 });
      assert.equal(replay.delivered, 1);
      assert.equal((await localKeys(file)).length, 1);
    });
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await container.deleteIfExists(); await pool.end(); await rm(dir, { recursive: true, force: true });
  }
});
