import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { rulePackContentHash, type ChapterTemplate, type CoverageManifest, type RulePack } from '@bondbuddy/domain';
import {
  readProductionComponentSnapshots,
  registerProductionComponentSnapshots,
  type ProductionComponentRefs,
} from './component-snapshot-registry.js';
import { productionSnapshotHash } from './canonical-snapshot.js';

const pack = JSON.parse(readFileSync(new URL('../../domain/examples/synthetic-rule-pack.json', import.meta.url), 'utf8')) as RulePack;
const template: ChapterTemplate = {
  schema_version: 'chapter-template-v1', template_id: 'synthetic-template', version: 'synthetic-1',
  rule_pack_id: pack.pack_id, market: 'sse', offering: 'public_all', document_stages: ['registration'],
  chapters: [{ chapter_id: 'synthetic-chapter', title: '合成章节', form_refs: ['synthetic'],
    source_ref_ids: ['synthetic-lead'], required_fields: [], applicability: '仅用于测试' }],
};
const coverage: CoverageManifest = {
  schema_version: 'capability-coverage-v1', manifest_id: 'synthetic-coverage', version: 'synthetic-1',
  rule_pack_id: pack.pack_id, assessed_at: '2026-09-28T00:00:00Z',
  items: [{ item_id: 'synthetic-item', area: '仅用于测试', disposition: 'uncovered', document_stages: ['registration'],
    source_ref_ids: [], rationale: '合成测试覆盖项' }], open_blockers: [],
};

function refsFor(nextPack = pack): ProductionComponentRefs {
  return {
    rule_pack: { kind: 'rule_pack', id: nextPack.pack_id, version: nextPack.version, sha256: rulePackContentHash(nextPack) },
    chapter_template: { kind: 'chapter_template', id: template.template_id, version: template.version, sha256: productionSnapshotHash(template) },
    coverage_manifest: { kind: 'coverage_manifest', id: coverage.manifest_id, version: coverage.version, sha256: productionSnapshotHash(coverage) },
  };
}

class MemoryTransaction {
  readonly rows = new Map<string, { component_kind: 'rule_pack' | 'chapter_template' | 'coverage_manifest'; component_id: string; component_version: string; snapshot_sha256: string; snapshot: unknown }>();

  async query(sql: string, values: any[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    if (sql.includes('INSERT INTO bb_rule_pack_production_component_snapshots')) {
      const [component_kind, component_id, component_version, snapshot_sha256, rawSnapshot] = values as [string, string, string, string, string];
      const key = `${component_kind}:${component_id}:${component_version}`;
      if (this.rows.has(key)) return { rowCount: 0, rows: [] };
      const row = { component_kind: component_kind as 'rule_pack' | 'chapter_template' | 'coverage_manifest', component_id, component_version, snapshot_sha256, snapshot: JSON.parse(rawSnapshot) };
      this.rows.set(key, row);
      return { rowCount: 1, rows: [row] };
    }
    if (sql.includes('SELECT component_kind, component_id, component_version, snapshot_sha256, snapshot')) {
      const keys = sql.includes('WHERE (component_kind')
        ? [
          `rule_pack:${values[0]}:${values[1]}`,
          `chapter_template:${values[3]}:${values[4]}`,
          `coverage_manifest:${values[6]}:${values[7]}`,
        ]
        : [`${values[0]}:${values[1]}:${values[2]}`];
      const rows = keys.map(key => this.rows.get(key)).filter((row): row is NonNullable<typeof row> => Boolean(row));
      if (sql.includes('WHERE (component_kind')) {
        const expectedHashes = [values[2], values[5], values[8]];
        const filtered = rows.filter(row => expectedHashes.includes(row.snapshot_sha256));
        return { rowCount: filtered.length, rows: filtered };
      }
      return { rowCount: rows.length, rows };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
}

test('synthetic complete component snapshots register once and read back by exact refs', async () => {
  const transaction = new MemoryTransaction();
  const refs = refsFor();
  const snapshots = { rule_pack: pack, chapter_template: template, coverage_manifest: coverage };
  await registerProductionComponentSnapshots(transaction, refs, snapshots);
  await registerProductionComponentSnapshots(transaction, refs, snapshots);
  assert.equal(transaction.rows.size, 3, 'same immutable set is idempotent');
  assert.deepEqual(await readProductionComponentSnapshots(transaction, refs), snapshots);
});

test('registry rejects identity mutation and incomplete or mismatched component sets', async () => {
  const transaction = new MemoryTransaction();
  const refs = refsFor();
  await registerProductionComponentSnapshots(transaction, refs, { rule_pack: pack, chapter_template: template, coverage_manifest: coverage });

  const mutated = structuredClone(pack);
  mutated.rules[0]!.title = 'different synthetic content';
  assert.notEqual(refsFor(mutated).rule_pack.sha256, refs.rule_pack.sha256);
  await assert.rejects(registerProductionComponentSnapshots(transaction, refsFor(mutated), {
    rule_pack: mutated, chapter_template: template, coverage_manifest: coverage,
  }), /PRODUCTION_COMPONENT_SNAPSHOT_COLLISION/);

  const badTemplate = { ...template, rule_pack_id: 'other-pack' };
  await assert.rejects(registerProductionComponentSnapshots(transaction, refs, {
    rule_pack: pack, chapter_template: badTemplate, coverage_manifest: coverage,
  }), /INVALID_PRODUCTION_COMPONENT_SNAPSHOT_SET/);
  await assert.rejects(readProductionComponentSnapshots(transaction, {
    ...refs, chapter_template: { ...refs.chapter_template, sha256: '0'.repeat(64) },
  }), /PRODUCTION_COMPONENT_SNAPSHOT_NOT_FOUND/);
});
