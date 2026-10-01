import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import {
  registerProductionComponentSnapshots,
  type ProductionComponentRefs,
  type ProductionComponentSnapshots,
  type ProductionComponentTransaction,
} from '@bondbuddy/rule-pack-registry';

export type ProductionComponentBundle = {
  readonly refs: ProductionComponentRefs;
  readonly snapshots: ProductionComponentSnapshots;
};

const COMPONENT_KINDS = ['rule_pack', 'chapter_template', 'coverage_manifest'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Reject malformed bundles before opening a transaction. Snapshot semantics and hash validation
 * remain centralized in the registry package. */
export function parseProductionComponentBundle(value: unknown): ProductionComponentBundle {
  if (!isRecord(value) || !hasExactKeys(value, ['refs', 'snapshots'])) throw new Error('INVALID_PRODUCTION_COMPONENT_BUNDLE');
  const refs = value.refs;
  const snapshots = value.snapshots;
  if (!isRecord(refs) || !isRecord(snapshots)
    || !hasExactKeys(refs, COMPONENT_KINDS) || !hasExactKeys(snapshots, COMPONENT_KINDS)) {
    throw new Error('INVALID_PRODUCTION_COMPONENT_BUNDLE');
  }
  for (const kind of COMPONENT_KINDS) {
    const ref = refs[kind];
    if (!isRecord(ref) || !hasExactKeys(ref, ['kind', 'id', 'version', 'sha256'])
      || ref.kind !== kind || typeof ref.id !== 'string' || typeof ref.version !== 'string'
      || typeof ref.sha256 !== 'string') {
      throw new Error('INVALID_PRODUCTION_COMPONENT_BUNDLE');
    }
  }
  return value as unknown as ProductionComponentBundle;
}

/** Register a full immutable component set in one explicit database transaction. */
export async function registerProductionComponentBundle(
  client: ProductionComponentTransaction,
  bundle: ProductionComponentBundle,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await registerProductionComponentSnapshots(client, bundle.refs, bundle.snapshots);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the registration failure */ }
    throw error;
  }
}

function summary(bundle: ProductionComponentBundle): object {
  return {
    result: 'registered',
    refs: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, {
      id: bundle.refs[kind].id,
      version: bundle.refs[kind].version,
      sha256: bundle.refs[kind].sha256,
    }])),
  };
}

export async function importProductionComponentBundleFile(filePath: string, databaseUrl: string): Promise<object> {
  const raw = await readFile(filePath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('INVALID_PRODUCTION_COMPONENT_BUNDLE_JSON'); }
  const bundle = parseProductionComponentBundle(parsed);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await registerProductionComponentBundle(client, bundle);
  } finally {
    client?.release();
    await pool.end();
  }
  return summary(bundle);
}

async function main(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (args.length !== 1 || !args[0]) throw new Error('USAGE: production-component-import <bundle.json>');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const result = await importProductionComponentBundleFile(args[0], env.DATABASE_URL);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    const safeCodes = new Set([
      'USAGE: production-component-import <bundle.json>',
      'DATABASE_URL_REQUIRED',
      'INVALID_PRODUCTION_COMPONENT_BUNDLE',
      'INVALID_PRODUCTION_COMPONENT_BUNDLE_JSON',
      'INVALID_PRODUCTION_COMPONENT_SNAPSHOT_SET',
      'INVALID_PRODUCTION_COMPONENT_REF',
      'PRODUCTION_COMPONENT_REF_MISMATCH',
      'PRODUCTION_COMPONENT_SNAPSHOT_COLLISION',
    ]);
    const code = error instanceof Error && safeCodes.has(error.message) ? error.message : 'PRODUCTION_COMPONENT_IMPORT_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
