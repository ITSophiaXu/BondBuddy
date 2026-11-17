// SYNTHETIC metadata only; real API/PostgreSQL input locks, with no Blob or provider access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, type SourceProspectus } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { lockProspectusEditBase } from './unified-authoring.js';
import { digest } from './data.js';

const connection = await isolatedTestDatabase(undefined, 'prospectus-source-lock');
const origin = 'http://bondbuddy.test';
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('an adopted generated clean result defaults exactly, rejects null, and preserves explicit result verification', () => {
  const current = { artifact_id: 'adopted-clean', artifact_version: 3, sha256: 'e'.repeat(64) };
  const selected = { ...current };
  assert.deepEqual(lockProspectusEditBase(current, undefined), selected);
  assert.deepEqual(lockProspectusEditBase(current, selected), selected);
  assert.throws(() => lockProspectusEditBase(current, null),
    (error: any) => error.status === 409 && error.code === 'INPUT_REVISION_CONFLICT' && /默认基线/.test(error.message));
  for (const requested of [{ ...selected, artifact_id: 'other-clean' }, { ...selected, artifact_version: 2 },
    { ...selected, sha256: 'f'.repeat(64) }])
    assert.deepEqual(lockProspectusEditBase(current, requested), requested, 'exact explicit result pin reaches existing owner/quality/source validation');
  assert.equal(lockProspectusEditBase(undefined, undefined), undefined, 'no selected manuscript retains legacy default behavior');
  assert.equal(lockProspectusEditBase(undefined, null), null);
  assert.deepEqual(lockProspectusEditBase(undefined, selected), selected);
  assert.equal(lockProspectusEditBase({ artifact_id: null, artifact_version: null, sha256: 'a'.repeat(64) }, undefined), null,
    'an adopted uploaded manuscript does not silently reuse an old clean result');
  const locked = lockProspectusEditBase(current, undefined);
  current.sha256 = 'f'.repeat(64);
  assert.equal(locked?.sha256, 'e'.repeat(64), 'later mutable input cannot change the selected artifact pin');
});

async function fixture(sourceMedia = docx, kind: 'update' | 'generation' = 'update') {
  const pool = new Pool({ connectionString: connection }), owner = `synthetic-source-lock-${randomUUID()}`;
  const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
  const close = async () => { await app.close(); await pool.end(); };
  const send = (method: string, url: string, payload?: unknown, revision?: number) => app.inject({ method: method as any, url,
    headers: { origin, ...(revision ? { 'if-match': String(revision) } : {}) }, payload: payload as any });
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic adopted source lock', kind,
      issuer_name: 'Synthetic source issuer', market: null, offering: null,
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' } });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json().project_id, base = `/api/v1/projects/${projectId}`;
    const materialId = `z-synthetic-source-${randomUUID()}`;
    const addMaterial = async (id: string, version: number, role: 'historical' | 'reference' | 'financial' | 'audit', sha256: string,
      media = ['financial','audit'].includes(role) ? 'text/plain' : docx) => {
      const uploadId = randomUUID();
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
    const source = await addMaterial(materialId, 2, 'historical', 'b'.repeat(64), sourceMedia);
    const supporting = await addMaterial(`a-synthetic-financial-${randomUUID()}`, 1, 'audit', 'c'.repeat(64));
    const versionId = randomUUID();
    await pool.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version)
      VALUES($1,$2,$3,1,'upload',$7,$4,$5,$6)`,
    [versionId, owner, projectId, source.sha256, source.material_id, source.material_version,
      sourceMedia === docx ? 'synthetic-original.docx' : 'synthetic-original.pdf']);
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
    return { pool, close, owner, projectId, versionId, selectionRevision, source, older, supporting, declaration, ref, lock, assertNoInput,
      addMaterial, send, base, saved };
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

test('an adopted authoring DOCX or PDF remains the input baseline beside an earlier ordinary reference DOCX', { skip: !connection }, async () => {
  for (const { kind, media } of [{ kind: 'update' as const, media: docx }, { kind: 'update' as const, media: 'application/pdf' },
    { kind: 'generation' as const, media: docx }]) {
    const f = await fixture(media, kind);
    try {
      // Normal reference-material uploads persist a material without a prospectus-version row.
      const reference = await f.addMaterial(`ordinary-reference-${randomUUID()}`, 1, 'reference', 'd'.repeat(64));
      assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_prospectus_versions WHERE project_id=$1 AND material_id=$2',
        [f.projectId, reference.material_id])).rows[0].n, 0);
      const saved = await f.send('PATCH', f.base, { update_details: { ...f.saved.json().update_details, format_template: null,
        source_prospectuses: [f.declaration, { ...f.declaration, ...reference }] } }, f.saved.json().draft_revision);
      assert.equal(saved.statusCode, 200, saved.body);
      const selected = [f.ref(reference), f.ref(f.source), f.ref(f.supporting)];
      const locked = await f.send('POST', `${f.base}/input-revisions`, { draft_revision: saved.json().draft_revision,
        prospectus_selection_revision: f.selectionRevision, material_versions: selected, requirement_message_ids: [] });
      assert.equal(locked.statusCode, 201, locked.body);
      const input = (await f.pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [f.projectId, locked.json().input_revision])).rows[0].manifest;
      assert.deepEqual(input.authoring.format_policy, { version: 'source-format-v1', mode: media === docx ? 'preserve_docx' : 'reconstruct_pdf',
        template: { kind: 'material', ...f.source }, selection: 'automatic' });
      assert.ok(input.materials.some((pin: any) => pin.material_id === reference.material_id && pin.role === 'reference'), 'reference evidence remains selected');
      assert.deepEqual(input.prospectus_selection, { revision: f.selectionRevision, version_id: f.versionId });
      // A later draft template edit must not rewrite a previously locked manuscript.
      const before = structuredClone(input);
      const changed = await f.send('PATCH', f.base, { update_details: { ...saved.json().update_details, format_template: reference } }, saved.json().draft_revision);
      assert.equal(changed.statusCode, 200, changed.body);
      const oldInput = (await f.pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [f.projectId, locked.json().input_revision])).rows[0].manifest;
      assert.deepEqual(oldInput, before);
    } finally { await f.close(); }
  }
});

test('a conflicting explicit reference format creates no input until the old format choice is cleared', { skip: !connection }, async () => {
  const f = await fixture();
  try {
    const reference = await f.addMaterial(`ordinary-reference-${randomUUID()}`, 1, 'reference', 'd'.repeat(64));
    const saved = await f.send('PATCH', f.base, { update_details: { ...f.saved.json().update_details, format_template: reference,
      source_prospectuses: [f.declaration, { ...f.declaration, ...reference }] } }, f.saved.json().draft_revision);
    assert.equal(saved.statusCode, 200, saved.body);
    const payload = { draft_revision: saved.json().draft_revision, prospectus_selection_revision: f.selectionRevision,
      material_versions: [f.ref(reference), f.ref(f.source), f.ref(f.supporting)], requirement_message_ids: [] };
    const rejected = await f.send('POST', `${f.base}/input-revisions`, payload);
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(rejected.json().code, 'INPUT_REVISION_CONFLICT');
    assert.match(rejected.json().message, /清除旧格式选择/);
    await f.assertNoInput();
    const cleared = await f.send('PATCH', f.base, { update_details: { ...saved.json().update_details, format_template: null } }, saved.json().draft_revision);
    assert.equal(cleared.statusCode, 200, cleared.body);
    const locked = await f.send('POST', `${f.base}/input-revisions`, { ...payload, draft_revision: cleared.json().draft_revision });
    assert.equal(locked.statusCode, 201, locked.body);
    const input = (await f.pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
      [f.projectId, locked.json().input_revision])).rows[0].manifest;
    assert.deepEqual(input.authoring.format_policy.template, { kind: 'material', ...f.source });
  } finally { await f.close(); }
});

// Synthetic eligible delivery metadata isolates the real input endpoint's continuation decision.
// It does not claim a generated Word result was produced or validated by this fixture.
async function generatedFixture() {
  const f = await fixture();
  try {
    const initial = await f.lock();
    assert.equal(initial.statusCode, 201, initial.body);
    const original = (await f.pool.query(`SELECT manifest,material_versions,draft_revision FROM bb_input_revisions
      WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3`, [f.owner, f.projectId, initial.json().input_revision])).rows[0];
    const seed = async () => {
      const run = randomUUID(), artifact = randomUUID(), versionId = randomUUID();
      const revision = (await f.pool.query('SELECT coalesce(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',
        [f.owner, f.projectId])).rows[0].n;
      // Use a new immutable synthetic snapshot with the same draft issuer checked by server.ts.
      // The actual initial snapshot remains unchanged, including its pending reviewed identity.
      const manifest = { ...structuredClone(original.manifest), issuer_name: f.saved.json().issuer_name };
      const hash = digest(JSON.stringify(manifest)), sha256 = digest(`synthetic-clean:${artifact}`);
      await f.pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,'[]')`,
      [f.projectId, revision, f.owner, original.draft_revision, hash, manifest, JSON.stringify(original.material_versions)]);
      await f.pool.query('UPDATE bb_projects SET latest_input_revision=$3 WHERE owner_user_id=$1 AND id=$2', [f.owner, f.projectId, revision]);
      await f.pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,artifact_id)
        VALUES($1,$2,$3,$4,$5,$1,'update',$5,'queued',$6)`, [run, f.owner, f.projectId, revision, hash, artifact]);
      await f.pool.query(`INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,
        validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
        VALUES($1,$2,$3,$1,1,$4,10,'synthetic','passed','available','readback_verified',$4,10,$5)`,
      [artifact, f.owner, run, sha256, { sha256, byte_size: 10, validator_version: 'synthetic', quality_status: 'passed' }]);
      await f.pool.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
        VALUES($1,1,$2,$3,$4,$5,$1,'passed','available',$1)`, [artifact, f.owner, run, docx, sha256]);
      await f.pool.query("UPDATE bb_runs SET state='succeeded',artifact_version=1 WHERE owner_user_id=$1 AND id=$2", [f.owner, run]);
      await f.pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,checkpoint)
        VALUES($1,$2,$3,'update','unified_v1','succeeded',$4)`,
      [randomUUID(), f.owner, run, { stages: { word_delivery_pair: { clean_artifact_id: artifact } } }]);
      await f.pool.query(`INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,artifact_id,artifact_version,run_id)
        VALUES($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM bb_prospectus_versions WHERE owner_user_id=$2 AND project_id=$3),
          'generated','synthetic-result.docx',$4,$5,1,$6)`, [versionId, f.owner, f.projectId, sha256, artifact, run]);
      return { pin: { artifact_id: artifact, artifact_version: 1, sha256 }, run, input_revision: revision, versionId };
    };
    const older = await seed(), current = await seed();
    const adopted = await f.send('POST', `${f.base}/prospectus-versions/current`,
      { request_id: randomUUID(), expected_selection_revision: f.selectionRevision, version_id: current.versionId });
    assert.equal(adopted.statusCode, 200, adopted.body);
    const draft = await f.send('GET', f.base);
    assert.equal(draft.statusCode, 200, draft.body);
    const lockState = async () => ({
      inputs: (await f.pool.query('SELECT revision,input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 ORDER BY revision',
        [f.owner, f.projectId])).rows,
      latest: (await f.pool.query('SELECT latest_input_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2', [f.owner, f.projectId])).rows[0].latest_input_revision,
      outbox: (await f.pool.query("SELECT id,payload FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='project.input_locked' ORDER BY id",
        [f.owner, f.projectId])).rows,
    });
    const payload = { draft_revision: draft.json().draft_revision, prospectus_selection_revision: adopted.json().selection_revision,
      material_versions: [f.ref(f.source), f.ref(f.supporting)], requirement_message_ids: [] };
    return { ...f, olderClean: older, currentClean: current, draft, payload, lockState };
  } catch (error) { await f.close(); throw error; }
}

test('an explicit historical clean result may differ from current when exact sources and issuer still match', { skip: !connection }, async () => {
  const f = await generatedFixture();
  try {
    assert.notEqual(f.olderClean.pin.artifact_id, f.currentClean.pin.artifact_id);
    const before = await f.lockState();
    for (const { requested, expected } of [{ requested: { edit_base: f.olderClean.pin }, expected: f.olderClean },
      { requested: {}, expected: f.currentClean }]) {
      const locked = await f.send('POST', `${f.base}/input-revisions`, { ...f.payload, ...requested });
      assert.equal(locked.statusCode, 201, locked.body);
      const input = (await f.pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',
        [f.owner, f.projectId, locked.json().input_revision])).rows[0].manifest;
      assert.deepEqual(input.authoring.previous_output, { artifact_id: expected.pin.artifact_id, version: expected.pin.artifact_version,
        sha256: expected.pin.sha256, run_id: expected.run, input_revision: expected.input_revision });
      assert.deepEqual(input.authoring.format_policy, { version: 'source-format-v1', mode: 'preserve_docx',
        template: { kind: 'artifact', ...input.authoring.previous_output }, selection: 'previous_output' });
      assert.equal(input.prospectus_selection.version_id, f.currentClean.versionId, 'immutable current snapshot does not replace the explicit historical result');
    }
    assert.deepEqual((await f.lockState()).inputs.slice(0, before.inputs.length), before.inputs, 'earlier immutable snapshots remain unchanged');
  } finally { await f.close(); }
});

test('explicit and default generated continuations reject changed source sets or issuer without creating inputs', { skip: !connection }, async () => {
  for (const change of ['source-set', 'issuer'] as const) {
    const f = await generatedFixture();
    try {
      let changes: Record<string, unknown>, selected = f.payload.material_versions;
      if (change === 'source-set') {
        const reference = await f.addMaterial(`new-reference-${randomUUID()}`, 1, 'reference', 'd'.repeat(64));
        changes = { update_details: { ...f.draft.json().update_details,
          source_prospectuses: [f.declaration, { ...f.declaration, ...reference }] } };
        selected = [...selected, f.ref(reference)];
      } else changes = { issuer_name: 'Synthetic changed issuer' };
      const changed = await f.send('PATCH', f.base, changes, f.draft.json().draft_revision);
      assert.equal(changed.statusCode, 200, changed.body);
      const before = await f.lockState();
      for (const requested of [{ edit_base: f.olderClean.pin }, { edit_base: f.currentClean.pin }, {}]) {
        const rejected = await f.send('POST', `${f.base}/input-revisions`, { ...f.payload,
          draft_revision: changed.json().draft_revision, material_versions: selected, ...requested });
        assert.equal(rejected.statusCode, 409, `${change}: ${rejected.body}`);
        assert.equal(rejected.json().code, 'INPUT_REVISION_CONFLICT');
        assert.match(rejected.json().message, /来源材料或发行人不一致/);
        assert.deepEqual(await f.lockState(), before, 'rejection creates no input/outbox and leaves latest input unchanged');
      }
    } finally { await f.close(); }
  }
});
