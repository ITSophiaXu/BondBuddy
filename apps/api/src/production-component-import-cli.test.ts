import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { rulePackContentHash, type ChapterTemplate, type CoverageManifest, type RulePack } from '@bondbuddy/domain';
import { productionSnapshotHash, type ProductionComponentRefs } from '@bondbuddy/rule-pack-registry';
import {
  parseProductionComponentBundle,
  registerProductionComponentBundle,
} from './production-component-import-cli.js';

const pack = JSON.parse(readFileSync(new URL('../../../packages/domain/examples/synthetic-rule-pack.json', import.meta.url), 'utf8')) as RulePack;
const template: ChapterTemplate = {
  schema_version: 'chapter-template-v1', template_id: 'cli-synthetic-template', version: 'cli-synthetic-1',
  rule_pack_id: pack.pack_id, market: 'sse', offering: 'public_all', document_stages: ['registration'],
  chapters: [{ chapter_id: 'cli-synthetic-chapter', title: '合成章节', form_refs: ['synthetic'],
    source_ref_ids: ['synthetic-lead'], required_fields: [], applicability: '仅用于测试' }],
};
const coverage: CoverageManifest = {
  schema_version: 'capability-coverage-v1', manifest_id: 'cli-synthetic-coverage', version: 'cli-synthetic-1',
  rule_pack_id: pack.pack_id, assessed_at: '2026-09-28T00:00:00Z',
  items: [{ item_id: 'cli-synthetic-item', area: '仅用于测试', disposition: 'uncovered', document_stages: ['registration'],
    source_ref_ids: [], rationale: '合成测试覆盖项' }], open_blockers: [],
};
const refs: ProductionComponentRefs = {
  rule_pack: { kind: 'rule_pack', id: pack.pack_id, version: pack.version, sha256: rulePackContentHash(pack) },
  chapter_template: { kind: 'chapter_template', id: template.template_id, version: template.version, sha256: productionSnapshotHash(template) },
  coverage_manifest: { kind: 'coverage_manifest', id: coverage.manifest_id, version: coverage.version, sha256: productionSnapshotHash(coverage) },
};
const bundle = { refs, snapshots: { rule_pack: pack, chapter_template: template, coverage_manifest: coverage } };

class MemoryClient {
  readonly calls: string[] = [];
  readonly rows = new Map<string, { component_kind: string; component_id: string; component_version: string; snapshot_sha256: string; snapshot: unknown }>();
  failCommit = false;

  async query(sql: string, values: any[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    const normalized = sql.trim();
    this.calls.push(normalized);
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      if (normalized === 'COMMIT' && this.failCommit) throw new Error('synthetic commit failure');
      return { rows: [], rowCount: null };
    }
    if (normalized.includes('INSERT INTO bb_rule_pack_production_component_snapshots')) {
      const [component_kind, component_id, component_version, snapshot_sha256, rawSnapshot] = values as [string, string, string, string, string];
      const key = `${component_kind}:${component_id}:${component_version}`;
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      this.rows.set(key, { component_kind, component_id, component_version, snapshot_sha256, snapshot: JSON.parse(rawSnapshot) });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.includes('SELECT component_kind, component_id, component_version, snapshot_sha256, snapshot')) {
      const key = `${values[0]}:${values[1]}:${values[2]}`;
      const row = this.rows.get(key);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error('unexpected query');
  }
}

test('strictly parses a complete bundle and rejects extra or missing keys', () => {
  assert.deepEqual(parseProductionComponentBundle(bundle), bundle);
  assert.throws(() => parseProductionComponentBundle({ ...bundle, actor: 'someone' }), /INVALID_PRODUCTION_COMPONENT_BUNDLE/);
  assert.throws(() => parseProductionComponentBundle({ refs, snapshots: { rule_pack: pack } }), /INVALID_PRODUCTION_COMPONENT_BUNDLE/);
});

test('registers all immutable snapshots in one transaction and rolls back failed registration', async () => {
  const client = new MemoryClient();
  await registerProductionComponentBundle(client, bundle);
  assert.deepEqual(client.calls.filter((call) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call)), ['BEGIN', 'COMMIT']);
  assert.equal(client.rows.size, 3);
  await registerProductionComponentBundle(client, bundle);
  assert.equal(client.rows.size, 3, 'identical immutable snapshots are idempotent');

  const mutated = structuredClone(bundle);
  (mutated.snapshots.rule_pack.rules[0] as { title: string }).title = 'different synthetic content';
  const failing = new MemoryClient();
  await assert.rejects(registerProductionComponentBundle(failing, mutated), /PRODUCTION_COMPONENT_REF_MISMATCH/);
  assert.deepEqual(failing.calls.filter((call) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call)), ['BEGIN', 'ROLLBACK']);
});

test('rolls back when commit fails and does not expose component content', async () => {
  const client = new MemoryClient();
  client.failCommit = true;
  await assert.rejects(registerProductionComponentBundle(client, bundle), /synthetic commit failure/);
  assert.deepEqual(client.calls.filter((call) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call)), ['BEGIN', 'COMMIT', 'ROLLBACK']);
  assert.equal(JSON.stringify(refs).includes('synthetic content'), false);
});
