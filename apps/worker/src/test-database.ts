import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

// Test-only helper. `node --test` runs every test file in its own process in parallel, so suites that share
// one database race on global rows (outbox counts, queued jobs, bb_outbox triggers). Each calling file or
// isolation key gets a private copy of the configured, already-migrated database, cloned with CREATE DATABASE ... TEMPLATE and
// dropped when the file finishes. The configured database is only a template: tests never connect to it,
// because PostgreSQL refuses to clone a template that has open sessions. The role needs CREATEDB.

const cloned = new Map<string, Promise<string>>();
const created: Array<{ template: URL; name: string }> = [];

// A file's after hooks close its pools and background work. Drop clones only once
// those hooks and their connections have finished, while still failing the file if cleanup fails.
process.once('beforeExit', () => {
  void (async () => {
    const failures: unknown[] = [];
    for (const { template, name } of created) {
      try {
        await withMaintenance(template, (client) => client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, `Failed to drop ${failures.length} test database clone(s)`);
  })().catch((error: unknown) => {
    process.stderr.write(`Test database cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
});

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function withMaintenance<T>(template: URL, work: (client: Client) => Promise<T>): Promise<T> {
  const maintenance = new URL(template);
  maintenance.pathname = '/postgres';
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

async function cloneDatabase(templateUrl: string): Promise<string> {
  const template = new URL(templateUrl);
  const templateName = decodeURIComponent(template.pathname.slice(1));
  if (!templateName) throw new Error('test database URL must name the migrated template database');
  const cloneName = `${templateName.slice(0, 40)}_t${process.pid}_${randomBytes(4).toString('hex')}`;
  await withMaintenance(template, async (client) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query(`CREATE DATABASE ${quoteIdent(cloneName)} TEMPLATE ${quoteIdent(templateName)}`);
        return;
      } catch (error) {
        // 55006: another file is cloning the same template at this moment; retry briefly.
        if ((error as { code?: string }).code !== '55006' || attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
      }
    }
  });
  created.push({ template, name: cloneName });
  const url = new URL(template);
  url.pathname = `/${encodeURIComponent(cloneName)}`;
  return url.toString();
}

/**
 * Resolves the database for one test file or isolation key: the suite-specific variable if set, otherwise BB_TEST_DATABASE_URL.
 * Returns undefined (so the suite skips) when neither is set; otherwise a private clone of that database.
 */
export async function isolatedTestDatabase(specificVariable?: string, isolationKey = ''): Promise<string | undefined> {
  const template = (specificVariable ? process.env[specificVariable] : undefined) || process.env.BB_TEST_DATABASE_URL;
  if (!template) return undefined;
  const key = `${template}\0${isolationKey}`;
  let clone = cloned.get(key);
  if (!clone) { clone = cloneDatabase(template); cloned.set(key, clone); }
  return clone;
}
