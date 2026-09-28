import type { QueryResultRow } from 'pg';
import {
  rulePackContentHash,
  validateRulePackCompanions,
  type ChapterTemplate,
  type CoverageManifest,
  type RulePack,
} from '@bondbuddy/domain';
import { productionSnapshotHash } from './canonical-snapshot.js';

export type ProductionComponentKind = 'rule_pack' | 'chapter_template' | 'coverage_manifest';

export type ProductionComponentRef = {
  readonly kind: ProductionComponentKind;
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
};

export type ProductionComponentSnapshots = {
  readonly rule_pack: RulePack;
  readonly chapter_template: ChapterTemplate;
  readonly coverage_manifest: CoverageManifest;
};

export type ProductionComponentRefs = {
  readonly rule_pack: ProductionComponentRef;
  readonly chapter_template: ProductionComponentRef;
  readonly coverage_manifest: ProductionComponentRef;
};

type RegistryRow = QueryResultRow & {
  component_kind: ProductionComponentKind;
  component_id: string;
  component_version: string;
  snapshot_sha256: string;
  snapshot: unknown;
};

/** Minimal transaction-scoped query surface keeps this module independent of the API/server layer. */
export type ProductionComponentTransaction = {
  query: (queryText: string, values?: any[]) => Promise<{ rows: RegistryRow[]; rowCount: number | null }>;
};

const HASH = /^[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function refFor(kind: ProductionComponentKind, value: unknown): ProductionComponentRef {
  if (kind === 'rule_pack') {
    const pack = value as RulePack;
    return { kind, id: pack.pack_id, version: pack.version, sha256: rulePackContentHash(pack) };
  }
  if (kind === 'chapter_template') {
    const template = value as ChapterTemplate;
    return { kind, id: template.template_id, version: template.version, sha256: productionSnapshotHash(template) };
  }
  const coverage = value as CoverageManifest;
  return { kind, id: coverage.manifest_id, version: coverage.version, sha256: productionSnapshotHash(coverage) };
}

function snapshotFor(kind: ProductionComponentKind, snapshots: ProductionComponentSnapshots): unknown {
  switch (kind) {
    case 'rule_pack': return snapshots.rule_pack;
    case 'chapter_template': return snapshots.chapter_template;
    case 'coverage_manifest': return snapshots.coverage_manifest;
  }
}

function expectedRefs(snapshots: ProductionComponentSnapshots): ProductionComponentRefs {
  const checked = validateRulePackCompanions(
    snapshots.rule_pack,
    snapshots.chapter_template,
    snapshots.coverage_manifest,
  );
  if (!checked.ok) fail('INVALID_PRODUCTION_COMPONENT_SNAPSHOT_SET');
  return {
    rule_pack: refFor('rule_pack', checked.pack),
    chapter_template: refFor('chapter_template', checked.template),
    coverage_manifest: refFor('coverage_manifest', checked.coverage),
  };
}

function assertRef(ref: ProductionComponentRef): void {
  if (!ref || !['rule_pack', 'chapter_template', 'coverage_manifest'].includes(ref.kind)
    || typeof ref.id !== 'string' || ref.id.trim() === ''
    || typeof ref.version !== 'string' || ref.version.trim() === ''
    || typeof ref.sha256 !== 'string' || !HASH.test(ref.sha256)) {
    fail('INVALID_PRODUCTION_COMPONENT_REF');
  }
}

function assertRefsMatch(expected: ProductionComponentRefs, actual: ProductionComponentRefs): void {
  for (const kind of ['rule_pack', 'chapter_template', 'coverage_manifest'] as const) {
    assertRef(actual[kind]);
    if (actual[kind].kind !== kind
      || actual[kind].id !== expected[kind].id
      || actual[kind].version !== expected[kind].version
      || actual[kind].sha256 !== expected[kind].sha256) {
      fail('PRODUCTION_COMPONENT_REF_MISMATCH');
    }
  }
}

/**
 * Persist a complete, schema-checked component set. Call with a transaction
 * client; the database protects each immutable (kind,id,version) identity.
 * This records snapshots only and does not publish a production capability.
 */
export async function registerProductionComponentSnapshots(
  transaction: ProductionComponentTransaction,
  refs: ProductionComponentRefs,
  snapshots: ProductionComponentSnapshots,
): Promise<void> {
  const expected = expectedRefs(snapshots);
  assertRefsMatch(expected, refs);

  for (const kind of ['rule_pack', 'chapter_template', 'coverage_manifest'] as const) {
    const ref = refs[kind];
    const result = await transaction.query(`
      INSERT INTO bb_rule_pack_production_component_snapshots
        (component_kind, component_id, component_version, snapshot_sha256, snapshot)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (component_kind, component_id, component_version) DO NOTHING
      RETURNING component_kind, component_id, component_version, snapshot_sha256, snapshot
    `, [kind, ref.id, ref.version, ref.sha256, JSON.stringify(snapshotFor(kind, snapshots))]);
    if (result.rowCount === 1) continue;

    const existing = await transaction.query(`
      SELECT component_kind, component_id, component_version, snapshot_sha256, snapshot
      FROM bb_rule_pack_production_component_snapshots
      WHERE component_kind=$1 AND component_id=$2 AND component_version=$3
      FOR SHARE
    `, [kind, ref.id, ref.version]);
    const row = existing.rows[0];
    if (!row || row.snapshot_sha256 !== ref.sha256) fail('PRODUCTION_COMPONENT_SNAPSHOT_COLLISION');
    if (productionSnapshotHash(row.snapshot) !== productionSnapshotHash(snapshotFor(kind, snapshots))) {
      // Rule-pack refs intentionally use the domain content hash, while this
      // equality check also ensures the complete stored JSON was not replaced.
      fail('PRODUCTION_COMPONENT_SNAPSHOT_COLLISION');
    }
  }
}

/**
 * Read all components by exact frozen refs from the caller's active
 * transaction. Request bodies never supply component JSON to release code.
 */
export async function readProductionComponentSnapshots(
  transaction: ProductionComponentTransaction,
  refs: ProductionComponentRefs,
): Promise<ProductionComponentSnapshots> {
  for (const kind of ['rule_pack', 'chapter_template', 'coverage_manifest'] as const) assertRef(refs[kind]);
  if (refs.rule_pack.kind !== 'rule_pack'
    || refs.chapter_template.kind !== 'chapter_template'
    || refs.coverage_manifest.kind !== 'coverage_manifest') fail('INVALID_PRODUCTION_COMPONENT_REF');

  const result = await transaction.query(`
    SELECT component_kind, component_id, component_version, snapshot_sha256, snapshot
    FROM bb_rule_pack_production_component_snapshots
    WHERE (component_kind, component_id, component_version, snapshot_sha256) IN
      (('rule_pack',$1,$2,$3), ('chapter_template',$4,$5,$6), ('coverage_manifest',$7,$8,$9))
    FOR SHARE
  `, [
    refs.rule_pack.id, refs.rule_pack.version, refs.rule_pack.sha256,
    refs.chapter_template.id, refs.chapter_template.version, refs.chapter_template.sha256,
    refs.coverage_manifest.id, refs.coverage_manifest.version, refs.coverage_manifest.sha256,
  ]);
  if (result.rowCount !== 3) fail('PRODUCTION_COMPONENT_SNAPSHOT_NOT_FOUND');

  const byKind = new Map(result.rows.map((row) => [row.component_kind, row]));
  const packRow = byKind.get('rule_pack');
  const templateRow = byKind.get('chapter_template');
  const coverageRow = byKind.get('coverage_manifest');
  if (!packRow || !templateRow || !coverageRow) fail('PRODUCTION_COMPONENT_SNAPSHOT_NOT_FOUND');

  const pack = packRow.snapshot as RulePack;
  const template = templateRow.snapshot as ChapterTemplate;
  const coverage = coverageRow.snapshot as CoverageManifest;
  const checked = validateRulePackCompanions(pack, template, coverage);
  if (!checked.ok) fail('INVALID_PRODUCTION_COMPONENT_SNAPSHOT_SET');
  const actual: ProductionComponentRefs = {
    rule_pack: refFor('rule_pack', checked.pack),
    chapter_template: refFor('chapter_template', checked.template),
    coverage_manifest: refFor('coverage_manifest', checked.coverage),
  };
  assertRefsMatch(actual, refs);
  // Verify stored full-snapshot checksums independently of the SQL lookup.
  if (refFor('chapter_template', template).sha256 !== templateRow.snapshot_sha256
    || refFor('coverage_manifest', coverage).sha256 !== coverageRow.snapshot_sha256
    || refFor('rule_pack', pack).sha256 !== packRow.snapshot_sha256) {
    fail('PRODUCTION_COMPONENT_SNAPSHOT_HASH_MISMATCH');
  }
  return { rule_pack: checked.pack, chapter_template: checked.template, coverage_manifest: checked.coverage };
}
