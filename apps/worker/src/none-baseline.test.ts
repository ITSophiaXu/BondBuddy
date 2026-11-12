// Synthetic worker boundary tests; API none-baseline.pg.test exercises the shared guard against real PostgreSQL.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { emptyUpdateDetails, reportingWindow } from '@bondbuddy/contracts';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { unifiedInputGate, type UnifiedManifest } from './unified-input.js';
import { editingSource } from './file-authoring-stage.js';
import type { RunRow, InputRevisionRow } from './run-pipeline.js';

const history = { material_id: 'history', material_version: 1, sha256: 'a'.repeat(64) };
function fixture() {
  const financial = { material_id: 'financial', material_version: 1, role: 'financial', sha256: 'b'.repeat(64) };
  const manifest: UnifiedManifest = { kind: 'generation', issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private', materials: [financial],
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', target_reporting_periods: reportingWindow('sse', 'private', '2025-09-30') },
    authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [], knowledge: [{ path: 'synthetic', markdown: 'synthetic', sha256: digest('synthetic') }],
      knowledge_status: 'authoring_reference_not_compliance_approval', format_policy: { version: 'source-format-v1', mode: 'new_document', template: null, selection: 'automatic' } } };
  const run = { owner_user_id: 'owner', project_id: 'project' } as RunRow;
  const execute = (pool: Pool) => { const hash = inputManifestHash(manifest); run.input_hash = hash;
    return unifiedInputGate(pool, run, { manifest, input_hash: hash, draft_revision: 1, material_versions: manifest.materials,
      rule_pack_version: null, template_version: null } as InputRevisionRow); };
  return { financial, manifest, run, execute };
}

test('worker none rejects omitted historical material and a database outage before model execution', async () => {
  for (const kind of ['update', 'generation']) {
    const f = fixture(); f.manifest.kind = kind;
    const statements: string[] = [];
    const client = { query: async (sql: string) => { statements.push(sql);
      if (sql.includes('FROM bb_projects')) return { rows: [{ kind }] };
      if (sql.includes('FROM bb_material_versions')) return { rows: [{ id: history.material_id, version: 1, sha256: history.sha256, filename: 'synthetic' }] };
      return { rows: [] }; }, release() {} };
    const pool = { query: async () => ({ rows: [f.financial] }), connect: async () => client } as unknown as Pool;
    assert.deepEqual(await f.execute(pool), { kind: 'fail', code: kind === 'update' ? 'HISTORICAL_BASELINE_REQUIRED' : 'FIRST_DRAFT_CONFIRMATION_REQUIRED' });
    assert.match(statements.find(s => s.includes('FROM bb_projects'))!, /FOR SHARE/);
    assert.ok(statements.findIndex(s => s.includes('FROM bb_projects')) < statements.findIndex(s => s.includes('FROM bb_material_versions')));
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.deepEqual(await f.execute({ query: async () => ({ rows: [f.financial] }), connect: async () => { throw Error('synthetic outage'); } } as unknown as Pool),
      { kind: 'fail', code: 'DATA_UNAVAILABLE' });
  }
});

test('a verified exact previous output bypasses none while unavailable/wrong-hash artifacts still fail', async () => {
  const f = fixture(), artifact = { artifact_id: 'clean', version: 2, sha256: 'c'.repeat(64), run_id: 'previous', input_revision: 1 };
  f.manifest.authoring.previous_output = artifact;
  f.manifest.authoring.format_policy = { version: 'source-format-v1', mode: 'preserve_docx', template: { kind: 'artifact', ...artifact }, selection: 'previous_output' };
  for (const available of [false, true]) for (const exactHash of [false, true]) {
    let checkedArtifact = false;
    const pool = { query: async (sql: string) => {
      if (sql.includes('FROM bb_material_versions')) return { rows: [f.financial] };
      assert.match(sql, /FROM bb_artifact_versions/); assert.match(sql, /r.state='succeeded'/); assert.match(sql, /quality_status='passed'/);
      checkedArtifact = true; return { rows: available ? [{ object_key: 'synthetic', sha256: exactHash ? artifact.sha256 : 'd'.repeat(64) }] : [] };
    }, connect: async () => { throw Error('a baseline must not query none history'); } } as unknown as Pool;
    assert.deepEqual(await f.execute(pool), available && exactHash ? null : { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' });
    assert.equal(checkedArtifact, true);
  }
  const loaded = { manifest: f.manifest, requirements: [], materials: [
    { pin: f.financial, filename: 'synthetic', mediaType: 'text/plain', objectKey: 'synthetic', records: [] },
    { pin: { material_id: artifact.artifact_id, material_version: artifact.version, sha256: artifact.sha256, role: 'project_output' },
      filename: 'clean.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', objectKey: 'synthetic', records: [] }] };
  assert.equal(editingSource(loaded), loaded.materials[1]);
  assert.throws(() => editingSource({ ...loaded, materials: loaded.materials.slice(0, 1) }), /INPUT_REVISION_CONFLICT/);
  assert.throws(() => editingSource({ ...loaded, materials: [...loaded.materials, loaded.materials[1]!] }), /INPUT_REVISION_CONFLICT/);
});
