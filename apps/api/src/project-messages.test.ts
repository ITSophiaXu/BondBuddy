import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { projectMessageSetRef } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { digest, uid, type PrivateBlobs } from './data.js';
import { isolatedTestDatabase } from './test-database.js';
import { loadCurrentProjectMessageSetPin } from './project-message-set-lock.js';

const connection = await isolatedTestDatabase(undefined, 'project-messages');

test('project messages persist exact edits, replay, ordered history, audited plaintext and input refs without execution',
  { skip: !connection }, async () => {
    const pool = new Pool({ connectionString: connection });
    const storage = new Map<string, Buffer>();
    const blobs: PrivateBlobs = {
      async put(key, bytes) { storage.set(key, bytes); },
      async get(key) { const bytes = storage.get(key); if (!bytes) throw Error('Blob missing'); return bytes; },
      async getIfExists(key) { return storage.get(key) ?? null; },
      async getIfExistsBounded(key, max) { const bytes = storage.get(key); if (bytes && bytes.length > max) throw Error('Blob exceeds bound'); return bytes ?? null; },
      async exists(key) { return storage.has(key); },
      async delete(key) { storage.delete(key); },
    };
    const owner = `msg-owner-${uid().slice(0, 8)}`;
    const foreign = `msg-foreign-${uid().slice(0, 8)}`;
    let active = owner;
    const app = createServer({ pool, blobs, allowedOrigin: 'http://bondbuddy.test',
      principal: async () => ({ userId: active, csrfVerified: true }) });
    const send = (user: string, method: string, url: string, payload?: unknown) => {
      active = user;
      return app.inject({ method: method as never, url, headers: { origin: 'http://bondbuddy.test' }, payload: payload as never });
    };
    try {
      for (const id of [owner, foreign])
        await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, id.replaceAll('-', '_')]);
      const createProject = async (user: string) => {
        const response = await send(user, 'POST', '/api/v1/projects',
          { name: 'Synthetic message workspace', kind: 'review', issuer_name: null, market: null, offering: null });
        assert.equal(response.statusCode, 201, response.body);
        return response.json().project_id as string;
      };
      const projectId = await createProject(owner);
      const otherProject = await createProject(owner);
      const replayProject = await createProject(owner);
      const foreignProject = await createProject(foreign);
      const path = `/api/v1/projects/${projectId}/messages`;
      const first = { message_id: 'message-z', submission_request_id: 'req-z1',
        expected_message_version: null, body: 'Synthetic submitted credit 50', material_versions: [] };
      const second = { message_id: 'message-a', submission_request_id: 'req-a1',
        expected_message_version: null, body: 'Synthetic as of June', material_versions: [] };
      const saved1 = await send(owner, 'POST', path, first);
      assert.equal(saved1.statusCode, 201, saved1.body);
      assert.equal(saved1.headers['cache-control'], 'no-store');
      assert.equal(saved1.json().source_status, 'user_asserted');
      assert.equal(saved1.json().route, 'save_only');
      assert.equal(saved1.json().intent_status, 'not_classified');
      const saved2 = await send(owner, 'POST', path, second);
      assert.equal(saved2.statusCode, 201, saved2.body);
      assert.equal((await send(owner, 'POST', path, first)).json().submission_id, saved1.json().submission_id);
      assert.equal((await send(owner, 'POST', path, { ...first, body: 'Synthetic changed retry' })).statusCode, 409);
      assert.equal((await send(owner, 'POST', path, { ...first, submission_request_id: 'different-key' })).statusCode, 409);
      assert.equal((await send(owner, 'POST', path, { ...first, message_id: 'message-new', submission_request_id: 'new-key', material_versions: [
        { material_id: 'foreign-material', material_version: 1 },
      ] })).statusCode, 404);
      assert.equal((await send(foreign, 'POST', path, first)).statusCode, 404);
      assert.equal((await send(foreign, 'GET', path)).statusCode, 404);
      assert.equal((await send(owner, 'GET', `/api/v1/projects/${otherProject}/messages`)).json().items.length, 0);
      assert.equal((await send(owner, 'GET', `/api/v1/projects/${foreignProject}/messages`)).statusCode, 404);
      const page1 = await send(owner, 'GET', `${path}?limit=1`);
      assert.equal(page1.statusCode, 200, page1.body);
      assert.equal(page1.headers['cache-control'], 'no-store');
      assert.deepEqual(page1.json().items.map((item: { message_id: string }) => item.message_id), ['message-z']);
      const page2 = await send(owner, 'GET', `${path}?limit=1&cursor=${page1.json().next_cursor}`);
      assert.deepEqual(page2.json().items.map((item: { message_id: string }) => item.message_id), ['message-a']);
      assert.equal(page2.json().next_cursor, null);
      assert.deepEqual(page2.json().project_message_set_ref.message_ids, ['message-a', 'message-z']);
      assert.equal((await send(owner, 'GET', `${path}?cursor=bad`)).statusCode, 422);
      assert.equal((await send(owner, 'GET', `${path}?limit=51`)).statusCode, 422);
      const badVersion = await send(owner, 'POST', path, { ...first, submission_request_id: 'req-z2', expected_message_version: null });
      assert.equal(badVersion.statusCode, 409);
      const edit = await send(owner, 'POST', path,
        { ...first, body: 'Synthetic corrected credit 40', submission_request_id: 'req-z2', expected_message_version: 1 });
      assert.equal(edit.statusCode, 201, edit.body);
      assert.equal(edit.json().revises_submission_id, saved1.json().submission_id);
      assert.equal(edit.json().message_version, 2);
      assert.equal(edit.json().project_message_set_ref.version, saved2.json().project_message_set_ref.version + 1);
      assert.notEqual(edit.json().project_message_set_ref.content_sha256, saved2.json().project_message_set_ref.content_sha256);
      assert.equal((await send(owner, 'POST', path, { ...first, body: 'Other edit', submission_request_id: 'req-z3', expected_message_version: 1 })).statusCode, 409);
      const stalePage = await send(owner, 'GET', `${path}?limit=1&cursor=${page1.json().next_cursor}`);
      assert.equal(stalePage.statusCode, 409, stalePage.body);
      const refreshed = await send(owner, 'GET', path);
      assert.equal(refreshed.statusCode, 200, refreshed.body);
      assert.deepEqual(refreshed.json().items.map((item: { body: string }) => item.body),
        ['Synthetic corrected credit 40', 'Synthetic as of June']);
      assert.equal(refreshed.json().items[0].revises_submission_id, saved1.json().submission_id);
      const original = await send(owner, 'GET', `${path}/message-z/versions/1`);
      assert.equal(original.statusCode, 200, original.body);
      assert.equal(original.json().body, first.body);
      assert.equal(original.json().revises_submission_id, null);
      assert.equal((await send(foreign, 'GET', `${path}/message-z/versions/1`)).statusCode, 404);
      assert.equal((await send(owner, 'GET', `${path}/message-z/versions/3`)).statusCode, 404);
      assert.equal((await send(owner, 'GET', `${path}/message-z/versions/0`)).statusCode, 422);
      assert.equal((await send(owner, 'POST', path, first)).json().is_current, false);
      const pin = await loadCurrentProjectMessageSetPin(pool, { ownerUserId: owner, projectId });
      assert.deepEqual(projectMessageSetRef(pin), refreshed.json().project_message_set_ref);
      const lockRequest = { draft_revision: 1, material_versions: [], requirement_message_ids: [],
        project_message_set_ref: saved2.json().project_message_set_ref };
      assert.equal((await send(owner, 'POST', `/api/v1/projects/${projectId}/input-revisions`, lockRequest)).statusCode, 409,
        'previous set ref is stale after an edit');
      assert.equal((await send(owner, 'POST', `/api/v1/projects/${projectId}/input-revisions`,
        { ...lockRequest, project_message_set_ref: refreshed.json().project_message_set_ref,
          requirement_message_ids: ['message-a', 'message-z'] })).statusCode, 201);
      const locked = (await pool.query('SELECT manifest,requirement_message_ids FROM bb_input_revisions WHERE project_id=$1 AND revision=1',
        [projectId])).rows[0];
      assert.deepEqual(locked.manifest.project_message_set_ref, refreshed.json().project_message_set_ref);
      assert.deepEqual(locked.requirement_message_ids, ['message-a', 'message-z']);
      const secretInput = { message_id: 'message-secret', submission_request_id: 'req-secret',
        expected_message_version: null, body: 'Synthetic body\npassword=SYN_PRIVATE_VALUE', material_versions: [] };
      assert.equal((await send(owner, 'POST', path, secretInput)).statusCode, 201);
      const safeHistory = await send(owner, 'GET', path);
      assert.equal(safeHistory.statusCode, 200, safeHistory.body);
      assert.ok(!safeHistory.body.includes('SYN_PRIVATE_VALUE'));
      assert.ok(safeHistory.body.includes('password=[REDACTED]'));
      assert.deepEqual(locked.manifest.project_message_set_ref, refreshed.json().project_message_set_ref,
        'a later save leaves previously locked input unchanged');
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM bb_runs WHERE project_id=$1', [projectId])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM bb_log_access_audit WHERE actor_id=$1 AND purpose='project_message_view'",
        [owner])).rows[0].n >= 3, true);
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='project_message.saved'",
        [owner])).rows[0].n, 4, 'replay never emits another saved event');
      const messages = (await pool.query("SELECT * FROM bb_user_submission_versions WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message' ORDER BY version",
        [owner, projectId])).rows;
      assert.deepEqual(messages.map(m => m.message_version), [1, 1, 2, 1]);
      assert.equal(messages[2].revises_submission_id, messages[0].id);
      assert.equal(messages[2].content_sha256.trim(), digest('Synthetic corrected credit 40'));
      const editedSnapshot = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [messages[2].snapshot_id])).rows[0].object_key;
      storage.delete(editedSnapshot);
      assert.equal((await send(owner, 'GET', path)).statusCode, 503, 'missing private bytes cannot be a successful partial history');
      const firstSnapshot = (await pool.query('SELECT object_key FROM bb_snapshot_refs WHERE id=$1', [messages[0].snapshot_id])).rows[0].object_key;
      await pool.query(`INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version)
        VALUES($1,$2,'prompt_snapshot',$3,$4,'retention_expired','synthetic-v1')`,
      [uid(), owner, messages[0].snapshot_id, firstSnapshot]);
      assert.equal((await send(owner, 'GET', `${path}/message-z/versions/1`)).statusCode, 503,
        'retained metadata cannot bypass a purged prompt body');
      const replayPath = `/api/v1/projects/${replayProject}/messages`;
      const simultaneous = await Promise.all([send(owner, 'POST', replayPath, first), send(owner, 'POST', replayPath, first)]);
      assert.deepEqual(simultaneous.map(result => result.statusCode), [201, 201]);
      assert.equal(simultaneous[0].json().submission_id, simultaneous[1].json().submission_id);
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM bb_user_submission_versions
        WHERE owner_user_id=$1 AND project_id=$2 AND submission_kind='project_message'`,
      [owner, replayProject])).rows[0].n, 1, 'concurrent retries insert only one immutable version');
      const malformedSnapshot = uid();
      await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,snapshot_kind,version,object_key,content_sha256,redaction_version)
        VALUES($1,$2,$3,'user_prompt',1,$4,$5,'scrub_v1')`,
      [malformedSnapshot, owner, otherProject,
        `users/${owner}/projects/${otherProject}/snapshots/${malformedSnapshot}`, digest('synthetic-orphan')]);
      await pool.query(`INSERT INTO bb_user_submission_versions(id,owner_user_id,project_id,snapshot_id,submission_kind,
        message_id,submission_request_id,message_version,version,content_sha256)
        VALUES($1,$2,$3,$4,'project_message','orphan-message','orphan-key',2,1,$5)`,
      [uid(), owner, otherProject, malformedSnapshot, digest('synthetic-orphan')]);
      assert.equal((await send(owner, 'GET', `/api/v1/projects/${otherProject}/messages`)).statusCode, 503,
        'malformed nonempty history is never returned as an empty set');
      assert.equal((await send(owner, 'POST', `/api/v1/projects/${otherProject}/input-revisions`,
        { draft_revision: 1, material_versions: [], requirement_message_ids: [] })).statusCode, 503,
        'input-lock rejects a malformed nonempty history');
      assert.equal((await send(owner, 'POST', `/api/v1/projects/${otherProject}/messages`,
        { ...first, submission_request_id: 'orphan-new' })).statusCode, 503,
        'new saves cannot silently append to a malformed chain');
    } finally { await app.close(); await pool.end(); }
  });
