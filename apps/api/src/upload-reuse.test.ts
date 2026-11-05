import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest } from './data.js';
import { docxSample, DOCX, PDF, TEXT } from './upload-safety.samples.js';
import { runStorageLifecycle } from './storage-lifecycle.js';

import { isolatedTestDatabase } from './test-database.js';
const connection = await isolatedTestDatabase();
const blobConnection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

test('real storage: concurrent renamed uploads reuse one immutable version, replay survives cleanup and stays owner scoped', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const initialOwner = `reuse-${randomUUID()}`;
  let owner = initialOwner;
  const container = `bb-reuse-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, container);
  const app = createServer({ pool, blobs, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any,
    headers: { origin, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) } });
  const create = async () => {
    const r = await send('POST', '/api/v1/projects', { name: 'Synthetic upload reuse', kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(r.statusCode, 201, r.body); return r.json().project_id as string;
  };
  const bytes = await docxSample();
  const declaration = { byte_size: bytes.length, sha256: digest(bytes) };
  const received = async (project: string, filename: string, role = 'historical') => {
    const r = await send('POST', `/api/v1/projects/${project}/materials/uploads`, { ...declaration, filename, role, media_type: DOCX });
    assert.equal(r.statusCode, 201, r.body);
    const session = r.json();
    const put = await send('PUT', session.upload_url, bytes);
    assert.equal(put.statusCode, 204, put.body);
    return { ...session, complete: `/api/v1/projects/${project}/materials/uploads/${session.upload_id}/complete` };
  };
  const complete = async (session: { complete: string }) => {
    const r = await send('POST', session.complete, declaration);
    assert.equal(r.statusCode, 200, r.body); return r.json();
  };
  try {
    const project = await create();
    const [first, renamed] = await Promise.all([received(project, 'history.docx'), received(project, 'renamed.docx')]);
    const started = performance.now();
    const results = await Promise.all([complete(first), complete(renamed)]);
    assert.equal(results[0].material_id, results[1].material_id);
    const canonical = results[0];
    const redundant = canonical.upload_id === first.upload_id ? renamed : first;
    const canonicalKey = `users/${owner}/projects/${project}/uploads/${canonical.upload_id}`;
    const redundantKey = `users/${owner}/projects/${project}/uploads/${redundant.upload_id}`;
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='material.persisted'", [owner])).rows[0].n, 1);
    assert.equal((await send('GET', `/api/v1/projects/${project}/events`)).json().items.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1', [owner])).rows[0].n, 0, 'upload never starts a full update');
    assert.equal((await complete(redundant)).material_id, canonical.material_id);
    assert.equal((await send('PUT', redundant.upload_url, bytes)).statusCode, 409, 'resolved staging cannot be rewritten');
    assert.equal((await send('POST', redundant.complete, { ...declaration, sha256: 'a'.repeat(64) })).statusCode, 409);
    await assert.rejects(pool.query('UPDATE bb_upload_reuse_receipts SET material_version=2 WHERE upload_id=$1', [redundant.upload_id]), /immutable/);

    // Redundant staging bytes follow the existing explicit grace policy, without deleting the canonical object.
    await pool.query("UPDATE bb_uploads SET expires_at=now()-interval '2 hours' WHERE id=$1", [redundant.upload_id]);
    const cleanup = await runStorageLifecycle(pool, blobs, { materialRetentionDays: 1, orphanUploadGraceHours: 1, ownerScope: owner });
    assert.equal(cleanup.purged, 1);
    assert.equal(await blobs.exists(redundantKey), false);
    assert.equal(await blobs.exists(canonicalKey), true);
    assert.equal((await complete(redundant)).material_id, canonical.material_id, 'completion receipt survives staging cleanup');
    const otherRole = await complete(await received(project, 'audit.docx', 'audit'));
    assert.notEqual(otherRole.material_id, canonical.material_id);
    const otherProject = await create();
    assert.notEqual((await complete(await received(otherProject, 'history.docx'))).material_id, canonical.material_id);
    owner = `reuse-other-${randomUUID()}`;
    assert.equal((await send('POST', redundant.complete, declaration)).statusCode, 404);
    assert.equal((await send('GET', `/api/v1/projects/${project}/materials/${canonical.material_id}`)).statusCode, 404);
    const foreignProject = await create();
    assert.notEqual((await complete(await received(foreignProject, 'history.docx'))).material_id, canonical.material_id);
    owner = initialOwner;

    await blobs.delete(canonicalKey);
    assert.equal((await send('POST', redundant.complete, declaration)).statusCode, 503, 'missing canonical bytes never report saved');
    const pending = await received(project, 'another-copy.docx');
    assert.equal((await send('POST', pending.complete, declaration)).statusCode, 503, 'missing canonical does not silently create another recognition event');
    await blobs.put(canonicalKey, bytes, PDF);
    await pool.query("CREATE FUNCTION bb_fail_reuse_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='upload.reused' THEN RAISE EXCEPTION 'synthetic reuse outbox failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER bb_fail_reuse_test BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_fail_reuse_test()');
    try {
      assert.equal((await send('POST', pending.complete, declaration)).statusCode, 500);
      assert.equal((await pool.query('SELECT 1 FROM bb_upload_reuse_receipts WHERE upload_id=$1', [pending.upload_id])).rowCount, 0, 'outbox failure rolls back reuse receipt');
    } finally {
      await pool.query('DROP TRIGGER bb_fail_reuse_test ON bb_outbox');
      await pool.query('DROP FUNCTION bb_fail_reuse_test()');
    }
    assert.equal((await complete(pending)).material_id, canonical.material_id);
    assert.equal((await send('DELETE', `/api/v1/projects/${project}/materials/${canonical.material_id}`)).statusCode, 204);
    assert.equal((await send('POST', redundant.complete, declaration)).statusCode, 404, 'receipt cannot revive a deleted version');
    assert.notEqual((await complete(await received(project, 'replacement.docx'))).material_id, canonical.material_id);
    process.stdout.write(`Synthetic concurrent/replay storage scenario: ${Math.round(performance.now() - started)} ms\n`);
  } finally {
    await app.close(); await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(container).deleteIfExists();
  }
});

test('project byte capacity checks exact boundary using explicit synthetic metadata', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({connectionString: connection});
  const owner = `byte-capacity-${randomUUID()}`, project = randomUUID();
  const container = `bb-byte-capacity-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, container);
  const app = createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const bytes = Buffer.from('Synthetic boundary note\n');
  try {
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic byte boundary','update')", [project,owner]);
    // Arithmetic/transaction boundary fixture only; these 5 prior objects are not a 500 MiB transport test.
    for(let i=0;i<5;i++){
      const id=randomUUID(),key=`synthetic/${owner}/${id}`,size=M1_UPLOAD_LIMITS.fileBytes-(i===0?bytes.length:0),hash=digest(`synthetic prior ${i}`);
      await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'prior.pdf',$4,$5,$6,'audit',$7,now(),'completed')",[id,owner,project,PDF,size,hash,key]);
      await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$1,'audit','prior.pdf',$4,$5,$6,$7,'persisted')",[id,owner,project,PDF,size,hash,key]);
    }
    const send=(method:string,url:string,payload:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
    const save=async(data:Buffer)=>{
      const declaration={byte_size:data.length,sha256:digest(data)};
      const r=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{...declaration,filename:'boundary.txt',media_type:TEXT,role:'notes'});
      assert.equal(r.statusCode,201,r.body);
      const put=await send('PUT',r.json().upload_url,data);assert.equal(put.statusCode,204,put.body);
      return send('POST',`/api/v1/projects/${project}/materials/uploads/${r.json().upload_id}/complete`,declaration);
    };
    const boundary=await save(bytes);assert.equal(boundary.statusCode,200,boundary.body);
    assert.equal((await save(Buffer.from('Extra note\n'))).statusCode,422);
    assert.equal((await save(bytes)).json().material_id,boundary.json().material_id,'duplicate remains reusable at full byte capacity');
    assert.equal(Number((await pool.query('SELECT sum(byte_size) bytes FROM bb_material_versions WHERE owner_user_id=$1',[owner])).rows[0].bytes),M1_UPLOAD_LIMITS.projectBytes);
  } finally {
    await app.close();await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(container).deleteIfExists();
  }
});

test('real storage: 60-file boundary, concurrent final slots, partial failure and duplicate reuse at capacity', { skip: !connection || !blobConnection }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = `capacity-${randomUUID()}`;
  const container = `bb-capacity-${randomUUID().replaceAll('-', '')}`;
  const blobs = azureBlobs(blobConnection!, container);
  const app = createServer({ pool, blobs, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any,
    headers: { origin, ...(Buffer.isBuffer(payload) ? { 'content-type': 'application/octet-stream' } : {}) } });
  try {
    const projectResponse = await send('POST', '/api/v1/projects', { name: 'Synthetic capacity', kind: 'update', issuer_name: null, market: null, offering: null });
    const project = projectResponse.json().project_id;
    const receive = async (index: number) => {
      const bytes = Buffer.from(`Synthetic financial note ${index}\n`);
      const declaration = { byte_size: bytes.length, sha256: digest(bytes) };
      const r = await send('POST', `/api/v1/projects/${project}/materials/uploads`, { ...declaration, filename: `note-${index}.txt`, role: 'notes', media_type: TEXT });
      assert.equal(r.statusCode, 201, r.body);
      const put = await send('PUT', r.json().upload_url, bytes);
      assert.equal(put.statusCode, 204, put.body);
      return { url: `/api/v1/projects/${project}/materials/uploads/${r.json().upload_id}/complete`, declaration };
    };
    const finish = (s: Awaited<ReturnType<typeof receive>>) => send('POST', s.url, s.declaration);
    const started = performance.now();
    for (let i = 0; i < 59; i++) assert.equal((await finish(await receive(i))).statusCode, 200);
    const [a, b] = await Promise.all([receive(59), receive(60)]);
    const race = await Promise.all([finish(a), finish(b)]);
    assert.deepEqual(race.map(r => r.statusCode).sort(), [200, 422]);
    const events = await send('GET', `/api/v1/projects/${project}/events?limit=100`);
    assert.equal(events.json().items.length, M1_UPLOAD_LIMITS.projectFiles, 'failed sibling retains all successful materials');
    assert.equal((await finish(await receive(0))).statusCode, 200, 'renamed same-content retry needs no extra capacity');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1', [owner])).rows[0].n, 60);
    const oversized = await send('POST', `/api/v1/projects/${project}/materials/uploads`, { filename: 'large.txt', role: 'notes', media_type: TEXT, byte_size: M1_UPLOAD_LIMITS.fileBytes + 1, sha256: 'a'.repeat(64) });
    assert.equal(oversized.statusCode, 422);
    const elapsed = Math.round(performance.now() - started);
    process.stdout.write(`Synthetic 60 small-file transfers and final-slot race: ${elapsed} ms (not a 500 MiB load certification)\n`);
  } finally {
    await app.close(); await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(container).deleteIfExists();
  }
});
