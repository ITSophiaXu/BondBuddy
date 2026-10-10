import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { emptyM4Draft } from './m4-workspace.js';
import { inputManifestHash } from './production-rule-pin.js';
import { azureBlobs, digest } from './data.js';

const connection = await isolatedTestDatabase(undefined, 'material-delete-workspace');
test('deleted material and template do not break a shared workspace; ownership and immutable inputs are preserved', { skip: !connection || !process.env.BB_TEST_AZURITE_CONNECTION_STRING }, async () => {
  const pool = new Pool({ connectionString: connection });
  const owner = randomUUID(), foreign = randomUUID(); let actor = owner;
  const blobs = azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!, `bb-delete-${owner.replaceAll('-', '')}`);
  const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test', principal: async () => ({ userId: actor, csrfVerified: true }) });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { origin: 'http://bondbuddy.test' } });
  const ok = async (method: string, url: string, payload?: unknown) => { const r = await send(method, url, payload); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  try {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)', [owner, `syn_${owner.replaceAll('-', '').slice(0, 20)}`, foreign, `syn_${foreign.replaceAll('-', '').slice(0, 20)}`]);
    const topic = (await ok('POST', '/api/v1/m4/topics', { creation_request_id: randomUUID(), name: 'Synthetic deletion' })).topic;
    const second = (await ok('POST', '/api/v1/m4/topics', { creation_request_id: randomUUID(), name: 'Synthetic second topic' })).topic;
    const upload = randomUUID(), id = randomUUID(), bytes = Buffer.alloc(100, 1), sha = digest(bytes), object = `users/${owner}/projects/${topic.project_id}/materials/${upload}`;
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await blobs.put(object, bytes, mime);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.docx',$4,100,$5,'other',$6,now()+interval '1 hour','completed')`, [upload, owner, topic.project_id, mime, sha, object]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'other','synthetic.docx',$5,100,$6,$7,'persisted')`, [id, owner, topic.project_id, upload, mime, sha, object]);
    const pin = { source_project_id: topic.project_id, material_id: id, material_version: 1, sha256: sha };
    for (const t of [topic, second]) await ok('POST', `/api/v1/m4/topics/${t.topic_id}/materials`, { material: pin });
    const template = (await ok('POST', '/api/v1/m4/templates', { creation_request_id: randomUUID(), name: 'Synthetic template', broker: 'Synthetic broker', document_type: 'init', market: 'sse', material: pin })).template;
    const input = { ...emptyM4Draft('init'), materials: [pin], template: { template_id: template.template_id, template_version: template.template_version, sha256: template.sha256 }, fields: { broker: 'Synthetic broker', market: 'sse' } };
    await ok('PUT', `/api/v1/m4/topics/${topic.topic_id}/drafts/init`, { expected_version: 0, input });
    const manifest = { materials: [pin], synthetic: true }, hash = inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,$5,'[]')`, [topic.project_id, owner, hash, manifest, JSON.stringify([pin])]);
    const path = `/api/v1/projects/${topic.project_id}/materials/${id}`;
    actor = foreign; assert.equal((await send('DELETE', path)).statusCode, 404); actor = owner;
    assert.equal((await send('GET', path)).statusCode, 200);
    assert.equal((await send('DELETE', path)).statusCode, 204);
    assert.equal((await send('DELETE', path)).statusCode, 204);
    assert.equal((await send('GET', path)).statusCode, 404);
    for (const t of [topic, second]) {
      const w = await ok('GET', `/api/v1/m4/topics/${t.topic_id}/workspace`);
      assert.deepEqual(w.materials, []); assert.deepEqual(w.material_details, []); assert.deepEqual(w.templates, []);
    }
    await ok('PUT', `/api/v1/m4/topics/${topic.topic_id}/drafts/init`, { expected_version: 1, input: { ...input, materials: [], template: null } });
    const saved = (await ok('GET', `/api/v1/m4/topics/${topic.topic_id}/workspace`)).drafts.init;
    assert.equal(saved.version, 2); assert.deepEqual(saved.materials, []); assert.equal(saved.template, null);
    const original = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2', [owner, topic.project_id])).rows[0];
    assert.deepEqual(original.manifest, manifest); assert.equal(original.input_hash.trim(), hash);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='material.deleted'", [owner, id])).rows[0].n, 1);
  } finally { await app.close(); await pool.end(); }
});
