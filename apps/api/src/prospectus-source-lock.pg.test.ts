// SYNTHETIC metadata only; real API/PostgreSQL input locks, with no Blob or provider access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, type SourceProspectus } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'prospectus-source-lock');
const origin = 'http://bondbuddy.test';
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function fixture() {
  const pool = new Pool({ connectionString: connection }), owner = `synthetic-source-lock-${randomUUID()}`;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
  const close = async () => { await app.close(); await pool.end(); };
  const send = (method: string, url: string, payload?: unknown, revision?: number) => app.inject({ method: method as any, url,
    headers: { origin, ...(revision ? { 'if-match': String(revision) } : {}) }, payload: payload as any });
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic adopted source lock', kind: 'update',
      issuer_name: 'Synthetic source issuer', market: null, offering: null,
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' } });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project_id, base = `/api/v1/projects/${projectId}`;
    const materialId = `z-synthetic-source-${randomUUID()}`;
    const addMaterial = async (id: string, version: number, role: 'historical' | 'financial', sha256: string) => {
      const uploadId = randomUUID(), media = role === 'historical' ? docx : 'text/plain';
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,
        expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'synthetic-source-lock',$4,10,$5,$6,$7,now()+interval '1 hour','completed',$5,10)`,
      [uploadId, owner, projectId, media, sha256, role, `synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,$2,$3,$4,$5,$6,'synthetic-source-lock',$7,10,$8,$9,'persisted')`,
      [id, version, owner, projectId, uploadId, role, media, sha256, `synthetic/${id}/${version}`]);
      return { material_id: id, material_version: version, sha256 };
    };
    const older = await addMaterial(materialId, 1, 'historical', 'a'.repeat(64));
    const source = await addMaterial(materialId, 2, 'historical', 'b'.repeat(64));
    const supporting = await addMaterial(`a-synthetic-financial-${randomUUID()}`, 1, 'financial', 'c'.repeat(64));
    const versionId = randomUUID();
    await pool.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version)
      VALUES($1,$2,$3,1,'upload','synthetic-original.docx',$4,$5,$6)`,
    [versionId, owner, projectId, source.sha256, source.material_id, source.material_version]);
    // Adopt the registered metadata through the actual API; selecting an upload reads no Blob bytes.
    const adopted = await send('POST', `${base}/prospectus-versions/current`,
      { request_id: randomUUID(), expected_selection_revision: 0, version_id: versionId });
    assert.equal(adopted.statusCode, 200, adopted.body);
    assert.equal(adopted.json().current_version_id, versionId);
    const selectionRevision: number = adopted.json().selection_revision;
    assert.equal(selectionRevision, 1);
    const current = await send('GET', base);
    assert.equal(current.statusCode, 200, current.body);
    const declaration: SourceProspectus = { ...source, issuer_name: 'Synthetic source issuer', relation: 'same_issuer',
      market: 'sse', offering: 'private', reporting_periods: [{ start: '2024-01-01', end: '2024-12-31', period_kind: 'annual',
        scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }], status: 'user_asserted' };
    const saved = await send('PATCH', base,
      { update_details: { ...current.json().update_details, source_prospectuses: [declaration] } }, current.json().draft_revision);
    assert.equal(saved.statusCode, 200, saved.body);
    const ref = ({ material_id, material_version }: typeof source) => ({ material_id, material_version });
    const materials = [ref(supporting), ref(source)];
    const lock = (selected = materials, selection = selectionRevision) => send('POST', `${base}/input-revisions`,
      { draft_revision: saved.json().draft_revision, prospectus_selection_revision: selection,
        material_versions: selected, requirement_message_ids: [] });
    const assertNoInput = async () => {
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1', [projectId])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT latest_input_revision FROM bb_projects WHERE id=$1', [projectId])).rows[0].latest_input_revision,
        saved.json().input_revision);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='project.input_locked'", [projectId])).rows[0].n, 0);
    };
    return { pool, close, projectId, versionId, selectionRevision, source, older, supporting, declaration, ref, lock, assertNoInput };
  } catch (error) { await close(); throw error; }
}

test('an adopted original cannot be omitted or replaced by another material version when locking input', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    for (const selected of [[], [f.ref(f.supporting)], [f.ref(f.supporting), f.ref(f.older)]]) {
      const rejected = await f.lock(selected);
      assert.equal(rejected.statusCode, 409, rejected.body);
      assert.equal(rejected.json().code, 'INPUT_REVISION_CONFLICT');
      assert.match(rejected.json().message, /请包含当前募集书版本/);
      await f.assertNoInput();
    }
  } finally { await f.close(); }
});

test('a valid adopted-source request locks its exact version, SHA and DOCX format baseline', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    const locked = await f.lock();
    assert.equal(locked.statusCode, 201, locked.body);
    const input = (await f.pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [f.projectId, locked.json().input_revision])).rows[0];
    assert.equal(String(input.input_hash).trim(), locked.json().input_hash);
    assert.deepEqual(input.manifest.materials.find((m: { material_id: string }) => m.material_id === f.source.material_id),
      { ...f.source, role: 'historical' });
    assert.deepEqual(input.manifest.authoring.source_prospectuses, [f.declaration]);
    assert.deepEqual(input.manifest.authoring.format_policy, { version: 'source-format-v1', mode: 'preserve_docx',
      template: { kind: 'material', ...f.source }, selection: 'automatic' });
    assert.deepEqual(input.manifest.prospectus_selection, { revision: f.selectionRevision, version_id: f.versionId });
    assert.equal(input.manifest.authoring.previous_output, undefined);
    assert.notEqual(input.manifest.authoring.format_policy.template.sha256, f.older.sha256);
  } finally { await f.close(); }
});

test('a stale prospectus selection is rejected without creating an input revision', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    const rejected = await f.lock(undefined, f.selectionRevision - 1);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().code, 'INPUT_REVISION_CONFLICT');
    assert.match(rejected.json().message, /当前募集书已变化/);
    await f.assertNoInput();
  } finally { await f.close(); }
});
