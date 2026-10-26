import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { digest, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase();
const origin = 'http://bondbuddy.test';
const word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sha = 'a'.repeat(64);

test('#34 PG16 project Word history: complete pairs, stable pages, isolation and failure boundaries',
  { skip: !connection && 'BB_TEST_DATABASE_URL not set; PG16 integration not run' }, async () => {
    const pool = new Pool({ connectionString: connection });
    const bytes = makeSyntheticDocxFixture();
    const contents = new Map<string, Buffer>();
    let blobReads = 0;
    const blobs: PrivateBlobs = {
      put: async (key, data) => { contents.set(key, data); },
      get: async key => { const data = contents.get(key); if (!data) throw new Error('Blob missing'); return data; },
      getIfExists: async key => contents.get(key) ?? null,
      getIfExistsBounded: async (key, max) => { blobReads++; const data = contents.get(key); return data && data.length <= max ? data : null; },
      exists: async key => contents.has(key),
      delete: async key => { contents.delete(key); },
    };
    let owner = `history-${randomUUID()}`;
    const firstOwner = owner;
    const otherOwner = `history-${randomUUID()}`;
    const firstProject = randomUUID();
    const otherProject = randomUUID();
    const emptyProject = randomUUID();
    const previousTier = process.env.BB_DEPLOYMENT_TIER;
    const previousSwitch = process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
    process.env.BB_DEPLOYMENT_TIER = 'preprod';
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
    const app = createServer({ pool, blobs, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
    const read = (url: string) => app.inject({ method: 'GET', url });
    const url = (projectId = firstProject) => `/api/v1/projects/${projectId}/artifacts`;
    const countGrants = async () => Number((await pool.query('SELECT count(*) AS n FROM bb_artifact_download_grants')).rows[0].n);
    async function makeProject(projectId: string, user = firstOwner) {
      await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic project','update')", [projectId, user]);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,1,$2,1,$3,'{}','[]','[]')`, [projectId, user, sha]);
    }
    async function makeRun(projectId: string, options: {
      user?: string; time: string; state?: 'succeeded' | 'test_completed' | 'failed' | 'paused';
      bundle?: boolean; testGrantId?: string; role?: 'update' | 'review';
    }) {
      const user = options.user ?? firstOwner;
      const id = randomUUID(), primary = randomUUID(), clean = randomUUID(), baseline = randomUUID();
      const state = options.state ?? 'succeeded';
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,channel,test_grant_id)
        VALUES($1,$2,$3,1,$4,$5,$6,$4,'running',$7,$8)`,
        [id, user, projectId, sha, randomUUID(), options.role ?? 'update', options.testGrantId ? 'non_production_test' : 'production', options.testGrantId ?? null]);
      const checkpoint = options.bundle ? { stages: { word_delivery_pair: {
        revision_artifact_id: primary, clean_artifact_id: clean, baseline_artifact_id: baseline,
      } } } : {};
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint,channel,test_grant_id)
        VALUES($1,$2,$3,$4,'default','running','running',$5,$6,$7)`,
        [randomUUID(), user, id, options.role ?? 'update', checkpoint,
          options.testGrantId ? 'non_production_test' : 'production', options.testGrantId ?? null]);
      async function artifact(artifactId: string) {
        const key = `synthetic/history/${artifactId}`, evidenceId = randomUUID(), hash = digest(bytes);
        contents.set(key, bytes);
        await pool.query(`INSERT INTO bb_word_delivery_evidence
          (id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,
           quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence,created_at)
          VALUES($1,$2,$3,$4,1,$5,$6,'synthetic-validator','passed','available','readback_verified',$5,$6,$7,$8)`,
          [evidenceId, user, id, artifactId, hash, bytes.length,
            { sha256: hash, byte_size: bytes.length, validator_version: 'synthetic-validator', quality_status: 'passed' }, options.time]);
        await pool.query(`INSERT INTO bb_artifact_versions
          (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id,created_at)
          VALUES($1,1,$2,$3,$4,$5,$6,'passed',$7,$8,$9)`,
          [artifactId, user, id, word, hash, key, options.testGrantId ? 'test_only' : 'available', evidenceId, options.time]);
        return key;
      }
      const primaryKey = state === 'succeeded' || state === 'test_completed' ? await artifact(primary) : null;
      if (options.bundle) { await artifact(clean); await artifact(baseline); }
      await pool.query('UPDATE bb_jobs SET state=$2,stage=$2,lease_token=NULL,lease_until=NULL WHERE run_id=$1',[id,state]);
      await pool.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload,occurred_at)
        VALUES($1,$2,$3,1,$3,'run.state_changed',$4,$4,'{}',$5)`,[randomUUID(),user,id,state,options.time]);
      await pool.query(`UPDATE bb_runs SET state=$2,stage=$2,event_cursor=1,updated_at=$3,artifact_id=$4,artifact_version=$5 WHERE id=$1`,
        [id, state, options.time, primaryKey ? primary : null, primaryKey ? 1 : null]);
      return { id, primary, clean, baseline, primaryKey };
    }
    try {
      const pgVersion = Number((await pool.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
      assert.ok(pgVersion >= 160000 && pgVersion < 170000, 'integration requires real PostgreSQL 16');
      await makeProject(firstProject);
      await makeProject(otherProject);
      await makeProject(emptyProject);
      const empty = await read(url(emptyProject));
      assert.equal(empty.statusCode, 200, empty.body);
      assert.deepEqual(empty.json(), { items: [], page: { has_more: false, next_cursor: null } });
      const early = await makeRun(firstProject, { time: '2026-09-26T12:00:00.000001Z' });
      const middle = await makeRun(firstProject, { time: '2026-09-27T12:00:00.000001Z', bundle: true });
      const latest = await makeRun(firstProject, { time: '2026-09-27T12:00:00.000001Z', bundle: true });
      await makeRun(firstProject, { time: '2026-09-28T12:00:00.000001Z', state: 'failed' });
      await makeRun(firstProject, { time: '2026-09-28T13:00:00.000001Z', state: 'paused' });
      await makeRun(firstProject, { time: '2026-09-28T14:00:00.000001Z', role: 'review' });
      const otherProjectResult = await makeRun(otherProject, { time: '2026-09-29T12:00:00.000001Z', bundle: true });
      const mixedRun = await makeRun(firstProject, { time: '2026-09-25T12:00:00.000001Z', bundle: true });
      await pool.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,
        '{stages,word_delivery_pair,baseline_artifact_id}',to_jsonb($2::text)) WHERE run_id=$1`,
        [mixedRun.id, otherProjectResult.baseline]);
      assert.ok((await read(url())).json().items.some((item: { run_id: string }) => item.run_id === mixedRun.id),
        'a later mutable job pair cannot replace the exact pair already delivered');
      await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [mixedRun.primary]);
      const olderFirst = [middle, latest].sort((a, b) => b.id.localeCompare(a.id));
      const first = await read(`${url()}?limit=1`);
      assert.equal(first.statusCode, 200, first.body);
      assert.match(String(first.headers['cache-control']), /no-store/);
      assert.deepEqual(first.json().items.map((item: { run_id: string }) => item.run_id), [olderFirst[0].id]);
      assert.equal(first.json().items[0].word_delivery.revision.artifact_id, olderFirst[0].primary);
      assert.equal(first.json().items[0].word_delivery.clean.artifact_id, olderFirst[0].clean);
      assert.equal(first.json().items[0].word_delivery.baseline.artifact_id, olderFirst[0].baseline);
      assert.deepEqual(Object.keys(first.json().items[0]).sort(),
        ['channel', 'completed_at', 'input_revision', 'primary_artifact', 'run_id', 'state', 'word_delivery']);
      const cursor = first.json().page.next_cursor as string;
      assert.ok(cursor);
      for (const indexes of [[4], [4, 7]]) {
        const overflow = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        for (const index of indexes) overflow[index] = 2147483648;
        const rejected = await read(`${url()}?cursor=${Buffer.from(JSON.stringify(overflow)).toString('base64url')}`);
        assert.equal(rejected.statusCode, 422, 'cursor execution must fit the persisted PostgreSQL integer');
      }
      const newSuccess = await makeRun(firstProject, { time: '2026-09-29T12:00:00.000001Z', bundle: true });
      const version2Evidence = randomUUID(), version2Key = `synthetic/history/${randomUUID()}`;
      await pool.query(`INSERT INTO bb_word_delivery_evidence
        (id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,
         quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
        SELECT $2,owner_user_id,run_id,artifact_id,2,candidate_sha256,byte_size,validator_version,
          quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence
        FROM bb_word_delivery_evidence WHERE artifact_id=$1`, [newSuccess.clean, version2Evidence]);
      await pool.query(`INSERT INTO bb_artifact_versions
        (id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
        SELECT id,2,owner_user_id,run_id,media_type,sha256,$2,quality_status,delivery_status,$3
        FROM bb_artifact_versions WHERE id=$1 AND version=1`, [newSuccess.clean, version2Key, version2Evidence]);
      contents.set(version2Key, bytes);
      await pool.query("UPDATE bb_runs SET updated_at=now()+interval '1 day' WHERE id=$1",[olderFirst[1].id]);
      const second = await read(`${url()}?limit=1&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(second.statusCode, 200, second.body);
      assert.deepEqual(second.json().items.map((item: { run_id: string }) => item.run_id), [olderFirst[1].id]);
      const third = await read(`${url()}?limit=1&cursor=${encodeURIComponent(second.json().page.next_cursor)}`);
      assert.equal(third.statusCode, 200, third.body);
      assert.deepEqual(third.json().items.map((item: { run_id: string }) => item.run_id), [early.id]);
      assert.equal(third.json().items[0].word_delivery, null, 'single Word result does not claim a revision/baseline pair');
      assert.deepEqual(third.json().page, { has_more: false, next_cursor: null });
      assert.ok(!(await read(url())).json().items.some((item: { run_id: string }) => item.run_id === mixedRun.id),
        'revocation remains live even when the captured delivery pair is immutable');
      assert.equal((await read(url())).json().items[0].run_id, newSuccess.id, 'fresh list sees newer success');
      assert.equal((await read(url())).json().items[0].word_delivery.clean.version, 1,
        'an artifact registered after completion cannot replace the exact delivered clean copy');

      assert.equal((await read(url())).json().items.length, 4, 'only successful update runs are listed');
      assert.equal(await countGrants(), 0, 'history reads do not mint download grants');
      const direct = await read(`/api/v1/artifacts/${early.primary}`);
      assert.equal(direct.statusCode, 200, direct.body);
      assert.equal(await countGrants(), 1, 'direct checked artifact read still creates the short-lived grant');

      await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [middle.clean]);
      assert.ok(!(await read(url())).json().items.some((item: { run_id: string }) => item.run_id === middle.id),
        'revoked sibling excludes the entire bundle');
      await pool.query("UPDATE bb_artifact_versions SET quality_status='failed',delivery_status='revoked',word_delivery_evidence_id=NULL WHERE id=$1", [latest.baseline]);
      assert.ok(!(await read(url())).json().items.some((item: { run_id: string }) => item.run_id === latest.id),
        'failed quality sibling excludes the entire bundle');
      await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1", [early.primary]);
      assert.deepEqual((await read(url())).json().items.map((item: { run_id: string }) => item.run_id), [newSuccess.id],
        'revoked primary cannot appear as a historical success');
      contents.set(newSuccess.primaryKey!, Buffer.from('synthetic corrupted Word bytes'));
      const damaged = await read(url());
      assert.equal(damaged.statusCode, 503, damaged.body);
      assert.equal(damaged.json().code, 'DATA_UNAVAILABLE');
      assert.equal(await countGrants(), 1, 'failed read created no grant');
      contents.set(newSuccess.primaryKey!, bytes);
      assert.equal((await read(url())).statusCode, 200);
      const publishedCleanKey = `synthetic/history/${newSuccess.clean}`;
      contents.delete(publishedCleanKey);
      const missingSibling = await read(url());
      assert.equal(missingSibling.statusCode, 503, missingSibling.body);
      assert.equal(missingSibling.json().code, 'DATA_UNAVAILABLE', 'a missing clean file cannot be advertised in a complete bundle');
      contents.set(publishedCleanKey, bytes);

      for (const suffix of ['?cursor=bogus', '?limit=51', '?limit=0', '?extra=1']) {
        const invalid = await read(`${url()}${suffix}`);
        assert.equal(invalid.statusCode, 422, suffix);
      }
      const wrongProjectCursor = await read(`${url(otherProject)}?cursor=${encodeURIComponent(cursor)}`);
      assert.equal(wrongProjectCursor.statusCode, 422);
      owner = otherOwner;
      for (const target of [url(), `${url()}?cursor=bogus`]) {
        const foreign = await read(target);
        assert.equal(foreign.statusCode, 404, foreign.body);
      }
      owner = firstOwner;
      await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1', [otherProject]);
      assert.equal((await read(url(otherProject))).statusCode, 404);

      const grantId = randomUUID();
      await pool.query(`INSERT INTO bb_non_production_test_grants
        (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
        VALUES($1,$2,$3,1,$4,$4,$4,$4,'synthetic-operator','synthetic-history-test',now()+interval '1 day')`,
        [grantId, firstOwner, firstProject, sha]);
      const testRun = await makeRun(firstProject, { time: '2026-09-29T13:00:00.000001Z', state: 'test_completed', bundle: true, testGrantId: grantId });
      assert.equal((await read(url())).json().items[0].run_id, testRun.id);
      process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'disabled';
      assert.ok(!(await read(url())).json().items.some((item: { run_id: string }) => item.run_id === testRun.id));
      process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
      await pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic-operator',revoked_reason='synthetic-revoke'
        WHERE grant_id=$1`, [grantId]);
      assert.ok(!(await read(url())).json().items.some((item: { run_id: string }) => item.run_id === testRun.id));

      const checked = await read('/api/v1/artifacts/'+newSuccess.primary);
      assert.equal(checked.statusCode,200,checked.body);
      const downloadUrl = checked.json().download_url;
      const downloaded = await read(downloadUrl);
      assert.equal(downloaded.statusCode,200,downloaded.body);
      assert.deepEqual(downloaded.rawPayload,bytes);
      const grantCount = await countGrants(), readsBefore = blobReads;
      await assert.rejects(pool.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1',[newSuccess.primary]),{code:'23514'});
      // Explicitly simulate missing provenance only in this disposable clone.
      const corrupt = await pool.connect();
      try {
        await corrupt.query('BEGIN');
        await corrupt.query('ALTER TABLE bb_run_execution_delivery_artifacts DROP CONSTRAINT bb_execution_delivery_member_origin');
        await corrupt.query('ALTER TABLE bb_artifact_execution_bindings DISABLE TRIGGER bb_artifact_execution_immutable');
        await corrupt.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1',[newSuccess.primary]);
        await corrupt.query('ALTER TABLE bb_artifact_execution_bindings ENABLE TRIGGER bb_artifact_execution_immutable');
        await corrupt.query('COMMIT');
      } catch(error) { await corrupt.query('ROLLBACK'); throw error; }
      finally { corrupt.release(); }
      assert.equal((await read('/api/v1/artifacts/'+newSuccess.primary)).statusCode,404,'no grant from an unbound artifact');
      assert.equal((await read(downloadUrl)).statusCode,404,'an existing grant cannot bypass missing provenance');
      assert.ok(!(await read(url())).json().items.some((item:{run_id:string})=>item.run_id===newSuccess.id),'history cannot borrow an unbound primary');
      assert.equal(blobReads,readsBefore,'missing provenance fails before private bytes are read');
      assert.equal(await countGrants(),grantCount,'no new grants are minted');
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE id=$1',[newSuccess.primary])).rows[0].n,1,'the legacy artifact remains, without fallback');
    } finally {
      await app.close();
      await pool.end();
      if (previousTier === undefined) delete process.env.BB_DEPLOYMENT_TIER;
      else process.env.BB_DEPLOYMENT_TIER = previousTier;
      if (previousSwitch === undefined) delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
      else process.env.BB_NON_PRODUCTION_TEST_CHANNEL = previousSwitch;
    }
  });
