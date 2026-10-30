import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, type SourceProspectus } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase(undefined, 'source-format');
const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const origin = 'http://bondbuddy.test';

test('format template selection is owner-scoped, exact, PATCH-compatible and immutable after input locking',
  { skip: !connection }, async () => {
    const pool = new Pool({ connectionString: connection });
    let owner = `synthetic-format-${randomUUID()}`;
    const app = createServer({ pool, allowedOrigin: origin, principal: async () => ({ userId: owner, csrfVerified: true }) });
    const send = (method: string, url: string, payload?: unknown, revision?: number) => app.inject({ method: method as any, url,
      headers: { origin, ...(revision ? { 'if-match': String(revision) } : {}) }, payload: payload as any });
    const create = async () => {
      const result = await send('POST', '/api/v1/projects', { name: 'Synthetic format preservation', kind: 'generation',
        issuer_name: 'Synthetic issuer', market: null, offering: null,
        update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1' } });
      assert.equal(result.statusCode, 201, result.body); return result.json();
    };
    const addMaterial = async (projectId: string, suffix: string) => {
      const id = `${suffix}-${randomUUID()}`, uploadId = randomUUID(), sha256 = suffix === 'z-first' ? 'a'.repeat(64) : 'b'.repeat(64);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'synthetic.docx',$4,10,$5,'reference',$6,now()+interval '1 hour','completed',$5,10)`,
      [uploadId, owner, projectId, docx, sha256, `synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'reference','synthetic.docx',$5,10,$6,$7,'persisted')`,
      [id, owner, projectId, uploadId, docx, sha256, `synthetic/${id}`]);
      return { material_id: id, material_version: 1, sha256 };
    };
    try {
      const p = await create(), first = await addMaterial(p.project_id, 'z-first'), second = await addMaterial(p.project_id, 'a-second');
      const source = (pin: typeof first): SourceProspectus => ({ ...pin, issuer_name: null, relation: 'same_issuer', market: 'sse', offering: 'private',
        reporting_periods: [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: null, status: 'needs_confirmation', evidence_refs: [] }], status: 'user_asserted' });
      const details = { ...p.update_details, source_prospectuses: [source(first), source(second)] };
      let saved = await send('PATCH', `/api/v1/projects/${p.project_id}`, { update_details: { ...details, format_template: second } }, p.draft_revision);
      assert.equal(saved.statusCode, 200, saved.body);
      let revision = saved.json().draft_revision;
      assert.deepEqual(saved.json().update_details.format_template, second);

      const stale = await send('PATCH', `/api/v1/projects/${p.project_id}`, { update_details: { ...details, format_template: { ...second, sha256: 'c'.repeat(64) } } }, revision);
      assert.equal(stale.statusCode, 409, stale.body);
      const absentVersion = await send('PATCH', `/api/v1/projects/${p.project_id}`, { update_details: { ...details, format_template: { ...second, material_version: 2 } } }, revision);
      assert.equal(absentVersion.statusCode, 404, absentVersion.body);

      saved = await send('PATCH', `/api/v1/projects/${p.project_id}`, { update_details: { ...details, other_information: 'legacy browser edit' } }, revision);
      assert.equal(saved.statusCode, 200, saved.body); revision = saved.json().draft_revision;
      assert.deepEqual(saved.json().update_details.format_template, second, 'omitted new field preserves the selected template');
      const refs = [first, second].map(({ material_id, material_version }) => ({ material_id, material_version }));
      const lock = (materials = refs) => send('POST', `/api/v1/projects/${p.project_id}/input-revisions`,
        { draft_revision: revision, material_versions: materials, requirement_message_ids: [] });
      const deselected = await lock([refs[0]]);
      assert.equal(deselected.statusCode, 409, deselected.body);
      const locked = await lock(); assert.equal(locked.statusCode, 201, locked.body);
      const before = (await pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [p.project_id, locked.json().input_revision])).rows[0];
      assert.deepEqual(before.manifest.authoring.format_policy.template, { kind: 'material', ...second });

      saved = await send('PATCH', `/api/v1/projects/${p.project_id}`, { update_details: { ...details, format_template: null } }, revision);
      assert.equal(saved.statusCode, 200, saved.body); revision = saved.json().draft_revision;
      assert.equal(saved.json().update_details.format_template, null);
      const auto = await lock(); assert.equal(auto.statusCode, 201, auto.body);
      const after = (await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [p.project_id, auto.json().input_revision])).rows[0];
      assert.deepEqual(after.manifest.authoring.format_policy.template, { kind: 'material', ...first }, 'recommendation follows request order, not ID order');
      const original = (await pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [p.project_id, locked.json().input_revision])).rows[0];
      assert.deepEqual(original, before, 'later draft choices leave previous inputs and hashes immutable');

      const otherProject = await create();
      const wrongProject = await send('PATCH', `/api/v1/projects/${otherProject.project_id}`, { update_details: { ...otherProject.update_details, format_template: second } }, otherProject.draft_revision);
      assert.equal(wrongProject.statusCode, 404, wrongProject.body);
      owner = `synthetic-foreign-format-${randomUUID()}`;
      const foreign = await create();
      const wrongOwner = await send('PATCH', `/api/v1/projects/${foreign.project_id}`, { update_details: { ...foreign.update_details, format_template: second } }, foreign.draft_revision);
      assert.equal(wrongOwner.statusCode, 404, wrongOwner.body);
      assert.equal(wrongOwner.body.includes(second.material_id), false);
    } finally { await app.close(); await pool.end(); }
  });
